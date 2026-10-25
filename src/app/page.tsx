// Caminho: src/app/chat/page.tsx
'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { Virtuoso } from 'react-virtuoso';

// Hooks Nativos da Arquitetura ChatChat
import { useCamera } from '@/hooks/useCamera';
import { useLocalVault } from '@/hooks/useLocalVault';
import {
  useWebRTC,
  processFileForP2P,
  generateMasterKey,
  encryptChunk,
  decryptChunk
} from '@/hooks/useWebRTC';
import { useLiveCall } from '@/hooks/useLiveCall';
import { useChatEngine } from '@/hooks/useChatEngine';
import {
  useContactsCleanRoom,
  resolveDisplayName,
  hashPhoneIdentifier
} from '@/hooks/useContactsCleanRoom';

// Parte 1: Componentes Visuais Isolados
import { Avatar, CustomAudioPlayer } from '@/components/chat/ChatUIComponents';

// Parte 2: Utilitários e Tipos de Contactos / Páginas Globais
import {
  type ContactFaceStatus,
  type GlobalPageConfig,
  type GlobalPageAccessRequest,
  GLOBAL_PAGES_STORAGE_KEY,
  normalizePhoneKey,
  normalizeEmailKey,
  isPhoneTypedInSearchBar,
  getContactsStorageKey,
  getContactFaceStatusStorageKey,
  getDeletedContactsStorageKey,
  getBlockedByOthersStorageKey,
  getMyAvatarStorageKey,
  formatPageHandle,
  formatPageHashtags,
  normalizeExternalUrl,
  generateCompressedAvatarDataUrl,
  deduplicateContactsList
} from '@/lib/chat/contactUtils';

// Parte 3: Modais Isolados
import {
  ChatModals,
  type ContactFormState,
  type GlobalPageFormState
} from '@/components/chat/ChatModals';

// Componentes de Chamadas
import { IncomingCall } from '@/components/calls/IncomingCall';
import { CallWindow } from '@/components/calls/CallWindow';

// Utilitários de Media
import {
  HD_AUDIO_CONSTRAINTS,
  getStatusDisplay,
  formatBytes,
  formatDuration,
  isVideoFileCheck,
  detectMimeFromBinary,
  getNormalizedMimeType,
  cloneFileToRamSafely,
  fixVideoDurationAndPlayback,
  prepareFileForP2PSafe,
  generateMediaThumbnailAndMeta,
  compressImageBlobForMobile,
  uploadToStorageWithAutoChunking,
  downloadMediaBufferFromMetadata,
  purgeCloudStorageForMsg,
  sendP2PChunksWithBackpressure
} from '@/lib/chatMediaUtils';

import type {
  UserProfile,
  SavedContact,
  ImageMetadata,
  ChatMessage
} from '@/app/types/chat';

export type { UserProfile, SavedContact, ImageMetadata, ChatMessage };

// ============================================================================
// CODIFICADOR DE METADADOS DA PÁGINA GLOBAL NA TABELA PÚBLICA PROFILES
// Garante que qualquer outra conta veja os dados da Página Global em tempo real,
// ocultando os metadados completamente na aba de Meus Contactos.
// ============================================================================
const GP_STATUS_MARKER = '||__GP__:';

const extractCleanPresenceStatus = (rawStatus?: string | null): string => {
  if (!rawStatus) return 'Online';
  const idx = rawStatus.indexOf(GP_STATUS_MARKER);
  if (idx === -1) return rawStatus;
  return rawStatus.slice(0, idx).trim() || 'Online';
};

const encodeStatusWithGlobalPage = (
  rawStatus: string | undefined | null,
  cfg: GlobalPageConfig
): string => {
  const baseStatus = extractCleanPresenceStatus(rawStatus);
  // O avatar já fica salvo em profiles.avatar_url; evitamos duplicar Base64 longo no campo status
  const compactAvatar =
    cfg.avatar_url && !cfg.avatar_url.startsWith('data:') ? cfg.avatar_url : null;
  const compactConfig: GlobalPageConfig = {
    ...cfg,
    avatar_url: compactAvatar
  };
  return `${baseStatus}${GP_STATUS_MARKER}${JSON.stringify(compactConfig)}`;
};

const decodeGlobalPageFromProfileRow = (
  profileRow: any
): GlobalPageConfig | null => {
  const rawStatus = profileRow?.status;
  if (!rawStatus || typeof rawStatus !== 'string') return null;
  const idx = rawStatus.indexOf(GP_STATUS_MARKER);
  if (idx === -1) return null;
  const jsonPart = rawStatus.slice(idx + GP_STATUS_MARKER.length).trim();
  if (!jsonPart) return null;
  try {
    const parsed = JSON.parse(jsonPart) as GlobalPageConfig;
    if (!parsed || !parsed.userId) return null;
    return {
      ...parsed,
      userId: String(parsed.userId),
      title: parsed.title || profileRow.username || 'Página Global',
      avatar_url: parsed.avatar_url || profileRow.avatar_url || null,
      handle: formatPageHandle(parsed.handle || parsed.title || profileRow.username || 'pagina'),
      hashtags: parsed.hashtags || '',
      bio_link: parsed.bio_link || '',
      approvedUserIds: Array.isArray(parsed.approvedUserIds) ? parsed.approvedUserIds.map(String) : [],
      pendingRequests: Array.isArray(parsed.pendingRequests) ? parsed.pendingRequests : [],
      rejectedUserIds: Array.isArray(parsed.rejectedUserIds) ? parsed.rejectedUserIds.map(String) : []
    };
  } catch {
    return null;
  }
};

export default function ChatHub() {
  const {
    currentUser, globalProfiles, mySavedContacts, setMySavedContacts,
    followedIds, followerCounts, loading,
    activeTab, setActiveTab, selectedContact, setSelectedContact, selectedGroup, setSelectedGroup,
    messages, setMessages, groupMessages, setGroupMessages, galleryMessages,
    setUnreadSenders, communityGroups, groupMembers,
    deletedForMeIds, setDeletedForMeIds, isShaking,
    handleToggleFollow, handleSendNudge, handleDeleteMessage, handleClearChat,
    handleGroupTrash, confirmLimparTotal, handleGalleryTrash, handleCreateGroup, fetchGalleryMedia
  } = useChatEngine();

  const {
    contacts: cleanRoomContacts,
    discoverContactByPhone,
    addOrUpdateContact
  } = useContactsCleanRoom(currentUser?.id || null);

  // Estados de Contactos e Carinha (Verde / Amarelo / Vermelho)
  const [showAddContactModal, setShowAddContactModal] = useState<boolean>(false);
  const [addModalTab, setAddModalTab] = useState<'contact' | 'global_profile'>('contact');
  const [targetUserToAdd, setTargetUserToAdd] = useState<UserProfile | null>(null);
  const [contactForm, setContactForm] = useState<ContactFormState>({
    search: '',
    customName: '',
    address: '',
    phone: ''
  });
  const [isSavingContact, setIsSavingContact] = useState<boolean>(false);

  const [contactFaceStatuses, setContactFaceStatuses] = useState<Record<string, ContactFaceStatus>>({});
  const [deletedContactIds, setDeletedContactIds] = useState<string[]>([]);
  const [blockedByUserIds, setBlockedByUserIds] = useState<string[]>([]);
  const [openContactMenuId, setOpenContactMenuId] = useState<string | null>(null);

  const contactFaceStatusesRef = useRef<Record<string, ContactFaceStatus>>({});
  const deletedContactIdsRef = useRef<string[]>([]);
  const blockedByUserIdsRef = useRef<string[]>([]);

  // Estados de Foto de Perfil e Páginas Globais (Pública/Privada, Solicitações, +18, Bio Link)
  const [myAvatarUrl, setMyAvatarUrl] = useState<string | null>(null);
  const [isUpdatingAvatar, setIsUpdatingAvatar] = useState<boolean>(false);
  const avatarFileInputRef = useRef<HTMLInputElement>(null);

  const [globalPageConfigs, setGlobalPageConfigs] = useState<Record<string, GlobalPageConfig>>({});
  const globalPageConfigsRef = useRef<Record<string, GlobalPageConfig>>({});
  const hasAutoPublishedMyPageRef = useRef<boolean>(false);

  const [globalPageForm, setGlobalPageForm] = useState<GlobalPageFormState>({
    title: '',
    description: '',
    avatar_url: null,
    visibility: 'public',
    handle: '',
    hashtags: '',
    bio_link: '',
    is_adult: false
  });
  const [isSavingGlobalPage, setIsSavingGlobalPage] = useState<boolean>(false);
  const globalPageAvatarInputRef = useRef<HTMLInputElement>(null);

  const [verifiedAdultPageIds, setVerifiedAdultPageIds] = useState<string[]>([]);
  const [pendingAdultTarget, setPendingAdultTarget] = useState<any | null>(null);
  const [pendingPrivatePageTarget, setPendingPrivatePageTarget] = useState<any | null>(null);

  const [globalDisplayLimit, setGlobalDisplayLimit] = useState<number>(10);
  const [newMessage, setNewMessage] = useState<string>('');
  const [newGroupMessage, setNewGroupMessage] = useState<string>('');

  const [selectedGalleryItem, setSelectedGalleryItem] = useState<ChatMessage | null>(null);
  const [showGroupTrashMenu, setShowGroupTrashMenu] = useState<boolean>(false);
  const [showClearTotalPopup, setShowClearTotalPopup] = useState<boolean>(false);
  const [showGalleryTrashMenu, setShowGalleryTrashMenu] = useState<boolean>(false);

  const [selectedMessage, setSelectedMessage] = useState<ChatMessage | null>(null);
  const [showHeaderTrashMenu, setShowHeaderTrashMenu] = useState<boolean>(false);

  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isFileVideo, setIsFileVideo] = useState<boolean>(false);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [downloadProgressMap, setDownloadProgressMap] = useState<Record<string, number>>({});
  const [customPassword, setCustomPassword] = useState<string>('');
  const [unlockedImages, setUnlockedImages] = useState<string[]>([]);
  const [unlockingMsgId, setUnlockingMsgId] = useState<string | null>(null);
  const [p2pMediaUrls, setP2pMediaUrls] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [autoDownload, setAutoDownload] = useState<boolean>(true);
  const [callCameraFacing, setCallCameraFacing] = useState<'user' | 'environment'>('user');

  const selectedMediaBlobRef = useRef<Blob | null>(null);
  const selectedMediaNameRef = useRef<string>('');
  const hydratedIdsRef = useRef<Set<string>>(new Set());
  const inFlightHydrationRef = useRef<Set<string>>(new Set());
  const purgedIdsRef = useRef<Set<string>>(new Set());
  const p2pMediaUrlsRef = useRef<Record<string, string>>({});
  const isPressingMicRef = useRef<boolean>(false);
  const activeChatContactIdRef = useRef<string | null>(null);

  const [isRecordingAudio, setIsRecordingAudio] = useState<boolean>(false);
  const [audioTime, setAudioTime] = useState<number>(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { saveToVault, getFromVault, deleteFromVault } = useLocalVault();

  useEffect(() => {
    p2pMediaUrlsRef.current = p2pMediaUrls;
  }, [p2pMediaUrls]);

  useEffect(() => {
    contactFaceStatusesRef.current = contactFaceStatuses;
  }, [contactFaceStatuses]);

  useEffect(() => {
    deletedContactIdsRef.current = deletedContactIds;
  }, [deletedContactIds]);

  useEffect(() => {
    blockedByUserIdsRef.current = blockedByUserIds;
  }, [blockedByUserIds]);

  useEffect(() => {
    globalPageConfigsRef.current = globalPageConfigs;
  }, [globalPageConfigs]);

  // Se o utilizador aberto na conversa bloquear o utilizador atual, fecha o painel em tempo real
  useEffect(() => {
    if (selectedContact?.id && blockedByUserIds.includes(String(selectedContact.id))) {
      setSelectedContact(null);
      setMessages([]);
    }
  }, [blockedByUserIds, selectedContact?.id, setSelectedContact, setMessages]);

  // Carrega configurações salvas das Páginas Globais e confirmações +18 locais
  useEffect(() => {
    try {
      const rawPages = localStorage.getItem(GLOBAL_PAGES_STORAGE_KEY);
      if (rawPages) {
        const parsed = JSON.parse(rawPages);
        globalPageConfigsRef.current = parsed;
        setGlobalPageConfigs(parsed);
      }
      const rawAdultOk = sessionStorage.getItem('chatchat_verified_adult_pages');
      if (rawAdultOk) {
        setVerifiedAdultPageIds(JSON.parse(rawAdultOk));
      }
    } catch {}
  }, []);

  // Extrai configurações de Páginas Globais diretamente de globalProfiles assim que carregam
  useEffect(() => {
    if (!globalProfiles || globalProfiles.length === 0) return;
    setGlobalPageConfigs((prev: Record<string, GlobalPageConfig>) => {
      let changed = false;
      const next = { ...prev };
      for (const prof of globalProfiles) {
        const decoded = decodeGlobalPageFromProfileRow(prof);
        if (decoded) {
          const uid = String(decoded.userId);
          const existing = next[uid];
          // Preserva solicitações pendentes locais que ainda não tenham sido processadas
          const mergedPending = existing?.pendingRequests?.length
            ? existing.pendingRequests.filter(
                (req: GlobalPageAccessRequest) =>
                  !(decoded.approvedUserIds || []).includes(String(req.requesterId)) &&
                  !(decoded.rejectedUserIds || []).includes(String(req.requesterId))
              )
            : decoded.pendingRequests || [];
          const mergedCfg: GlobalPageConfig = {
            ...decoded,
            avatar_url: decoded.avatar_url || prof.avatar_url || existing?.avatar_url || null,
            pendingRequests: mergedPending.length > 0 ? mergedPending : (decoded.pendingRequests || [])
          };
          if (!existing || JSON.stringify(existing) !== JSON.stringify(mergedCfg)) {
            next[uid] = mergedCfg;
            changed = true;
          }
        }
      }
      if (!changed) return prev;
      globalPageConfigsRef.current = next;
      try {
        localStorage.setItem(GLOBAL_PAGES_STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, [globalProfiles]);

  // Carrega estados salvos da carinha, contactos excluídos e bloqueios recebidos
  useEffect(() => {
    if (!currentUser?.id) return;
    const faceKey = getContactFaceStatusStorageKey(currentUser.id);
    const delKey = getDeletedContactsStorageKey(currentUser.id);
    const blockedByKey = getBlockedByOthersStorageKey(currentUser.id);
    try {
      const savedFace = localStorage.getItem(faceKey) || localStorage.getItem('chatchat_contact_face_status');
      if (savedFace) {
        const parsedFace = JSON.parse(savedFace);
        contactFaceStatusesRef.current = parsedFace;
        setContactFaceStatuses(parsedFace);
      }
      const savedDeleted = localStorage.getItem(delKey) || localStorage.getItem('chatchat_deleted_contacts');
      if (savedDeleted) {
        const parsedDel = JSON.parse(savedDeleted);
        deletedContactIdsRef.current = parsedDel;
        setDeletedContactIds(parsedDel);
      }
      const savedBlockedBy = localStorage.getItem(blockedByKey);
      if (savedBlockedBy) {
        const parsedBlockedBy = JSON.parse(savedBlockedBy);
        blockedByUserIdsRef.current = parsedBlockedBy;
        setBlockedByUserIds(parsedBlockedBy);
      }
    } catch {}
  }, [currentUser?.id]);

  // Fecha o menu da carinha ao clicar fora
  useEffect(() => {
    if (!openContactMenuId) return;
    const closeMenu = () => setOpenContactMenuId(null);
    window.addEventListener('click', closeMenu);
    return () => window.removeEventListener('click', closeMenu);
  }, [openContactMenuId]);

  // Carrega a foto de perfil do utilizador atual e sincroniza automaticamente a Página Global local com a tabela profiles
  useEffect(() => {
    if (!currentUser?.id) return;
    const myId = String(currentUser.id);
    const avatarKey = getMyAvatarStorageKey(myId);

    try {
      const cachedAvatar = localStorage.getItem(avatarKey);
      if (cachedAvatar) setMyAvatarUrl(cachedAvatar);
      else if (currentUser.avatar_url) setMyAvatarUrl(currentUser.avatar_url);
    } catch {}

    const fetchMyLatestAvatarAndSyncPage = async () => {
      try {
        const { data } = await supabase
          .from('profiles')
          .select('id, username, avatar_url, status')
          .eq('id', myId)
          .maybeSingle();

        if (data?.avatar_url) {
          setMyAvatarUrl(data.avatar_url);
          try {
            localStorage.setItem(avatarKey, data.avatar_url);
          } catch {}
        }

        const remotePageCfg = decodeGlobalPageFromProfileRow(data);
        const localPageCfg = globalPageConfigsRef.current[myId];

        if (remotePageCfg) {
          setGlobalPageConfigs((prev: Record<string, GlobalPageConfig>) => {
            const next = { ...prev, [myId]: remotePageCfg };
            globalPageConfigsRef.current = next;
            try {
              localStorage.setItem(GLOBAL_PAGES_STORAGE_KEY, JSON.stringify(next));
            } catch {}
            return next;
          });
        } else if (localPageCfg && !hasAutoPublishedMyPageRef.current) {
          // Se o utilizador já configurou a página localmente (como na Imagem 1), publica na tabela profiles automaticamente
          hasAutoPublishedMyPageRef.current = true;
          const encodedStatus = encodeStatusWithGlobalPage(data?.status, localPageCfg);
          await supabase
            .from('profiles')
            .update({
              status: encodedStatus,
              updated_at: new Date().toISOString()
            })
            .eq('id', myId);
        }
      } catch {}
    };
    fetchMyLatestAvatarAndSyncPage();
  }, [currentUser?.id, currentUser?.avatar_url]);

  // Propaga novas fotos de perfil de globalProfiles para os contactos salvos
  useEffect(() => {
    if (!globalProfiles || globalProfiles.length === 0 || !currentUser?.id) return;
    const profileAvatarMap = new Map<string, string | null>();
    globalProfiles.forEach((p: UserProfile) => {
      if (p?.id && p.avatar_url) {
        profileAvatarMap.set(String(p.id), p.avatar_url);
      }
    });
    if (profileAvatarMap.size === 0) return;

    setMySavedContacts((prev: SavedContact[]) => {
      let changed = false;
      const next = prev.map((c: SavedContact) => {
        const latestAvatar = profileAvatarMap.get(String(c.id));
        if (latestAvatar && latestAvatar !== c.avatar_url) {
          changed = true;
          return { ...c, avatar_url: latestAvatar };
        }
        return c;
      });
      if (!changed) return prev;
      try {
        localStorage.setItem(getContactsStorageKey(currentUser.id), JSON.stringify(next));
        localStorage.setItem('my_saved_contacts', JSON.stringify(next));
      } catch {}
      return next;
    });
  }, [globalProfiles, currentUser?.id, setMySavedContacts]);

  // Isolamento e desduplicação automática da lista de contactos por utilizador
  useEffect(() => {
    if (!currentUser?.id) return;
    const userStorageKey = getContactsStorageKey(currentUser.id);
    const delKey = getDeletedContactsStorageKey(currentUser.id);

    try {
      const savedDeletedRaw = localStorage.getItem(delKey) || localStorage.getItem('chatchat_deleted_contacts');
      const deletedSet = new Set<string>(savedDeletedRaw ? JSON.parse(savedDeletedRaw) : []);

      const rawUserContacts = localStorage.getItem(userStorageKey);
      const rawLegacyContacts = localStorage.getItem('my_saved_contacts');
      const parsedUser: SavedContact[] = rawUserContacts ? JSON.parse(rawUserContacts) : [];
      const parsedLegacy: SavedContact[] = !rawUserContacts && rawLegacyContacts ? JSON.parse(rawLegacyContacts) : [];

      setMySavedContacts((prev: SavedContact[]) => {
        const combined = [...parsedUser, ...parsedLegacy, ...prev].filter(
          (c: SavedContact) => c && c.id && !deletedSet.has(String(c.id))
        );
        const deduplicated = deduplicateContactsList(combined, currentUser.id);
        localStorage.setItem(userStorageKey, JSON.stringify(deduplicated));
        localStorage.setItem('my_saved_contacts', JSON.stringify(deduplicated));
        return deduplicated;
      });
    } catch (err) {
      console.warn('Erro ao inicializar lista de contactos do utilizador:', err);
    }
  }, [currentUser?.id, setMySavedContacts]);

  useEffect(() => {
    if (!cleanRoomContacts || cleanRoomContacts.length === 0) return;
    const userStorageKey = getContactsStorageKey(currentUser?.id);

    setMySavedContacts((prev: SavedContact[]) => {
      const deletedSet = new Set(deletedContactIdsRef.current);
      const map = new Map(
        prev
          .filter((c: SavedContact) => !deletedSet.has(String(c.id)))
          .map((c: SavedContact) => [String(c.id), c])
      );

      cleanRoomContacts.forEach((item: any) => {
        const cid = String(item.contactId);
        if (deletedSet.has(cid)) {
          map.delete(cid);
          return;
        }
        const existing = map.get(cid);
        const profileEmail = (item.profile as any)?.email || existing?.email;

        map.set(cid, {
          id: cid,
          username: item.profile.username || item.profile.displayName || existing?.username || 'Desconhecido',
          email: profileEmail,
          avatar_url: item.profile.avatarUrl ?? existing?.avatar_url ?? null,
          status: extractCleanPresenceStatus(existing?.status || 'Online'),
          savedName: resolveDisplayName(item) || existing?.savedName || 'Desconhecido',
          address: existing?.address || '',
          phone: existing?.phone || '',
          addedAt: item.updatedAt || existing?.addedAt || new Date().toISOString()
        });
      });

      const merged = deduplicateContactsList(Array.from(map.values()), currentUser?.id);
      try {
        localStorage.setItem(userStorageKey, JSON.stringify(merged));
        localStorage.setItem('my_saved_contacts', JSON.stringify(merged));
      } catch {}
      return merged;
    });
  }, [cleanRoomContacts, currentUser?.id, setMySavedContacts]);

  const handleAvatarUploadChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentUser?.id) return;

    setIsUpdatingAvatar(true);
    try {
      const { blob, dataUrl } = await generateCompressedAvatarDataUrl(file, 256);
      let finalAvatarUrl = dataUrl;

      const fixedPath = `avatars/avatar_${currentUser.id}.jpg`;
      try {
        const { error: upErr } = await supabase.storage
          .from('avatars')
          .upload(fixedPath, blob, { contentType: 'image/jpeg', upsert: true });

        if (!upErr) {
          const { data: pubData } = supabase.storage.from('avatars').getPublicUrl(fixedPath);
          if (pubData?.publicUrl) {
            finalAvatarUrl = `${pubData.publicUrl}?t=${Date.now()}`;
          }
        }
      } catch {}

      const { error: dbErr } = await supabase
        .from('profiles')
        .update({ avatar_url: finalAvatarUrl, updated_at: new Date().toISOString() })
        .eq('id', currentUser.id);

      if (dbErr) throw dbErr;

      setMyAvatarUrl(finalAvatarUrl);
      try {
        localStorage.setItem(getMyAvatarStorageKey(currentUser.id), finalAvatarUrl);
      } catch {}
    } catch (err: any) {
      alert(`Não foi possível atualizar a foto de perfil: ${err?.message || 'Tente outra imagem.'}`);
    } finally {
      setIsUpdatingAvatar(false);
      if (avatarFileInputRef.current) avatarFileInputRef.current.value = '';
    }
  };

  const handleGlobalPageAvatarPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { dataUrl } = await generateCompressedAvatarDataUrl(file, 256);
      setGlobalPageForm((prev: GlobalPageFormState) => ({ ...prev, avatar_url: dataUrl }));
    } catch (err: any) {
      alert(`Erro ao carregar imagem da Página Global: ${err?.message || 'Tente outra imagem.'}`);
    } finally {
      if (globalPageAvatarInputRef.current) globalPageAvatarInputRef.current.value = '';
    }
  };

  const populateGlobalPageFormForCurrentUser = useCallback(() => {
    if (!currentUser?.id) return;
    const myId = String(currentUser.id);
    const existing = globalPageConfigsRef.current[myId];
    setGlobalPageForm({
      title: existing?.title || currentUser.username || '',
      description: existing?.description || '',
      avatar_url: existing?.avatar_url || myAvatarUrl || currentUser.avatar_url || null,
      visibility: existing?.visibility || 'public',
      handle: existing?.handle || formatPageHandle(currentUser.username || ''),
      hashtags: existing?.hashtags || '',
      bio_link: existing?.bio_link || '',
      is_adult: Boolean(existing?.is_adult)
    });
  }, [currentUser?.id, currentUser?.username, currentUser?.avatar_url, myAvatarUrl]);

  const handleOpenGlobalPageEditor = useCallback(() => {
    setTargetUserToAdd(null);
    populateGlobalPageFormForCurrentUser();
    setAddModalTab('global_profile');
    setShowAddContactModal(true);
  }, [populateGlobalPageFormForCurrentUser]);

  // Publica a configuração da Página Global na tabela pública profiles (status codificado) e notifica em private_messages
  const publishGlobalPageConfigToSupabase = useCallback(async (myId: string, configToPublish: GlobalPageConfig) => {
    try {
      const encodedStatus = encodeStatusWithGlobalPage(currentUser?.status, configToPublish);
      await supabase
        .from('profiles')
        .update({
          username: configToPublish.title,
          ...(configToPublish.avatar_url ? { avatar_url: configToPublish.avatar_url } : {}),
          status: encodedStatus,
          updated_at: new Date().toISOString()
        })
        .eq('id', myId);
    } catch {}

    try {
      const { data: oldSignals } = await supabase
        .from('private_messages')
        .select('id, image_metadata')
        .eq('sender_id', myId)
        .eq('receiver_id', myId)
        .not('image_metadata', 'is', null);

      if (oldSignals && oldSignals.length > 0) {
        const oldIds = oldSignals
          .filter((r: any) => r.image_metadata?.is_global_page_config === true)
          .map((r: any) => r.id);
        if (oldIds.length > 0) {
          await supabase.from('private_messages').delete().in('id', oldIds);
        }
      }

      await supabase.from('private_messages').insert([
        {
          sender_id: myId,
          receiver_id: myId,
          content: '',
          image_metadata: {
            is_deleted: true,
            is_global_page_config: true,
            page_config: configToPublish
          } as any
        }
      ]);
    } catch {}
  }, [currentUser?.status]);

  const handleSaveGlobalPage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser?.id) return;

    const cleanTitle = globalPageForm.title.trim();
    if (!cleanTitle) {
      alert('Por favor, informe o Título / Nome da sua Página Global.');
      return;
    }

    setIsSavingGlobalPage(true);
    const myId = String(currentUser.id);

    try {
      const existing = globalPageConfigsRef.current[myId];
      const formattedHandle = formatPageHandle(globalPageForm.handle || cleanTitle);
      const formattedHashtags = formatPageHashtags(globalPageForm.hashtags);
      const cleanBioLink = globalPageForm.bio_link.trim();
      const chosenAvatar = globalPageForm.avatar_url || myAvatarUrl || currentUser.avatar_url || null;

      const newPageConfig: GlobalPageConfig = {
        userId: myId,
        title: cleanTitle,
        description: globalPageForm.description.trim(),
        avatar_url: chosenAvatar,
        visibility: globalPageForm.visibility,
        handle: formattedHandle,
        hashtags: formattedHashtags,
        bio_link: cleanBioLink,
        is_adult: Boolean(globalPageForm.is_adult),
        approvedUserIds: existing?.approvedUserIds || [],
        pendingRequests: existing?.pendingRequests || [],
        rejectedUserIds: existing?.rejectedUserIds || [],
        updated_at: new Date().toISOString()
      };

      setGlobalPageConfigs((prev: Record<string, GlobalPageConfig>) => {
        const updated = { ...prev, [myId]: newPageConfig };
        globalPageConfigsRef.current = updated;
        try {
          localStorage.setItem(GLOBAL_PAGES_STORAGE_KEY, JSON.stringify(updated));
        } catch {}
        return updated;
      });

      if (chosenAvatar) {
        setMyAvatarUrl(chosenAvatar);
        try {
          localStorage.setItem(getMyAvatarStorageKey(myId), chosenAvatar);
        } catch {}
      }

      await publishGlobalPageConfigToSupabase(myId, newPageConfig);

      if (selectedContact && String(selectedContact.id) === myId) {
        setSelectedContact((prev: any) =>
          prev ? { ...prev, username: cleanTitle, avatar_url: chosenAvatar } : prev
        );
      }

      setShowAddContactModal(false);
      setActiveTab('global');
    } catch (err: any) {
      alert(`Erro ao guardar Perfil Global: ${err?.message || 'Tente novamente.'}`);
    } finally {
      setIsSavingGlobalPage(false);
    }
  };

  // Envia solicitação de acesso a uma Página Global Privada
  const handleRequestPrivatePageAccess = useCallback(async (targetProfile: any) => {
    if (!currentUser?.id || !targetProfile?.id) return;
    const myId = String(currentUser.id);
    const targetId = String(targetProfile.id);

    const requestObj: GlobalPageAccessRequest = {
      requesterId: myId,
      requesterName: currentUser.username || 'Utilizador',
      requesterAvatar: myAvatarUrl || currentUser.avatar_url || null,
      requestedAt: new Date().toISOString()
    };

    setGlobalPageConfigs((prev: Record<string, GlobalPageConfig>) => {
      const existing: GlobalPageConfig = prev[targetId] || {
        userId: targetId,
        title: targetProfile.username || 'Página Privada',
        description: '',
        avatar_url: targetProfile.avatar_url || null,
        visibility: 'private',
        handle: `@${targetProfile.username || 'pagina'}`,
        hashtags: '',
        bio_link: '',
        is_adult: false,
        approvedUserIds: [],
        pendingRequests: [],
        rejectedUserIds: [],
        updated_at: new Date().toISOString()
      };

      const currentPending = existing.pendingRequests || [];
      if (currentPending.some((r: GlobalPageAccessRequest) => String(r.requesterId) === myId)) {
        return prev;
      }

      const updatedCfg: GlobalPageConfig = {
        ...existing,
        pendingRequests: [...currentPending, requestObj],
        rejectedUserIds: (existing.rejectedUserIds || []).filter((id: string) => String(id) !== myId)
      };

      const next = { ...prev, [targetId]: updatedCfg };
      globalPageConfigsRef.current = next;
      try {
        localStorage.setItem(GLOBAL_PAGES_STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });

    try {
      await supabase.from('private_messages').insert([
        {
          sender_id: myId,
          receiver_id: targetId,
          content: '',
          image_metadata: {
            is_deleted: true,
            is_global_page_access_request: true,
            target_page_id: targetId,
            request_data: requestObj
          } as any
        }
      ]);
    } catch {}

    setPendingPrivatePageTarget(null);
    alert('Solicitação enviada! Assim que o dono da página escolher Aceito, você poderá ver o conteúdo da página.');
  }, [currentUser, myAvatarUrl]);

  // Dono da Página Global Privada responde à solicitação: Aceito (true) ou Não aceito (false)
  const handleRespondPrivatePageRequest = useCallback(async (requesterId: string, accept: boolean) => {
    if (!currentUser?.id) return;
    const myId = String(currentUser.id);
    const reqId = String(requesterId);

    const existing: GlobalPageConfig = globalPageConfigsRef.current[myId] || {
      userId: myId,
      title: currentUser.username || 'Minha Página',
      description: '',
      avatar_url: myAvatarUrl || currentUser.avatar_url || null,
      visibility: 'private',
      handle: formatPageHandle(currentUser.username || 'pagina'),
      hashtags: '',
      bio_link: '',
      is_adult: false,
      approvedUserIds: [],
      pendingRequests: [],
      rejectedUserIds: [],
      updated_at: new Date().toISOString()
    };

    const updatedPending = (existing.pendingRequests || []).filter(
      (r: GlobalPageAccessRequest) => String(r.requesterId) !== reqId
    );
    const currentApproved = new Set((existing.approvedUserIds || []).map(String));
    const currentRejected = new Set((existing.rejectedUserIds || []).map(String));

    if (accept) {
      currentApproved.add(reqId);
      currentRejected.delete(reqId);
    } else {
      currentRejected.add(reqId);
      currentApproved.delete(reqId);
    }

    const updatedConfig: GlobalPageConfig = {
      ...existing,
      pendingRequests: updatedPending,
      approvedUserIds: Array.from(currentApproved),
      rejectedUserIds: Array.from(currentRejected),
      updated_at: new Date().toISOString()
    };

    setGlobalPageConfigs((prev: Record<string, GlobalPageConfig>) => {
      const next = { ...prev, [myId]: updatedConfig };
      globalPageConfigsRef.current = next;
      try {
        localStorage.setItem(GLOBAL_PAGES_STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });

    // Remove o sinal de pedido pendente no banco de dados
    try {
      const { data: reqSignals } = await supabase
        .from('private_messages')
        .select('id, image_metadata')
        .eq('sender_id', reqId)
        .eq('receiver_id', myId)
        .not('image_metadata', 'is', null);

      if (reqSignals && reqSignals.length > 0) {
        const signalIds = reqSignals
          .filter((r: any) => r.image_metadata?.is_global_page_access_request === true)
          .map((r: any) => r.id);
        if (signalIds.length > 0) {
          await supabase.from('private_messages').delete().in('id', signalIds);
        }
      }
    } catch {}

    // Envia confirmação direta para a conta que solicitou (passa pelo RLS porque receiver_id = reqId)
    try {
      await supabase.from('private_messages').insert([
        {
          sender_id: myId,
          receiver_id: reqId,
          content: '',
          image_metadata: {
            is_deleted: true,
            is_global_page_config: true,
            page_config: updatedConfig
          } as any
        }
      ]);

      // Se foi Aceito, partilha também as postagens globais existentes da página para que a outra conta as veja
      if (accept) {
        const { data: myGlobalPosts } = await supabase
          .from('private_messages')
          .select('*')
          .eq('sender_id', myId)
          .eq('receiver_id', myId)
          .not('image_metadata', 'is', null);

        if (myGlobalPosts && myGlobalPosts.length > 0) {
          const postsToShare = myGlobalPosts
            .filter((row: any) => Boolean(row.image_metadata?.is_global_post) === true)
            .map((row: any) => ({
              sender_id: myId,
              receiver_id: reqId,
              content: row.content || '',
              image_metadata: {
                ...row.image_metadata,
                is_global_post: true,
                global_page_owner_id: myId,
                global_post_id: row.image_metadata?.global_post_id || String(row.id)
              }
            }));

          if (postsToShare.length > 0) {
            await supabase.from('private_messages').insert(postsToShare);
          }
        }
      }
    } catch {}

    await publishGlobalPageConfigToSupabase(myId, updatedConfig);
  }, [currentUser, myAvatarUrl, publishGlobalPageConfigToSupabase]);

  const syncBlockSignalToDatabase = useCallback(async (targetContactId: string, isBlocking: boolean) => {
    if (!currentUser?.id || String(targetContactId).startsWith('offline-')) return;
    const myId = String(currentUser.id);
    const targetId = String(targetContactId);

    try {
      await supabase
        .from('user_contacts')
        .update({ is_blocked: isBlocking })
        .eq('owner_id', myId)
        .eq('contact_id', targetId);
    } catch {}

    try {
      const { data: existingSignals } = await supabase
        .from('private_messages')
        .select('id, image_metadata')
        .eq('sender_id', myId)
        .eq('receiver_id', targetId)
        .not('image_metadata', 'is', null);

      if (existingSignals && existingSignals.length > 0) {
        const signalIdsToDelete = existingSignals
          .filter((row: any) => row.image_metadata?.is_block_signal === true)
          .map((row: any) => row.id);

        if (signalIdsToDelete.length > 0) {
          await supabase
            .from('private_messages')
            .delete()
            .in('id', signalIdsToDelete);
        }
      }

      await supabase
        .from('private_messages')
        .insert([{
          sender_id: myId,
          receiver_id: targetId,
          content: '',
          image_metadata: {
            is_deleted: true,
            is_block_signal: true,
            block_action: isBlocking ? 'blocked' : 'unblocked'
          } as any
        }]);
    } catch (err) {
      console.warn('Aviso ao sincronizar sinal de bloqueio:', err);
    }
  }, [currentUser?.id]);

  const handleToggleContactFaceStatus = useCallback((contactId: string, targetStatus: ContactFaceStatus) => {
    const idStr = String(contactId);
    const currentStatus = contactFaceStatusesRef.current[idStr] || 'normal';
    const nextStatus: ContactFaceStatus = currentStatus === targetStatus ? 'normal' : targetStatus;

    setContactFaceStatuses((prev: Record<string, ContactFaceStatus>) => {
      const updated = { ...prev, [idStr]: nextStatus };
      contactFaceStatusesRef.current = updated;
      try {
        localStorage.setItem(getContactFaceStatusStorageKey(currentUser?.id), JSON.stringify(updated));
        localStorage.setItem('chatchat_contact_face_status', JSON.stringify(updated));
      } catch {}
      return updated;
    });

    if (nextStatus === 'blocked') {
      syncBlockSignalToDatabase(idStr, true);
    } else if (currentStatus === 'blocked') {
      syncBlockSignalToDatabase(idStr, false);
    }

    setOpenContactMenuId(null);
  }, [currentUser?.id, syncBlockSignalToDatabase]);

  const handleExcludeContactFromList = useCallback(async (contact: SavedContact) => {
    const idStr = String(contact.id);
    setOpenContactMenuId(null);

    const nextDeleted = Array.from(new Set([...deletedContactIdsRef.current, idStr]));
    deletedContactIdsRef.current = nextDeleted;
    setDeletedContactIds(nextDeleted);
    try {
      localStorage.setItem(getDeletedContactsStorageKey(currentUser?.id), JSON.stringify(nextDeleted));
      localStorage.setItem('chatchat_deleted_contacts', JSON.stringify(nextDeleted));
    } catch {}

    const userStorageKey = getContactsStorageKey(currentUser?.id);
    setMySavedContacts((prev: SavedContact[]) => {
      const updated = prev.filter((c: SavedContact) => String(c.id) !== idStr);
      try {
        localStorage.setItem(userStorageKey, JSON.stringify(updated));
        localStorage.setItem('my_saved_contacts', JSON.stringify(updated));
      } catch {}
      return updated;
    });

    if (selectedContact && String(selectedContact.id) === idStr) {
      setSelectedContact(null);
    }

    if (currentUser?.id && !idStr.startsWith('offline-')) {
      try {
        await supabase
          .from('user_contacts')
          .delete()
          .eq('owner_id', currentUser.id)
          .eq('contact_id', idStr);
      } catch {}
    }
  }, [currentUser?.id, selectedContact, setMySavedContacts, setSelectedContact]);

  const handleOpenAddContact = useCallback((user: UserProfile) => {
    if (blockedByUserIdsRef.current.includes(String(user.id))) return;
    setTargetUserToAdd(user);
    setAddModalTab('contact');
    setContactForm({ search: '', customName: user.username, address: '', phone: '' });
    setShowAddContactModal(true);
  }, []);

  const handleOpenGenericAddContact = useCallback(() => {
    setTargetUserToAdd(null);
    setAddModalTab('contact');
    setContactForm({ search: '', customName: '', address: '', phone: '' });
    populateGlobalPageFormForCurrentUser();
    setShowAddContactModal(true);
  }, [populateGlobalPageFormForCurrentUser]);

  const handleSearchUser = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setContactForm((prev: ContactFormState) => ({ ...prev, search: val }));

    if (isPhoneTypedInSearchBar(val)) return;

    const cleanSearch = val.includes('@')
      ? val.replace(/\s+/g, '').toLowerCase()
      : val.trim().toLowerCase();
    if (!cleanSearch) return;

    const match = globalProfiles.find(
      (p: UserProfile) =>
        !blockedByUserIdsRef.current.includes(String(p.id)) &&
        (p.username?.toLowerCase() === cleanSearch ||
          p.email?.replace(/\s+/g, '').toLowerCase() === cleanSearch)
    );
    if (match) {
      setContactForm((prev: ContactFormState) => ({ ...prev, customName: prev.customName || match.username }));
    }
  }, [globalProfiles]);

  const handlePhoneInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const rawVal = e.target.value;
    const sanitizedPhone = rawVal.replace(/[^0-9+()\-\s]/g, '');
    setContactForm((prev: ContactFormState) => ({ ...prev, phone: sanitizedPhone }));
  }, []);

  const handleSaveContact = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingContact(true);

    try {
      const rawSearch = contactForm.search.trim();
      const rawPhone = contactForm.phone.trim();

      if (!targetUserToAdd && !rawSearch && !rawPhone) {
        alert('Por favor, preencha o campo "@Utilizador ou Email" ou o campo "Telefone" para adicionar o contacto.');
        return;
      }

      if (rawSearch && isPhoneTypedInSearchBar(rawSearch)) {
        alert(
          'Erro: Inseriu um número de telefone na barra de "@Utilizador ou Email". Por favor, coloque o número apenas no campo "Telefone".'
        );
        return;
      }

      if (rawPhone && (rawPhone.includes('@') || /[a-zA-Z]/.test(rawPhone))) {
        alert(
          'Erro: Inseriu um e-mail ou letras na barra de "Telefone". O campo Telefone aceita apenas números!'
        );
        return;
      }

      const inputPhoneKey = normalizePhoneKey(rawPhone);
      if (rawPhone && (inputPhoneKey.length < 8 || inputPhoneKey.length > 15)) {
        alert(
          'Erro: Digite um número de telefone válido com DDD (mínimo de 8 dígitos numéricos, ex: 67 98456-9676).'
        );
        return;
      }

      const isEmailAttempt = rawSearch.includes('@') && !rawSearch.startsWith('@');
      const inputEmailKey = normalizeEmailKey(rawSearch);
      if (isEmailAttempt && !inputEmailKey) {
        alert('Erro: Digite um endereço de e-mail válido (ex: usuario@gmail.com).');
        return;
      }

      const normalizedSearch = isEmailAttempt
        ? inputEmailKey
        : rawSearch.toLowerCase();
      const searchWithoutAt = normalizedSearch.startsWith('@')
        ? normalizedSearch.slice(1).trim()
        : normalizedSearch.trim();

      if (rawSearch && !isEmailAttempt && searchWithoutAt.length < 2) {
        alert('Erro: Digite um @Utilizador ou endereço de e-mail válido.');
        return;
      }

      let baseUser: any = targetUserToAdd;

      if (!baseUser && normalizedSearch) {
        baseUser = globalProfiles.find((p: UserProfile) => {
          const pUser = p.username?.trim().toLowerCase();
          const pEmail = p.email?.replace(/\s+/g, '').toLowerCase();
          return (
            pUser === normalizedSearch ||
            pUser === searchWithoutAt ||
            (pEmail && pEmail === normalizedSearch)
          );
        });
      }

      if (!baseUser && normalizedSearch) {
        try {
          if (inputEmailKey) {
            const { data: emailMatch } = await supabase
              .from('profiles')
              .select('id, username, email, avatar_url, status')
              .ilike('email', inputEmailKey)
              .maybeSingle();
            if (emailMatch) baseUser = emailMatch;
          }
          if (!baseUser && searchWithoutAt) {
            const { data: userMatch } = await supabase
              .from('profiles')
              .select('id, username, email, avatar_url, status')
              .ilike('username', searchWithoutAt)
              .maybeSingle();
            if (userMatch) baseUser = userMatch;
          }
        } catch {}
      }

      if (!baseUser && rawPhone) {
        try {
          const foundByPhone = await discoverContactByPhone(rawPhone);
          if (foundByPhone) {
            baseUser = foundByPhone;
          }
        } catch (err) {
          console.warn('Pesquisa por telefone SHA-256 indisponível:', err);
        }
      }

      const resolvedUserId = baseUser?.id || baseUser?.contactId
        ? String(baseUser.id || baseUser.contactId)
        : null;

      if (resolvedUserId && blockedByUserIdsRef.current.includes(resolvedUserId)) {
        alert('Perfil não encontrado ou indisponível.');
        return;
      }

      if (currentUser?.id && resolvedUserId === String(currentUser.id)) {
        alert('Não pode adicionar o seu próprio perfil à lista de contactos.');
        return;
      }

      const resolvedUsername = String(
        baseUser?.username ||
        baseUser?.profile?.username ||
        baseUser?.display_name ||
        baseUser?.profile?.displayName ||
        (!isEmailAttempt && searchWithoutAt ? searchWithoutAt : '') ||
        contactForm.customName.trim() ||
        'Desconhecido'
      );

      const resolvedEmail =
        normalizeEmailKey(baseUser?.email || baseUser?.profile?.email) ||
        inputEmailKey ||
        undefined;

      const isRealUser = Boolean(resolvedUserId && !resolvedUserId.startsWith('offline-'));

      const activeContactsList = mySavedContacts.filter(
        (c: SavedContact) => !deletedContactIdsRef.current.includes(String(c.id))
      );

      const duplicateContact = activeContactsList.find((c: SavedContact) => {
        const existingId = String(c.id);
        const existingPhoneKey =
          normalizePhoneKey(c.phone) ||
          (isPhoneTypedInSearchBar(c.username) ? normalizePhoneKey(c.username) : '');
        const existingEmailKey =
          normalizeEmailKey(c.email) ||
          normalizeEmailKey(c.username) ||
          normalizeEmailKey(c.phone);
        const existingUsername = c.username?.trim().toLowerCase();

        if (isRealUser && existingId === resolvedUserId) return true;
        if (inputPhoneKey.length >= 8 && existingPhoneKey.length >= 8 && existingPhoneKey === inputPhoneKey) {
          return true;
        }
        if (resolvedEmail && existingEmailKey && existingEmailKey === resolvedEmail) {
          return true;
        }
        if (
          !isEmailAttempt &&
          searchWithoutAt &&
          existingUsername &&
          existingUsername === searchWithoutAt
        ) {
          return true;
        }
        if (
          isRealUser &&
          !existingId.startsWith('offline-') &&
          existingUsername &&
          existingUsername === resolvedUsername.toLowerCase()
        ) {
          return true;
        }
        return false;
      });

      if (duplicateContact) {
        const wasOffline = String(duplicateContact.id).startsWith('offline-');
        if (!wasOffline || !isRealUser) {
          alert(
            `Este contacto (${duplicateContact.savedName || duplicateContact.username}) já está cadastrado na sua lista com este número, e-mail ou utilizador!`
          );
          return;
        }
      }

      const finalContactId = isRealUser
        ? resolvedUserId!
        : (duplicateContact?.id || `offline-${Date.now()}`);

      const newContact: SavedContact = {
        id: finalContactId,
        username: resolvedUsername,
        email: resolvedEmail || normalizeEmailKey(duplicateContact?.email) || undefined,
        avatar_url:
          baseUser?.avatar_url ??
          baseUser?.profile?.avatarUrl ??
          duplicateContact?.avatar_url ??
          null,
        status: extractCleanPresenceStatus(baseUser?.status || (isRealUser ? 'Online' : 'Offline')),
        savedName:
          contactForm.customName.trim() ||
          duplicateContact?.savedName ||
          resolvedUsername ||
          'Desconhecido',
        address: contactForm.address.trim() || duplicateContact?.address || '',
        phone: inputPhoneKey ? rawPhone : (normalizePhoneKey(duplicateContact?.phone) ? duplicateContact!.phone : ''),
        addedAt: new Date().toISOString()
      };

      if (deletedContactIdsRef.current.includes(String(newContact.id))) {
        const restoredDeleted = deletedContactIdsRef.current.filter((id: string) => id !== String(newContact.id));
        deletedContactIdsRef.current = restoredDeleted;
        setDeletedContactIds(restoredDeleted);
        try {
          localStorage.setItem(getDeletedContactsStorageKey(currentUser?.id), JSON.stringify(restoredDeleted));
          localStorage.setItem('chatchat_deleted_contacts', JSON.stringify(restoredDeleted));
        } catch {}
      }

      if (isRealUser) {
        try {
          await addOrUpdateContact(newContact.id, newContact.savedName);
        } catch (err) {
          console.warn('Guardado apenas localmente:', err);
        }
      }

      const filteredList = activeContactsList.filter(
        (c: SavedContact) =>
          String(c.id) !== String(newContact.id) &&
          (!duplicateContact || String(c.id) !== String(duplicateContact.id))
      );

      const updatedContacts = deduplicateContactsList(
        [...filteredList, newContact],
        currentUser?.id
      );

      const userStorageKey = getContactsStorageKey(currentUser?.id);
      setMySavedContacts(updatedContacts);
      localStorage.setItem(userStorageKey, JSON.stringify(updatedContacts));
      localStorage.setItem('my_saved_contacts', JSON.stringify(updatedContacts));

      setShowAddContactModal(false);
      setTargetUserToAdd(null);
      setActiveTab('contacts');
    } finally {
      setIsSavingContact(false);
    }
  };

  const handleRegisterMyPhoneHash = useCallback(async () => {
    if (!currentUser) return;
    const rawPhone = window.prompt('Digite o seu número de telemóvel (ex: +5567999999999) para que os seus contactos o possam encontrar com privacidade SHA-256:');
    if (!rawPhone || !rawPhone.trim()) return;
    try {
      const phoneHash = await hashPhoneIdentifier(rawPhone.trim());
      const { error } = await supabase
        .from('profiles')
        .update({ phone_hash: phoneHash, updated_at: new Date().toISOString() })
        .eq('id', currentUser.id);
      if (error) throw error;
      alert('Número vinculado com criptografia SHA-256! Agora os seus amigos podem adicioná-lo pelo telefone.');
    } catch {
      alert('Não foi possível vincular o número. Verifique se executou o script SQL no Supabase.');
    }
  }, [currentUser]);

  const safePurgeCloudForMsg = useCallback(async (msg: ChatMessage) => {
    if (!msg.image_metadata || purgedIdsRef.current.has(msg.id)) return;
    const hasParts =
      Array.isArray(msg.image_metadata.p2p_info?.cloud_parts) &&
      msg.image_metadata.p2p_info!.cloud_parts!.length > 0;
    if (!msg.image_metadata.url && !hasParts) return;

    purgedIdsRef.current.add(msg.id);
    try {
      await purgeCloudStorageForMsg(msg);
      const clearMeta = (m: ChatMessage): ChatMessage =>
        m.id === msg.id && m.image_metadata
          ? {
              ...m,
              image_metadata: {
                ...m.image_metadata,
                url: null,
                p2p_info: m.image_metadata.p2p_info
                  ? { ...m.image_metadata.p2p_info, cloud_parts: null }
                  : null,
                status: 'p2p_secured_and_deleted_from_vault'
              }
            }
          : m;

      if (msg.group_id) {
        setGroupMessages((prev: ChatMessage[]) => prev.map(clearMeta));
      } else {
        setMessages((prev: ChatMessage[]) => prev.map(clearMeta));
      }
    } catch {
      purgedIdsRef.current.delete(msg.id);
    }
  }, [setGroupMessages, setMessages]);

  const handleCameraCapture = useCallback(async (file: File, isVideo: boolean) => {
    const normalizedMime = getNormalizedMimeType(file, isVideo, false);
    const safeName = file.name || (isVideo ? `video_${Date.now()}.mp4` : `photo_${Date.now()}.jpg`);

    try {
      let ramBlob = await cloneFileToRamSafely(file, normalizedMime);
      if (!isVideo) {
        ramBlob = await compressImageBlobForMobile(ramBlob, safeName);
      }
      const detachedFile = new File([ramBlob], safeName, { type: ramBlob.type || normalizedMime });
      selectedMediaBlobRef.current = ramBlob;
      selectedMediaNameRef.current = safeName;

      const previewUrl = URL.createObjectURL(ramBlob);
      setImagePreview((prev: string | null) => {
        if (prev) URL.revokeObjectURL(prev);
        return previewUrl;
      });
      setSelectedImage(detachedFile);
      setIsFileVideo(isVideo);
    } catch {
      selectedMediaBlobRef.current = file;
      selectedMediaNameRef.current = safeName;
      setImagePreview((prev: string | null) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(file);
      });
      setSelectedImage(file);
      setIsFileVideo(isVideo);
    }
  }, []);

  const {
    videoRef, isCameraOpen, isRecording, facingMode,
    startCamera: openCamera, stopCamera: closeCamera,
    toggleFacingMode: toggleCameraFacingMode,
    handleCameraPressStart, handleCameraPressEnd
  } = useCamera(handleCameraCapture);

  const { initializeWebRTC, dataChannelsRef, closeAllConnections } = useWebRTC(currentUser, setP2pMediaUrls);
  const {
    callStatus,
    incomingCall,
    localStream,
    remoteStream,
    isVideoCall,
    isSpeakerphoneOn,
    toggleSpeakerphone,
    switchCamera: hookSwitchCallCamera,
    startCall,
    acceptCall,
    rejectCall,
    endCall
  } = useLiveCall(currentUser, mySavedContacts) as any;

  useEffect(() => {
    if (localStream && (callStatus === 'calling' || callStatus === 'connected')) {
      const audioTracks = localStream.getAudioTracks?.() || [];
      audioTracks.forEach((track: MediaStreamTrack) => {
        if (track.applyConstraints) {
          track.applyConstraints(HD_AUDIO_CONSTRAINTS).catch(() => {});
        }
      });
    }
  }, [localStream, callStatus]);

  const handleFlipCallCamera = useCallback(async () => {
    if (typeof hookSwitchCallCamera === 'function') {
      hookSwitchCallCamera();
      return;
    }
    if (!localStream) return;
    const nextFacing = callCameraFacing === 'user' ? 'environment' : 'user';
    try {
      const newVideoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: nextFacing }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      const newVideoTrack = newVideoStream.getVideoTracks()[0];
      if (!newVideoTrack) return;

      const oldVideoTracks = localStream.getVideoTracks();
      oldVideoTracks.forEach((t: MediaStreamTrack) => {
        t.stop();
        localStream.removeTrack(t);
      });
      localStream.addTrack(newVideoTrack);
      setCallCameraFacing(nextFacing);
    } catch (err) {
      console.warn('Não foi possível alternar a câmara na chamada:', err);
    }
  }, [hookSwitchCallCamera, localStream, callCameraFacing]);

  // ============================================================================
  // SINCRONIZAÇÃO GLOBAL ENTRE CONTAS (PROFILES + PRIVATE_MESSAGES)
  // ============================================================================
  const syncBlockRelationshipsFromServer = useCallback(async () => {
    if (!currentUser?.id) return;
    const myId = String(currentUser.id);

    try {
      const discoveredPages: Record<string, GlobalPageConfig> = { ...globalPageConfigsRef.current };
      let pagesChanged = false;

      // 1. Lê da tabela pública profiles (acessível por todas as contas em tempo real)
      const { data: latestProfiles } = await supabase
        .from('profiles')
        .select('id, username, avatar_url, status');

      if (latestProfiles && latestProfiles.length > 0) {
        for (const prof of latestProfiles) {
          const decoded = decodeGlobalPageFromProfileRow(prof);
          if (decoded) {
            const uid = String(decoded.userId);
            const prevCfg = discoveredPages[uid];
            const mergedCfg: GlobalPageConfig = {
              ...decoded,
              avatar_url: decoded.avatar_url || prof.avatar_url || prevCfg?.avatar_url || null
            };
            if (!prevCfg || JSON.stringify(prevCfg) !== JSON.stringify(mergedCfg)) {
              discoveredPages[uid] = mergedCfg;
              pagesChanged = true;
            }
          }
        }
      }

      // 2. Lê os sinais mais recentes de private_messages onde o utilizador atual participa
      const { data: signalRows } = await supabase
        .from('private_messages')
        .select('id, sender_id, receiver_id, image_metadata, created_at')
        .or(`sender_id.eq.${myId},receiver_id.eq.${myId}`)
        .not('image_metadata', 'is', null)
        .order('created_at', { ascending: false })
        .limit(300);

      const blockedByOthersSet = new Set<string>();
      const myBlockedUpdates: Record<string, ContactFaceStatus> = {};
      let myBlocksChanged = false;
      const incomingAccessRequests: Array<{ targetPageId: string; req: GlobalPageAccessRequest }> = [];

      if (signalRows && signalRows.length > 0) {
        // Percorre do mais antigo ao mais recente dentro do lote para respeitar a última ação
        const chronologicalRows = [...signalRows].reverse();

        for (const row of chronologicalRows) {
          const meta = row.image_metadata as any;
          if (!meta) continue;

          if (meta.is_global_page_config === true && meta.page_config?.userId) {
            const cfg = meta.page_config as GlobalPageConfig;
            const uid = String(cfg.userId);
            const prevCfg = discoveredPages[uid];
            // Atualiza se for mais recente ou ainda não existir
            if (
              !prevCfg ||
              !prevCfg.updated_at ||
              (cfg.updated_at && cfg.updated_at >= prevCfg.updated_at)
            ) {
              const mergedCfg: GlobalPageConfig = {
                ...prevCfg,
                ...cfg,
                avatar_url: cfg.avatar_url || prevCfg?.avatar_url || null
              };
              if (JSON.stringify(prevCfg) !== JSON.stringify(mergedCfg)) {
                discoveredPages[uid] = mergedCfg;
                pagesChanged = true;
              }
            }
            continue;
          }

          if (meta.is_global_page_access_request === true && meta.target_page_id && meta.request_data) {
            incomingAccessRequests.push({
              targetPageId: String(meta.target_page_id),
              req: meta.request_data as GlobalPageAccessRequest
            });
            continue;
          }

          if (meta.is_block_signal !== true) continue;

          const senderId = String(row.sender_id);
          const receiverId = String(row.receiver_id);
          const action = meta.block_action;

          if (receiverId === myId && senderId !== myId) {
            if (action === 'blocked') {
              blockedByOthersSet.add(senderId);
            } else if (action === 'unblocked') {
              blockedByOthersSet.delete(senderId);
            }
          } else if (senderId === myId && receiverId !== myId) {
            if (action === 'blocked') {
              myBlockedUpdates[receiverId] = 'blocked';
            } else if (action === 'unblocked') {
              myBlockedUpdates[receiverId] = 'normal';
            }
          }
        }
      }

      for (const item of incomingAccessRequests) {
        const page: GlobalPageConfig = discoveredPages[item.targetPageId] || {
          userId: item.targetPageId,
          title: currentUser.username || 'Minha Página',
          description: '',
          avatar_url: myAvatarUrl || currentUser.avatar_url || null,
          visibility: 'private',
          handle: formatPageHandle(currentUser.username || 'pagina'),
          hashtags: '',
          bio_link: '',
          is_adult: false,
          approvedUserIds: [],
          pendingRequests: [],
          rejectedUserIds: [],
          updated_at: new Date().toISOString()
        };

        const reqId = String(item.req.requesterId);
        const alreadyApproved = (page.approvedUserIds || []).map(String).includes(reqId);
        const alreadyRejected = (page.rejectedUserIds || []).map(String).includes(reqId);
        const alreadyPending = (page.pendingRequests || []).some(
          (r: GlobalPageAccessRequest) => String(r.requesterId) === reqId
        );

        if (!alreadyApproved && !alreadyRejected && !alreadyPending) {
          discoveredPages[item.targetPageId] = {
            ...page,
            pendingRequests: [...(page.pendingRequests || []), item.req]
          };
          pagesChanged = true;
        }
      }

      if (pagesChanged) {
        globalPageConfigsRef.current = discoveredPages;
        setGlobalPageConfigs(discoveredPages);
        try {
          localStorage.setItem(GLOBAL_PAGES_STORAGE_KEY, JSON.stringify(discoveredPages));
        } catch {}
      }

      const nextBlockedByList = Array.from(blockedByOthersSet);
      const prevBlockedByStr = JSON.stringify([...blockedByUserIdsRef.current].sort());
      const nextBlockedByStr = JSON.stringify([...nextBlockedByList].sort());

      if (prevBlockedByStr !== nextBlockedByStr) {
        blockedByUserIdsRef.current = nextBlockedByList;
        setBlockedByUserIds(nextBlockedByList);
        try {
          localStorage.setItem(getBlockedByOthersStorageKey(myId), JSON.stringify(nextBlockedByList));
        } catch {}
      }

      const currentFaces = { ...contactFaceStatusesRef.current };
      Object.entries(myBlockedUpdates).forEach(([targetId, status]) => {
        if (status === 'blocked' && currentFaces[targetId] !== 'blocked') {
          currentFaces[targetId] = 'blocked';
          myBlocksChanged = true;
        } else if (status === 'normal' && currentFaces[targetId] === 'blocked') {
          currentFaces[targetId] = 'normal';
          myBlocksChanged = true;
        }
      });

      if (myBlocksChanged) {
        contactFaceStatusesRef.current = currentFaces;
        setContactFaceStatuses(currentFaces);
        try {
          localStorage.setItem(getContactFaceStatusStorageKey(myId), JSON.stringify(currentFaces));
          localStorage.setItem('chatchat_contact_face_status', JSON.stringify(currentFaces));
        } catch {}
      }
    } catch {}
  }, [currentUser, myAvatarUrl]);

  // Carrega estritamente Postagens Globais na aba Global e Mensagens Privadas na aba Contactos
  const loadHistoryForContactAndTab = useCallback(async (contactId: string | null, tabMode: string) => {
    if (!currentUser?.id || !contactId || contactId.startsWith('offline-')) {
      setMessages([]);
      return;
    }

    const myId = String(currentUser.id);
    if (tabMode === 'global') {
      const { data } = await supabase
        .from('private_messages')
        .select('*')
        .or(`sender_id.eq.${contactId},receiver_id.eq.${contactId},receiver_id.eq.${myId}`)
        .order('created_at', { ascending: true });

      if (data && activeChatContactIdRef.current === contactId) {
        const seenPostKeys = new Set<string>();
        const onlyGlobalPosts: ChatMessage[] = [];

        for (const m of data as ChatMessage[]) {
          const meta = m.image_metadata as any;
          if (!Boolean(meta?.is_global_post)) continue;
          if (meta?.is_block_signal || meta?.is_global_page_config || meta?.is_global_page_access_request) {
            continue;
          }
          const pageOwnerId = String(meta?.global_page_owner_id || m.sender_id);
          if (pageOwnerId !== String(contactId) && String(m.receiver_id) !== String(contactId)) {
            continue;
          }
          const dedupKey = String(meta?.global_post_id || m.id);
          if (seenPostKeys.has(dedupKey)) continue;
          seenPostKeys.add(dedupKey);
          onlyGlobalPosts.push(m);
        }

        setMessages(onlyGlobalPosts);
      }
    } else if (tabMode === 'contacts') {
      const { data } = await supabase
        .from('private_messages')
        .select('*')
        .or(`and(sender_id.eq.${myId},receiver_id.eq.${contactId}),and(sender_id.eq.${contactId},receiver_id.eq.${myId})`)
        .order('created_at', { ascending: true });

      if (data && activeChatContactIdRef.current === contactId) {
        const onlyPrivateMessages = data.filter(
          (m: ChatMessage) =>
            !Boolean((m.image_metadata as any)?.is_global_post) &&
            !(m.image_metadata as any)?.is_block_signal &&
            !(m.image_metadata as any)?.is_global_page_config &&
            !(m.image_metadata as any)?.is_global_page_access_request
        );
        setMessages(onlyPrivateMessages);
      }
    }
  }, [currentUser?.id, setMessages]);

  useEffect(() => {
    if (!currentUser?.id) return;

    const myId = String(currentUser.id);
    const activeContactId = selectedContact?.id ? String(selectedContact.id) : null;
    const activeGroupId = selectedGroup?.id ? String(selectedGroup.id) : null;

    syncBlockRelationshipsFromServer();

    const mergeIncomingMessages = (prev: ChatMessage[], incoming: ChatMessage[]) => {
      if (!incoming || incoming.length === 0) return prev;
      let changed = false;
      const byId = new Map(prev.map((m: ChatMessage) => [m.id, m]));
      const byGlobalPostId = new Set(
        prev
          .map((m: ChatMessage) => (m.image_metadata as any)?.global_post_id)
          .filter(Boolean)
      );

      for (const msg of incoming) {
        const meta = msg.image_metadata as any;
        if (
          meta?.is_block_signal ||
          meta?.is_global_page_config ||
          meta?.is_global_page_access_request
        ) {
          continue;
        }

        const isGlobalPost = Boolean(meta?.is_global_post);
        if (activeTab === 'global' && !isGlobalPost) continue;
        if (activeTab === 'contacts' && isGlobalPost) continue;

        const senderId = String(msg.sender_id);
        if (
          senderId !== myId &&
          (contactFaceStatusesRef.current[senderId] === 'blocked' ||
            blockedByUserIdsRef.current.includes(senderId))
        ) {
          continue;
        }

        const existing = byId.get(msg.id);
        if (!existing) {
          if (isGlobalPost && meta?.global_post_id && byGlobalPostId.has(meta.global_post_id)) {
            continue;
          }
          byId.set(msg.id, msg);
          if (meta?.global_post_id) byGlobalPostId.add(meta.global_post_id);
          changed = true;
        } else if (
          JSON.stringify(existing.image_metadata) !== JSON.stringify(msg.image_metadata) ||
          existing.content !== msg.content
        ) {
          byId.set(msg.id, msg);
          changed = true;
        }
      }

      if (!changed) return prev;
      return Array.from(byId.values()).sort(
        (a: ChatMessage, b: ChatMessage) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
    };

    const realtimeChannel = supabase
      .channel(`instant_sync_${myId}_${activeTab}_${activeContactId || activeGroupId || 'idle'}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'profiles' },
        (payload) => {
          const prof = payload.new as any;
          if (!prof || !prof.id) return;
          const decoded = decodeGlobalPageFromProfileRow(prof);
          if (decoded) {
            const uid = String(decoded.userId);
            setGlobalPageConfigs((prev: Record<string, GlobalPageConfig>) => {
              const next = {
                ...prev,
                [uid]: {
                  ...decoded,
                  avatar_url: decoded.avatar_url || prof.avatar_url || prev[uid]?.avatar_url || null
                }
              };
              globalPageConfigsRef.current = next;
              try {
                localStorage.setItem(GLOBAL_PAGES_STORAGE_KEY, JSON.stringify(next));
              } catch {}
              return next;
            });
          }
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'private_messages' },
        (payload) => {
          const msg = payload.new as ChatMessage;
          if (!msg || !msg.id) return;

          const meta = msg.image_metadata as any;
          const senderId = String(msg.sender_id);
          const receiverId = String(msg.receiver_id);

          if (meta?.is_global_page_config === true && meta.page_config?.userId) {
            const cfg = meta.page_config as GlobalPageConfig;
            const uid = String(cfg.userId);
            setGlobalPageConfigs((prev: Record<string, GlobalPageConfig>) => {
              const next = {
                ...prev,
                [uid]: {
                  ...prev[uid],
                  ...cfg,
                  avatar_url: cfg.avatar_url || prev[uid]?.avatar_url || null
                }
              };
              globalPageConfigsRef.current = next;
              try {
                localStorage.setItem(GLOBAL_PAGES_STORAGE_KEY, JSON.stringify(next));
              } catch {}
              return next;
            });
            return;
          }

          if (meta?.is_global_page_access_request === true && meta.target_page_id && meta.request_data) {
            const targetPageId = String(meta.target_page_id);
            const req = meta.request_data as GlobalPageAccessRequest;
            setGlobalPageConfigs((prev: Record<string, GlobalPageConfig>) => {
              const page: GlobalPageConfig = prev[targetPageId] || {
                userId: targetPageId,
                title: currentUser.username || 'Minha Página',
                description: '',
                avatar_url: myAvatarUrl || currentUser.avatar_url || null,
                visibility: 'private',
                handle: formatPageHandle(currentUser.username || 'pagina'),
                hashtags: '',
                bio_link: '',
                is_adult: false,
                approvedUserIds: [],
                pendingRequests: [],
                rejectedUserIds: [],
                updated_at: new Date().toISOString()
              };
              const reqId = String(req.requesterId);
              if (
                (page.approvedUserIds || []).map(String).includes(reqId) ||
                (page.pendingRequests || []).some(
                  (r: GlobalPageAccessRequest) => String(r.requesterId) === reqId
                )
              ) {
                return prev;
              }
              const next = {
                ...prev,
                [targetPageId]: {
                  ...page,
                  pendingRequests: [...(page.pendingRequests || []), req]
                }
              };
              globalPageConfigsRef.current = next;
              try {
                localStorage.setItem(GLOBAL_PAGES_STORAGE_KEY, JSON.stringify(next));
              } catch {}
              return next;
            });
            return;
          }

          if (meta?.is_block_signal === true) {
            if (receiverId === myId && senderId !== myId) {
              if (meta.block_action === 'blocked') {
                setBlockedByUserIds((prev: string[]) => {
                  const next = prev.includes(senderId) ? prev : [...prev, senderId];
                  blockedByUserIdsRef.current = next;
                  try {
                    localStorage.setItem(getBlockedByOthersStorageKey(myId), JSON.stringify(next));
                  } catch {}
                  return next;
                });
              } else if (meta.block_action === 'unblocked') {
                setBlockedByUserIds((prev: string[]) => {
                  const next = prev.filter((id: string) => id !== senderId);
                  blockedByUserIdsRef.current = next;
                  try {
                    localStorage.setItem(getBlockedByOthersStorageKey(myId), JSON.stringify(next));
                  } catch {}
                  return next;
                });
              }
            }
            return;
          }

          const senderState = contactFaceStatusesRef.current[senderId];
          if (senderState === 'blocked' || blockedByUserIdsRef.current.includes(senderId)) {
            return;
          }

          const isGlobalPost = Boolean(meta?.is_global_post);

          if (activeTab === 'global' && isGlobalPost && activeContactId) {
            const pageOwnerId = String(meta?.global_page_owner_id || senderId);
            if (pageOwnerId === activeContactId || senderId === activeContactId || receiverId === activeContactId) {
              setMessages((prev: ChatMessage[]) => mergeIncomingMessages(prev, [msg]));
            }
            return;
          }

          if (activeTab === 'contacts' && !isGlobalPost) {
            const isRelevantToActiveChat =
              activeContactId &&
              ((senderId === myId && receiverId === activeContactId) ||
                (senderId === activeContactId && receiverId === myId));

            if (isRelevantToActiveChat) {
              setMessages((prev: ChatMessage[]) => mergeIncomingMessages(prev, [msg]));
            } else if (payload.eventType === 'INSERT' && receiverId === myId && senderState !== 'muted') {
              setUnreadSenders((prev: string[]) =>
                prev.includes(senderId) ? prev : [...prev, senderId]
              );
            }
          }
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'group_messages' },
        (payload) => {
          const msg = payload.new as ChatMessage;
          if (!msg || !msg.id) return;
          if (activeGroupId && String(msg.group_id) === activeGroupId) {
            setGroupMessages((prev: ChatMessage[]) => mergeIncomingMessages(prev, [msg]));
          }
        }
      )
      .subscribe();

    const syncInterval = setInterval(async () => {
      await syncBlockRelationshipsFromServer();

      if (activeContactId && !activeContactId.startsWith('offline-')) {
        if (
          contactFaceStatusesRef.current[activeContactId] === 'blocked' ||
          blockedByUserIdsRef.current.includes(activeContactId)
        ) {
          return;
        }
        await loadHistoryForContactAndTab(activeContactId, activeTab);
      } else if (activeGroupId) {
        const { data } = await supabase
          .from('group_messages')
          .select('*')
          .eq('group_id', activeGroupId)
          .order('created_at', { ascending: true });

        if (data) {
          setGroupMessages((prev: ChatMessage[]) => mergeIncomingMessages(prev, data));
        }
      }
    }, 2500);

    return () => {
      clearInterval(syncInterval);
      supabase.removeChannel(realtimeChannel);
    };
  }, [
    currentUser,
    myAvatarUrl,
    activeTab,
    selectedContact?.id,
    selectedGroup?.id,
    setMessages,
    setGroupMessages,
    setUnreadSenders,
    syncBlockRelationshipsFromServer,
    loadHistoryForContactAndTab
  ]);

  useEffect(() => {
    try {
      const savedUnlocked = localStorage.getItem('unlocked_p2p_images');
      if (savedUnlocked) setUnlockedImages(JSON.parse(savedUnlocked));
      const savedAutoDl = localStorage.getItem('chatchat_auto_download');
      if (savedAutoDl !== null) setAutoDownload(savedAutoDl === 'true');
    } catch {}

    return () => {
      closeAllConnections?.();
      if (audioTimerRef.current) clearInterval(audioTimerRef.current);
      Object.values(p2pMediaUrlsRef.current).forEach((url: string) => {
        if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
      });
    };
  }, [closeAllConnections]);

  const handleToggleAutoDownload = useCallback(() => {
    setAutoDownload((prev: boolean) => {
      const next = !prev;
      try {
        localStorage.setItem('chatchat_auto_download', String(next));
      } catch {}
      return next;
    });
  }, []);

  useEffect(() => {
    let isMounted = true;
    const hydrateVaultMedia = async () => {
      const allMsgs: ChatMessage[] = [...messages, ...groupMessages, ...galleryMessages];
      const candidates = allMsgs.filter(
        (msg: ChatMessage) =>
          msg.image_metadata &&
          (msg.image_metadata.url || msg.image_metadata.p2p_info?.cloud_parts) &&
          !msg.image_metadata.is_nudge &&
          !msg.image_metadata.is_deleted &&
          !(msg.image_metadata as any).is_block_signal &&
          !(msg.image_metadata as any).is_global_page_config &&
          !(msg.image_metadata as any).is_global_page_access_request &&
          !String(msg.id).startsWith('temp-') &&
          !String(msg.id).startsWith('gtemp-') &&
          !hydratedIdsRef.current.has(msg.id) &&
          !inFlightHydrationRef.current.has(msg.id)
      );

      if (candidates.length === 0) return;

      const HYDRATION_CONCURRENCY = 4;
      for (let i = 0; i < candidates.length; i += HYDRATION_CONCURRENCY) {
        if (!isMounted) break;
        const batch = candidates.slice(i, i + HYDRATION_CONCURRENCY);

        await Promise.allSettled(
          batch.map(async (msg: ChatMessage) => {
            if (!isMounted || hydratedIdsRef.current.has(msg.id) || inFlightHydrationRef.current.has(msg.id)) {
              return;
            }
            inFlightHydrationRef.current.add(msg.id);

            try {
              const hasCloudParts =
                Array.isArray(msg.image_metadata?.p2p_info?.cloud_parts) &&
                msg.image_metadata!.p2p_info!.cloud_parts!.length > 0;
              const hasCloudUrl = Boolean(msg.image_metadata?.url);
              const isMe = msg.sender_id === currentUser?.id;
              const isLockedForMe =
                Boolean(msg.image_metadata?.is_password_protected) &&
                !isMe &&
                !unlockedImages.includes(msg.id);

              if (p2pMediaUrlsRef.current[msg.id]) {
                hydratedIdsRef.current.add(msg.id);
                return;
              }

              let blob = await getFromVault(msg.id);

              if (blob && blob.size > 0) {
                const headBuf = await blob.slice(0, 16).arrayBuffer();
                const realMime = detectMimeFromBinary(
                  headBuf,
                  msg.image_metadata?.original_name,
                  Boolean(msg.image_metadata?.is_video),
                  Boolean(msg.image_metadata?.is_audio)
                );
                if (blob.type !== realMime) {
                  blob = new Blob([blob], { type: realMime });
                }
              }

              if ((!blob || blob.size === 0) && (hasCloudParts || hasCloudUrl) && !isLockedForMe && (autoDownload || isMe)) {
                const mergedBuffer = await downloadMediaBufferFromMetadata(
                  msg.image_metadata!,
                  msg.image_metadata?.url || undefined,
                  (pct: number) => {
                    if (isMounted) {
                      setDownloadProgressMap((prev: Record<string, number>) => ({ ...prev, [msg.id]: pct }));
                    }
                  }
                );

                if (mergedBuffer.byteLength > 0) {
                  const realMime = detectMimeFromBinary(
                    mergedBuffer,
                    msg.image_metadata?.original_name,
                    Boolean(msg.image_metadata?.is_video),
                    Boolean(msg.image_metadata?.is_audio)
                  );
                  blob = new Blob([mergedBuffer], { type: realMime });
                  await saveToVault(msg.id, blob);
                }
              }

              if (blob && blob.size > 0 && isMounted) {
                const objectUrl = URL.createObjectURL(blob);
                hydratedIdsRef.current.add(msg.id);
                setP2pMediaUrls((prev: Record<string, string>) => {
                  if (prev[msg.id] && prev[msg.id] !== objectUrl && prev[msg.id].startsWith('blob:')) {
                    URL.revokeObjectURL(prev[msg.id]);
                  }
                  return { ...prev, [msg.id]: objectUrl };
                });
                setDownloadProgressMap((prev: Record<string, number>) => {
                  const next = { ...prev };
                  delete next[msg.id];
                  return next;
                });
              }
            } catch {
              if (isMounted) {
                setDownloadProgressMap((prev: Record<string, number>) => {
                  const next = { ...prev };
                  delete next[msg.id];
                  return next;
                });
              }
            } finally {
              inFlightHydrationRef.current.delete(msg.id);
            }
          })
        );
      }
    };

    hydrateVaultMedia();
    return () => { isMounted = false; };
  }, [messages, groupMessages, galleryMessages, getFromVault, saveToVault, currentUser?.id, unlockedImages, autoDownload]);

  useEffect(() => {
    if (activeTab === 'groups' && selectedGroup && currentUser && groupMembers.length > 0) {
      groupMembers.forEach((member: any) => {
        if (member.user_id !== currentUser.id && !dataChannelsRef.current[member.user_id]) {
          initializeWebRTC(member.user_id, true);
        }
      });
    }
  }, [groupMembers, selectedGroup, activeTab, currentUser, initializeWebRTC, dataChannelsRef]);

  const clearImageSelection = useCallback(() => {
    setImagePreview((prev: string | null) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    selectedMediaBlobRef.current = null;
    selectedMediaNameRef.current = '';
    setSelectedImage(null);
    setIsFileVideo(false);
    setUploadProgress(0);
    setCustomPassword('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawPickedFile = e.target.files?.[0];
    if (!rawPickedFile) return;

    const isVideo = isVideoFileCheck(rawPickedFile);
    const normalizedMime = getNormalizedMimeType(rawPickedFile, isVideo, false);
    const extFallback = isVideo ? 'mp4' : 'jpg';
    const rawExt = rawPickedFile.name?.includes('.') ? rawPickedFile.name.split('.').pop() : extFallback;
    const cleanExt = (rawExt || extFallback).toLowerCase().replace(/[^a-z0-9]/g, '') || extFallback;
    const safeName = rawPickedFile.name || `media_${Date.now()}.${cleanExt}`;

    try {
      let ramBlob = await cloneFileToRamSafely(rawPickedFile, normalizedMime);
      if (!isVideo) {
        ramBlob = await compressImageBlobForMobile(ramBlob, safeName);
      }

      const finalMime = ramBlob.type || normalizedMime;
      const detachedFile = new File([ramBlob], safeName, { type: finalMime });

      selectedMediaBlobRef.current = ramBlob;
      selectedMediaNameRef.current = safeName;

      const previewUrl = URL.createObjectURL(ramBlob);
      setImagePreview((prev: string | null) => {
        if (prev) URL.revokeObjectURL(prev);
        return previewUrl;
      });
      setSelectedImage(detachedFile);
      setIsFileVideo(isVideo);
    } catch (err: any) {
      alert(`Não foi possível abrir o ficheiro selecionado: ${err?.message || 'Tente novamente.'}`);
    }
  };

  const handleSidebarScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    if (target.scrollHeight - target.scrollTop <= target.clientHeight + 50) {
      if (activeTab === 'global' && globalDisplayLimit < globalProfiles.length) {
        setGlobalDisplayLimit((prev: number) => prev + 10);
      }
    }
  };

  const executeSend = async (e?: React.FormEvent, overrideFile: File | null = null, isAudioNote: boolean = false) => {
    if (e) e.preventDefault();
    const targetId = (activeTab === 'contacts' || activeTab === 'global') ? selectedContact?.id : selectedGroup?.id;
    if (!currentUser || !targetId) return;

    const targetIdStr = String(targetId);
    const isGroup = activeTab === 'groups';
    const isGlobalPost = activeTab === 'global';
    const uniqueGlobalPostId = isGlobalPost ? `gpost_${currentUser.id}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}` : undefined;

    if (!isGroup) {
      if (contactFaceStatusesRef.current[targetIdStr] === 'blocked') {
        alert('Este contacto está bloqueado (carinha vermelha). Desbloqueie o contacto para enviar mensagens.');
        return;
      }

      if (blockedByUserIdsRef.current.includes(targetIdStr)) {
        setSelectedContact(null);
        alert('Não é possível enviar mensagem. Este perfil não está disponível.');
        return;
      }

      if (!targetIdStr.startsWith('offline-')) {
        try {
          const { data: latestBlockCheck } = await supabase
            .from('private_messages')
            .select('image_metadata, created_at')
            .eq('sender_id', targetIdStr)
            .eq('receiver_id', currentUser.id)
            .not('image_metadata', 'is', null)
            .order('created_at', { ascending: false })
            .limit(15);

          if (latestBlockCheck && latestBlockCheck.length > 0) {
            const latestSignal = latestBlockCheck.find(
              (r: any) => r.image_metadata?.is_block_signal === true
            );
            if (latestSignal && (latestSignal.image_metadata as any)?.block_action === 'blocked') {
              setBlockedByUserIds((prev: string[]) => (prev.includes(targetIdStr) ? prev : [...prev, targetIdStr]));
              setSelectedContact(null);
              alert('Não é possível enviar mensagem. Este perfil não está disponível.');
              return;
            }
          }
        } catch {}
      }
    }

    if (targetIdStr.startsWith('offline-')) {
      alert('Este contacto foi criado offline e não está ligado à Rede Global.');
      return;
    }

    const hasMedia = Boolean(overrideFile || selectedMediaBlobRef.current || selectedImage);
    const textToSend = (activeTab === 'contacts' || activeTab === 'global') ? newMessage.trim() : newGroupMessage.trim();
    if (!textToSend && !hasMedia) return;

    if (activeTab === 'contacts' || activeTab === 'global') setNewMessage('');
    else setNewGroupMessage('');

    setIsUploading(true);
    setUploadProgress(5);
    const isProtected = customPassword.trim() !== '';

    let inMemoryBlob: Blob | null = null;
    let finalFile: File | null = null;
    let normalizedMime = 'image/jpeg';
    let isFileVideoLocal = false;

    if (hasMedia) {
      try {
        if (overrideFile) {
          isFileVideoLocal = isVideoFileCheck(overrideFile) && !isAudioNote;
          normalizedMime = getNormalizedMimeType(overrideFile, isFileVideoLocal, isAudioNote);
          inMemoryBlob = await cloneFileToRamSafely(overrideFile, normalizedMime);
          normalizedMime = inMemoryBlob.type || normalizedMime;
          finalFile = new File([inMemoryBlob], overrideFile.name || `audio_${Date.now()}.webm`, { type: normalizedMime });
        } else if (selectedMediaBlobRef.current) {
          isFileVideoLocal = isFileVideo && !isAudioNote;
          const fileNameRef = selectedMediaNameRef.current || selectedImage?.name || (isFileVideoLocal ? `video_${Date.now()}.mp4` : `img_${Date.now()}.jpg`);
          normalizedMime = getNormalizedMimeType({ type: selectedMediaBlobRef.current.type, name: fileNameRef }, isFileVideoLocal, isAudioNote);
          inMemoryBlob = new Blob([selectedMediaBlobRef.current], { type: normalizedMime });
          finalFile = new File([inMemoryBlob], fileNameRef, { type: normalizedMime });
        } else if (selectedImage) {
          isFileVideoLocal = isVideoFileCheck(selectedImage) && !isAudioNote;
          normalizedMime = getNormalizedMimeType(selectedImage, isFileVideoLocal, isAudioNote);
          inMemoryBlob = await cloneFileToRamSafely(selectedImage, normalizedMime);
          normalizedMime = inMemoryBlob.type || normalizedMime;
          finalFile = new File([inMemoryBlob], selectedImage.name || `media_${Date.now()}`, { type: normalizedMime });
        }
      } catch (readErr: any) {
        setIsUploading(false);
        setUploadProgress(0);
        alert(`Erro ao preparar mídia: ${readErr?.message || 'Tente selecionar novamente.'}`);
        return;
      }
    }

    let metadata: ImageMetadata | null = null;
    let p2pData: Awaited<ReturnType<typeof processFileForP2P>> | null = null;
    let previewBase64 = '';
    let mediaWidth: number | undefined;
    let mediaHeight: number | undefined;
    let mediaDurationSec: number | undefined;

    if (inMemoryBlob && !isAudioNote && !isProtected) {
      const inspected = await generateMediaThumbnailAndMeta(inMemoryBlob, isFileVideoLocal);
      previewBase64 = inspected.previewBase64;
      mediaWidth = inspected.width;
      mediaHeight = inspected.height;
      mediaDurationSec = inspected.durationSec;
    }

    const tempId = (isGroup ? 'gtemp-' : 'temp-') + Date.now();
    const localBlobUrl = inMemoryBlob ? URL.createObjectURL(inMemoryBlob) : null;

    const tempMsg: ChatMessage = {
      id: tempId,
      sender_id: currentUser.id,
      ...(isGroup ? { group_id: targetId } : { receiver_id: targetId }),
      content: textToSend,
      image_metadata: finalFile
        ? ({
            preview: localBlobUrl,
            preview_base64: previewBase64,
            mime_type: normalizedMime,
            is_uploading: true,
            is_video: isFileVideoLocal,
            is_audio: isAudioNote,
            ...(isGlobalPost
              ? {
                  is_global_post: true,
                  global_page_owner_id: targetIdStr,
                  global_post_id: uniqueGlobalPostId
                }
              : {})
          } as any)
        : isGlobalPost
        ? ({
            is_global_post: true,
            global_page_owner_id: targetIdStr,
            global_post_id: uniqueGlobalPostId
          } as any)
        : null,
      created_at: new Date().toISOString(),
      is_read: false
    };

    if (isGroup) setGroupMessages((prev: ChatMessage[]) => [...prev, tempMsg]);
    else setMessages((prev: ChatMessage[]) => [...prev, tempMsg]);

    if (finalFile && inMemoryBlob) {
      try {
        const hasWebCrypto = typeof window !== 'undefined' && Boolean(window.crypto?.subtle);

        const hasOpenChannel = isGroup
          ? groupMembers.some((m: any) => m.user_id !== currentUser.id && dataChannelsRef.current[m.user_id]?.readyState === 'open')
          : dataChannelsRef.current[targetId]?.readyState === 'open';

        if (hasWebCrypto && hasOpenChannel && !isProtected && !isFileVideoLocal && inMemoryBlob.size <= 4 * 1024 * 1024) {
          try {
            p2pData = await prepareFileForP2PSafe(finalFile, customPassword);
          } catch (cryptoErr) {
            console.warn('WebCrypto P2P ignorado, a usar Storage:', cryptoErr);
          }
        }

        const extFromMime = normalizedMime.includes('webm')
          ? 'webm'
          : normalizedMime.includes('mp4')
          ? 'mp4'
          : normalizedMime.includes('png')
          ? 'png'
          : normalizedMime.includes('gif')
          ? 'gif'
          : 'jpg';
        const fileName = `${Date.now()}-${Math.random().toString(36).substring(2)}.${extFromMime}`;

        let fileToUpload: Blob = inMemoryBlob;
        let contentType = normalizedMime;

        if (isProtected) {
          if (!hasWebCrypto) {
            throw new Error('Para enviar mídia com senha, aceda via HTTPS ou localhost.');
          }
          const key = await generateMasterKey(customPassword);
          const rawBuffer = await inMemoryBlob.arrayBuffer();
          const encryptedFullBuffer = await encryptChunk(rawBuffer, key);
          fileToUpload = new Blob([encryptedFullBuffer], { type: 'application/octet-stream' });
          contentType = 'application/octet-stream';
        }

        const { publicUrl, cloudParts } = await uploadToStorageWithAutoChunking(
          fileName,
          fileToUpload,
          contentType,
          isFileVideoLocal,
          (pct: number) => setUploadProgress(pct)
        );

        const persistentMediaId = `media_${currentUser.id}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

        metadata = {
          url: publicUrl,
          preview_base64: isProtected ? '' : previewBase64,
          mime_type: normalizedMime,
          status: cloudParts
            ? 'chunked_cloud_vault'
            : 'cloud_synced_vault',
          original_name: finalFile.name || `media_${Date.now()}.${extFromMime}`,
          is_password_protected: isProtected,
          is_video: isFileVideoLocal,
          is_audio: isAudioNote,
          ...(isGlobalPost
            ? {
                is_global_post: true,
                global_page_owner_id: targetIdStr,
                global_post_id: uniqueGlobalPostId
              }
            : {}),
          p2p_info: {
            media_id: persistentMediaId,
            totalChunks: p2pData?.totalChunks || (cloudParts ? cloudParts.length : 1),
            encrypted: isProtected,
            expected_size: inMemoryBlob.size,
            duration_sec: mediaDurationSec,
            width: mediaWidth,
            height: mediaHeight,
            ...(cloudParts ? { cloud_parts: cloudParts } : {})
          }
        } as any;
      } catch (err: any) {
        if (localBlobUrl) URL.revokeObjectURL(localBlobUrl);
        if (isGroup) setGroupMessages((prev: ChatMessage[]) => prev.filter((m: ChatMessage) => m.id !== tempId));
        else setMessages((prev: ChatMessage[]) => prev.filter((m: ChatMessage) => m.id !== tempId));
        setIsUploading(false);
        setUploadProgress(0);
        alert(`Erro ao enviar ficheiro: ${err?.message || 'Falha no processamento'}`);
        return;
      }
    } else if (isGlobalPost) {
      metadata = {
        is_global_post: true,
        global_page_owner_id: targetIdStr,
        global_post_id: uniqueGlobalPostId
      } as any;
    }

    const { data, error: insertError } = await supabase
      .from(isGroup ? 'group_messages' : 'private_messages')
      .insert([{
        sender_id: currentUser.id,
        ...(isGroup ? { group_id: targetId } : { receiver_id: targetId }),
        content: textToSend,
        image_metadata: metadata
      }])
      .select();

    if (insertError || !data || !data[0]) {
      if (localBlobUrl) URL.revokeObjectURL(localBlobUrl);
      if (isGroup) setGroupMessages((prev: ChatMessage[]) => prev.filter((m: ChatMessage) => m.id !== tempId));
      else setMessages((prev: ChatMessage[]) => prev.filter((m: ChatMessage) => m.id !== tempId));
      setIsUploading(false);
      setUploadProgress(0);
      alert(`Não foi possível guardar a mensagem: ${insertError?.message || 'Erro desconhecido'}`);
      return;
    }

    const finalMsg: ChatMessage = data[0];

    // Se for uma Postagem Global, distribui cópias de leitura para que outras contas vejam no mural da Página Global
    if (isGlobalPost && !isGroup) {
      try {
        const ownerPageCfg = globalPageConfigsRef.current[targetIdStr];
        const isPagePrivate = ownerPageCfg?.visibility === 'private';
        const recipientIds = isPagePrivate
          ? Array.from(new Set([...(ownerPageCfg?.approvedUserIds || []).map(String), targetIdStr]))
          : Array.from(new Set([...globalProfiles.map((p: UserProfile) => String(p.id)), targetIdStr]));

        const fanoutRows = recipientIds
          .filter((rid: string) => rid !== String(targetId) && rid !== String(currentUser.id))
          .map((rid: string) => ({
            sender_id: currentUser.id,
            receiver_id: rid,
            content: textToSend,
            image_metadata: metadata
          }));

        if (fanoutRows.length > 0) {
          await supabase.from('private_messages').insert(fanoutRows);
        }
      } catch {}
    }

    if (inMemoryBlob) {
      hydratedIdsRef.current.add(finalMsg.id);
      if (localBlobUrl) {
        setP2pMediaUrls((prev: Record<string, string>) => ({ ...prev, [finalMsg.id]: localBlobUrl }));
      }
      try {
        await saveToVault(finalMsg.id, inMemoryBlob);
      } catch (vaultErr) {
        console.warn('Aviso: Não foi possível salvar no cofre local:', vaultErr);
      }
    }

    if (isGroup) setGroupMessages((prev: ChatMessage[]) => prev.map((m: ChatMessage) => (m.id === tempId ? finalMsg : m)));
    else setMessages((prev: ChatMessage[]) => prev.map((m: ChatMessage) => (m.id === tempId ? finalMsg : m)));

    if (finalFile && p2pData) {
      const payload = JSON.stringify({
        type: 'file_start',
        msgId: finalMsg.id,
        totalChunks: p2pData.totalChunks,
        fileType: normalizedMime,
        isPasswordProtected: isProtected
      });

      if (isGroup) {
        groupMembers.forEach((member: any) => {
          if (member.user_id !== currentUser.id) {
            const channel = dataChannelsRef.current[member.user_id];
            if (channel && channel.readyState === 'open') {
              sendP2PChunksWithBackpressure(channel, payload, p2pData!.encryptedChunks);
            }
          }
        });
      } else {
        const targetChannel = dataChannelsRef.current[targetId];
        if (targetChannel && targetChannel.readyState === 'open') {
          sendP2PChunksWithBackpressure(targetChannel, payload, p2pData.encryptedChunks);
        }
      }
    }

    if (!overrideFile) clearImageSelection();
    setIsUploading(false);
    setUploadProgress(0);
  };

  const startAudioRecording = async () => {
    const targetId = (activeTab === 'contacts' || activeTab === 'global') ? selectedContact?.id : selectedGroup?.id;
    if ((activeTab === 'contacts' || activeTab === 'global') && targetId) {
      if (contactFaceStatusesRef.current[String(targetId)] === 'blocked') {
        alert('Este contacto está bloqueado. Desbloqueie para enviar áudio.');
        return;
      }
      if (blockedByUserIdsRef.current.includes(String(targetId))) {
        setSelectedContact(null);
        return;
      }
    }

    isPressingMicRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: HD_AUDIO_CONSTRAINTS
      });
      if (!isPressingMicRef.current) {
        stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
        return;
      }

      const preferredMime = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : '';

      const recorder = preferredMime
        ? new MediaRecorder(stream, { mimeType: preferredMime, audioBitsPerSecond: 128000 })
        : new MediaRecorder(stream, { audioBitsPerSecond: 128000 });

      audioChunksRef.current = [];
      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
        if (audioChunksRef.current.length > 0) {
          const finalAudioMime = preferredMime.includes('mp4') ? 'audio/mp4' : 'audio/webm';
          const ext = finalAudioMime.includes('mp4') ? 'm4a' : 'webm';
          const blob = new Blob(audioChunksRef.current, { type: finalAudioMime });
          const file = new File([blob], `audio_${Date.now()}.${ext}`, { type: finalAudioMime });
          executeSend(undefined, file, true);
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setIsRecordingAudio(true);
      setAudioTime(0);
      if (audioTimerRef.current) clearInterval(audioTimerRef.current);
      audioTimerRef.current = setInterval(() => setAudioTime((prev: number) => prev + 1), 1000);
    } catch {
      isPressingMicRef.current = false;
      alert('Para gravar áudios em HD, permita o acesso ao microfone.');
    }
  };

  const stopAudioRecording = useCallback((cancel: boolean = false) => {
    isPressingMicRef.current = false;
    if (cancel) audioChunksRef.current = [];
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecordingAudio(false);
    if (audioTimerRef.current) {
      clearInterval(audioTimerRef.current);
      audioTimerRef.current = null;
    }
  }, []);

  const proceedSelectUserToChat = useCallback((contact: any, tabOverride?: string) => {
    const contactId = contact?.id ? String(contact.id) : null;
    if (contactId && blockedByUserIdsRef.current.includes(contactId)) {
      return;
    }

    const currentTabMode = tabOverride || activeTab;
    setSelectedGroup(null);
    setSelectedContact(contact);
    setSelectedMessage(null);
    setShowHeaderTrashMenu(false);
    setOpenContactMenuId(null);

    activeChatContactIdRef.current = contactId;
    setMessages([]);
    loadHistoryForContactAndTab(contactId, currentTabMode);

    setUnreadSenders((prev: string[]) => prev.filter((id: string) => id !== contact.id));
    clearImageSelection();
    if (
      currentUser &&
      contactId &&
      !contactId.startsWith('offline-') &&
      contactFaceStatusesRef.current[contactId] !== 'blocked' &&
      !blockedByUserIdsRef.current.includes(contactId)
    ) {
      initializeWebRTC(contactId, true);
    }
  }, [
    activeTab,
    clearImageSelection,
    currentUser,
    initializeWebRTC,
    loadHistoryForContactAndTab,
    setMessages,
    setSelectedContact,
    setSelectedGroup,
    setUnreadSenders
  ]);

  const handleSelectUserToChat = useCallback((contact: any) => {
    const contactId = contact?.id ? String(contact.id) : null;
    if (contactId && blockedByUserIdsRef.current.includes(contactId)) {
      return;
    }

    if (activeTab === 'global' && contactId) {
      const pageConfig =
        globalPageConfigsRef.current[contactId] ||
        decodeGlobalPageFromProfileRow(contact);
      const myId = currentUser?.id ? String(currentUser.id) : '';
      const isMyOwnPage = Boolean(myId && myId === contactId);
      const isApprovedVisitor = Boolean(
        myId && (pageConfig?.approvedUserIds || []).map(String).includes(myId)
      );

      // 1. Quando a página for Privada: abre a popup de solicitação até ser Aceito pelo dono
      if (pageConfig?.visibility === 'private' && !isMyOwnPage && !isApprovedVisitor) {
        setPendingPrivatePageTarget(contact);
        return;
      }

      // 2. Quando a página for +18: abre a popup de confirmação de idade
      if (pageConfig?.is_adult && !isMyOwnPage && !verifiedAdultPageIds.includes(contactId)) {
        setPendingAdultTarget(contact);
        return;
      }
    }

    proceedSelectUserToChat(contact, activeTab);
  }, [
    activeTab,
    currentUser?.id,
    proceedSelectUserToChat,
    verifiedAdultPageIds
  ]);

  const handleConfirmAdultAge = useCallback(() => {
    if (!pendingAdultTarget?.id) {
      setPendingAdultTarget(null);
      return;
    }
    const targetId = String(pendingAdultTarget.id);
    const updated = Array.from(new Set([...verifiedAdultPageIds, targetId]));
    setVerifiedAdultPageIds(updated);
    try {
      sessionStorage.setItem('chatchat_verified_adult_pages', JSON.stringify(updated));
    } catch {}
    const targetToOpen = pendingAdultTarget;
    setPendingAdultTarget(null);
    proceedSelectUserToChat(targetToOpen, 'global');
  }, [pendingAdultTarget, proceedSelectUserToChat, verifiedAdultPageIds]);

  const handleManualDownload = async (msgId: string) => {
    const msg: ChatMessage | undefined = [...messages, ...groupMessages, ...galleryMessages].find((m: ChatMessage) => m.id === msgId);
    if (!msg || !msg.image_metadata) return;

    const existingUrl = msg.image_metadata.url || p2pMediaUrls[msgId];
    const hasCloudParts =
      Array.isArray(msg.image_metadata.p2p_info?.cloud_parts) &&
      msg.image_metadata.p2p_info!.cloud_parts!.length > 0;
    if (!existingUrl && !hasCloudParts) return;

    setUnlockingMsgId(msgId);
    try {
      let finalBlob: Blob;
      const isMe = msg.sender_id === currentUser?.id;

      if (msg.image_metadata.is_password_protected && !isMe && !unlockedImages.includes(msgId)) {
        const pwd = window.prompt('Esta mídia está protegida com senha P2P. Digite a senha:');
        if (!pwd) {
          setUnlockingMsgId(null);
          return;
        }
        const encryptedBuffer = await downloadMediaBufferFromMetadata(
          msg.image_metadata,
          existingUrl || undefined,
          (pct: number) => setDownloadProgressMap((prev: Record<string, number>) => ({ ...prev, [msgId]: pct }))
        );
        const key = await generateMasterKey(pwd);
        const decryptedBuffer = await decryptChunk(encryptedBuffer, key);
        const detectedMime = detectMimeFromBinary(
          decryptedBuffer,
          msg.image_metadata.original_name,
          Boolean(msg.image_metadata.is_video),
          Boolean(msg.image_metadata.is_audio)
        );
        finalBlob = new Blob([decryptedBuffer], { type: detectedMime });

        const updatedUnlocked = [...unlockedImages, msgId];
        setUnlockedImages(updatedUnlocked);
        localStorage.setItem('unlocked_p2p_images', JSON.stringify(updatedUnlocked));
      } else {
        const rawBuffer = await downloadMediaBufferFromMetadata(
          msg.image_metadata,
          existingUrl || undefined,
          (pct: number) => setDownloadProgressMap((prev: Record<string, number>) => ({ ...prev, [msgId]: pct }))
        );
        const detectedMime = detectMimeFromBinary(
          rawBuffer,
          msg.image_metadata.original_name,
          Boolean(msg.image_metadata.is_video),
          Boolean(msg.image_metadata.is_audio)
        );
        finalBlob = new Blob([rawBuffer], { type: detectedMime });
      }

      await saveToVault(msgId, finalBlob);
      hydratedIdsRef.current.add(msgId);
      const virtualUrl = URL.createObjectURL(finalBlob);
      setP2pMediaUrls((prev: Record<string, string>) => {
        if (prev[msgId] && prev[msgId] !== virtualUrl && prev[msgId].startsWith('blob:')) {
          URL.revokeObjectURL(prev[msgId]);
        }
        return { ...prev, [msgId]: virtualUrl };
      });

      setUnlockingMsgId(null);
      setDownloadProgressMap((prev: Record<string, number>) => {
        const next = { ...prev };
        delete next[msgId];
        return next;
      });
    } catch {
      setUnlockingMsgId(null);
      setDownloadProgressMap((prev: Record<string, number>) => {
        const next = { ...prev };
        delete next[msgId];
        return next;
      });
      alert('Senha incorreta ou erro ao transferir.');
    }
  };

  const handleDeleteGalleryItem = useCallback(async (item: ChatMessage) => {
    const id = item.id;
    await safePurgeCloudForMsg(item).catch(() => {});
    const updated = [...deletedForMeIds, id];
    setDeletedForMeIds(updated);
    localStorage.setItem('deleted_for_me', JSON.stringify(updated));
    await deleteFromVault(id);
    setP2pMediaUrls((prev: Record<string, string>) => {
      if (prev[id]?.startsWith('blob:')) URL.revokeObjectURL(prev[id]);
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSelectedGalleryItem(null);
  }, [deleteFromVault, deletedForMeIds, safePurgeCloudForMsg, setDeletedForMeIds]);

  const handleConfirmClearTotal = useCallback(async () => {
    await Promise.allSettled(groupMessages.map((gm: ChatMessage) => safePurgeCloudForMsg(gm)));
    confirmLimparTotal();
    setShowClearTotalPopup(false);
  }, [confirmLimparTotal, groupMessages, safePurgeCloudForMsg]);

  const isTypingText = (activeTab === 'contacts' || activeTab === 'global')
    ? newMessage.trim().length > 0
    : newGroupMessage.trim().length > 0;
  const canSend = isTypingText || selectedImage !== null;

  const isChatOpen =
    ((activeTab === 'contacts' || activeTab === 'global') && selectedContact !== null) ||
    (activeTab === 'groups' && selectedGroup !== null);

  const isPanelOpen = isChatOpen || activeTab === 'gallery';

  const visibleGlobalProfiles = useMemo(() => {
    const blockedBySet = new Set(blockedByUserIds);
    return globalProfiles.filter((p: UserProfile) => !blockedBySet.has(String(p.id)));
  }, [globalProfiles, blockedByUserIds]);

  const visibleSavedContacts = useMemo(() => {
    const deletedSet = new Set(deletedContactIds);
    const blockedBySet = new Set(blockedByUserIds);
    return mySavedContacts.filter(
      (c: SavedContact) => !deletedSet.has(String(c.id)) && !blockedBySet.has(String(c.id))
    );
  }, [mySavedContacts, deletedContactIds, blockedByUserIds]);

  const activeGlobalPageConfig: GlobalPageConfig | null = useMemo(() => {
    if (activeTab !== 'global' || !selectedContact?.id) return null;
    const cid = String(selectedContact.id);
    const existing =
      globalPageConfigs[cid] ||
      decodeGlobalPageFromProfileRow(selectedContact);
    if (existing) return existing;
    return {
      userId: cid,
      title: selectedContact.username || 'Página Global',
      description: '',
      avatar_url: selectedContact.avatar_url || null,
      visibility: 'public',
      handle: formatPageHandle(selectedContact.username || 'pagina'),
      hashtags: '',
      bio_link: '',
      is_adult: false,
      approvedUserIds: [],
      pendingRequests: [],
      rejectedUserIds: [],
      updated_at: ''
    };
  }, [activeTab, selectedContact, globalPageConfigs]);

  const myOwnGlobalPageConfig: GlobalPageConfig | null = useMemo(() => {
    if (!currentUser?.id) return null;
    return (
      globalPageConfigs[String(currentUser.id)] ||
      decodeGlobalPageFromProfileRow(currentUser) ||
      null
    );
  }, [currentUser, globalPageConfigs]);

  const myPendingAccessRequests: GlobalPageAccessRequest[] = useMemo(() => {
    return myOwnGlobalPageConfig?.pendingRequests || [];
  }, [myOwnGlobalPageConfig]);

  const displayedMessages = useMemo(() => {
    const rawList: ChatMessage[] = (activeTab === 'contacts' || activeTab === 'global') ? messages : groupMessages;
    return rawList.filter((m: ChatMessage) => {
      if (deletedForMeIds.includes(m.id)) return false;
      const meta = m.image_metadata as any;
      if (meta?.is_block_signal || meta?.is_global_page_config || meta?.is_global_page_access_request) {
        return false;
      }

      if (activeTab === 'global' && !Boolean(meta?.is_global_post)) return false;
      if (activeTab === 'contacts' && Boolean(meta?.is_global_post)) return false;

      const senderId = String(m.sender_id);
      if (
        senderId !== String(currentUser?.id) &&
        (contactFaceStatuses[senderId] === 'blocked' || blockedByUserIds.includes(senderId))
      ) {
        return false;
      }
      return true;
    });
  }, [activeTab, messages, groupMessages, deletedForMeIds, contactFaceStatuses, blockedByUserIds, currentUser?.id]);

  const displayedGallery = useMemo(() => {
    return (galleryMessages as ChatMessage[]).filter((m: ChatMessage) => {
      if (deletedForMeIds.includes(m.id)) return false;
      const meta = m.image_metadata as any;
      if (meta?.is_block_signal || meta?.is_global_page_config || meta?.is_global_page_access_request) {
        return false;
      }
      return Boolean(meta?.url || meta?.p2p_info?.cloud_parts);
    });
  }, [galleryMessages, deletedForMeIds]);

  if (loading) {
    return (
      <div className="fixed top-0 left-0 w-full h-[100dvh] bg-slate-50 flex items-center justify-center text-emerald-500 font-medium animate-pulse">
        A carregar o ChatChat...
      </div>
    );
  }

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes popup-open { 0% { opacity: 0; transform: scale(0.95) translateY(10px); } 100% { opacity: 1; transform: scale(1) translateY(0); } }
        .animate-popup { animation: popup-open 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        @keyframes shake {
          0%, 100% { transform: translateX(0) translateY(0); }
          10%, 30%, 50%, 70%, 90% { transform: translateX(-8px) translateY(-4px); }
          20%, 40%, 60%, 80% { transform: translateX(8px) translateY(4px); }
        }
        .animate-shake { animation: shake 0.6s cubic-bezier(.36,.07,.19,.97) both; }
      `}} />

      {/* MODAIS ISOLADOS (PARTE 3) */}
      <ChatModals
        currentUser={currentUser}
        globalPageConfigs={globalPageConfigs}
        pendingAdultTarget={pendingAdultTarget}
        setPendingAdultTarget={setPendingAdultTarget}
        handleConfirmAdultAge={handleConfirmAdultAge}
        pendingPrivatePageTarget={pendingPrivatePageTarget}
        setPendingPrivatePageTarget={setPendingPrivatePageTarget}
        handleRequestPrivatePageAccess={handleRequestPrivatePageAccess}
        selectedGalleryItem={selectedGalleryItem}
        setSelectedGalleryItem={setSelectedGalleryItem}
        p2pMediaUrls={p2pMediaUrls}
        unlockingMsgId={unlockingMsgId}
        downloadProgressMap={downloadProgressMap}
        handleManualDownload={handleManualDownload}
        onDeleteGalleryItem={handleDeleteGalleryItem}
        showAddContactModal={showAddContactModal}
        setShowAddContactModal={setShowAddContactModal}
        addModalTab={addModalTab}
        setAddModalTab={setAddModalTab}
        targetUserToAdd={targetUserToAdd}
        contactForm={contactForm}
        setContactForm={setContactForm}
        handleSearchUser={handleSearchUser}
        handlePhoneInputChange={handlePhoneInputChange}
        handleSaveContact={handleSaveContact}
        isSavingContact={isSavingContact}
        globalPageForm={globalPageForm}
        setGlobalPageForm={setGlobalPageForm}
        globalPageAvatarInputRef={globalPageAvatarInputRef}
        handleGlobalPageAvatarPick={handleGlobalPageAvatarPick}
        populateGlobalPageFormForCurrentUser={populateGlobalPageFormForCurrentUser}
        handleSaveGlobalPage={handleSaveGlobalPage}
        isSavingGlobalPage={isSavingGlobalPage}
        showClearTotalPopup={showClearTotalPopup}
        setShowClearTotalPopup={setShowClearTotalPopup}
        onConfirmClearTotal={handleConfirmClearTotal}
      />

      {/* CHAMADAS WEBRTC + BARRA FLUTUANTE */}
      {callStatus === 'ringing' && incomingCall && (
        <IncomingCall callerName={incomingCall.callerName} hasVideo={incomingCall.hasVideo} onAccept={acceptCall} onReject={rejectCall} />
      )}
      {(callStatus === 'calling' || callStatus === 'connected') && (
        <>
          <CallWindow
            localStream={localStream}
            remoteStream={remoteStream}
            isVideoCall={isVideoCall}
            remoteName={incomingCall?.callerName || selectedContact?.username || 'Desconhecido'}
            onEndCall={endCall}
            {...({
              isSpeakerphoneOn,
              onToggleSpeaker: toggleSpeakerphone,
              onSwitchCamera: handleFlipCallCamera
            } as any)}
          />

          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[10000] flex items-center gap-3 px-5 py-3 rounded-full bg-slate-950/85 border border-white/15 backdrop-blur-xl shadow-2xl">
            <button
              type="button"
              onClick={() => toggleSpeakerphone?.()}
              title={isSpeakerphoneOn ? 'Desativar Viva-voz' : 'Ativar Viva-voz'}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-full font-bold text-xs transition-all active:scale-95 ${
                isSpeakerphoneOn
                  ? 'bg-emerald-500 text-white ring-4 ring-emerald-400/30'
                  : 'bg-slate-800 text-slate-200 hover:bg-slate-700'
              }`}
            >
              <span className="text-base">{isSpeakerphoneOn ? '🔊' : '🔈'}</span>
              <span>{isSpeakerphoneOn ? 'Viva-voz ON' : 'Viva-voz'}</span>
            </button>

            {isVideoCall && (
              <button
                type="button"
                onClick={handleFlipCallCamera}
                title="Alternar entre Câmera Frontal e Traseira"
                className="flex items-center gap-2 px-4 py-2.5 rounded-full font-bold text-xs bg-slate-800 text-white hover:bg-slate-700 transition-all active:scale-95"
              >
                <span className="text-base">🔄</span>
                <span>Virar Câmera</span>
              </button>
            )}

            <button
              type="button"
              onClick={endCall}
              title="Encerrar Chamada"
              className="flex items-center gap-2 px-5 py-2.5 rounded-full font-bold text-xs bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-600/40 transition-all active:scale-95"
            >
              <span className="text-base">📞</span>
              <span>Desligar</span>
            </button>
          </div>
        </>
      )}

      {/* CÂMARA DE FOTOS E VÍDEOS */}
      {isCameraOpen && (
        <div className="fixed top-0 left-0 w-full h-[100dvh] z-[9999] bg-black flex flex-col animate-popup">
          <div className="flex-1 relative bg-black flex items-center justify-center overflow-hidden">
            <video ref={videoRef} autoPlay playsInline muted className={`w-full h-full object-cover ${facingMode === 'user' ? 'scale-x-[-1]' : ''}`} />
            <div className="absolute top-0 left-0 w-full p-6 flex justify-between items-center bg-gradient-to-b from-black/80 to-transparent z-50">
              <button onClick={closeCamera} className="text-white hover:text-rose-500 bg-white/10 px-4 py-2.5 rounded-full backdrop-blur-md font-bold text-sm">✕ Fechar</button>
              <button onClick={toggleCameraFacingMode} className="text-white hover:text-emerald-400 bg-white/10 px-4 py-2.5 rounded-full backdrop-blur-md font-bold text-sm flex items-center gap-1.5">
                <span>🔄</span>
                <span>Virar Câmera</span>
              </button>
            </div>
            <div className="absolute bottom-10 left-0 w-full flex flex-col items-center pb-6 bg-gradient-to-t from-black/80 to-transparent z-50">
              <button
                onMouseDown={handleCameraPressStart}
                onMouseUp={handleCameraPressEnd}
                onTouchStart={handleCameraPressStart}
                onTouchEnd={handleCameraPressEnd}
                className={`w-20 h-20 rounded-full border-[6px] transition-all duration-300 ${isRecording ? 'border-rose-500 bg-rose-500/50 scale-110' : 'border-white bg-white/20'}`}
              />
            </div>
          </div>
        </div>
      )}

      {/* WRAPPER PRINCIPAL */}
      <div className={`fixed top-0 left-0 w-full h-[100dvh] flex flex-row bg-[#f0f2f5] text-slate-900 overflow-hidden font-sans max-w-[100vw] ${isShaking ? 'animate-shake' : ''}`}>
        
        {/* NAVEGAÇÃO MOBILE INFERIOR */}
        <nav className={`${isChatOpen ? 'hidden' : 'flex'} md:hidden fixed bottom-0 left-0 w-full h-[65px] bg-white border-t border-slate-200 z-[60] flex-row items-center justify-around px-2 pb-1`}>
          <button
            onClick={() => {
              setActiveTab('global');
              setSelectedGroup(null);
              if (selectedContact?.id) loadHistoryForContactAndTab(String(selectedContact.id), 'global');
            }}
            className={`flex flex-col items-center justify-center gap-1 w-full h-full relative ${activeTab === 'global' ? 'text-emerald-500' : 'text-slate-500'}`}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
            <span className="text-[11px] font-bold">Global</span>
            {myPendingAccessRequests.length > 0 && (
              <span className="absolute top-1 right-4 w-4 h-4 rounded-full bg-amber-500 text-white text-[9px] font-bold flex items-center justify-center">
                {myPendingAccessRequests.length}
              </span>
            )}
          </button>
          <button
            onClick={() => {
              setActiveTab('contacts');
              setSelectedGroup(null);
              if (selectedContact?.id) loadHistoryForContactAndTab(String(selectedContact.id), 'contacts');
            }}
            className={`flex flex-col items-center justify-center gap-1 w-full h-full ${activeTab === 'contacts' ? 'text-emerald-500' : 'text-slate-500'}`}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
            <span className="text-[11px] font-bold">Contactos</span>
          </button>
          <button onClick={handleOpenGenericAddContact} className="flex flex-col items-center justify-center gap-1 w-full h-full text-slate-500 hover:text-emerald-500 transition">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="20" y1="8" x2="20" y2="14"></line><line x1="23" y1="11" x2="17" y2="11"></line></svg>
            <span className="text-[11px] font-bold">Adicionar</span>
          </button>
          <button onClick={() => { setActiveTab('groups'); setSelectedContact(null); }} className={`flex flex-col items-center justify-center gap-1 w-full h-full ${activeTab === 'groups' ? 'text-emerald-500' : 'text-slate-500'}`}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
            <span className="text-[11px] font-bold">Grupos</span>
          </button>
          <button onClick={() => { setActiveTab('gallery'); setSelectedContact(null); setSelectedGroup(null); fetchGalleryMedia(); }} className={`flex flex-col items-center justify-center gap-1 w-full h-full ${activeTab === 'gallery' ? 'text-emerald-500' : 'text-slate-500'}`}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M22 16V4c0-1.1-.9-2-2-2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2zm-11-4l2.03 2.71L16 11l4 5H8l3-4zM2 6v14c0 1.1.9 2 2 2h14v-2H4V6H2z"/></svg>
            <span className="text-[11px] font-bold">Galeria</span>
          </button>
        </nav>

        {/* SIDEBAR */}
        <aside className={`${isPanelOpen ? 'hidden md:flex' : 'flex'} w-full md:w-[320px] lg:w-[380px] flex-col bg-white border-r border-slate-200 z-10 pb-[65px] md:pb-0 h-full relative`}>
          
          <header className="flex flex-col w-full bg-[#f0f2f5] pt-3 pb-2 border-b border-slate-200 z-10 shrink-0">
            <div className="flex justify-between items-center px-3 h-[44px] gap-1">
              <button
                onClick={() => {
                  const targetId = selectedContact?.id ? String(selectedContact.id) : null;
                  if (
                    targetId &&
                    (contactFaceStatusesRef.current[targetId] === 'blocked' ||
                      blockedByUserIdsRef.current.includes(targetId))
                  ) {
                    return;
                  }
                  handleSendNudge();
                }}
                className="flex items-center gap-1.5 hover:opacity-80 transition cursor-pointer shrink-0"
                title="Chamar a atenção (Nudge)"
              >
                <svg viewBox="0 0 100 100" className="w-[32px] h-[32px] shrink-0">
                  <circle cx="50" cy="50" r="45" fill="#10b981" />
                  <circle cx="35" cy="50" r="9" fill="#ffffff" />
                  <circle cx="65" cy="50" r="9" fill="#ffffff" />
                </svg>
                <span className="text-[21px] font-extrabold tracking-tight" style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>
                  <span className="text-[#0e2138]">Chat</span><span className="text-[#10b981]">Chat</span>
                </span>
              </button>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleToggleAutoDownload}
                  title={autoDownload ? 'Auto-Download: ON (Sincroniza automaticamente no PC e Celular)' : 'Auto-Download: OFF (Economia — exibe apenas a imagem borrada até tocar)'}
                  className={`text-[11px] font-bold px-2 py-1.5 rounded-lg transition flex items-center gap-1 ${
                    autoDownload
                      ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                      : 'bg-slate-200 text-slate-600 hover:bg-slate-300'
                  }`}
                >
                  <span>{autoDownload ? '⚡ Auto: ON' : '⬇️ Auto: OFF'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleRegisterMyPhoneHash}
                  title="Vincular o meu telefone (SHA-256)"
                  className="text-[11px] font-bold text-emerald-700 bg-emerald-100 hover:bg-emerald-200 px-2 py-1.5 rounded-lg transition"
                >
                  🔒 Meu Nº
                </button>

                <input
                  type="file"
                  accept="image/*"
                  ref={avatarFileInputRef}
                  onChange={handleAvatarUploadChange}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => avatarFileInputRef.current?.click()}
                  disabled={isUpdatingAvatar}
                  title="Alterar a minha Foto de Perfil"
                  className="relative rounded-full ring-2 ring-emerald-500/40 hover:ring-emerald-500 transition active:scale-95 shrink-0 disabled:opacity-50"
                >
                  <Avatar
                    name={currentUser?.username || 'Eu'}
                    customEmoji={myAvatarUrl || currentUser?.avatar_url}
                    size="w-8 h-8"
                    fontSize="text-xs"
                  />
                </button>
              </div>
            </div>
          </header>

          <div className="hidden md:flex flex-row items-center justify-around px-2 py-2.5 border-b border-slate-100 bg-white gap-1">
            <button
              onClick={() => {
                setActiveTab('global');
                setSelectedGroup(null);
                setSelectedGalleryItem(null);
                if (selectedContact?.id) loadHistoryForContactAndTab(String(selectedContact.id), 'global');
              }}
              title="Páginas Globais"
              className={`p-2.5 rounded-xl transition flex items-center justify-center relative ${activeTab === 'global' ? 'bg-emerald-50 text-emerald-600 shadow-sm' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
              {myPendingAccessRequests.length > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center">
                  {myPendingAccessRequests.length}
                </span>
              )}
            </button>
            <button
              onClick={() => {
                setActiveTab('contacts');
                setSelectedGroup(null);
                setSelectedGalleryItem(null);
                if (selectedContact?.id) loadHistoryForContactAndTab(String(selectedContact.id), 'contacts');
              }}
              title="Adicionados"
              className={`p-2.5 rounded-xl transition flex items-center justify-center ${activeTab === 'contacts' ? 'bg-emerald-50 text-emerald-600 shadow-sm' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
            </button>
            <button onClick={handleOpenGenericAddContact} title="Adicionar Contacto ou Perfil Global" className="p-2.5 rounded-xl transition text-slate-500 hover:bg-slate-50 hover:text-emerald-500 flex items-center justify-center">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="20" y1="8" x2="20" y2="14"></line><line x1="23" y1="11" x2="17" y2="11"></line></svg>
            </button>
            <button onClick={() => { setActiveTab('groups'); setSelectedContact(null); setSelectedGalleryItem(null); }} title="Grupos" className={`p-2.5 rounded-xl transition flex items-center justify-center ${activeTab === 'groups' ? 'bg-emerald-50 text-emerald-600 shadow-sm' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
            </button>
            <button onClick={() => { setActiveTab('gallery'); setSelectedContact(null); setSelectedGroup(null); fetchGalleryMedia(); }} title="Galeria" className={`p-2.5 rounded-xl transition flex items-center justify-center ${activeTab === 'gallery' ? 'bg-emerald-50 text-emerald-600 shadow-sm' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M22 16V4c0-1.1-.9-2-2-2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2zm-11-4l2.03 2.71L16 11l4 5H8l3-4zM2 6v14c0 1.1.9 2 2 2h14v-2H4V6H2z"/></svg>
            </button>
          </div>

          <div onScroll={handleSidebarScroll} className="flex-1 overflow-y-auto custom-scrollbar no-scrollbar w-full relative bg-white pb-16 md:pb-0">
            {activeTab === 'global' ? (
              <div className="flex flex-col">
                <div className="px-4 py-3 bg-white sticky top-0 z-10 border-b border-slate-100 flex items-center justify-between gap-2">
                  <div className="flex flex-col">
                    <span className="font-bold text-slate-800 text-[16px]">Páginas Globais</span>
                    <span className="text-[12px] text-slate-500">Postagens globais, @, # e link da bio.</span>
                  </div>
                  <button
                    type="button"
                    onClick={handleOpenGlobalPageEditor}
                    className="text-xs font-bold text-emerald-600 bg-emerald-50 hover:bg-emerald-100 px-2.5 py-1.5 rounded-lg transition shrink-0"
                  >
                    ✏️ Alterar Nome / Página
                  </button>
                </div>

                {/* CARTÃO FIXO DA MINHA PRÓPRIA PÁGINA GLOBAL */}
                {currentUser && (
                  <div
                    onClick={() =>
                      handleSelectUserToChat({
                        id: currentUser.id,
                        username: myOwnGlobalPageConfig?.title || currentUser.username,
                        avatar_url: myOwnGlobalPageConfig?.avatar_url || myAvatarUrl || currentUser.avatar_url,
                        status: currentUser.status
                      })
                    }
                    className="w-full flex items-start justify-start gap-3.5 p-3 px-4 bg-emerald-50/50 hover:bg-emerald-50 border-b border-emerald-100 cursor-pointer transition-all"
                  >
                    <Avatar
                      name={myOwnGlobalPageConfig?.title || currentUser.username}
                      customEmoji={myOwnGlobalPageConfig?.avatar_url || myAvatarUrl || currentUser.avatar_url}
                    />
                    <div className="flex flex-col items-start flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 w-full flex-wrap">
                        <span className="text-[15px] font-extrabold text-emerald-950 truncate">
                          {myOwnGlobalPageConfig?.title || currentUser.username}
                        </span>
                        <span className="text-[10px] font-bold bg-emerald-500 text-white px-1.5 py-0.5 rounded">
                          Minha Página Global
                        </span>
                        <span className="text-[11px] text-slate-500 font-medium truncate">
                          {myOwnGlobalPageConfig?.handle || `@${currentUser.username}`}
                        </span>
                        {myOwnGlobalPageConfig?.visibility === 'private' ? (
                          <span className="text-[10px] font-bold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">
                            🔒 Privada
                          </span>
                        ) : (
                          <span className="text-[10px] font-bold bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded">
                            🌍 Pública
                          </span>
                        )}
                        {myOwnGlobalPageConfig?.is_adult && (
                          <span className="text-[10px] font-extrabold bg-rose-100 text-rose-600 px-1.5 py-0.5 rounded">
                            🔞 +18
                          </span>
                        )}
                      </div>
                      <span className="text-[12px] text-slate-600 line-clamp-2 text-left mt-0.5">
                        {myOwnGlobalPageConfig?.description || 'Toque aqui para abrir e publicar postagens na sua Página Global.'}
                      </span>
                      {myOwnGlobalPageConfig?.hashtags && (
                        <span className="text-[11px] font-semibold text-emerald-600 truncate w-full text-left mt-0.5">
                          {myOwnGlobalPageConfig.hashtags}
                        </span>
                      )}
                      {myOwnGlobalPageConfig?.bio_link && (
                        <a
                          href={normalizeExternalUrl(myOwnGlobalPageConfig.bio_link)}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e: React.MouseEvent) => e.stopPropagation()}
                          className="mt-1 inline-flex items-center gap-1 text-[11.5px] font-bold text-blue-600 hover:underline truncate max-w-full"
                        >
                          <span>🔗</span>
                          <span className="truncate">{myOwnGlobalPageConfig.bio_link}</span>
                        </a>
                      )}
                    </div>
                  </div>
                )}

                {/* PAINEL DE SOLICITAÇÕES DA MINHA PÁGINA PRIVADA (ACEITO / NÃO ACEITO) */}
                {myPendingAccessRequests.length > 0 && (
                  <div className="mx-3 my-2 p-3 rounded-xl bg-amber-50 border border-amber-200 flex flex-col gap-2">
                    <span className="text-xs font-extrabold text-amber-800">
                      🔒 Solicitações da Página Privada ({myPendingAccessRequests.length})
                    </span>
                    {myPendingAccessRequests.map((req: GlobalPageAccessRequest) => (
                      <div key={req.requesterId} className="flex items-center justify-between gap-2 bg-white p-2 rounded-lg border border-amber-100">
                        <div className="flex items-center gap-2 min-w-0">
                          <Avatar name={req.requesterName} customEmoji={req.requesterAvatar} size="w-8 h-8" fontSize="text-xs" />
                          <span className="text-xs font-bold text-slate-800 truncate">{req.requesterName}</span>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleRespondPrivatePageRequest(req.requesterId, true)}
                            className="px-2.5 py-1 rounded-md bg-emerald-500 hover:bg-emerald-600 text-white text-[11px] font-bold transition"
                          >
                            Aceito
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRespondPrivatePageRequest(req.requesterId, false)}
                            className="px-2.5 py-1 rounded-md bg-rose-500 hover:bg-rose-600 text-white text-[11px] font-bold transition"
                          >
                            Não aceito
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {visibleGlobalProfiles.slice(0, globalDisplayLimit).map((profile: UserProfile) => {
                  const pid = String(profile.id);
                  const pageCfg =
                    globalPageConfigs[pid] ||
                    decodeGlobalPageFromProfileRow(profile);
                  const displayTitle = pageCfg?.title || profile.username;
                  const displayAvatar = pageCfg?.avatar_url || profile.avatar_url;
                  const displayHandle = pageCfg?.handle || `@${profile.username}`;
                  const isPrivatePage = pageCfg?.visibility === 'private';
                  const isAdultPage = Boolean(pageCfg?.is_adult);
                  const myId = currentUser?.id ? String(currentUser.id) : '';
                  const canSeeFullPreview =
                    !isPrivatePage ||
                    pid === myId ||
                    Boolean(myId && (pageCfg?.approvedUserIds || []).map(String).includes(myId));

                  return (
                    <div
                      key={profile.id}
                      onClick={() => handleSelectUserToChat(profile)}
                      className="w-full flex items-start justify-start gap-3.5 p-3 px-4 transition-all hover:bg-slate-50 border-b border-slate-50 cursor-pointer"
                    >
                      <Avatar name={displayTitle} customEmoji={displayAvatar} />
                      <div className="flex flex-col items-start flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 w-full flex-wrap">
                          <span className="text-[15.5px] font-bold text-slate-900 truncate">
                            {displayTitle}
                          </span>
                          <span className="text-[11px] text-slate-400 font-medium truncate">
                            {displayHandle}
                          </span>
                          {isPrivatePage ? (
                            <span className="text-[10px] font-bold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">
                              🔒 Privada
                            </span>
                          ) : (
                            <span className="text-[10px] font-bold bg-emerald-50 text-emerald-600 px-1.5 py-0.5 rounded">
                              🌍 Pública
                            </span>
                          )}
                          {isAdultPage && (
                            <span className="text-[10px] font-extrabold bg-rose-100 text-rose-600 px-1.5 py-0.5 rounded">
                              🔞 +18
                            </span>
                          )}
                        </div>

                        <span className="text-[12.5px] text-slate-600 line-clamp-2 text-left mt-0.5">
                          {canSeeFullPreview
                            ? pageCfg?.description || 'Tocar para ver página'
                            : '🔒 Página privada — tocar para solicitar acesso'}
                        </span>

                        {canSeeFullPreview && pageCfg?.hashtags && (
                          <span className="text-[11px] font-semibold text-emerald-600 truncate w-full text-left mt-0.5">
                            {pageCfg.hashtags}
                          </span>
                        )}

                        {canSeeFullPreview && pageCfg?.bio_link && (
                          <a
                            href={normalizeExternalUrl(pageCfg.bio_link)}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e: React.MouseEvent) => e.stopPropagation()}
                            className="mt-1 inline-flex items-center gap-1 text-[11.5px] font-bold text-blue-600 hover:underline truncate max-w-full"
                          >
                            <span>🔗</span>
                            <span className="truncate">{pageCfg.bio_link}</span>
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : activeTab === 'contacts' ? (
              <div className="flex flex-col">
                <div className="px-4 py-3 flex items-center justify-between text-slate-700 font-bold text-[15px] border-b border-slate-100 bg-white sticky top-0 z-10">
                  <span>Meus Contactos</span>
                  <button onClick={handleOpenGenericAddContact} className="text-xs font-bold text-emerald-600 hover:underline">
                    + Adicionar
                  </button>
                </div>
                {visibleSavedContacts.length === 0 ? (
                  <div className="p-6 text-center text-slate-400 text-sm mt-4">Não tem contactos adicionados.</div>
                ) : (
                  visibleSavedContacts.map((contact: SavedContact) => {
                    const cleanContactStatus = extractCleanPresenceStatus(contact.status);
                    const statusInfo = getStatusDisplay(cleanContactStatus);
                    const idStr = String(contact.id);
                    const faceState: ContactFaceStatus = contactFaceStatuses[idStr] || 'normal';
                    const faceFillColor =
                      faceState === 'blocked'
                        ? '#ef4444'
                        : faceState === 'muted'
                        ? '#eab308'
                        : '#10b981';

                    return (
                      <div
                        key={contact.id}
                        onClick={() => handleSelectUserToChat(contact)}
                        className="w-full flex items-center justify-between gap-3 p-3 px-4 transition-all hover:bg-slate-50 active:bg-slate-100 border-b border-slate-50 cursor-pointer relative"
                      >
                        <div className="flex items-center gap-4 flex-1 min-w-0">
                          <div className="relative shrink-0">
                            <Avatar name={contact.savedName} customEmoji={contact.avatar_url} />
                            {statusInfo.text === 'Online' && faceState !== 'blocked' && (
                              <span className="absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-white bg-emerald-500 z-20"></span>
                            )}
                          </div>
                          <div className="flex flex-col items-start flex-1 min-w-0">
                            <span className="text-[16px] font-bold text-slate-900 truncate w-full text-left">
                              {contact.savedName}
                            </span>
                            <span className="text-[13px] text-slate-500 truncate w-full text-left">
                              {faceState === 'blocked' ? (
                                <span className="text-rose-600 font-semibold">Bloqueado</span>
                              ) : faceState === 'muted' ? (
                                <span className="text-amber-600 font-semibold">Silenciado</span>
                              ) : statusInfo.text !== 'Online' && statusInfo.text !== 'Offline' ? (
                                statusInfo.text
                              ) : (
                                'Tocar para conversar...'
                              )}
                            </span>
                          </div>
                        </div>

                        <div className="relative shrink-0" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={(e: React.MouseEvent) => {
                              e.stopPropagation();
                              setOpenContactMenuId((prev: string | null) => (prev === idStr ? null : idStr));
                            }}
                            title="Opções do contacto"
                            className="p-1.5 rounded-full hover:bg-slate-200/70 active:scale-95 transition flex items-center justify-center"
                          >
                            <svg viewBox="0 0 100 100" className="w-[30px] h-[30px] shrink-0 drop-shadow-sm transition-colors duration-200">
                              <circle cx="50" cy="50" r="45" fill={faceFillColor} />
                              <circle cx="35" cy="50" r="9" fill="#ffffff" />
                              <circle cx="65" cy="50" r="9" fill="#ffffff" />
                            </svg>
                          </button>

                          {openContactMenuId === idStr && (
                            <div
                              onClick={(e: React.MouseEvent) => e.stopPropagation()}
                              className="absolute right-0 top-11 w-48 bg-white rounded-xl shadow-[0_8px_28px_rgba(0,0,0,0.18)] border border-slate-100 overflow-hidden z-[90] flex flex-col py-1 animate-popup"
                            >
                              <button
                                type="button"
                                onClick={() => handleToggleContactFaceStatus(idStr, 'muted')}
                                className="px-3.5 py-2.5 text-left text-[13.5px] font-semibold text-amber-600 hover:bg-amber-50 flex items-center gap-2.5 transition"
                              >
                                <svg viewBox="0 0 100 100" className="w-5 h-5 shrink-0">
                                  <circle cx="50" cy="50" r="45" fill="#eab308" />
                                  <circle cx="35" cy="50" r="9" fill="#ffffff" />
                                  <circle cx="65" cy="50" r="9" fill="#ffffff" />
                                </svg>
                                <span>{faceState === 'muted' ? 'Ativar som' : 'Silenciar'}</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => handleToggleContactFaceStatus(idStr, 'blocked')}
                                className="px-3.5 py-2.5 text-left text-[13.5px] font-semibold text-rose-600 hover:bg-rose-50 flex items-center gap-2.5 transition border-t border-slate-50"
                              >
                                <svg viewBox="0 0 100 100" className="w-5 h-5 shrink-0">
                                  <circle cx="50" cy="50" r="45" fill="#ef4444" />
                                  <circle cx="35" cy="50" r="9" fill="#ffffff" />
                                  <circle cx="65" cy="50" r="9" fill="#ffffff" />
                                </svg>
                                <span>{faceState === 'blocked' ? 'Desbloquear' : 'Bloquear'}</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => handleExcludeContactFromList(contact)}
                                className="px-3.5 py-2.5 text-left text-[13.5px] font-bold text-slate-700 hover:bg-slate-100 flex items-center gap-2.5 transition border-t border-slate-100"
                              >
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-rose-500 shrink-0">
                                  <polyline points="3 6 5 6 21 6"></polyline>
                                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                </svg>
                                <span>Excluir contato</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            ) : activeTab === 'groups' ? (
              <div className="flex flex-col">
                <div className="flex items-center justify-between w-full p-2 border-b border-slate-100 pr-4 sticky top-0 bg-white z-10">
                  <button onClick={handleCreateGroup} className="flex items-center gap-3 p-2 text-emerald-600 font-bold active:bg-slate-100 rounded-xl hover:bg-slate-50 transition">
                    <div className="w-9 h-9 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
                      <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                    </div>
                    Novo Grupo
                  </button>
                  <button onClick={() => setShowGroupTrashMenu(!showGroupTrashMenu)} className="p-2 text-slate-400 hover:text-rose-500 rounded-full transition">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6"/></svg>
                  </button>
                </div>

                {showGroupTrashMenu && (
                  <div className="absolute top-14 right-4 w-40 bg-white rounded-xl shadow-[0_4px_20px_rgba(0,0,0,0.15)] border border-slate-100 overflow-hidden z-[70] flex flex-col">
                    <button onClick={() => { setShowGroupTrashMenu(false); handleGroupTrash('limpar'); }} className="px-4 py-3 text-left text-[14px] font-semibold text-slate-700 hover:bg-slate-50 border-b border-slate-50">Limpar</button>
                    <button onClick={() => { setShowGroupTrashMenu(false); handleGroupTrash('limpar_tudo'); }} className="px-4 py-3 text-left text-[14px] font-semibold text-slate-700 hover:bg-slate-50 border-b border-slate-50">Limpar Tudo</button>
                    <button onClick={() => { setShowGroupTrashMenu(false); setShowClearTotalPopup(true); }} className="px-4 py-3 text-left text-[14px] font-bold text-rose-600 hover:bg-rose-50">Limpar Total</button>
                  </div>
                )}

                {communityGroups.map((group: any) => (
                  <button key={group.id} onClick={() => { setSelectedGroup(group); setSelectedContact(null); }} className="w-full flex items-center justify-start gap-4 p-3 px-4 transition-all hover:bg-slate-50 border-b border-slate-50">
                    <Avatar name={group.name} customEmoji={group.is_private ? '🔒' : '👥'} />
                    <div className="flex flex-col items-start flex-1 min-w-0">
                      <span className="text-[16px] font-bold text-slate-900 truncate w-full text-left">{group.name}</span>
                      <span className="text-[13px] text-slate-500 truncate w-full text-left">Tocar para abrir</span>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex flex-col">
                <div className="flex items-center justify-between p-4 border-b border-slate-100 bg-white sticky top-0 z-20 relative">
                  <span className="font-bold text-slate-700">Mídias Guardadas</span>
                  <button onClick={() => setShowGalleryTrashMenu(!showGalleryTrashMenu)} className="text-rose-500 font-bold text-sm px-2 py-1 bg-rose-50 rounded-lg hover:bg-rose-100 transition">Limpar</button>
                  {showGalleryTrashMenu && (
                    <div className="absolute top-14 right-4 w-48 bg-white rounded-xl shadow-[0_4px_20px_rgba(0,0,0,0.15)] border border-slate-100 overflow-hidden z-[70] flex flex-col">
                      <button onClick={() => { setShowGalleryTrashMenu(false); handleGalleryTrash('apagar_pra_mim'); }} className="px-4 py-3 text-left text-[14px] font-semibold text-slate-700 hover:bg-slate-50 border-b border-slate-50">Apagar para mim (Local)</button>
                      <button
                        onClick={async () => {
                          setShowGalleryTrashMenu(false);
                          await Promise.allSettled(galleryMessages.map((item: ChatMessage) => safePurgeCloudForMsg(item)));
                          handleGalleryTrash('apagar_tudo');
                        }}
                        className="px-4 py-3 text-left text-[14px] font-bold text-rose-600 hover:bg-rose-50"
                      >
                        Apagar tudo (Nuvem e Local)
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </aside>

        {/* ECRÃ PRINCIPAL */}
        <main className={`${isPanelOpen ? 'flex' : 'hidden md:flex'} flex-1 flex-col bg-[#efeae2] relative overflow-hidden z-20 h-full w-full min-w-0`}>
          <div className="absolute inset-0 z-0 opacity-20 pointer-events-none" style={{ backgroundImage: 'url("https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png")', backgroundRepeat: 'repeat', backgroundSize: '400px' }}></div>

          {activeTab === 'gallery' ? (
            <div className="flex flex-col h-full w-full min-w-0 bg-white relative z-10 pb-[65px] md:pb-4">
              <div className="flex md:hidden items-center justify-between px-4 py-3 border-b border-slate-200 bg-[#f0f2f5] shrink-0 relative">
                <span className="font-bold text-slate-800 text-[16px]">Mídias Guardadas</span>
                <button onClick={() => setShowGalleryTrashMenu(!showGalleryTrashMenu)} className="text-rose-500 font-bold text-xs px-2.5 py-1.5 bg-rose-50 rounded-lg hover:bg-rose-100 transition">
                  Limpar
                </button>
                {showGalleryTrashMenu && (
                  <div className="absolute top-12 right-4 w-48 bg-white rounded-xl shadow-[0_4px_20px_rgba(0,0,0,0.15)] border border-slate-100 overflow-hidden z-[70] flex flex-col">
                    <button onClick={() => { setShowGalleryTrashMenu(false); handleGalleryTrash('apagar_pra_mim'); }} className="px-4 py-3 text-left text-[14px] font-semibold text-slate-700 hover:bg-slate-50 border-b border-slate-50">Apagar para mim (Local)</button>
                    <button
                      onClick={async () => {
                        setShowGalleryTrashMenu(false);
                        await Promise.allSettled(galleryMessages.map((item: ChatMessage) => safePurgeCloudForMsg(item)));
                        handleGalleryTrash('apagar_tudo');
                      }}
                      className="px-4 py-3 text-left text-[14px] font-bold text-rose-600 hover:bg-rose-50"
                    >
                      Apagar tudo (Nuvem e Local)
                    </button>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 p-3 gap-2 overflow-y-auto custom-scrollbar flex-1">
                {displayedGallery.map((item: ChatMessage) => {
                  const isLocked = item.image_metadata?.is_password_protected && item.sender_id !== currentUser?.id && !unlockedImages.includes(item.id);
                  const isVideo = item.image_metadata?.is_video;
                  const isAudio = item.image_metadata?.is_audio;
                  const localVaultUrl = p2pMediaUrls[item.id] || (!isLocked ? item.image_metadata?.url : null);
                  const previewBlur = item.image_metadata?.preview_base64;

                  return (
                    <div key={item.id} onClick={() => setSelectedGalleryItem(item)} className="aspect-square bg-slate-100 rounded-xl relative cursor-pointer overflow-hidden border border-slate-200 hover:shadow-md transition">
                      <div className="absolute top-2 left-2 z-20 bg-black/40 backdrop-blur-md rounded px-1.5 py-0.5 text-white flex items-center shadow-sm">
                        {isVideo ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                        ) : isAudio ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
                        )}
                      </div>
                      {isAudio ? (
                        <div className="w-full h-full flex flex-col items-center justify-center bg-slate-800 text-emerald-400 gap-2">
                          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>
                        </div>
                      ) : localVaultUrl && !isLocked ? (
                        isVideo ? (
                          <video src={localVaultUrl} playsInline preload="metadata" className="w-full h-full object-cover bg-black" muted />
                        ) : (
                          <img src={localVaultUrl} alt="Galeria" className="w-full h-full object-cover" />
                        )
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center bg-slate-900 text-xs text-white gap-1 relative overflow-hidden">
                          {previewBlur && (
                            <img src={previewBlur} alt="" className="absolute inset-0 w-full h-full object-cover blur-md scale-110 opacity-65" />
                          )}
                          <span className="relative z-10 text-lg">{isLocked ? '🔒' : '⬇️'}</span>
                          <span className="relative z-10 text-[10px] font-bold">{isLocked ? 'Protegido' : '⬇️ Baixar Mídia'}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : isChatOpen ? (
            <div className="flex flex-col h-full w-full min-w-0 relative z-10">
              
              {/* CABEÇALHO DO CHAT / PÁGINA GLOBAL */}
              <header className="h-[60px] md:h-[65px] w-full bg-[#f0f2f5] flex items-center px-2 shadow-sm z-20 shrink-0 border-b border-slate-200">
                {selectedMessage ? (
                  <div className="flex items-center justify-between w-full bg-emerald-500/10 h-full px-2">
                    <div className="flex items-center gap-3">
                      <button onClick={() => { setSelectedMessage(null); setShowHeaderTrashMenu(false); }} className="p-2 hover:bg-slate-200/50 rounded-full transition text-slate-600">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                      </button>
                      <span className="font-bold text-slate-800 text-[16px]">1 Selecionada</span>
                    </div>

                    <div className="flex items-center gap-2 md:gap-3 text-slate-600 pr-2 relative">
                      {(selectedMessage.image_metadata?.url || p2pMediaUrls[selectedMessage.id] || selectedMessage.image_metadata?.p2p_info?.cloud_parts) && (
                        <button onClick={() => { handleManualDownload(selectedMessage.id); setSelectedMessage(null); }} className="p-2 hover:bg-slate-200/50 rounded-full transition" title="Transferir / Desbloquear">
                          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                        </button>
                      )}

                      <button onClick={() => setShowHeaderTrashMenu(!showHeaderTrashMenu)} className="p-2 hover:bg-slate-200/50 rounded-full transition" title="Apagar">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                      </button>

                      {showHeaderTrashMenu && (
                        <div className="absolute top-12 right-0 w-48 bg-white border border-slate-200 rounded-xl shadow-[0_4px_20px_rgba(0,0,0,0.15)] z-50 overflow-hidden flex flex-col py-1 animate-popup">
                          <button onClick={() => { setShowHeaderTrashMenu(false); handleDeleteMessage(selectedMessage, 'me'); setSelectedMessage(null); }} className="px-4 py-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50 transition">Apagar para mim</button>
                          {selectedMessage.sender_id === currentUser?.id && !selectedMessage.image_metadata?.is_deleted && (
                            <button
                              onClick={async () => {
                                setShowHeaderTrashMenu(false);
                                await safePurgeCloudForMsg(selectedMessage).catch(() => {});
                                handleDeleteMessage(selectedMessage, 'all');
                                setSelectedMessage(null);
                              }}
                              className="px-4 py-3 text-left text-sm font-bold text-rose-600 hover:bg-rose-50 transition"
                            >
                              Apagar para todos
                            </button>
                          )}
                          <div className="w-full h-[1px] bg-slate-100 my-1"></div>
                          <button onClick={() => { setShowHeaderTrashMenu(false); handleClearChat(); setSelectedMessage(null); }} className="px-4 py-3 text-left text-sm font-bold text-rose-600 hover:bg-rose-50 transition">Limpar conversa</button>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                    <button onClick={() => { setSelectedContact(null); setSelectedGroup(null); }} className="md:hidden flex items-center justify-center p-2 mr-1 text-slate-800 rounded-full active:bg-slate-200 shrink-0">
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    </button>

                    <div className="flex items-center flex-1 min-w-0 pl-1">
                      <Avatar
                        name={
                          activeTab === 'global'
                            ? activeGlobalPageConfig?.title || selectedContact?.username
                            : activeTab === 'contacts'
                            ? selectedContact?.savedName || selectedContact?.username
                            : selectedGroup?.name
                        }
                        customEmoji={
                          activeTab === 'global'
                            ? activeGlobalPageConfig?.avatar_url || selectedContact?.avatar_url
                            : activeTab === 'contacts'
                            ? selectedContact?.avatar_url
                            : (selectedGroup?.is_private ? '🔒' : '👥')
                        }
                        size="w-10 h-10"
                      />
                      <div className="flex flex-col ml-3 flex-1 min-w-0">
                        <h3 className="font-bold text-slate-900 text-[16px] truncate">
                          {activeTab === 'global'
                            ? activeGlobalPageConfig?.title || selectedContact?.username
                            : activeTab === 'contacts'
                            ? selectedContact?.savedName || selectedContact?.username
                            : selectedGroup?.name}
                        </h3>
                        {(activeTab === 'contacts' || activeTab === 'global') && selectedContact && (
                          <span className="text-[12px] text-slate-500 truncate">
                            {activeTab === 'global'
                              ? `${activeGlobalPageConfig?.handle || '@' + selectedContact.username} • ${
                                  activeGlobalPageConfig?.visibility === 'private' ? '🔒 Página Privada' : '🌍 Página Pública'
                                }`
                              : 'Chat Direto'}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 md:gap-3 text-slate-600 pr-2 shrink-0">
                      {activeTab === 'contacts' && selectedContact && (
                        <>
                          <button
                            onClick={() => {
                              const cid = String(selectedContact.id);
                              if (contactFaceStatusesRef.current[cid] === 'blocked') {
                                alert('Desbloqueie este contacto antes de iniciar uma chamada.');
                                return;
                              }
                              if (blockedByUserIdsRef.current.includes(cid)) return;
                              startCall(selectedContact.id, true);
                            }}
                            className="p-2 hover:bg-slate-200 rounded-full transition"
                            title="Chamada de Vídeo"
                          >
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>
                          </button>
                          <button
                            onClick={() => {
                              const cid = String(selectedContact.id);
                              if (contactFaceStatusesRef.current[cid] === 'blocked') {
                                alert('Desbloqueie este contacto antes de iniciar uma chamada.');
                                return;
                              }
                              if (blockedByUserIdsRef.current.includes(cid)) return;
                              startCall(selectedContact.id, false);
                            }}
                            className="p-2 hover:bg-slate-200 rounded-full transition"
                            title="Chamada de Áudio"
                          >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                          </button>
                        </>
                      )}

                      {activeTab === 'global' && selectedContact && (
                        <>
                          {currentUser?.id && String(selectedContact.id) === String(currentUser.id) && (
                            <button
                              type="button"
                              onClick={handleOpenGlobalPageEditor}
                              className="text-xs font-bold text-emerald-700 bg-emerald-100 hover:bg-emerald-200 px-3 py-1.5 rounded-full transition"
                            >
                              ✏️ Alterar Nome
                            </button>
                          )}
                          <div className="flex flex-col items-center justify-center mr-1">
                            <button
                              onClick={() => handleToggleFollow(selectedContact.id)}
                              className={`font-bold text-[11px] px-4 py-1.5 rounded-full transition shadow-sm ${followedIds.includes(selectedContact.id) ? 'bg-slate-200 text-slate-700 hover:bg-slate-300' : 'bg-emerald-500 text-white hover:bg-emerald-600'}`}
                            >
                              {followedIds.includes(selectedContact.id) ? 'A Seguir' : 'Seguir'}
                            </button>
                            <span className="text-[10px] text-slate-500 mt-1 font-medium leading-none">
                              {followerCounts[selectedContact.id] || 0} seguidores
                            </span>
                          </div>
                          {(!currentUser?.id || String(selectedContact.id) !== String(currentUser.id)) && (
                            <button onClick={() => handleOpenAddContact(selectedContact)} className="p-2 hover:bg-slate-200 rounded-full transition text-slate-500" title="Adicionar aos Contactos">
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="20" y1="8" x2="20" y2="14"></line><line x1="23" y1="11" x2="17" y2="11"></line></svg>
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </>
                )}
              </header>

              {/* CARTÃO COMPLETO DO PERFIL GLOBAL ABAIXO DO CABEÇALHO (NOME, @ DA PÁGINA, DESCRIÇÃO, # DA PÁGINA, LINK DA BIO E SOLICITAÇÕES) — VISÍVEL APENAS NA ABA GLOBAL */}
              {activeTab === 'global' && activeGlobalPageConfig && (
                <div className="bg-white/95 backdrop-blur-sm border-b border-slate-200 px-4 py-3 z-20 flex flex-col gap-2 shrink-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar
                        name={activeGlobalPageConfig.title}
                        customEmoji={activeGlobalPageConfig.avatar_url || selectedContact?.avatar_url}
                        size="w-12 h-12"
                        fontSize="text-base"
                      />
                      <div className="flex flex-col min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-extrabold text-slate-900 text-sm truncate">
                            {activeGlobalPageConfig.title}
                          </span>
                          <span className="text-xs text-slate-500 font-medium">
                            {activeGlobalPageConfig.handle}
                          </span>
                          {activeGlobalPageConfig.visibility === 'private' ? (
                            <span className="text-[10px] font-bold bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
                              🔒 Privada
                            </span>
                          ) : (
                            <span className="text-[10px] font-bold bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">
                              🌍 Pública
                            </span>
                          )}
                          {activeGlobalPageConfig.is_adult && (
                            <span className="text-[10px] font-extrabold bg-rose-100 text-rose-600 px-2 py-0.5 rounded-full">
                              🔞 +18
                            </span>
                          )}
                        </div>

                        <p className="text-xs text-slate-600 leading-relaxed mt-0.5">
                          {activeGlobalPageConfig.description || 'Sem descrição na página global.'}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* ABAIXO DO NOME: @ DA PÁGINA, # DA PÁGINA E LINK DA BIO (EXCLUSIVOS DA PÁGINA GLOBAL) */}
                  <div className="flex flex-wrap items-center gap-3 pt-0.5">
                    <span className="text-xs font-semibold text-slate-500">
                      {activeGlobalPageConfig.handle}
                    </span>
                    {activeGlobalPageConfig.hashtags && (
                      <span className="text-xs font-bold text-emerald-600">
                        {activeGlobalPageConfig.hashtags}
                      </span>
                    )}
                    {activeGlobalPageConfig.bio_link && (
                      <a
                        href={normalizeExternalUrl(activeGlobalPageConfig.bio_link)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-bold text-blue-600 hover:underline"
                      >
                        <span>🔗</span>
                        <span>{activeGlobalPageConfig.bio_link}</span>
                      </a>
                    )}
                  </div>

                  {currentUser?.id &&
                    String(selectedContact?.id) === String(currentUser.id) &&
                    (activeGlobalPageConfig.pendingRequests?.length || 0) > 0 && (
                      <div className="mt-1 pt-2 border-t border-amber-200 flex flex-col gap-1.5">
                        <span className="text-[11px] font-extrabold text-amber-700">
                          🔒 Solicitações pendentes para esta página ({activeGlobalPageConfig.pendingRequests!.length}):
                        </span>
                        {activeGlobalPageConfig.pendingRequests!.map((req: GlobalPageAccessRequest) => (
                          <div key={req.requesterId} className="flex items-center justify-between bg-amber-50/80 px-2.5 py-1.5 rounded-lg">
                            <span className="text-xs font-bold text-slate-800 truncate">{req.requesterName}</span>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleRespondPrivatePageRequest(req.requesterId, true)}
                                className="px-2.5 py-1 rounded bg-emerald-500 hover:bg-emerald-600 text-white text-[11px] font-bold transition"
                              >
                                Aceito
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRespondPrivatePageRequest(req.requesterId, false)}
                                className="px-2.5 py-1 rounded bg-rose-500 hover:bg-rose-600 text-white text-[11px] font-bold transition"
                              >
                                Não aceito
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                </div>
              )}

              {/* LISTA VIRTUALIZADA */}
              <div className="flex-1 w-full relative z-10 bg-transparent min-h-0">
                <Virtuoso
                  style={{ height: '100%', width: '100%' }}
                  data={displayedMessages}
                  initialTopMostItemIndex={Math.max(0, displayedMessages.length - 1)}
                  followOutput="smooth"
                  itemContent={(_index: number, msg: ChatMessage) => {
                    const isMe = msg.sender_id === currentUser?.id;
                    const isLocked = msg.image_metadata?.is_password_protected && !isMe && !unlockedImages.includes(msg.id);
                    const hasCloudParts =
                      Array.isArray(msg.image_metadata?.p2p_info?.cloud_parts) &&
                      msg.image_metadata!.p2p_info!.cloud_parts!.length > 0;
                    const hasMediaAttachment = Boolean(
                      msg.image_metadata?.url ||
                      msg.image_metadata?.preview ||
                      msg.image_metadata?.preview_base64 ||
                      hasCloudParts ||
                      msg.image_metadata?.is_video ||
                      msg.image_metadata?.is_audio
                    );

                    const localVaultUrl =
                      p2pMediaUrls[msg.id] ||
                      msg.image_metadata?.preview ||
                      (!isLocked && !hasCloudParts && (autoDownload || isMe) ? msg.image_metadata?.url : null) ||
                      null;

                    const isSelected = selectedMessage?.id === msg.id;
                    const dlPercent = downloadProgressMap[msg.id];
                    const fileSizeLabel = formatBytes(msg.image_metadata?.p2p_info?.expected_size);
                    const videoDurationLabel = formatDuration(msg.image_metadata?.p2p_info?.duration_sec);

                    const bubbleBg = isMe
                      ? (isSelected ? 'bg-emerald-300 ring-2 ring-emerald-500/50 scale-[1.01]' : 'bg-[#dcf8c6]')
                      : (isSelected ? 'bg-emerald-200 ring-2 ring-emerald-500/50 scale-[1.01]' : 'bg-white');

                    return (
                      <div className="px-3 md:px-6 py-1 w-full group relative">
                        {isSelected && <div className="absolute inset-0 bg-emerald-500/10 z-0 transition-opacity"></div>}

                        <div className={`flex relative z-10 w-full ${isMe ? 'justify-end' : 'justify-start'}`}>
                          <div
                            onClick={() => { setSelectedMessage(isSelected ? null : msg); setShowHeaderTrashMenu(false); }}
                            className={`max-w-[85%] md:max-w-[65%] px-2 pt-1.5 pb-5 text-[14.5px] md:text-[15.5px] shadow-sm relative break-words whitespace-pre-wrap cursor-pointer transition-all duration-200 ${bubbleBg} ${isMe ? 'rounded-xl rounded-tr-none' : 'rounded-xl rounded-tl-none'} ${msg.image_metadata?.is_deleted ? 'text-slate-500 italic opacity-80' : ''}`}
                          >
                            {msg.image_metadata?.is_deleted ? (
                              <span className="flex items-center gap-1.5 opacity-80 mt-1 mr-4">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg>
                                Mensagem apagada
                              </span>
                            ) : (
                              <>
                                {msg.image_metadata && msg.image_metadata.is_audio && !msg.image_metadata.is_nudge ? (
                                  localVaultUrl && !isLocked ? (
                                    <CustomAudioPlayer src={localVaultUrl} isMe={isMe} />
                                  ) : (
                                    <div
                                      onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleManualDownload(msg.id); }}
                                      className="flex items-center gap-3 px-3 py-2 bg-slate-800 text-white rounded-xl min-w-[200px] cursor-pointer hover:bg-slate-700 transition"
                                    >
                                      <span className="text-lg">🎙️</span>
                                      <div className="flex flex-col">
                                        <span className="text-xs font-bold text-emerald-400">
                                          {dlPercent !== undefined
                                            ? `A transferir áudio... ${dlPercent}%`
                                            : isLocked
                                            ? '🔒 Desbloquear Áudio'
                                            : `⬇️ Baixar Áudio ${fileSizeLabel ? `(${fileSizeLabel})` : ''}`}
                                        </span>
                                      </div>
                                    </div>
                                  )
                                ) : hasMediaAttachment && msg.image_metadata && !msg.image_metadata.is_nudge ? (
                                  <div className="mb-1 mt-1 relative rounded-lg overflow-hidden bg-slate-900 min-w-[210px]">
                                    {!localVaultUrl || isLocked ? (
                                      <div
                                        onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleManualDownload(msg.id); }}
                                        className="w-full h-52 flex flex-col items-center justify-center bg-slate-900 text-white p-4 gap-2 cursor-pointer hover:bg-slate-800 transition relative overflow-hidden"
                                      >
                                        {msg.image_metadata.preview_base64 && !isLocked && (
                                          <img
                                            src={msg.image_metadata.preview_base64}
                                            alt="Pré-visualização Borrada"
                                            className="absolute inset-0 w-full h-full object-cover blur-md scale-110 opacity-75"
                                          />
                                        )}
                                        <div className="relative z-10 flex flex-col items-center justify-center bg-black/55 backdrop-blur-md px-4 py-3 rounded-2xl border border-white/15 shadow-lg gap-1.5 text-center">
                                          {dlPercent !== undefined || unlockingMsgId === msg.id ? (
                                            <>
                                              <div className="w-36 h-2 bg-white/20 rounded-full overflow-hidden">
                                                <div
                                                  className="h-full bg-emerald-400 transition-all duration-200"
                                                  style={{ width: `${dlPercent || 25}%` }}
                                                />
                                              </div>
                                              <span className="text-xs font-bold text-emerald-400">
                                                A descarregar... {dlPercent || 25}%
                                              </span>
                                            </>
                                          ) : (
                                            <>
                                              <span className="text-2xl">
                                                {isLocked ? '🔒' : msg.image_metadata.is_video ? '🎬' : '📷'}
                                              </span>
                                              <span className="text-xs font-bold text-white">
                                                {isLocked ? 'Desbloquear com senha' : '⬇️ Baixar Mídia'}
                                              </span>
                                              {(fileSizeLabel || videoDurationLabel) && (
                                                <span className="text-[11px] text-emerald-300 font-medium">
                                                  {[videoDurationLabel, fileSizeLabel].filter(Boolean).join(' • ')}
                                                </span>
                                              )}
                                            </>
                                          )}
                                        </div>
                                      </div>
                                    ) : msg.image_metadata.is_video ? (
                                      <div className="relative">
                                        <video
                                          key={localVaultUrl}
                                          src={localVaultUrl}
                                          controls
                                          playsInline
                                          preload="auto"
                                          onLoadedMetadata={(e: React.SyntheticEvent<HTMLVideoElement>) => fixVideoDurationAndPlayback(e.currentTarget)}
                                          onPlay={(e: React.SyntheticEvent<HTMLVideoElement>) => {
                                            const v = e.currentTarget;
                                            if (isFinite(v.duration) && v.duration > 0 && v.currentTime >= v.duration - 0.1) {
                                              v.currentTime = 0;
                                            }
                                          }}
                                          onEnded={(e: React.SyntheticEvent<HTMLVideoElement>) => {
                                            e.currentTarget.currentTime = 0;
                                          }}
                                          className="w-full max-h-[320px] object-contain relative z-10 bg-black rounded-lg"
                                          onClick={(e: React.MouseEvent) => e.stopPropagation()}
                                        />
                                        {msg.image_metadata.is_uploading && uploadProgress > 0 && (
                                          <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center z-20 gap-2 p-4">
                                            <div className="w-full max-w-[160px] h-2 bg-white/20 rounded-full overflow-hidden">
                                              <div className="h-full bg-emerald-400 transition-all duration-200" style={{ width: `${uploadProgress}%` }} />
                                            </div>
                                            <span className="text-xs font-bold text-white">A enviar... {uploadProgress}%</span>
                                          </div>
                                        )}
                                      </div>
                                    ) : (
                                      <img
                                        src={localVaultUrl}
                                        alt="Anexo"
                                        className="w-full max-h-[300px] object-contain relative z-10 rounded-lg"
                                      />
                                    )}
                                  </div>
                                ) : null}

                                {msg.content && (
                                  <p className="leading-relaxed relative z-10 ml-1 mr-8 mt-0.5">{msg.content}</p>
                                )}
                              </>
                            )}

                            <div className="absolute bottom-1 right-2 flex items-center gap-1 text-[10px] md:text-[11px] text-[#667781] z-10">
                              <span>{new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                              {isMe && <span className="text-[#53bdeb] ml-[-2px] tracking-tighter">✓✓</span>}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  }}
                />
              </div>

              {/* BARRA DE PREVIEW */}
              {imagePreview && (
                <div className="px-4 py-2.5 bg-[#f0f2f5] border-t border-slate-200 flex items-center justify-between gap-3 z-20 animate-popup">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    {isFileVideo ? (
                      <video src={imagePreview} playsInline preload="metadata" className="h-14 w-14 object-cover rounded-xl border border-slate-300 shrink-0 bg-black" muted />
                    ) : (
                      <img src={imagePreview} alt="Preview" className="h-14 w-14 object-cover rounded-xl border border-slate-300 shrink-0" />
                    )}
                    <div className="flex flex-col flex-1 max-w-xs">
                      <span className="text-xs font-bold text-slate-700 truncate mb-1">
                        {isUploading && uploadProgress > 0
                          ? `A enviar (${uploadProgress}%)...`
                          : (selectedImage?.name || 'Anexo')}
                      </span>
                      <input
                        type="password"
                        placeholder="Senha P2P (opcional)"
                        value={customPassword}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCustomPassword(e.target.value)}
                        disabled={isUploading}
                        className="px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500 text-slate-800"
                      />
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={clearImageSelection}
                    disabled={isUploading}
                    className="p-2 text-rose-500 hover:bg-rose-100 rounded-full font-bold text-sm transition disabled:opacity-40"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* BARRA DE INPUT */}
              <form
                onSubmit={(e: React.FormEvent) => {
                  e.preventDefault();
                  if (!isRecordingAudio && canSend) executeSend();
                }}
                className="px-2 py-2.5 bg-[#f0f2f5] flex items-end gap-2 shrink-0 z-20 w-full min-w-0"
              >
                {isRecordingAudio ? (
                  <div className="flex-1 flex items-center bg-white rounded-full shadow-sm min-h-[45px] md:min-h-[50px] px-4 gap-3 overflow-hidden border border-rose-200">
                    <div className="w-3 h-3 bg-rose-500 rounded-full animate-pulse shrink-0"></div>
                    <span className="text-rose-600 font-bold text-[15px] w-12 shrink-0">
                      {Math.floor(audioTime / 60)}:{(audioTime % 60).toString().padStart(2, '0')}
                    </span>
                    <span className="text-[10px] font-bold bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full shrink-0">
                      48kHz HD
                    </span>
                    <div className="flex-1 flex items-center gap-[3px] h-6 overflow-hidden justify-center">
                      {[...Array(18)].map((_, i: number) => (
                        <div
                          key={i}
                          className="w-[3px] bg-rose-400 rounded-full animate-pulse"
                          style={{ height: `${25 + ((i * 19) % 70)}%`, animationDelay: `${i * 0.08}s`, animationDuration: '0.8s' }}
                        />
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => stopAudioRecording(true)}
                      className="text-xs font-bold text-rose-600 hover:bg-rose-50 px-3 py-1.5 rounded-full transition shrink-0"
                    >
                      Cancelar
                    </button>
                  </div>
                ) : (
                  <div className="flex-1 flex items-end bg-white rounded-3xl shadow-sm min-w-0 min-h-[45px] md:min-h-[50px] overflow-hidden px-1">
                    <button type="button" className="p-2 ml-1 text-slate-500 hover:text-emerald-500 transition shrink-0 rounded-full flex items-center justify-center">
                      <svg viewBox="0 0 24 24" className="w-[26px] h-[26px]" fill="currentColor">
                        <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 18c-4.411 0-8-3.589-8-8s3.589-8 8-8 8 3.589 8 8-3.589 8-8 8zm3.21-4.21a1.5 1.5 0 0 0-2.12-2.12c-.29.29-.68.42-1.09.42s-.8-.13-1.09-.42a1.5 1.5 0 1 0-2.12 2.12A4.478 4.478 0 0 0 12 17.5a4.478 4.478 0 0 0 3.21-1.71zM8.5 11.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm7 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/>
                      </svg>
                    </button>

                    <input
                      type="text"
                      placeholder={activeTab === 'global' ? 'Publicar postagem na Página Global...' : 'Mensagem'}
                      value={(activeTab === 'contacts' || activeTab === 'global') ? newMessage : newGroupMessage}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => (activeTab === 'contacts' || activeTab === 'global') ? setNewMessage(e.target.value) : setNewGroupMessage(e.target.value)}
                      disabled={isUploading}
                      className="flex-1 bg-transparent text-[16px] text-slate-900 placeholder-slate-400 focus:outline-none py-3.5 h-full min-w-0"
                    />

                    <div className="flex items-center pr-2 shrink-0 pb-1.5 gap-1">
                      <input type="file" accept="image/*,video/*" className="hidden" ref={fileInputRef} onChange={handleImageSelect} disabled={isUploading} />
                      <button type="button" onClick={() => fileInputRef.current?.click()} className="p-2 text-slate-500 -rotate-45 hover:text-emerald-500 transition rounded-full">
                        <svg className="w-[24px] h-[24px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                      </button>
                      <button type="button" onClick={() => openCamera()} className="p-2 text-slate-500 hover:text-emerald-500 transition rounded-full">
                        <svg className="w-[24px] h-[24px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2v2"/><circle cx="12" cy="13" r="4"/></svg>
                      </button>
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  onPointerDown={(e: React.PointerEvent<HTMLButtonElement>) => {
                    if (!canSend && !isRecordingAudio) {
                      e.currentTarget.setPointerCapture(e.pointerId);
                      startAudioRecording();
                    }
                  }}
                  onPointerUp={(e: React.PointerEvent<HTMLButtonElement>) => {
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                      e.currentTarget.releasePointerCapture(e.pointerId);
                    }
                    if (isRecordingAudio || isPressingMicRef.current) {
                      stopAudioRecording(false);
                    } else if (canSend) {
                      executeSend();
                    }
                  }}
                  onPointerCancel={(e: React.PointerEvent<HTMLButtonElement>) => {
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                      e.currentTarget.releasePointerCapture(e.pointerId);
                    }
                    if (isRecordingAudio || isPressingMicRef.current) {
                      stopAudioRecording(true);
                    }
                  }}
                  disabled={isUploading}
                  className="w-[50px] h-[50px] rounded-full bg-[#00a884] hover:bg-emerald-600 transition text-white flex items-center justify-center shadow-md shrink-0 active:scale-95 mb-0.5 touch-none select-none"
                >
                  {isUploading ? (
                    <div className="w-6 h-6 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  ) : canSend || isRecordingAudio ? (
                    <svg className="w-[22px] h-[22px] ml-1 mt-0.5" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                  ) : (
                    <svg className="w-[22px] h-[22px]" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>
                  )}
                </button>
              </form>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-6 relative bg-[#f0f2f5] pb-20 md:pb-0">
              <div className="w-80 h-80 opacity-50 mb-8" style={{ backgroundImage: 'url("https://static.whatsapp.net/rsrc.php/v3/y6/r/wa669aeJeom.png")', backgroundSize: 'contain', backgroundRepeat: 'no-repeat', backgroundPosition: 'center' }}></div>
              <h2 className="text-[32px] font-light text-slate-700 mb-4">ChatChat para Web</h2>
              <p className="text-slate-500 text-[14px] max-w-md leading-relaxed">Envie e receba mensagens rapidamente.<br/>Selecione uma conversa ao lado para começar.</p>
            </div>
          )}
        </main>
      </div>
    </>
  );
}