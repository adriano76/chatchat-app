// Caminho: src/components/contacts/AddContactModal.tsx
'use client';

import React from 'react';
import { usePhoneContacts } from '@/hooks/usePhoneContacts';
import { getPublicHandle, getDisplayNameByTab } from '@/utils/profileUtils';

export interface AddContactModalProps {
  isOpen: boolean;
  isEditing?: boolean;
  targetUserToAdd: any | null;
  contactForm: { search: string; customName: string; address: string; phone: string };
  setContactForm: React.Dispatch<React.SetStateAction<{ search: string; customName: string; address: string; phone: string }>>;
  onSearchUser: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSaveContact: (e: React.FormEvent) => void;
  onImportMultipleFromPhone?: (contacts: { name: string; phone: string; email?: string }[]) => void;
  onClose: () => void;
}

export function AddContactModal({
  isOpen,
  isEditing = false,
  targetUserToAdd,
  contactForm,
  setContactForm,
  onSearchUser,
  onSaveContact,
  onImportMultipleFromPhone,
  onClose,
}: AddContactModalProps) {
  const { pickFromPhoneAddressBook, loadingPhoneContacts } = usePhoneContacts();

  if (!isOpen) return null;

  const handlePullFromPhone = async () => {
    const picked = await pickFromPhoneAddressBook();
    if (!picked || picked.length === 0) return;

    if (picked.length === 1 || isEditing) {
      const first = picked[0];
      setContactForm((prev) => ({
        ...prev,
        customName: first.name || prev.customName,
        phone: first.phone || prev.phone,
        search: first.email || prev.search,
      }));
    } else if (onImportMultipleFromPhone) {
      onImportMultipleFromPhone(picked);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-popup">
      <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl flex flex-col">
        {targetUserToAdd ? (
          <div className="flex items-center justify-between gap-3 mb-4 border-b border-slate-100 pb-4">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-12 h-12 bg-slate-800 text-white rounded-full flex items-center justify-center font-bold text-lg shrink-0">
                {getDisplayNameByTab(targetUserToAdd, 'global').charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-bold text-slate-900 leading-tight truncate">
                  {isEditing ? '✏️ Editar Contacto' : getDisplayNameByTab(targetUserToAdd, 'global')}
                </h3>
                <span className="text-xs text-emerald-600 font-semibold block truncate">
                  Perfil Global: {getPublicHandle(targetUserToAdd)}
                </span>
                <p className="text-[10.5px] text-slate-400 mt-0.5">
                  Alterações guardadas apenas na aba Meus Contactos.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={handlePullFromPhone}
              disabled={loadingPhoneContacts}
              title="Puxar dados da agenda do telemóvel"
              className="px-2.5 py-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 rounded-xl text-[11px] font-bold transition flex items-center gap-1 shrink-0"
            >
              <span>📱</span>
              <span>{loadingPhoneContacts ? '...' : 'Agenda'}</span>
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 mb-4 border-b border-slate-100 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center shrink-0">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="20" y1="8" x2="20" y2="14"></line><line x1="23" y1="11" x2="17" y2="11"></line></svg>
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900 leading-tight">Novo Contacto</h3>
                <span className="text-xs text-slate-500">Agenda Privada</span>
              </div>
            </div>

            <button
              type="button"
              onClick={handlePullFromPhone}
              disabled={loadingPhoneContacts}
              className="px-3 py-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 rounded-xl text-xs font-bold transition flex items-center gap-1.5 shrink-0"
            >
              <span>📱</span>
              <span>{loadingPhoneContacts ? 'A abrir...' : 'Agenda do Celular'}</span>
            </button>
          </div>
        )}

        <form onSubmit={onSaveContact} className="flex flex-col gap-3">
          {!targetUserToAdd && !isEditing && (
            <div>
              <label className="text-xs font-bold text-slate-700 ml-1">Localizar (@arroba ou E-mail)</label>
              <input
                type="text"
                value={contactForm.search}
                onChange={onSearchUser}
                placeholder="Ex: @silvia_agua ou email..."
                className="w-full mt-1 px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500 focus:bg-white text-slate-900 text-sm transition"
              />
            </div>
          )}

          <div>
            <label className="text-xs font-bold text-slate-700 ml-1">
              Nome Personalizado (Apenas em Meus Contactos)
            </label>
            <input
              type="text"
              value={contactForm.customName}
              onChange={(e) => setContactForm({ ...contactForm, customName: e.target.value })}
              placeholder="Ex: João Água Mineral"
              className="w-full mt-1 px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500 focus:bg-white text-slate-900 text-sm transition"
              required
            />
          </div>

          <div>
            <label className="text-xs font-bold text-slate-700 ml-1">Telefone (Opcional)</label>
            <input
              type="tel"
              value={contactForm.phone}
              onChange={(e) => setContactForm({ ...contactForm, phone: e.target.value })}
              placeholder="+55 67 99999-9999"
              className="w-full mt-1 px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500 focus:bg-white text-slate-900 text-sm transition"
            />
          </div>

          <div>
            <label className="text-xs font-bold text-slate-700 ml-1">Endereço / Observação (Opcional)</label>
            <input
              type="text"
              value={contactForm.address}
              onChange={(e) => setContactForm({ ...contactForm, address: e.target.value })}
              placeholder="Rua, Número, Bairro"
              className="w-full mt-1 px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500 focus:bg-white text-slate-900 text-sm transition"
            />
          </div>

          <div className="flex w-full gap-3 mt-4 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 text-sm transition"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="flex-1 py-2.5 rounded-xl font-bold text-white bg-emerald-500 hover:bg-emerald-600 text-sm transition shadow-md shadow-emerald-500/30"
            >
              {isEditing ? 'Salvar Alterações' : 'Guardar Contacto'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}