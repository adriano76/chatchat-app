// src/hooks/useChatEngine.ts
'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useRouter } from 'next/navigation';
import { useLocalVault } from '@/hooks/useLocalVault';

export function useChatEngine() {
  const router = useRouter();
  const { deleteFromVault } = useLocalVault();

  const [currentUser, setCurrentUser] = useState<any>(null);
  const [globalProfiles, setGlobalProfiles] = useState<any[]>([]);
  const [mySavedContacts, setMySavedContacts] = useState<any[]>([]);
  const [followedIds, setFollowedIds] = useState<string[]>([]);
  const [followerCounts, setFollowerCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  const [activeTab, setActiveTab] = useState<'global' | 'contacts' | 'groups' | 'gallery'>('global');
  const [selectedContact, setSelectedContact] = useState<any>(null);
  const [selectedGroup, setSelectedGroup] = useState<any>(null);

  const [messages, setMessages] = useState<any[]>([]);
  const [unreadSenders, setUnreadSenders] = useState<string[]>([]);
  const [communityGroups, setCommunityGroups] = useState<any[]>([]);
  const [groupMessages, setGroupMessages] = useState<any[]>([]);
  const [groupMembers, setGroupMembers] = useState<any[]>([]);
  const [galleryMessages, setGalleryMessages] = useState<any[]>([]);

  const [deletedForMeIds, setDeletedForMeIds] = useState<string[]>([]);
  const [isShaking, setIsShaking] = useState(false);

  const activeTabRef = useRef(activeTab);
  const selectedContactRef = useRef(selectedContact);
  const selectedGroupRef = useRef(selectedGroup);

  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  useEffect(() => { selectedContactRef.current = selectedContact; }, [selectedContact]);
  useEffect(() => { selectedGroupRef.current = selectedGroup; }, [selectedGroup]);

  // 1. Iniciar Storage Local
  useEffect(() => {
    try {
      const saved = localStorage.getItem('deleted_for_me');
      if (saved) setDeletedForMeIds(JSON.parse(saved));
      const savedContactsStr = localStorage.getItem('my_saved_contacts');
      if (savedContactsStr) setMySavedContacts(JSON.parse(savedContactsStr));
    } catch (e) {}
  }, []);

  // 2. Sincronizar Seguidores
  useEffect(() => {
    async function loadFollowsAndCounts() {
      if (!currentUser) return;
      try {
        const { data: myFollows } = await supabase.from('followers').select('following_id').eq('follower_id', currentUser.id);
        if (myFollows) setFollowedIds(myFollows.map((f) => f.following_id));

        const { data: allFollowers } = await supabase.from('followers').select('following_id');
        if (allFollowers) {
          const counts: Record<string, number> = {};
          allFollowers.forEach((f) => { counts[f.following_id] = (counts[f.following_id] || 0) + 1; });
          setFollowerCounts(counts);
        }
      } catch (err) {}
    }
    loadFollowsAndCounts();
  }, [currentUser]);

  // 2.5 NOVO: Carregar Histórico e Membros quando um Grupo é selecionado
  useEffect(() => {
    async function loadGroupDetails() {
      if (!currentUser || !selectedGroup) return;
      const [msgsRes, membersRes] = await Promise.all([
        supabase.from('group_messages').select('*').eq('group_id', selectedGroup.id).order('created_at', { ascending: true }),
        supabase.from('group_members').select('*').eq('group_id', selectedGroup.id)
      ]);
      if (msgsRes.data) setGroupMessages(msgsRes.data);
      if (membersRes.data) setGroupMembers(membersRes.data);
    }
    loadGroupDetails();
  }, [currentUser, selectedGroup]);

  // 3. WebSockets em Tempo Real (Sem contaminação de conversas)
  useEffect(() => {
    if (!currentUser) return;

    const channel = supabase.channel('realtime-messages')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'private_messages' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          const novaMensagem = payload.new;
          const isIncoming = novaMensagem.receiver_id === currentUser.id;
          const isOutgoing = novaMensagem.sender_id === currentUser.id;

          if (!isIncoming && !isOutgoing) return;

          if (novaMensagem.image_metadata?.is_nudge && isIncoming) {
            setIsShaking(true);
            setTimeout(() => setIsShaking(false), 800);
          }

          const activePartnerId = selectedContactRef.current?.id;
          const isCurrentOpenChat =
            (activeTabRef.current === 'contacts' || activeTabRef.current === 'global') &&
            ((isIncoming && activePartnerId === novaMensagem.sender_id) ||
             (isOutgoing && activePartnerId === novaMensagem.receiver_id));

          if (isCurrentOpenChat) {
            setMessages((prev) => {
              // Evita duplicar se já existir ou se ainda estiver com ID otimista temp-
              if (prev.some((m) => m.id === novaMensagem.id)) return prev;
              const tempIdx = prev.findIndex(
                (m) => String(m.id).startsWith('temp-') && m.sender_id === novaMensagem.sender_id && m.content === novaMensagem.content
              );
              if (tempIdx !== -1) {
                const clone = [...prev];
                clone[tempIdx] = novaMensagem;
                return clone;
              }
              return [...prev, novaMensagem];
            });
          } else if (isIncoming) {
            setUnreadSenders((prev) => (prev.includes(novaMensagem.sender_id) ? prev : [...prev, novaMensagem.sender_id]));
          }
        } else if (payload.eventType === 'UPDATE') {
          setMessages((prev) => prev.map((m) => (m.id === payload.new.id ? payload.new : m)));
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'group_messages' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          const novaMensagem = payload.new;
          if (selectedGroupRef.current?.id !== novaMensagem.group_id) return;

          if (novaMensagem.image_metadata?.is_nudge && novaMensagem.sender_id !== currentUser.id && activeTabRef.current === 'groups') {
            setIsShaking(true);
            setTimeout(() => setIsShaking(false), 800);
          }

          setGroupMessages((prev) => {
            if (prev.some((m) => m.id === novaMensagem.id)) return prev;
            const tempIdx = prev.findIndex(
              (m) => String(m.id).startsWith('gtemp-') && m.sender_id === novaMensagem.sender_id && m.content === novaMensagem.content
            );
            if (tempIdx !== -1) {
              const clone = [...prev];
              clone[tempIdx] = novaMensagem;
              return clone;
            }
            return [...prev, novaMensagem];
          });
        } else if (payload.eventType === 'UPDATE') {
          setGroupMessages((prev) => prev.map((m) => (m.id === payload.new.id ? payload.new : m)));
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [currentUser]);

  // 4. Busca da Galeria
  const fetchGalleryMedia = useCallback(async () => {
    if (!currentUser) return;
    try {
      const { data: privData } = await supabase
        .from('private_messages')
        .select('*')
        .not('image_metadata', 'is', null)
        .or(`sender_id.eq.${currentUser.id},receiver_id.eq.${currentUser.id}`)
        .order('created_at', { ascending: false });
      const { data: grpData } = await supabase
        .from('group_messages')
        .select('*')
        .not('image_metadata', 'is', null)
        .order('created_at', { ascending: false });

      const combined = [...(privData || []), ...(grpData || [])]
        .filter((m) => !m.image_metadata?.is_nudge && !m.image_metadata?.is_deleted)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      setGalleryMessages(combined);
    } catch (err) {}
  }, [currentUser]);

  useEffect(() => {
    if (currentUser && activeTab === 'gallery') fetchGalleryMedia();
  }, [currentUser, activeTab, fetchGalleryMedia]);

  // 5. Iniciação Segura de Sessão
  useEffect(() => {
    async function loadData() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) return router.push('/login');
      setCurrentUser(session.user);

      const { data: profiles } = await supabase.from('profiles').select('*').neq('id', session.user.id).order('username', { ascending: true });
      if (profiles) setGlobalProfiles(profiles);

      const { data: grps } = await supabase.from('groups').select('*').order('created_at', { ascending: false });
      if (grps) setCommunityGroups(grps);
      setLoading(false);
    }
    loadData();
  }, [router]);

  const handleToggleFollow = async (targetUserId: string) => {
    if (!currentUser) return;
    const isCurrentlyFollowing = followedIds.includes(targetUserId);

    if (isCurrentlyFollowing) {
      setFollowedIds((prev) => prev.filter((id) => id !== targetUserId));
      setFollowerCounts((prev) => ({ ...prev, [targetUserId]: Math.max(0, (prev[targetUserId] || 1) - 1) }));
      await supabase.from('followers').delete().eq('follower_id', currentUser.id).eq('following_id', targetUserId);
    } else {
      setFollowedIds((prev) => [...prev, targetUserId]);
      setFollowerCounts((prev) => ({ ...prev, [targetUserId]: (prev[targetUserId] || 0) + 1 }));
      await supabase.from('followers').insert([{ follower_id: currentUser.id, following_id: targetUserId }]);
    }
  };

  // CORRIGIDO: Não envia `id: tempId` para o banco de dados PostgreSQL
  const handleSendNudge = async () => {
    const targetId = (activeTab === 'contacts' || activeTab === 'global') ? selectedContact?.id : selectedGroup?.id;
    if (!currentUser || !targetId) {
      alert('Selecione uma conversa primeiro para chamar a atenção!');
      return;
    }
    if (targetId.startsWith('offline-')) {
      alert('Este utilizador foi criado offline e não está ligado à Rede Global.');
      return;
    }

    setIsShaking(true);
    setTimeout(() => setIsShaking(false), 800);

    const isGroup = activeTab === 'groups';
    const tempId = (isGroup ? 'gtemp-' : 'temp-') + Date.now();

    const dbPayload = {
      sender_id: currentUser.id,
      ...(isGroup ? { group_id: targetId } : { receiver_id: targetId }),
      content: '👋 Chamou a atenção!',
      image_metadata: { is_nudge: true }
    };

    const optimisticMsg = {
      ...dbPayload,
      id: tempId,
      created_at: new Date().toISOString(),
      is_read: false
    };

    if (isGroup) setGroupMessages((prev) => [...prev, optimisticMsg]);
    else setMessages((prev) => [...prev, optimisticMsg]);

    const { data } = await supabase.from(isGroup ? 'group_messages' : 'private_messages').insert([dbPayload]).select();
    if (data && data[0]) {
      if (isGroup) setGroupMessages((prev) => prev.map((m) => (m.id === tempId ? data[0] : m)));
      else setMessages((prev) => prev.map((m) => (m.id === tempId ? data[0] : m)));
    }
  };

  const handleDeleteMessage = async (msg: any, type: 'me' | 'all') => {
    if (type === 'me') {
      const updated = Array.from(new Set([...deletedForMeIds, msg.id]));
      setDeletedForMeIds(updated);
      localStorage.setItem('deleted_for_me', JSON.stringify(updated));
    } else if (type === 'all') {
      const isGroup = msg.group_id != null;
      const tableName = isGroup ? 'group_messages' : 'private_messages';
      const payload = { content: '🚫 Mensagem apagada', image_metadata: { is_deleted: true } };

      if (isGroup) setGroupMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, ...payload } : m)));
      else setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, ...payload } : m)));

      await supabase.from(tableName).update(payload).eq('id', msg.id);
    }
  };

  const handleClearChat = () => {
    if (!selectedContact && !selectedGroup) return false;
    if (window.confirm('Limpar todas as mensagens desta conversa?')) {
      const isGroup = activeTab === 'groups';
      const targetId = isGroup ? selectedGroup?.id : selectedContact?.id;

      const idsToClear = isGroup
        ? groupMessages.filter((m) => m.group_id === targetId).map((m) => m.id)
        : messages.filter((m) =>
            (m.sender_id === targetId && m.receiver_id === currentUser?.id) ||
            (m.receiver_id === targetId && m.sender_id === currentUser?.id)
          ).map((m) => m.id);

      const updated = Array.from(new Set([...deletedForMeIds, ...idsToClear]));
      setDeletedForMeIds(updated);
      try { localStorage.setItem('deleted_for_me', JSON.stringify(updated)); } catch (e) {}
      return true;
    }
    return false;
  };

  const handleGroupTrash = (action: string) => {
    if (action === 'limpar') {
      if (!selectedGroup) { alert('Por favor, selecione um grupo.'); return false; }
      if (window.confirm(`Deseja esconder as mensagens de "${selectedGroup.name}"?`)) {
        const currentGroupMsgs = groupMessages.filter((m) => m.group_id === selectedGroup.id).map((m) => m.id);
        const updated = Array.from(new Set([...deletedForMeIds, ...currentGroupMsgs]));
        setDeletedForMeIds(updated);
        try { localStorage.setItem('deleted_for_me', JSON.stringify(updated)); } catch (e) {}
      }
    } else if (action === 'limpar_tudo') {
      if (window.confirm('Limpar os textos de TODOS os grupos?')) {
        const allGroupMsgIds = groupMessages.map((m) => m.id);
        const updated = Array.from(new Set([...deletedForMeIds, ...allGroupMsgIds]));
        setDeletedForMeIds(updated);
        try { localStorage.setItem('deleted_for_me', JSON.stringify(updated)); } catch (e) {}
      }
    }
    return true;
  };

  const confirmLimparTotal = async () => {
    const allGroupMsgIds = groupMessages.map((m) => m.id);
    const updated = Array.from(new Set([...deletedForMeIds, ...allGroupMsgIds]));
    setDeletedForMeIds(updated);
    try { localStorage.setItem('deleted_for_me', JSON.stringify(updated)); } catch (e) {}
    for (const id of allGroupMsgIds) { await deleteFromVault(id); }
  };

  const handleGalleryTrash = async (action: string) => {
    if (action === 'apagar_pra_mim') {
      if (window.confirm('Esconder todas as mídias da Galeria apenas para si?')) {
        const allGalleryIds = galleryMessages.map((m) => m.id);
        const updated = Array.from(new Set([...deletedForMeIds, ...allGalleryIds]));
        setDeletedForMeIds(updated);
        try { localStorage.setItem('deleted_for_me', JSON.stringify(updated)); } catch (e) {}
        for (const id of allGalleryIds) await deleteFromVault(id);
      }
    } else if (action === 'apagar_tudo') {
      if (window.confirm('APAGAR DEFINITIVAMENTE da base de dados para todos?')) {
        const allGalleryIds = galleryMessages.map((m) => m.id);
        const mySentMsgs = galleryMessages.filter((m) => m.sender_id === currentUser?.id);
        const updated = Array.from(new Set([...deletedForMeIds, ...allGalleryIds]));
        setDeletedForMeIds(updated);
        try { localStorage.setItem('deleted_for_me', JSON.stringify(updated)); } catch (e) {}
        for (const id of allGalleryIds) await deleteFromVault(id);
        for (const msg of mySentMsgs) {
          const tableName = msg.group_id ? 'group_messages' : 'private_messages';
          await supabase.from(tableName).update({ image_metadata: null }).eq('id', msg.id);
        }
        setGalleryMessages([]);
      }
    }
  };

  const handleCreateGroup = async () => {
    if (!currentUser) return;
    const groupName = window.prompt('Nome do Grupo:');
    if (!groupName?.trim()) return;
    const { data } = await supabase.from('groups').insert([{ name: groupName.trim(), created_by: currentUser.id, is_private: false }]).select();
    if (data && data[0]) {
      await supabase.from('group_members').insert([{ group_id: data[0].id, user_id: currentUser.id, role: 'admin' }]);
      setCommunityGroups((prev) => [data[0], ...prev]);
      setSelectedContact(null);
      setActiveTab('groups');
      setSelectedGroup(data[0]);
    }
  };

  return {
    currentUser, globalProfiles, mySavedContacts, setMySavedContacts,
    followedIds, followerCounts, loading,
    activeTab, setActiveTab, selectedContact, setSelectedContact, selectedGroup, setSelectedGroup,
    messages, setMessages, groupMessages, setGroupMessages, galleryMessages, setGalleryMessages,
    unreadSenders, setUnreadSenders, communityGroups, groupMembers,
    deletedForMeIds, setDeletedForMeIds, isShaking, setIsShaking,
    handleToggleFollow, handleSendNudge, handleDeleteMessage, handleClearChat,
    handleGroupTrash, confirmLimparTotal, handleGalleryTrash, handleCreateGroup, fetchGalleryMedia
  };
}