// src/hooks/useContactsCleanRoom.ts
'use client';

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

// ============================================================================
// 1. TIPAGENS (CLEAN ROOM ARCHITECTURE)
// ============================================================================

export interface PublicProfile {
  id: string;
  username?: string;
  displayName: string;
  avatarUrl?: string;
  lastSeen?: string;
}

export interface ContactItem {
  contactId: string;
  customAlias?: string;
  isBlocked: boolean;
  updatedAt: string;
  profile: PublicProfile;
}

export interface ContactsCacheState {
  lastSyncTimestamp: string;
  contacts: ContactItem[];
}

// ============================================================================
// 2. CRIPTOGRAFIA SHA-256 E NORMALIZAÇÃO E.164
// ============================================================================

/**
 * Normaliza número para o padrão internacional E.164
 */
export function normalizePhone(rawPhone: string, defaultCountryCode = '55'): string {
  const digits = rawPhone.replace(/\D/g, '');
  if (digits.length === 11 && !digits.startsWith(defaultCountryCode)) {
    return `+${defaultCountryCode}${digits}`;
  }
  return digits.startsWith('+') ? digits : `+${digits}`;
}

/**
 * Gera o Hash SHA-256 via Web Crypto API nativa do navegador
 */
export async function hashPhoneIdentifier(phone: string): Promise<string> {
  const normalized = normalizePhone(phone);
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolução com prioridade para o apelido local salvo pelo utilizador
 */
export function resolveDisplayName(contact: ContactItem): string {
  if (contact.customAlias && contact.customAlias.trim().length > 0) {
    return contact.customAlias;
  }
  if (contact.profile.displayName && contact.profile.displayName.trim().length > 0) {
    return contact.profile.displayName;
  }
  return contact.profile.username ? `@${contact.profile.username}` : 'Utilizador Desconhecido';
}

// ============================================================================
// 3. HOOK DE CACHE LOCAL E DELTA SYNC
// ============================================================================

const CACHE_PREFIX = 'repot_contacts_cache_';

export function useContactsCleanRoom(userId: string | null) {
  const [contacts, setContacts] = useState<ContactItem[]>([]);
  const [loading, setLoading] = useState(true);

  // 1. Carrega o cache local instantaneamente (< 100ms)
  const loadLocalCache = useCallback(() => {
    if (!userId) return;
    try {
      const raw = localStorage.getItem(`${CACHE_PREFIX}${userId}`);
      if (raw) {
        const parsed: ContactsCacheState = JSON.parse(raw);
        setContacts(parsed.contacts || []);
      }
    } catch (err) {
      console.warn('Falha ao ler cache local de contactos:', err);
    }
  }, [userId]);

  // 2. Sincronização incremental (Delta Sync)
  const syncWithServer = useCallback(async () => {
    if (!userId) return;

    let lastSync = '1970-01-01T00:00:00Z';
    const cachedRaw = localStorage.getItem(`${CACHE_PREFIX}${userId}`);
    if (cachedRaw) {
      try {
        const cached: ContactsCacheState = JSON.parse(cachedRaw);
        lastSync = cached.lastSyncTimestamp || lastSync;
      } catch {
        // Fallback para sincronização completa
      }
    }

    try {
      const { data, error } = await supabase
        .from('contacts')
        .select(`
          contact_id,
          custom_alias,
          is_blocked,
          updated_at,
          profile:profiles!contacts_contact_id_fkey(
            id,
            username,
            display_name,
            avatar_url,
            last_seen
          )
        `)
        .eq('owner_id', userId)
        .gt('updated_at', lastSync);

      if (error) throw error;

      if (data && data.length > 0) {
        const updatedItems: ContactItem[] = data
          .filter((item: any) => item.profile)
          .map((item: any) => ({
            contactId: item.contact_id,
            customAlias: item.custom_alias,
            isBlocked: item.is_blocked,
            updatedAt: item.updated_at,
            profile: {
              id: item.profile.id,
              username: item.profile.username,
              displayName: item.profile.display_name || item.profile.username || 'Utilizador',
              avatarUrl: item.profile.avatar_url,
              lastSeen: item.profile.last_seen,
            },
          }));

        setContacts((prev) => {
          const map = new Map(prev.map((c) => [c.contactId, c]));
          updatedItems.forEach((c) => map.set(c.contactId, c));
          const merged = Array.from(map.values());

          const stateToSave: ContactsCacheState = {
            lastSyncTimestamp: new Date().toISOString(),
            contacts: merged,
          };
          localStorage.setItem(`${CACHE_PREFIX}${userId}`, JSON.stringify(stateToSave));
          return merged;
        });
      }
    } catch (err) {
      console.error('Erro na sincronização de contactos:', err);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // 3. Descoberta via SHA-256 do telefone
  const discoverContactByPhone = useCallback(async (phoneNumber: string) => {
    const phoneHash = await hashPhoneIdentifier(phoneNumber);
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, last_seen')
      .eq('phone_hash', phoneHash)
      .maybeSingle();

    if (error) throw error;
    return data;
  }, []);

  // 4. Guardar contacto na tabela `contacts` do Supabase
  const addOrUpdateContact = useCallback(async (contactProfileId: string, customAlias?: string) => {
    if (!userId) return false;
    const now = new Date().toISOString();

    const { error } = await supabase
      .from('contacts')
      .upsert(
        {
          owner_id: userId,
          contact_id: contactProfileId,
          custom_alias: customAlias?.trim() || null,
          updated_at: now,
        },
        { onConflict: 'owner_id,contact_id' }
      );

    if (error) throw error;
    await syncWithServer();
    return true;
  }, [userId, syncWithServer]);

  useEffect(() => {
    if (userId) {
      loadLocalCache();
      syncWithServer();
    }
  }, [userId, loadLocalCache, syncWithServer]);

  return {
    contacts,
    loading,
    refreshContacts: syncWithServer,
    discoverContactByPhone,
    addOrUpdateContact,
  };
}