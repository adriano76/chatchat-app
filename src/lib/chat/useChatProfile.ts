// Caminho: src/hooks/chat/useChatProfile.ts
'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import {
  type GlobalPageConfig,
  type GlobalPageAccessRequest,
  GLOBAL_PAGES_STORAGE_KEY,
  getContactsStorageKey,
  getMyAvatarStorageKey,
  formatPageHandle,
  formatPageHashtags,
  generateCompressedAvatarDataUrl
} from '@/lib/chat/contactUtils';
import type { UserProfile, SavedContact } from '@/app/types/chat';
import type { GlobalPageFormState } from '@/components/chat/ChatModals';

interface UseChatProfileParams {
  currentUser: UserProfile | null;
  globalProfiles: UserProfile[];
  setMySavedContacts: React.Dispatch<React.SetStateAction<SavedContact[]>>;
  selectedContact: any;
  setSelectedContact: React.Dispatch<React.SetStateAction<any>>;
  setActiveTab: React.Dispatch<React.SetStateAction<any>>;
  setShowAddContactModal: React.Dispatch<React.SetStateAction<boolean>>;
  setAddModalTab: React.Dispatch<React.SetStateAction<'contact' | 'global_profile'>>;
  setTargetUserToAdd: React.Dispatch<React.SetStateAction<UserProfile | null>>;
}

export function useChatProfile({
  currentUser,
  globalProfiles,
  setMySavedContacts,
  selectedContact,
  setSelectedContact,
  setActiveTab,
  setShowAddContactModal,
  setAddModalTab,
  setTargetUserToAdd
}: UseChatProfileParams) {
  const [myAvatarUrl, setMyAvatarUrl] = useState<string | null>(null);
  const [isUpdatingAvatar, setIsUpdatingAvatar] = useState(false);
  const avatarFileInputRef = useRef<HTMLInputElement>(null);

  const [globalPageConfigs, setGlobalPageConfigs] = useState<Record<string, GlobalPageConfig>>({});
  const globalPageConfigsRef = useRef<Record<string, GlobalPageConfig>>({});

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
  const [isSavingGlobalPage, setIsSavingGlobalPage] = useState(false);
  const globalPageAvatarInputRef = useRef<HTMLInputElement>(null);

  const [verifiedAdultPageIds, setVerifiedAdultPageIds] = useState<string[]>([]);
  const [pendingAdultTarget, setPendingAdultTarget] = useState<any | null>(null);
  const [pendingPrivatePageTarget, setPendingPrivatePageTarget] = useState<any | null>(null);

  useEffect(() => {
    globalPageConfigsRef.current = globalPageConfigs;
  }, [globalPageConfigs]);

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

  // Carrega a foto de perfil do utilizador atual
  useEffect(() => {
    if (!currentUser?.id) return;
    const myId = String(currentUser.id);
    const avatarKey = getMyAvatarStorageKey(myId);

    try {
      const cachedAvatar = localStorage.getItem(avatarKey);
      if (cachedAvatar) setMyAvatarUrl(cachedAvatar);
      else if (currentUser.avatar_url) setMyAvatarUrl(currentUser.avatar_url);
    } catch {}

    const fetchMyLatestAvatar = async () => {
      try {
        const { data } = await supabase
          .from('profiles')
          .select('avatar_url')
          .eq('id', myId)
          .maybeSingle();
        if (data?.avatar_url) {
          setMyAvatarUrl(data.avatar_url);
          try {
            localStorage.setItem(avatarKey, data.avatar_url);
          } catch {}
        }
      } catch {}
    };
    fetchMyLatestAvatar();
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
      const next = prev.map((c) => {
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
      setGlobalPageForm((prev) => ({ ...prev, avatar_url: dataUrl }));
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
  }, [populateGlobalPageFormForCurrentUser, setAddModalTab, setShowAddContactModal, setTargetUserToAdd]);

  const publishGlobalPageConfigToSupabase = useCallback(async (myId: string, configToPublish: GlobalPageConfig) => {
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
  }, []);

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

      setGlobalPageConfigs((prev) => {
        const updated = { ...prev, [myId]: newPageConfig };
        globalPageConfigsRef.current = updated;
        try {
          localStorage.setItem(GLOBAL_PAGES_STORAGE_KEY, JSON.stringify(updated));
        } catch {}
        return updated;
      });

      try {
        await supabase
          .from('profiles')
          .update({
            username: cleanTitle,
            avatar_url: chosenAvatar,
            updated_at: new Date().toISOString()
          })
          .eq('id', myId);

        if (chosenAvatar) {
          setMyAvatarUrl(chosenAvatar);
          try {
            localStorage.setItem(getMyAvatarStorageKey(myId), chosenAvatar);
          } catch {}
        }
      } catch {}

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

    setGlobalPageConfigs((prev) => {
      const existing = prev[targetId] || {
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
      if (currentPending.some((r) => String(r.requesterId) === myId)) {
        return prev;
      }

      const updatedCfg: GlobalPageConfig = {
        ...existing,
        pendingRequests: [...currentPending, requestObj],
        rejectedUserIds: (existing.rejectedUserIds || []).filter((id) => String(id) !== myId)
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
    alert('Solicitação enviada! Assim que o criador da página aceitar, terá acesso às postagens.');
  }, [currentUser, myAvatarUrl]);

  // Dono da Página Global Privada responde à solicitação: Aceitar (true) ou Não aceitar (false)
  const handleRespondPrivatePageRequest = useCallback(async (requesterId: string, accept: boolean) => {
    if (!currentUser?.id) return;
    const myId = String(currentUser.id);
    const reqId = String(requesterId);

    const existing = globalPageConfigsRef.current[myId];
    if (!existing) return;

    const updatedPending = (existing.pendingRequests || []).filter(
      (r) => String(r.requesterId) !== reqId
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

    setGlobalPageConfigs((prev) => {
      const next = { ...prev, [myId]: updatedConfig };
      globalPageConfigsRef.current = next;
      try {
        localStorage.setItem(GLOBAL_PAGES_STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });

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

    await publishGlobalPageConfigToSupabase(myId, updatedConfig);
  }, [currentUser?.id, publishGlobalPageConfigToSupabase]);

  return {
    myAvatarUrl,
    setMyAvatarUrl,
    isUpdatingAvatar,
    avatarFileInputRef,
    handleAvatarUploadChange,
    globalPageConfigs,
    setGlobalPageConfigs,
    globalPageConfigsRef,
    globalPageForm,
    setGlobalPageForm,
    isSavingGlobalPage,
    globalPageAvatarInputRef,
    handleGlobalPageAvatarPick,
    populateGlobalPageFormForCurrentUser,
    handleOpenGlobalPageEditor,
    handleSaveGlobalPage,
    verifiedAdultPageIds,
    setVerifiedAdultPageIds,
    pendingAdultTarget,
    setPendingAdultTarget,
    pendingPrivatePageTarget,
    setPendingPrivatePageTarget,
    handleRequestPrivatePageAccess,
    handleRespondPrivatePageRequest
  };
}