// Caminho: src/types/chat.ts

export interface UserProfile {
  id: string;
  username: string;
  display_name?: string;
  email?: string;
  avatar_url?: string | null;
  status?: string;
}

export interface SavedContact extends UserProfile {
  savedName: string;
  address?: string;
  phone?: string;
  addedAt: string;
}

export interface ImageMetadata {
  url?: string | null;
  preview?: string | null;
  preview_base64?: string;
  status?: string;
  original_name?: string;
  mime_type?: string;
  is_uploading?: boolean;
  is_password_protected?: boolean;
  is_video?: boolean;
  is_audio?: boolean;
  is_nudge?: boolean;
  is_deleted?: boolean;
  p2p_info?: {
    media_id?: string;
    totalChunks?: number;
    encrypted?: boolean;
    expected_size?: number;
    duration_sec?: number;
    width?: number;
    height?: number;
    cloud_parts?: string[] | null;
    synced_devices?: string[];
  } | null;
}

export interface ChatMessage {
  id: string;
  sender_id: string;
  receiver_id?: string;
  group_id?: string;
  content: string;
  image_metadata?: ImageMetadata | null;
  created_at: string;
  is_read?: boolean;
}