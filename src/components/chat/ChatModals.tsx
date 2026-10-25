// Caminho: src/components/chat/ChatModals.tsx
'use client';

import React from 'react';
import { Avatar, CustomAudioPlayer } from '@/components/chat/ChatUIComponents';
import { formatBytes, fixVideoDurationAndPlayback } from '@/lib/chatMediaUtils';
import type { UserProfile, ChatMessage } from '@/app/types/chat';
import type { GlobalPageConfig } from '@/lib/chat/contactUtils';

export interface GlobalPageFormState {
  title: string;
  description: string;
  avatar_url: string | null;
  visibility: 'public' | 'private';
  handle: string;
  hashtags: string;
  bio_link: string;
  is_adult: boolean;
}

export interface ContactFormState {
  search: string;
  customName: string;
  address: string;
  phone: string;
}

export interface ChatModalsProps {
  currentUser: UserProfile | null;
  globalPageConfigs: Record<string, GlobalPageConfig>;

  // Modal +18 (Confirmação de Idade)
  pendingAdultTarget: any | null;
  setPendingAdultTarget: React.Dispatch<React.SetStateAction<any | null>>;
  handleConfirmAdultAge: () => void;

  // Modal de Solicitação de Página Privada
  pendingPrivatePageTarget: any | null;
  setPendingPrivatePageTarget: React.Dispatch<React.SetStateAction<any | null>>;
  handleRequestPrivatePageAccess: (targetProfile: any) => void;

  // Modal da Galeria
  selectedGalleryItem: ChatMessage | null;
  setSelectedGalleryItem: React.Dispatch<React.SetStateAction<ChatMessage | null>>;
  p2pMediaUrls: Record<string, string>;
  unlockingMsgId: string | null;
  downloadProgressMap: Record<string, number>;
  handleManualDownload: (msgId: string) => void;
  onDeleteGalleryItem: (item: ChatMessage) => Promise<void>;

  // Modal Adicionar (Contacto + Perfil Global)
  showAddContactModal: boolean;
  setShowAddContactModal: React.Dispatch<React.SetStateAction<boolean>>;
  addModalTab: 'contact' | 'global_profile';
  setAddModalTab: React.Dispatch<React.SetStateAction<'contact' | 'global_profile'>>;
  targetUserToAdd: UserProfile | null;
  contactForm: ContactFormState;
  setContactForm: React.Dispatch<React.SetStateAction<ContactFormState>>;
  handleSearchUser: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handlePhoneInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleSaveContact: (e: React.FormEvent) => Promise<void>;
  isSavingContact: boolean;

  // Configuração do Perfil Global
  globalPageForm: GlobalPageFormState;
  setGlobalPageForm: React.Dispatch<React.SetStateAction<GlobalPageFormState>>;
  globalPageAvatarInputRef: React.RefObject<HTMLInputElement | null>;
  handleGlobalPageAvatarPick: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  populateGlobalPageFormForCurrentUser: () => void;
  handleSaveGlobalPage: (e: React.FormEvent) => Promise<void>;
  isSavingGlobalPage: boolean;

  // Modal Limpeza Total
  showClearTotalPopup: boolean;
  setShowClearTotalPopup: React.Dispatch<React.SetStateAction<boolean>>;
  onConfirmClearTotal: () => Promise<void>;
}

export const ChatModals = React.memo(({
  currentUser,
  globalPageConfigs,
  pendingAdultTarget,
  setPendingAdultTarget,
  handleConfirmAdultAge,
  pendingPrivatePageTarget,
  setPendingPrivatePageTarget,
  handleRequestPrivatePageAccess,
  selectedGalleryItem,
  setSelectedGalleryItem,
  p2pMediaUrls,
  unlockingMsgId,
  downloadProgressMap,
  handleManualDownload,
  onDeleteGalleryItem,
  showAddContactModal,
  setShowAddContactModal,
  addModalTab,
  setAddModalTab,
  targetUserToAdd,
  contactForm,
  setContactForm,
  handleSearchUser,
  handlePhoneInputChange,
  handleSaveContact,
  isSavingContact,
  globalPageForm,
  setGlobalPageForm,
  globalPageAvatarInputRef,
  handleGlobalPageAvatarPick,
  populateGlobalPageFormForCurrentUser,
  handleSaveGlobalPage,
  isSavingGlobalPage,
  showClearTotalPopup,
  setShowClearTotalPopup,
  onConfirmClearTotal
}: ChatModalsProps) => {
  const privateTargetId = pendingPrivatePageTarget?.id ? String(pendingPrivatePageTarget.id) : '';
  const privateTargetCfg = privateTargetId ? globalPageConfigs[privateTargetId] : null;
  const myId = currentUser?.id ? String(currentUser.id) : '';
  const alreadyRequestedPrivate = Boolean(
    myId &&
    privateTargetCfg?.pendingRequests?.some((r) => String(r.requesterId) === myId)
  );

  return (
    <>
      {/* 1. MODAL DE CONFIRMAÇÃO DE IDADE (+18 CONTEÚDO ADULTO) */}
      {pendingAdultTarget && (
        <div className="fixed inset-0 z-[10001] bg-black/75 backdrop-blur-md flex items-center justify-center p-4 animate-popup">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl flex flex-col items-center text-center border border-rose-100">
            <div className="w-16 h-16 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center text-2xl font-extrabold mb-3 shadow-sm">
              +18
            </div>
            <h3 className="text-lg font-extrabold text-slate-900 mb-1">
              Conteúdo Adulto (+18)
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed mb-5">
              A página global{' '}
              <strong className="text-slate-900">
                {globalPageConfigs[String(pendingAdultTarget.id)]?.title || pendingAdultTarget.username}
              </strong>{' '}
              está marcada como conteúdo restrito para maiores de 18 anos. Confirma que tem 18 anos ou mais para aceder?
            </p>
            <div className="flex w-full gap-3">
              <button
                type="button"
                onClick={() => setPendingAdultTarget(null)}
                className="flex-1 py-3 rounded-xl font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 transition text-xs"
              >
                Não, sair
              </button>
              <button
                type="button"
                onClick={handleConfirmAdultAge}
                className="flex-1 py-3 rounded-xl font-bold text-white bg-rose-600 hover:bg-rose-500 transition shadow-md shadow-rose-600/30 text-xs"
              >
                Sim, tenho +18
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2. MODAL DE SOLICITAÇÃO DE ACESSO A PÁGINA GLOBAL PRIVADA */}
      {pendingPrivatePageTarget && (
        <div className="fixed inset-0 z-[10001] bg-black/75 backdrop-blur-md flex items-center justify-center p-4 animate-popup">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl flex flex-col items-center text-center border border-amber-100">
            <Avatar
              name={privateTargetCfg?.title || pendingPrivatePageTarget.username}
              customEmoji={privateTargetCfg?.avatar_url || pendingPrivatePageTarget.avatar_url}
              size="w-16 h-16"
              fontSize="text-2xl"
            />
            <span className="mt-3 text-[11px] font-bold bg-amber-100 text-amber-700 px-2.5 py-0.5 rounded-full">
              🔒 Página Global Privada
            </span>
            <h3 className="text-lg font-extrabold text-slate-900 mt-2">
              {privateTargetCfg?.title || pendingPrivatePageTarget.username}
            </h3>
            <span className="text-xs text-slate-400 font-medium mb-2">
              {privateTargetCfg?.handle || `@${pendingPrivatePageTarget.username}`}
            </span>
            {privateTargetCfg?.description && (
              <p className="text-xs text-slate-600 mb-4 line-clamp-3">
                {privateTargetCfg.description}
              </p>
            )}
            <p className="text-xs text-slate-500 leading-relaxed mb-5">
              {alreadyRequestedPrivate
                ? 'A sua solicitação já foi enviada. Aguarde que o criador da página aceite o seu pedido.'
                : 'Esta página global é privada. Envie uma solicitação para que o administrador aceite o seu acesso às postagens.'}
            </p>
            <div className="flex w-full gap-3">
              <button
                type="button"
                onClick={() => setPendingPrivatePageTarget(null)}
                className="flex-1 py-3 rounded-xl font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 transition text-xs"
              >
                Fechar
              </button>
              {!alreadyRequestedPrivate && (
                <button
                  type="button"
                  onClick={() => handleRequestPrivatePageAccess(pendingPrivatePageTarget)}
                  className="flex-1 py-3 rounded-xl font-bold text-white bg-emerald-500 hover:bg-emerald-600 transition shadow-md shadow-emerald-500/30 text-xs"
                >
                  Pedir Acesso
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 3. MODAL DA GALERIA */}
      {selectedGalleryItem && (
        <div
          className="fixed inset-0 z-[9998] bg-black/85 backdrop-blur-md flex items-center justify-center p-4 animate-popup"
          onClick={() => setSelectedGalleryItem(null)}
        >
          <div
            className="bg-slate-900 border border-white/10 text-white rounded-2xl max-w-2xl w-full overflow-hidden flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-white/10 flex justify-between items-center bg-slate-950">
              <span className="font-bold text-sm truncate">
                {selectedGalleryItem.image_metadata?.original_name || 'Mídia Guardada'}
              </span>
              <button
                onClick={() => setSelectedGalleryItem(null)}
                className="text-slate-400 hover:text-white font-bold p-1"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 bg-black flex items-center justify-center min-h-[300px] max-h-[65vh] p-4">
              {!p2pMediaUrls[selectedGalleryItem.id] && !selectedGalleryItem.image_metadata?.url ? (
                <div className="flex flex-col items-center justify-center gap-3 p-6 text-center">
                  {selectedGalleryItem.image_metadata?.preview_base64 && (
                    <img
                      src={selectedGalleryItem.image_metadata.preview_base64}
                      alt="Preview Borrado"
                      className="w-48 h-48 object-cover rounded-xl blur-md opacity-70"
                    />
                  )}
                  <button
                    onClick={() => handleManualDownload(selectedGalleryItem.id)}
                    className="bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-bold px-5 py-2.5 rounded-full shadow-lg transition"
                  >
                    {unlockingMsgId === selectedGalleryItem.id
                      ? `A transferir (${downloadProgressMap[selectedGalleryItem.id] || 0}%)...`
                      : `⬇️ Baixar Mídia ${formatBytes(selectedGalleryItem.image_metadata?.p2p_info?.expected_size)}`}
                  </button>
                </div>
              ) : selectedGalleryItem.image_metadata?.is_audio ? (
                <div className="bg-white p-4 rounded-2xl shadow-lg">
                  <CustomAudioPlayer
                    src={p2pMediaUrls[selectedGalleryItem.id] || selectedGalleryItem.image_metadata?.url}
                    isMe={selectedGalleryItem.sender_id === currentUser?.id}
                  />
                </div>
              ) : selectedGalleryItem.image_metadata?.is_video ? (
                <video
                  key={p2pMediaUrls[selectedGalleryItem.id] || selectedGalleryItem.image_metadata?.url || selectedGalleryItem.id}
                  src={p2pMediaUrls[selectedGalleryItem.id] || selectedGalleryItem.image_metadata?.url || ''}
                  controls
                  autoPlay
                  playsInline
                  preload="auto"
                  onLoadedMetadata={(e) => fixVideoDurationAndPlayback(e.currentTarget)}
                  onPlay={(e) => {
                    const v = e.currentTarget;
                    if (isFinite(v.duration) && v.duration > 0 && v.currentTime >= v.duration - 0.1) {
                      v.currentTime = 0;
                    }
                  }}
                  onEnded={(e) => {
                    e.currentTarget.currentTime = 0;
                  }}
                  className="max-h-[60vh] max-w-full rounded-lg bg-black"
                />
              ) : (
                <img
                  src={p2pMediaUrls[selectedGalleryItem.id] || selectedGalleryItem.image_metadata?.url || ''}
                  alt="Mídia"
                  className="max-h-[60vh] max-w-full object-contain rounded-lg"
                />
              )}
            </div>

            <div className="p-4 bg-slate-950 flex flex-wrap gap-3 items-center justify-between border-t border-white/10">
              <span className="text-xs text-slate-400">
                {new Date(selectedGalleryItem.created_at).toLocaleString()}
              </span>
              <div className="flex gap-2">
                {(selectedGalleryItem.image_metadata?.url || selectedGalleryItem.image_metadata?.p2p_info?.cloud_parts) && !p2pMediaUrls[selectedGalleryItem.id] && (
                  <button
                    onClick={() => handleManualDownload(selectedGalleryItem.id)}
                    className="bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-bold px-4 py-2 rounded-lg transition"
                  >
                    {unlockingMsgId === selectedGalleryItem.id ? 'A guardar...' : '⬇️ Salvar neste Aparelho'}
                  </button>
                )}
                <button
                  onClick={() => onDeleteGalleryItem(selectedGalleryItem)}
                  className="bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold px-4 py-2 rounded-lg transition"
                >
                  Apagar Mídia
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 4. MODAL ADICIONAR (CONTACTO + PERFIL GLOBAL) */}
      {showAddContactModal && (
        <div className="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-popup overflow-y-auto">
          <div className="bg-white rounded-2xl p-5 md:p-6 max-w-md w-full shadow-2xl flex flex-col my-auto max-h-[92dvh] overflow-y-auto custom-scrollbar">
            {!targetUserToAdd && (
              <div className="flex bg-slate-100 p-1 rounded-xl mb-4 shrink-0">
                <button
                  type="button"
                  onClick={() => setAddModalTab('contact')}
                  className={`flex-1 py-2 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 ${
                    addModalTab === 'contact'
                      ? 'bg-white text-emerald-600 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <span>👤 Novo Contacto</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    populateGlobalPageFormForCurrentUser();
                    setAddModalTab('global_profile');
                  }}
                  className={`flex-1 py-2 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 ${
                    addModalTab === 'global_profile'
                      ? 'bg-white text-emerald-600 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <span>🌐 Perfil Global</span>
                </button>
              </div>
            )}

            {addModalTab === 'contact' || targetUserToAdd ? (
              <>
                {targetUserToAdd ? (
                  <div className="flex items-center gap-4 mb-5 border-b border-slate-100 pb-4">
                    <Avatar name={targetUserToAdd.username} customEmoji={targetUserToAdd.avatar_url} size="w-14 h-14" fontSize="text-xl" />
                    <div>
                      <h3 className="text-lg font-bold text-slate-900 leading-tight">Adicionar Contacto</h3>
                      <span className="text-sm text-slate-500">@{targetUserToAdd.username}</span>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-4 mb-4 border-b border-slate-100 pb-3">
                    <div className="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center shrink-0">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="20" y1="8" x2="20" y2="14"></line><line x1="23" y1="11" x2="17" y2="11"></line></svg>
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-slate-900 leading-tight">Novo Contacto</h3>
                      <span className="text-xs text-slate-500">Busca Global ou Telefone (SHA-256)</span>
                    </div>
                  </div>
                )}
                <form onSubmit={handleSaveContact} className="flex flex-col gap-3">
                  {!targetUserToAdd && (
                    <div>
                      <label className="text-xs font-bold text-slate-700 ml-1">Localizar (@Utilizador ou Email)</label>
                      <input
                        type="text"
                        value={contactForm.search}
                        onChange={handleSearchUser}
                        placeholder="Ex: @usuario ou email@dominio.com"
                        className="w-full mt-1 px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500 text-slate-900 text-sm"
                      />
                    </div>
                  )}
                  <div>
                    <label className="text-xs font-bold text-slate-700 ml-1">Apelido Local (Nome na sua Agenda)</label>
                    <input
                      type="text"
                      value={contactForm.customName}
                      onChange={(e) => setContactForm({ ...contactForm, customName: e.target.value })}
                      placeholder="Ex: João"
                      className="w-full mt-1 px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500 text-slate-900 text-sm"
                      required
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-700 ml-1">Telefone (Descoberta Privada SHA-256)</label>
                    <input
                      type="tel"
                      inputMode="tel"
                      value={contactForm.phone}
                      onChange={handlePhoneInputChange}
                      placeholder="+55 67 99999-9999"
                      className="w-full mt-1 px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500 text-slate-900 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-700 ml-1">Morada (Opcional)</label>
                    <input
                      type="text"
                      value={contactForm.address}
                      onChange={(e) => setContactForm({ ...contactForm, address: e.target.value })}
                      placeholder="Rua ..."
                      className="w-full mt-1 px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500 text-slate-900 text-sm"
                    />
                  </div>
                  <div className="flex w-full gap-3 mt-3 pt-2">
                    <button type="button" onClick={() => setShowAddContactModal(false)} className="flex-1 py-2.5 rounded-xl font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 transition text-sm">Cancelar</button>
                    <button type="submit" disabled={isSavingContact} className="flex-1 py-2.5 rounded-xl font-bold text-white bg-emerald-500 hover:bg-emerald-600 transition shadow-md shadow-emerald-500/30 disabled:opacity-50 text-sm">
                      {isSavingContact ? 'A guardar...' : 'Guardar'}
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <form onSubmit={handleSaveGlobalPage} className="flex flex-col gap-3">
                <div className="flex items-center gap-3.5 border-b border-slate-100 pb-3">
                  <div className="relative group shrink-0">
                    <Avatar
                      name={globalPageForm.title || currentUser?.username || 'P'}
                      customEmoji={globalPageForm.avatar_url}
                      size="w-16 h-16"
                      fontSize="text-xl"
                    />
                    <input
                      type="file"
                      accept="image/*"
                      ref={globalPageAvatarInputRef}
                      onChange={handleGlobalPageAvatarPick}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => globalPageAvatarInputRef.current?.click()}
                      className="mt-1.5 w-full text-[11px] font-bold text-emerald-600 hover:underline text-center block"
                    >
                      📷 Mudar Foto
                    </button>
                  </div>
                  <div className="flex flex-col min-w-0">
                    <h3 className="text-base font-bold text-slate-900 leading-tight">
                      Configurar Perfil Global
                    </h3>
                    <span className="text-xs text-slate-500">
                      Os dados e o link da bio aparecem apenas na aba Global (nunca em Meus Contactos).
                    </span>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-700 ml-1">
                    Título da Página Global (Alterar Nome)
                  </label>
                  <input
                    type="text"
                    value={globalPageForm.title}
                    onChange={(e) => setGlobalPageForm((prev) => ({ ...prev, title: e.target.value }))}
                    placeholder="Ex: Canal Oficial / Nome da Página"
                    className="w-full mt-1 px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500 text-slate-900 text-sm"
                    required
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label className="text-xs font-bold text-slate-700 ml-1">@ da Página</label>
                    <input
                      type="text"
                      value={globalPageForm.handle}
                      onChange={(e) => setGlobalPageForm((prev) => ({ ...prev, handle: e.target.value }))}
                      placeholder="@minhapagina"
                      className="w-full mt-1 px-3.5 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500 text-slate-900 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-700 ml-1"># Hashtags da Página</label>
                    <input
                      type="text"
                      value={globalPageForm.hashtags}
                      onChange={(e) => setGlobalPageForm((prev) => ({ ...prev, hashtags: e.target.value }))}
                      placeholder="#noticias #jogos #arte"
                      className="w-full mt-1 px-3.5 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500 text-slate-900 text-sm"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-700 ml-1">Descrição da Página Global</label>
                  <textarea
                    rows={2}
                    value={globalPageForm.description}
                    onChange={(e) => setGlobalPageForm((prev) => ({ ...prev, description: e.target.value }))}
                    placeholder="Descreva sobre o que é a sua página global..."
                    className="w-full mt-1 px-3.5 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500 text-slate-900 text-sm resize-none"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-700 ml-1">
                    Link da Bio (Visível apenas no Perfil Global)
                  </label>
                  <input
                    type="text"
                    value={globalPageForm.bio_link}
                    onChange={(e) => setGlobalPageForm((prev) => ({ ...prev, bio_link: e.target.value }))}
                    placeholder="https://meusite.com ou instagram.com/..."
                    className="w-full mt-1 px-3.5 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500 text-slate-900 text-sm"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-700 ml-1">Visibilidade da Página</label>
                  <div className="grid grid-cols-2 gap-2.5 mt-1">
                    <button
                      type="button"
                      onClick={() => setGlobalPageForm((prev) => ({ ...prev, visibility: 'public' }))}
                      className={`py-2 px-3 rounded-xl font-bold text-xs border transition flex items-center justify-center gap-1.5 ${
                        globalPageForm.visibility === 'public'
                          ? 'bg-emerald-50 border-emerald-500 text-emerald-700'
                          : 'bg-slate-50 border-slate-200 text-slate-600'
                      }`}
                    >
                      <span>🌍 Pública</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setGlobalPageForm((prev) => ({ ...prev, visibility: 'private' }))}
                      className={`py-2 px-3 rounded-xl font-bold text-xs border transition flex items-center justify-center gap-1.5 ${
                        globalPageForm.visibility === 'private'
                          ? 'bg-amber-50 border-amber-500 text-amber-700'
                          : 'bg-slate-50 border-slate-200 text-slate-600'
                      }`}
                    >
                      <span>🔒 Privada (Com Solicitação)</span>
                    </button>
                  </div>
                </div>

                <label className="flex items-center justify-between gap-3 p-3 rounded-xl bg-rose-50/70 border border-rose-200/80 cursor-pointer mt-0.5">
                  <div className="flex flex-col">
                    <span className="text-xs font-bold text-rose-700 flex items-center gap-1.5">
                      <span>🔞 Conteúdo Adulto (+18)</span>
                    </span>
                    <span className="text-[11px] text-rose-600/90">
                      Exige confirmação de idade (+18 anos) antes de abrir a página
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    checked={globalPageForm.is_adult}
                    onChange={(e) => setGlobalPageForm((prev) => ({ ...prev, is_adult: e.target.checked }))}
                    className="w-4 h-4 accent-rose-600 rounded cursor-pointer shrink-0"
                  />
                </label>

                <div className="flex w-full gap-3 mt-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowAddContactModal(false)}
                    className="flex-1 py-2.5 rounded-xl font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 transition text-sm"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={isSavingGlobalPage}
                    className="flex-1 py-2.5 rounded-xl font-bold text-white bg-emerald-500 hover:bg-emerald-600 transition shadow-md shadow-emerald-500/30 disabled:opacity-50 text-sm"
                  >
                    {isSavingGlobalPage ? 'A publicar...' : 'Salvar Página Global'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* 5. MODAL LIMPEZA TOTAL */}
      {showClearTotalPopup && (
        <div className="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-popup">
          <div className="bg-white rounded-[24px] p-6 max-w-sm w-full shadow-2xl flex flex-col items-center text-center">
            <h3 className="text-xl font-extrabold text-slate-900 mb-2">Limpeza Total</h3>
            <p className="text-slate-600 text-[14px] font-medium mb-6">Todos os assuntos serão apagados.</p>
            <div className="flex w-full gap-3">
              <button onClick={() => setShowClearTotalPopup(false)} className="flex-1 py-3 rounded-xl font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 transition">Cancelar</button>
              <button
                onClick={onConfirmClearTotal}
                className="flex-1 py-3 rounded-xl font-bold text-white bg-rose-500 hover:bg-rose-600 transition shadow-md"
              >
                Apagar Tudo
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
});
ChatModals.displayName = 'ChatModals';