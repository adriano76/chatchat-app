// Caminho: src/lib/chat/contactUtils.ts
import type { SavedContact } from '@/app/types/chat';

export type ContactFaceStatus = 'normal' | 'muted' | 'blocked';

export interface GlobalPageAccessRequest {
  requesterId: string;
  requesterName: string;
  requesterAvatar?: string | null;
  requestedAt: string;
}

export interface GlobalPageConfig {
  userId: string;
  title: string;
  description: string;
  avatar_url: string | null;
  visibility: 'public' | 'private';
  handle: string;
  hashtags: string;
  bio_link: string;
  is_adult: boolean;
  approvedUserIds?: string[];
  pendingRequests?: GlobalPageAccessRequest[];
  rejectedUserIds?: string[];
  updated_at: string;
}

export const GLOBAL_PAGES_STORAGE_KEY = 'chatchat_global_pages_map_v1';

export const normalizePhoneKey = (phone?: string | null): string => {
  if (!phone) return '';
  const raw = String(phone).trim();
  // Se tiver '@' ou letras, não é um número de telefone válido
  if (raw.includes('@') || /[a-zA-Z]/.test(raw)) return '';
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  // Normaliza números com DDI +55 (Brasil) para comparar DDD + Número de forma única
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    return digits.slice(2);
  }
  return digits;
};

export const normalizeEmailKey = (value?: string | null): string => {
  if (!value) return '';
  const cleaned = String(value).replace(/\s+/g, '').toLowerCase();
  if (!cleaned.includes('@') || cleaned.startsWith('@')) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned) ? cleaned : '';
};

export const isPhoneTypedInSearchBar = (value?: string | null): boolean => {
  if (!value) return false;
  const trimmed = String(value).trim();
  if (!trimmed) return false;
  // Se contém apenas dígitos e símbolos telefónicos (+, -, parênteses, espaços)
  if (/^[0-9+()\-\s.]+$/.test(trimmed)) return true;
  // Se não é um e-mail mas possui 8 ou mais dígitos numéricos misturados
  const digits = trimmed.replace(/\D/g, '');
  if (!trimmed.includes('@') && digits.length >= 8) return true;
  return false;
};

export const getContactsStorageKey = (userId?: string | null): string => {
  return userId ? `my_saved_contacts_${userId}` : 'my_saved_contacts';
};

export const getContactFaceStatusStorageKey = (userId?: string | null): string => {
  return userId ? `chatchat_contact_face_status_${userId}` : 'chatchat_contact_face_status';
};

export const getDeletedContactsStorageKey = (userId?: string | null): string => {
  return userId ? `chatchat_deleted_contacts_${userId}` : 'chatchat_deleted_contacts';
};

export const getBlockedByOthersStorageKey = (userId?: string | null): string => {
  return userId ? `chatchat_blocked_by_others_${userId}` : 'chatchat_blocked_by_others';
};

export const getMyAvatarStorageKey = (userId?: string | null): string => {
  return userId ? `chatchat_my_avatar_${userId}` : 'chatchat_my_avatar';
};

export const formatPageHandle = (raw: string): string => {
  const cleaned = raw.replace(/\s+/g, '').replace(/^@+/, '');
  return cleaned ? `@${cleaned}` : '';
};

export const formatPageHashtags = (raw: string): string => {
  if (!raw.trim()) return '';
  return raw
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((tag) => (tag.startsWith('#') ? tag : `#${tag.replace(/^#+/, '')}`))
    .join(' ');
};

export const normalizeExternalUrl = (url?: string | null): string => {
  if (!url) return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

// Recorta e comprime a foto de perfil num quadrado leve (256x256 JPEG) para não sobrecarregar o banco
export const generateCompressedAvatarDataUrl = (
  file: File,
  targetSize: number = 256
): Promise<{ blob: Blob; dataUrl: string }> => {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = targetSize;
        canvas.height = targetSize;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Contexto 2D indisponível'));
          return;
        }
        const minSide = Math.min(img.width, img.height);
        const sx = (img.width - minSide) / 2;
        const sy = (img.height - minSide) / 2;
        ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, targetSize, targetSize);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.84);
        canvas.toBlob(
          (blob) => {
            if (blob) resolve({ blob, dataUrl });
            else reject(new Error('Falha ao comprimir foto de perfil'));
          },
          'image/jpeg',
          0.84
        );
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Ficheiro de imagem inválido'));
    };
    img.src = objectUrl;
  });
};

export const deduplicateContactsList = (
  list: SavedContact[],
  currentUserId?: string | null
): SavedContact[] => {
  if (!Array.isArray(list) || list.length === 0) return [];

  // Prioriza registos conectados à rede global (IDs reais) sobre registos offline
  const sorted = [...list].sort((a, b) => {
    const aOffline = String(a.id).startsWith('offline-') ? 1 : 0;
    const bOffline = String(b.id).startsWith('offline-') ? 1 : 0;
    return aOffline - bOffline;
  });

  const result: SavedContact[] = [];
  const byId = new Map<string, number>();
  const byPhone = new Map<string, number>();
  const byEmail = new Map<string, number>();

  for (const item of sorted) {
    if (!item || !item.id) continue;
    const idStr = String(item.id);
    if (currentUserId && idStr === String(currentUserId)) continue;

    // Corrige e deteta caso algum registo antigo tenha guardado e-mail no campo phone ou telefone no username
    const phoneFromPhoneField = normalizePhoneKey(item.phone);
    const phoneFromUsernameField = isPhoneTypedInSearchBar(item.username)
      ? normalizePhoneKey(item.username)
      : '';
    const phoneKey = phoneFromPhoneField || phoneFromUsernameField;

    const emailKey =
      normalizeEmailKey(item.email) ||
      normalizeEmailKey(item.username) ||
      normalizeEmailKey(item.phone);

    const cleanPhoneDisplay = phoneFromPhoneField
      ? item.phone
      : phoneFromUsernameField
      ? item.username
      : '';

    let existingIdx: number | undefined = byId.get(idStr);
    if (existingIdx === undefined && phoneKey.length >= 8) {
      existingIdx = byPhone.get(phoneKey);
    }
    if (existingIdx === undefined && emailKey) {
      existingIdx = byEmail.get(emailKey);
    }

    if (existingIdx !== undefined) {
      const prev = result[existingIdx];
      const prevIsOffline = String(prev.id).startsWith('offline-');
      const itemIsOffline = idStr.startsWith('offline-');

      const merged: SavedContact = {
        ...prev,
        ...item,
        id: prevIsOffline && !itemIsOffline ? item.id : prev.id,
        username: (!prevIsOffline ? prev.username : item.username) || prev.username,
        savedName: prev.savedName && prev.savedName !== 'Desconhecido' ? prev.savedName : item.savedName,
        email: prev.email || item.email || (emailKey || undefined),
        phone: normalizePhoneKey(prev.phone) ? prev.phone : cleanPhoneDisplay || '',
        address: prev.address || item.address || '',
        avatar_url: prev.avatar_url ?? item.avatar_url ?? null,
        status: !prevIsOffline ? prev.status : item.status
      };

      result[existingIdx] = merged;
      byId.set(String(merged.id), existingIdx);
      const mergedPhone = normalizePhoneKey(merged.phone);
      const mergedEmail = normalizeEmailKey(merged.email) || normalizeEmailKey(merged.username);
      if (mergedPhone.length >= 8) byPhone.set(mergedPhone, existingIdx);
      if (mergedEmail) byEmail.set(mergedEmail, existingIdx);
    } else {
      const newIdx = result.length;
      result.push({
        ...item,
        email: emailKey || item.email || undefined,
        phone: cleanPhoneDisplay || ''
      });
      byId.set(idStr, newIdx);
      if (phoneKey.length >= 8) byPhone.set(phoneKey, newIdx);
      if (emailKey) byEmail.set(emailKey, newIdx);
    }
  }

  return result;
};