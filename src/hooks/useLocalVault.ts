'use client';

export function useLocalVault() {
  const getDB = (): Promise<IDBDatabase> => {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('ChatChatVault', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('media')) {
          db.createObjectStore('media');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };

  const saveToVault = async (messageId: string, file: File | Blob): Promise<void> => {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('media', 'readwrite');
      const store = tx.objectStore('media');
      const request = store.put(file, messageId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  };

  const getFromVault = async (messageId: string): Promise<Blob | null> => {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('media', 'readonly');
      const store = tx.objectStore('media');
      const request = store.get(messageId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  };

  const deleteFromVault = async (messageId: string): Promise<void> => {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('media', 'readwrite');
      const store = tx.objectStore('media');
      const request = store.delete(messageId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  };

  return { saveToVault, getFromVault, deleteFromVault };
}