'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useLocalVault } from './useLocalVault';

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

export async function generateMasterKey(userPassword?: string) {
  let rawKey: ArrayBuffer;
  if (userPassword && userPassword.trim() !== '') {
    rawKey = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userPassword));
  } else {
    rawKey = new TextEncoder().encode('ChaveSecretaChatChat1234567890!!').buffer;
  }
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptChunk(buffer: ArrayBuffer, key: CryptoKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
  const combined = new Uint8Array(iv.length + encryptedBuffer.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encryptedBuffer), iv.length);
  return combined.buffer;
}

export async function decryptChunk(encryptedBuffer: ArrayBuffer, key: CryptoKey) {
  const iv = encryptedBuffer.slice(0, 12);
  const data = encryptedBuffer.slice(12);
  return await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, data);
}

export async function processFileForP2P(file: File, userPassword?: string) {
  const CHUNK_SIZE = 64 * 1024;
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const chunkMetadata = [];
  const encryptedChunks: ArrayBuffer[] = [];
  const key = await generateMasterKey(userPassword);

  const getHash = async (buffer: ArrayBuffer) => {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunkBlob = file.slice(start, end);
    const buffer = await chunkBlob.arrayBuffer();
    const encryptedBuffer = await encryptChunk(buffer, key);
    const hash = await getHash(encryptedBuffer);

    chunkMetadata.push({ part: `P${String(i + 1).padStart(2, '0')}`, hash, size: encryptedBuffer.byteLength });
    encryptedChunks.push(encryptedBuffer);
  }

  return { totalChunks, encrypted: true, chunks: chunkMetadata, encryptedChunks };
}

export function useWebRTC(currentUser: any, setP2pMediaUrls: React.Dispatch<React.SetStateAction<Record<string, string>>>) {
  const [activePeers, setActivePeers] = useState<string[]>([]);
  const peerConnectionsRef = useRef<Record<string, RTCPeerConnection>>({});
  const dataChannelsRef = useRef<Record<string, RTCDataChannel>>({});
  const signalingChannelRef = useRef<any>(null);
  const incomingFilesRef = useRef<Record<string, { chunks: ArrayBuffer[]; total: number; type: string; received: number; isLocked: boolean }>>({});
  const activeTransferByPeerRef = useRef<Record<string, string>>({});
  const pendingIceByPeerRef = useRef<Record<string, RTCIceCandidateInit[]>>({});

  const { saveToVault } = useLocalVault();

  const sendSignal = useCallback((targetId: string, signal: any) => {
    if (!signalingChannelRef.current || !currentUser) return;
    signalingChannelRef.current.send({
      type: 'broadcast',
      event: 'signal',
      payload: { targetUserId: targetId, senderId: currentUser.id, signal }
    });
  }, [currentUser]);

  const setupDataChannel = useCallback((channel: RTCDataChannel, targetUserId: string) => {
    dataChannelsRef.current[targetUserId] = channel;
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => setActivePeers((prev) => (prev.includes(targetUserId) ? prev : [...prev, targetUserId]));
    channel.onclose = () => setActivePeers((prev) => prev.filter((id) => id !== targetUserId));

    channel.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'file_start') {
            activeTransferByPeerRef.current[targetUserId] = data.msgId;
            incomingFilesRef.current[data.msgId] = {
              chunks: [],
              total: data.totalChunks,
              type: data.fileType,
              received: 0,
              isLocked: data.isPasswordProtected
            };
          }
        } catch (e) {}
      } else if (event.data instanceof ArrayBuffer) {
        const msgId = activeTransferByPeerRef.current[targetUserId];
        if (msgId && incomingFilesRef.current[msgId]) {
          const fileData = incomingFilesRef.current[msgId];
          fileData.chunks.push(event.data);
          fileData.received++;

          if (fileData.received === fileData.total) {
            if (!fileData.isLocked) {
              try {
                const key = await generateMasterKey('');
                const decryptedChunks: ArrayBuffer[] = [];
                for (const chunk of fileData.chunks) {
                  decryptedChunks.push(await decryptChunk(chunk, key));
                }
                const blob = new Blob(decryptedChunks, { type: fileData.type });
                await saveToVault(msgId, blob);
                const virtualUrl = URL.createObjectURL(blob);
                setP2pMediaUrls((prev) => ({ ...prev, [msgId]: virtualUrl }));
              } catch (e) {}
            }
            delete incomingFilesRef.current[msgId];
          }
        }
      }
    };
  }, [saveToVault, setP2pMediaUrls]);

  const initializeWebRTC = useCallback((targetUserId: string, initiateOffer = false) => {
    if (peerConnectionsRef.current[targetUserId]) {
      peerConnectionsRef.current[targetUserId].close();
    }

    const pc = new RTCPeerConnection(rtcConfig);
    peerConnectionsRef.current[targetUserId] = pc;
    pendingIceByPeerRef.current[targetUserId] = [];

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal(targetUserId, event.candidate);
    };

    if (initiateOffer) {
      const dataChannel = pc.createDataChannel('p2p-media');
      setupDataChannel(dataChannel, targetUserId);
      pc.createOffer().then((offer) => {
        pc.setLocalDescription(offer);
        sendSignal(targetUserId, offer);
      });
    } else {
      pc.ondatachannel = (event) => setupDataChannel(event.channel, targetUserId);
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        setActivePeers((prev) => (prev.includes(targetUserId) ? prev : [...prev, targetUserId]));
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        setActivePeers((prev) => prev.filter((id) => id !== targetUserId));
      }
    };
  }, [sendSignal, setupDataChannel]);

  useEffect(() => {
    if (!currentUser) return;
    const sigChannel = supabase.channel('webrtc_signals')
      .on('broadcast', { event: 'signal' }, async (payload) => {
        const { targetUserId, senderId, signal } = payload.payload;
        if (targetUserId !== currentUser.id) return;

        if (!peerConnectionsRef.current[senderId]) initializeWebRTC(senderId, false);
        const pc = peerConnectionsRef.current[senderId];
        if (!pc) return;

        try {
          if (signal.type === 'offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
            const queued = pendingIceByPeerRef.current[senderId] || [];
            for (const cand of queued) {
              await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
            }
            pendingIceByPeerRef.current[senderId] = [];

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendSignal(senderId, answer);
          } else if (signal.type === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
            const queued = pendingIceByPeerRef.current[senderId] || [];
            for (const cand of queued) {
              await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
            }
            pendingIceByPeerRef.current[senderId] = [];
          } else if (signal.candidate) {
            if (pc.remoteDescription) {
              await pc.addIceCandidate(new RTCIceCandidate(signal)).catch(() => {});
            } else {
              if (!pendingIceByPeerRef.current[senderId]) pendingIceByPeerRef.current[senderId] = [];
              pendingIceByPeerRef.current[senderId].push(signal);
            }
          }
        } catch (err) {}
      })
      .subscribe();

    signalingChannelRef.current = sigChannel;
    return () => { supabase.removeChannel(sigChannel); };
  }, [currentUser, initializeWebRTC, sendSignal]);

  const closeAllConnections = useCallback(() => {
    Object.values(peerConnectionsRef.current).forEach((pc) => pc.close());
    peerConnectionsRef.current = {};
    dataChannelsRef.current = {};
  }, []);

  return {
    activePeers,
    initializeWebRTC,
    dataChannelsRef,
    closeAllConnections
  };
}