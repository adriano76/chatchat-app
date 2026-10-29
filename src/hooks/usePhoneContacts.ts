// Caminho: src/hooks/usePhoneContacts.ts
'use client';

import { useState, useCallback } from 'react';

export interface PhoneContactItem {
  name: string;
  phone: string;
  email?: string;
}

export function usePhoneContacts() {
  const [loadingPhoneContacts, setLoadingPhoneContacts] = useState(false);

  // Abre a agenda do telemóvel para o utilizador selecionar 1 ou mais contactos
  const pickFromPhoneAddressBook = useCallback(async (): Promise<PhoneContactItem[]> => {
    setLoadingPhoneContacts(true);
    try {
      // CAMADA 1: Contact Picker API nativa do Android / Chrome Mobile
      if (typeof navigator !== 'undefined' && 'contacts' in navigator && 'ContactsManager' in window) {
        const props = ['name', 'tel', 'email'];
        const opts = { multiple: true };
        const selected = await (navigator as any).contacts.select(props, opts);

        if (selected && selected.length > 0) {
          return selected.map((c: any) => ({
            name: c.name?.[0] || 'Contacto do Telemóvel',
            phone: c.tel?.[0] || '',
            email: c.email?.[0] || '',
          }));
        }
      }

      // CAMADA 2: Plugin Capacitor Nativo (para WebView Android no APK)
      const cap = typeof window !== 'undefined' ? (window as any).Capacitor : null;
      if (cap && (cap.isNativePlatform?.() || cap.isNative)) {
        try {
          // Importação dinâmica segura para não quebrar caso o pacote ainda não esteja instalado
          const moduleName = '@capacitor-community/contacts';
          const { Contacts } = await import(/* webpackIgnore: true */ moduleName);
          const permission = await Contacts.requestPermissions();

          if (permission.contacts === 'granted') {
            const result = await Contacts.getContacts({
              projection: { name: true, phones: true, emails: true },
            });

            return (result.contacts || [])
              .filter((c: any) => c.name?.display || c.phones?.length)
              .map((c: any) => ({
                name: c.name?.display || 'Contacto',
                phone: c.phones?.[0]?.number || '',
                email: c.emails?.[0]?.address || '',
              }));
          }
        } catch (pluginErr) {
          alert(
            'Para ler a agenda diretamente no APK, instale o plugin no terminal:\nnpm install @capacitor-community/contacts && npx cap sync'
          );
        }
      } else {
        alert('A importação direta da agenda só está disponível no telemóvel (Android).');
      }

      return [];
    } catch (err) {
      return [];
    } finally {
      setLoadingPhoneContacts(false);
    }
  }, []);

  return {
    pickFromPhoneAddressBook,
    loadingPhoneContacts,
  };
}