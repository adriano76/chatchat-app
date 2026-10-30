// Caminho: src/hooks/usePhoneContacts.ts
'use client';

import { useState, useCallback } from 'react';
import { Contacts } from '@capacitor-community/contacts';

export interface PhoneContactItem {
  name: string;
  phone: string;
  email?: string;
}

export function usePhoneContacts() {
  const [loadingPhoneContacts, setLoadingPhoneContacts] = useState(false);

  // 1. Abre diretamente o seletor nativo da Agenda do Android para escolher 1 contacto
  const pickSingleContactFromPhone = useCallback(async (): Promise<PhoneContactItem | null> => {
    setLoadingPhoneContacts(true);
    try {
      const cap = typeof window !== 'undefined' ? (window as any).Capacitor : null;
      const isNative = Boolean(cap && (cap.isNativePlatform?.() || cap.isNative));

      // MODO 1: APK Android Nativo (Capacitor)
      if (isNative) {
        const ContactsPlugin = Contacts as any;

        const perm = await ContactsPlugin.requestPermissions();
        if (perm?.contacts !== 'granted') {
          alert('Permissão negada! Vá nas Configurações do Android > Aplicativos > ChatChat > Permissões e autorize "Contatos".');
          return null;
        }

        // Tenta abrir a tela nativa da Agenda do Android (pickContact)
        if (typeof ContactsPlugin.pickContact === 'function') {
          try {
            const res = await ContactsPlugin.pickContact({
              projection: { name: true, phones: true, emails: true },
            });
            const c = res?.contact;
            if (c) {
              const displayName =
                c.name?.display ||
                [c.name?.given, c.name?.family].filter(Boolean).join(' ') ||
                'Contacto';
              return {
                name: displayName,
                phone: c.phones?.[0]?.number || '',
                email: c.emails?.[0]?.address || '',
              };
            }
          } catch (pickErr: any) {
            // Se o utilizador apenas fechou/cancelou a agenda, não exibe erro
            const msg = String(pickErr?.message || '').toLowerCase();
            if (msg.includes('cancel') || msg.includes('dismiss')) {
              return null;
            }
          }
        }

        return null;
      }

      // MODO 2: Navegador Chrome no Telemóvel (Contact Picker API Web)
      if (typeof navigator !== 'undefined' && 'contacts' in navigator && 'ContactsManager' in window) {
        const selected = await (navigator as any).contacts.select(['name', 'tel', 'email'], {
          multiple: false,
        });
        if (selected && selected.length > 0) {
          const first = selected[0];
          return {
            name: first.name?.[0] || 'Contacto',
            phone: first.tel?.[0] || '',
            email: first.email?.[0] || '',
          };
        }
        return null;
      }

      alert('Para aceder à agenda do telemóvel, abra o ChatChat no aplicativo Android (APK) ou no Chrome do telemóvel.');
      return null;
    } catch (err: any) {
      alert('Erro ao abrir a agenda: ' + (err?.message || 'Verifique as permissões do aplicativo no Android.'));
      return null;
    } finally {
      setLoadingPhoneContacts(false);
    }
  }, []);

  // 2. Carrega a lista completa da agenda do telemóvel (para pesquisa interna ou seleção múltipla)
  const pickFromPhoneAddressBook = useCallback(async (): Promise<PhoneContactItem[]> => {
    setLoadingPhoneContacts(true);
    try {
      const cap = typeof window !== 'undefined' ? (window as any).Capacitor : null;
      const isNative = Boolean(cap && (cap.isNativePlatform?.() || cap.isNative));

      if (isNative) {
        const ContactsPlugin = Contacts as any;
        const perm = await ContactsPlugin.requestPermissions();

        if (perm?.contacts !== 'granted') {
          alert('Permissão de leitura da agenda não concedida.');
          return [];
        }

        const result = await ContactsPlugin.getContacts({
          projection: { name: true, phones: true, emails: true },
        });

        const list: PhoneContactItem[] = (result?.contacts || [])
          .filter((c: any) => c.name?.display || c.name?.given || c.phones?.length)
          .map((c: any) => ({
            name:
              c.name?.display ||
              [c.name?.given, c.name?.family].filter(Boolean).join(' ') ||
              'Contacto',
            phone: c.phones?.[0]?.number || '',
            email: c.emails?.[0]?.address || '',
          }));

        return list.sort((a, b) => a.name.localeCompare(b.name));
      }

      if (typeof navigator !== 'undefined' && 'contacts' in navigator && 'ContactsManager' in window) {
        const selected = await (navigator as any).contacts.select(['name', 'tel', 'email'], {
          multiple: true,
        });
        if (selected && selected.length > 0) {
          return selected.map((c: any) => ({
            name: c.name?.[0] || 'Contacto',
            phone: c.tel?.[0] || '',
            email: c.email?.[0] || '',
          }));
        }
        return [];
      }

      alert('A importação direta da agenda só está disponível no telemóvel (Android).');
      return [];
    } catch (err: any) {
      alert(
        'Não foi possível ler a agenda. Se estiver no APK, confirme que rodou "npx cap sync android" e reinstalou o APK pelo Android Studio.'
      );
      return [];
    } finally {
      setLoadingPhoneContacts(false);
    }
  }, []);

  return {
    pickSingleContactFromPhone,
    pickFromPhoneAddressBook,
    loadingPhoneContacts,
  };
}