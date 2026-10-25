// src/types/contacts.ts

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