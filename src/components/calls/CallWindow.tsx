// src/components/calls/CallWindow.tsx
'use client';

import React, { useEffect, useRef } from 'react';

export interface CallWindowProps {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  isVideoCall: boolean;
  remoteName: string;
  onEndCall: () => void;
}

export function CallWindow({
  localStream,
  remoteStream,
  isVideoCall,
  remoteName,
  onEndCall,
}: CallWindowProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);

  // Associa o stream local (sua câmara/microfone) à tag de vídeo local
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  // Associa o stream remoto (quem está do outro lado) e força a reprodução de áudio/vídeo
  useEffect(() => {
    if (remoteStream) {
      if (isVideoCall && remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream;
      }

      // Elemento de áudio autónomo para garantir que chamadas de áudio ou vídeo nunca fiquem mudas
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStream;
        remoteAudioRef.current.play().catch((error) => {
          console.warn('Autoplay do navegador restrito, aguardando gesto do utilizador:', error);
        });
      }
    }
  }, [remoteStream, isVideoCall]);

  return (
    <div className="fixed inset-0 z-[99999] bg-slate-950/95 backdrop-blur-md flex flex-col items-center justify-between p-6 text-white select-none">
      {/* Elemento de áudio invisível para garantir a escuta do som remoto */}
      <audio ref={remoteAudioRef} autoPlay playsInline />

      {/* Cabeçalho da Chamada */}
      <div className="flex flex-col items-center mt-6 z-10">
        <div className="w-20 h-20 rounded-full bg-emerald-500/20 border-2 border-emerald-500 flex items-center justify-center text-2xl font-bold mb-3 shadow-lg animate-pulse">
          {remoteName.charAt(0).toUpperCase()}
        </div>
        <h2 className="text-xl md:text-2xl font-bold tracking-tight">{remoteName}</h2>
        <p className="text-emerald-400 text-xs md:text-sm mt-1 font-medium flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
          {isVideoCall ? 'Chamada de Vídeo Segura' : 'Chamada de Áudio Segura'}
        </p>
      </div>

      {/* Corpo / Vídeos */}
      <div className="flex-1 flex items-center justify-center w-full max-w-4xl relative my-4">
        {isVideoCall ? (
          <div className="relative w-full h-full max-h-[65vh] bg-black rounded-3xl overflow-hidden flex items-center justify-center border border-white/10 shadow-2xl">
            {/* Vídeo do Outro Utilizador */}
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="w-full h-full object-cover"
            />

            {/* O seu Vídeo (Miniatura flutuante Picture-in-Picture) */}
            <div className="absolute bottom-4 right-4 w-28 h-40 md:w-36 md:h-48 bg-slate-900 rounded-2xl overflow-hidden border-2 border-white/20 shadow-2xl">
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover scale-x-[-1]"
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-4">
            <div className="w-36 h-36 rounded-full bg-emerald-500/10 border-4 border-emerald-500/30 flex items-center justify-center shadow-[0_0_50px_rgba(16,185,129,0.2)]">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-400">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                <path d="M19 10v1a7 7 0 0 1-14 0v-1"></path>
                <line x1="12" y1="19" x2="12" y2="23"></line>
                <line x1="8" y1="23" x2="16" y2="23"></line>
              </svg>
            </div>
            <span className="text-slate-400 text-sm font-medium">Áudio P2P Criptografado ativo</span>
          </div>
        )}
      </div>

      {/* Controles Inferiores (Desligar) */}
      <div className="mb-4 z-10">
        <button
          onClick={onEndCall}
          className="bg-rose-600 hover:bg-rose-500 active:scale-95 text-white font-bold px-8 py-3.5 rounded-full shadow-[0_4px_20px_rgba(225,29,72,0.4)] transition flex items-center gap-2.5 text-sm md:text-base cursor-pointer"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.33a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"></path>
            <line x1="23" y1="1" x2="1" y2="23"></line>
          </svg>
          Terminar Chamada
        </button>
      </div>
    </div>
  );
}