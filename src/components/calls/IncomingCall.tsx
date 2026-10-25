import React from 'react';

interface IncomingCallProps {
  callerName: string;
  hasVideo: boolean;
  onAccept: () => void;
  onReject: () => void;
}

export function IncomingCall({ callerName, hasVideo, onAccept, onReject }: IncomingCallProps) {
  return (
    <div className="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-popup">
      <div className="bg-slate-900 border border-slate-700 rounded-3xl max-w-sm w-full overflow-hidden shadow-2xl flex flex-col items-center p-8 text-center relative">
        {/* Animação de pulsar */}
        <div className="absolute top-10 w-24 h-24 bg-emerald-500/20 rounded-full animate-ping"></div>
        
        <div className="w-24 h-24 bg-slate-800 border-4 border-slate-700 rounded-full flex items-center justify-center text-4xl mb-4 relative z-10 shadow-lg">
          {callerName.charAt(0).toUpperCase()}
        </div>
        
        <h3 className="text-white text-xl font-bold mb-1">{callerName}</h3>
        <p className="text-emerald-400 text-sm font-semibold mb-8">
          A receber chamada de {hasVideo ? 'Vídeo' : 'Voz'}...
        </p>

        <div className="flex w-full gap-4 px-2">
          <button 
            onClick={onReject}
            className="flex-1 bg-rose-500 hover:bg-rose-600 text-white font-bold py-3.5 rounded-2xl transition shadow-[0_0_15px_rgba(244,63,94,0.4)] flex justify-center items-center gap-2"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/></svg>
            Rejeitar
          </button>
          
          <button 
            onClick={onAccept}
            className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white font-bold py-3.5 rounded-2xl transition shadow-[0_0_15px_rgba(16,185,129,0.4)] flex justify-center items-center gap-2"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
            Atender
          </button>
        </div>
      </div>
    </div>
  );
}