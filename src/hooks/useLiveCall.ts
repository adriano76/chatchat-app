// src/hooks/useLiveCall.ts
'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

const rtcConfig: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

export type CallStatus = 'idle' | 'calling' | 'ringing' | 'connected';

/**
 * Otimiza o SDP para forçar o codec Opus em alta definição com FEC (Forward Error Correction)
 * contra cortes de voz em redes móveis (4G/5G/Wi-Fi instável).
 */
function optimizeOpusSdp(sdp?: string): string | undefined {
  if (!sdp) return sdp;
  return sdp.replace(
    /a=fmtp:111 ((?:(?!useinbandfec).)*)\r?\n/g,
    'a=fmtp:111 $1;useinbandfec=1;usedtx=1;maxaveragebitrate=64000;cbr=0\r\n'
  );
}

export function useLiveCall(currentUser: any, contacts: any[]) {
  const [callStatus, setCallStatus] = useState<CallStatus>('idle');
  const [incomingCall, setIncomingCall] = useState<{
    callerId: string;
    callerName: string;
    hasVideo: boolean;
    offer: any;
  } | null>(null);
  const [activeCallTarget, setActiveCallTarget] = useState<string | null>(null);
  const [isVideoCall, setIsVideoCall] = useState(false);
  const [isSpeakerphoneOn, setIsSpeakerphoneOn] = useState(false);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const signalingRef = useRef<any>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

  // Refs do motor de amplificação Web Audio API para o Viva-voz
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);

  const callStatusRef = useRef<CallStatus>(callStatus);
  const contactsRef = useRef<any[]>(contacts);

  useEffect(() => { callStatusRef.current = callStatus; }, [callStatus]);
  useEffect(() => { contactsRef.current = contacts; }, [contacts]);

  // Captura de mídia com filtros DSP de voz e fallback para compatibilidade mobile universal
  const getOptimizedMediaStream = useCallback(async (withVideo: boolean): Promise<MediaStream> => {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: withVideo
          ? {
              facingMode: 'user',
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 30, max: 30 }
            }
          : false,
        audio: {
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true },
          autoGainControl: { ideal: true },
          sampleRate: { ideal: 48000 },
          channelCount: { ideal: 1 }
        }
      });
    } catch {
      // Fallback caso o hardware do telemóvel rejeite constraints avançadas
      return await navigator.mediaDevices.getUserMedia({
        video: withVideo,
        audio: true
      });
    }
  }, []);

  // Configura amplificação limpa (Compressor + Ganho) para o modo Viva-voz
  const attachAudioBooster = useCallback((stream: MediaStream, speakerActive: boolean) => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx || stream.getAudioTracks().length === 0) return;

      if (!audioContextRef.current) {
        const ctx: AudioContext = new AudioCtx();
        const source = ctx.createMediaStreamSource(stream);
        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.setValueAtTime(-24, ctx.currentTime);
        compressor.knee.setValueAtTime(30, ctx.currentTime);
        compressor.ratio.setValueAtTime(12, ctx.currentTime);
        compressor.attack.setValueAtTime(0.003, ctx.currentTime);
        compressor.release.setValueAtTime(0.25, ctx.currentTime);

        const gain = ctx.createGain();
        // Ganho extra apenas quando o Viva-voz está ativo (1.8x mais volume limpo)
        gain.gain.setValueAtTime(speakerActive ? 1.8 : 0.0, ctx.currentTime);

        source.connect(compressor);
        compressor.connect(gain);
        gain.connect(ctx.destination);

        audioContextRef.current = ctx;
        gainNodeRef.current = gain;
      } else if (gainNodeRef.current && audioContextRef.current) {
        if (audioContextRef.current.state === 'suspended') {
          audioContextRef.current.resume().catch(() => {});
        }
        gainNodeRef.current.gain.setValueAtTime(
          speakerActive ? 1.8 : 0.0,
          audioContextRef.current.currentTime
        );
      }
    } catch (e) {
      console.warn('Web Audio Booster indisponível neste dispositivo:', e);
    }
  }, []);

  const cleanupCall = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
      gainNodeRef.current = null;
    }
    pendingCandidatesRef.current = [];
    setLocalStream((prev) => {
      prev?.getTracks().forEach((t) => t.stop());
      return null;
    });
    setRemoteStream(null);
    setCallStatus('idle');
    setIncomingCall(null);
    setActiveCallTarget(null);
    setIsSpeakerphoneOn(false);
  }, []);

  const sendCallSignal = useCallback((targetId: string, eventName: string, payloadData: any = {}) => {
    if (!signalingRef.current || !currentUser) return;
    signalingRef.current.send({
      type: 'broadcast',
      event: eventName,
      payload: { targetUserId: targetId, senderId: currentUser.id, ...payloadData }
    });
  }, [currentUser]);

  const setupPeerConnection = useCallback((targetId: string, stream: MediaStream) => {
    if (pcRef.current) pcRef.current.close();

    const pc = new RTCPeerConnection(rtcConfig);
    pcRef.current = pc;

    stream.getTracks().forEach((track) => {
      if (track.kind === 'audio') {
        track.contentHint = 'speech';
      }
      const sender = pc.addTrack(track, stream);

      // Eleva o bitrate de áudio para 64 kbps para voz cristalina
      if (track.kind === 'audio' && sender.getParameters) {
        try {
          const params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }
          params.encodings[0].maxBitrate = 64000;
          (params.encodings[0] as any).priority = 'high';
          (params.encodings[0] as any).networkPriority = 'high';
          sender.setParameters(params).catch(() => {});
        } catch {}
      }
    });

    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        setRemoteStream(event.streams[0]);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendCallSignal(targetId, 'call_signal', { signal: event.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        cleanupCall();
      }
    };

    return pc;
  }, [cleanupCall, sendCallSignal]);

  // Canal de Sinalização Estável (não reinicia durante a chamada)
  useEffect(() => {
    if (!currentUser) return;

    const channel = supabase.channel('live_calls_channel')
      .on('broadcast', { event: 'call_invite' }, async (payload) => {
        const { targetUserId, senderId, hasVideo, offer } = payload.payload;
        if (targetUserId !== currentUser.id || callStatusRef.current !== 'idle') return;

        pendingCandidatesRef.current = [];
        const caller = contactsRef.current.find((c) => c.id === senderId);
        setIncomingCall({
          callerId: senderId,
          callerName: caller?.savedName || caller?.username || 'Alguém',
          hasVideo,
          offer
        });
        setCallStatus('ringing');
      })
      .on('broadcast', { event: 'call_accept' }, async (payload) => {
        const { targetUserId, answer } = payload.payload;
        if (targetUserId !== currentUser.id || !pcRef.current) return;

        const enhancedAnswer = {
          ...answer,
          sdp: optimizeOpusSdp(answer.sdp)
        };

        await pcRef.current.setRemoteDescription(new RTCSessionDescription(enhancedAnswer));
        for (const candidate of pendingCandidatesRef.current) {
          await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
        }
        pendingCandidatesRef.current = [];
        setCallStatus('connected');
      })
      .on('broadcast', { event: 'call_reject' }, (payload) => {
        if (payload.payload.targetUserId === currentUser.id) {
          alert('A chamada foi rejeitada.');
          cleanupCall();
        }
      })
      .on('broadcast', { event: 'call_end' }, (payload) => {
        if (payload.payload.targetUserId === currentUser.id) {
          cleanupCall();
        }
      })
      .on('broadcast', { event: 'call_signal' }, async (payload) => {
        const { targetUserId, signal } = payload.payload;
        if (targetUserId !== currentUser.id || !signal?.candidate) return;

        // Se o PeerConnection já tiver descrição remota, adiciona direto; caso contrário, guarda na fila
        if (pcRef.current && pcRef.current.remoteDescription) {
          await pcRef.current.addIceCandidate(new RTCIceCandidate(signal)).catch(() => {});
        } else {
          pendingCandidatesRef.current.push(signal);
        }
      })
      .subscribe();

    signalingRef.current = channel;
    return () => { supabase.removeChannel(channel); };
  }, [currentUser, cleanupCall]);

  const startCall = async (targetId: string, withVideo: boolean) => {
    try {
      pendingCandidatesRef.current = [];
      const stream = await getOptimizedMediaStream(withVideo);
      setLocalStream(stream);
      setIsVideoCall(withVideo);
      setIsSpeakerphoneOn(withVideo); // Vídeo inicia com viva-voz por padrão
      setCallStatus('calling');
      setActiveCallTarget(targetId);

      const pc = setupPeerConnection(targetId, stream);
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: withVideo
      });
      const enhancedOffer = {
        type: offer.type,
        sdp: optimizeOpusSdp(offer.sdp)
      };

      await pc.setLocalDescription(enhancedOffer);
      sendCallSignal(targetId, 'call_invite', { hasVideo: withVideo, offer: enhancedOffer });
    } catch (err) {
      alert('Erro ao aceder à câmara ou microfone.');
      cleanupCall();
    }
  };

  const acceptCall = async () => {
    if (!incomingCall) return;
    try {
      const stream = await getOptimizedMediaStream(incomingCall.hasVideo);
      setLocalStream(stream);
      setIsVideoCall(incomingCall.hasVideo);
      setIsSpeakerphoneOn(incomingCall.hasVideo);
      setCallStatus('connected');
      setActiveCallTarget(incomingCall.callerId);

      const pc = setupPeerConnection(incomingCall.callerId, stream);
      const enhancedOffer = {
        ...incomingCall.offer,
        sdp: optimizeOpusSdp(incomingCall.offer.sdp)
      };
      await pc.setRemoteDescription(new RTCSessionDescription(enhancedOffer));

      // Processa todos os candidatos ICE que chegaram enquanto o telefone tocava
      for (const candidate of pendingCandidatesRef.current) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
      }
      pendingCandidatesRef.current = [];

      const answer = await pc.createAnswer();
      const enhancedAnswer = {
        type: answer.type,
        sdp: optimizeOpusSdp(answer.sdp)
      };
      await pc.setLocalDescription(enhancedAnswer);

      sendCallSignal(incomingCall.callerId, 'call_accept', { answer: enhancedAnswer });
      setIncomingCall(null);
    } catch (err) {
      alert('Não foi possível aceitar a chamada.');
      rejectCall();
    }
  };

  const rejectCall = () => {
    if (incomingCall) {
      sendCallSignal(incomingCall.callerId, 'call_reject');
      setIncomingCall(null);
      setCallStatus('idle');
      pendingCandidatesRef.current = [];
    }
  };

  const endCall = () => {
    if (activeCallTarget) sendCallSignal(activeCallTarget, 'call_end');
    cleanupCall();
  };

  // Alterna o Viva-voz (Roteamento de saída + Amplificador Web Audio API)
  const toggleSpeakerphone = useCallback(async () => {
    const nextState = !isSpeakerphoneOn;
    setIsSpeakerphoneOn(nextState);

    if (remoteStream) {
      attachAudioBooster(remoteStream, nextState);
    }

    try {
      if (navigator.mediaDevices?.enumerateDevices) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter((d) => d.kind === 'audiooutput');
        const mediaElements = document.querySelectorAll<HTMLMediaElement>('video, audio');

        if (outputs.length > 0) {
          const speakerDevice = outputs.find((d) =>
            /speaker|viva|alto-falante|altifalante|hands-free/i.test(d.label)
          ) || outputs[outputs.length - 1];
          const defaultDevice = outputs[0];
          const targetSinkId = nextState ? speakerDevice.deviceId : defaultDevice.deviceId;

          mediaElements.forEach((el: any) => {
            if (typeof el.setSinkId === 'function' && !el.muted) {
              el.setSinkId(targetSinkId).catch(() => {});
            }
          });
        }
      }
    } catch {}
  }, [isSpeakerphoneOn, remoteStream, attachAudioBooster]);

  return {
    callStatus,
    incomingCall,
    localStream,
    remoteStream,
    isVideoCall,
    isSpeakerphoneOn,
     toggleSpeakerphone,
    startCall,
    acceptCall,
    rejectCall,
    endCall
  };
}