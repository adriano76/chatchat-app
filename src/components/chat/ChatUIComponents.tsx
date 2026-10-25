// Caminho: src/components/chat/ChatUIComponents.tsx
'use client';

import React, { useState, useEffect, useRef } from 'react';

export interface AvatarProps {
  name?: string;
  customEmoji?: string | null;
  size?: string;
  fontSize?: string;
}

export interface CustomAudioPlayerProps {
  src?: string | null;
  isMe: boolean;
}

export const Avatar = React.memo(({
  name,
  customEmoji,
  size = 'w-11 h-11 md:w-12 md:h-12',
  fontSize = 'text-base md:text-lg'
}: AvatarProps) => {
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setImgError(false);
  }, [customEmoji]);

  const isImageUrl = Boolean(
    customEmoji &&
    !imgError &&
    (customEmoji.startsWith('http://') ||
      customEmoji.startsWith('https://') ||
      customEmoji.startsWith('data:image/') ||
      customEmoji.startsWith('blob:'))
  );

  if (isImageUrl && customEmoji) {
    return (
      <div
        className={`${size} bg-slate-100 border border-slate-200 rounded-full flex items-center justify-center shrink-0 shadow-sm relative z-10 overflow-hidden`}
      >
        <img
          src={customEmoji}
          alt={name || 'Avatar'}
          onError={() => setImgError(true)}
          className="w-full h-full object-cover rounded-full"
        />
      </div>
    );
  }

  if (customEmoji && !imgError) {
    return (
      <div
        className={`${size} bg-slate-100 border border-slate-200 rounded-full flex items-center justify-center ${fontSize} shrink-0 shadow-sm relative z-10 overflow-hidden`}
      >
        <span className="scale-125 md:scale-150">{customEmoji}</span>
      </div>
    );
  }

  const initial = (name || 'A').charAt(0).toUpperCase();
  const colors = ['bg-slate-800', 'bg-blue-600', 'bg-purple-600', 'bg-rose-600', 'bg-amber-500'];
  const colorIndex = initial.charCodeAt(0) % colors.length;

  return (
    <div
      className={`${size} ${colors[colorIndex]} border border-white/50 rounded-full flex items-center justify-center text-white font-bold ${fontSize} shrink-0 shadow-sm relative z-10`}
    >
      {initial}
    </div>
  );
});
Avatar.displayName = 'Avatar';

export const CustomAudioPlayer = React.memo(({ src, isMe }: CustomAudioPlayerProps) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const updateDuration = () => {
      const dur = audio.duration;
      if (dur === Infinity) {
        const onSeekedFix = () => {
          audio.removeEventListener('seeked', onSeekedFix);
          if (isFinite(audio.duration) && audio.duration < 36000) {
            setDuration(audio.duration);
          }
          audio.currentTime = 0;
        };
        audio.addEventListener('seeked', onSeekedFix);
        try {
          audio.currentTime = 1e101;
        } catch {
          audio.removeEventListener('seeked', onSeekedFix);
        }
      } else if (isFinite(dur) && dur > 0 && dur < 36000) {
        setDuration(dur);
      }
    };

    const setAudioTime = () => {
      setCurrentTime(audio.currentTime);
      if (duration === 0 && isFinite(audio.duration) && audio.duration > 0 && audio.duration < 36000) {
        setDuration(audio.duration);
      }
    };

    const onEnd = () => {
      setIsPlaying(false);
      setCurrentTime(0);
      try {
        audio.currentTime = 0;
      } catch {}
    };

    audio.addEventListener('loadedmetadata', updateDuration);
    audio.addEventListener('loadeddata', updateDuration);
    audio.addEventListener('durationchange', updateDuration);
    audio.addEventListener('timeupdate', setAudioTime);
    audio.addEventListener('ended', onEnd);

    return () => {
      audio.removeEventListener('loadedmetadata', updateDuration);
      audio.removeEventListener('loadeddata', updateDuration);
      audio.removeEventListener('durationchange', updateDuration);
      audio.removeEventListener('timeupdate', setAudioTime);
      audio.removeEventListener('ended', onEnd);
    };
  }, [src, duration]);

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    const audio = audioRef.current;
    if (!audio || !src) return;

    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      if (isFinite(audio.duration) && audio.duration > 0 && audio.currentTime >= audio.duration - 0.1) {
        audio.currentTime = 0;
      }
      audio.play().catch(() => setIsPlaying(false));
      setIsPlaying(true);
    }
  };

  const formatTime = (time: number) => {
    if (isNaN(time) || !isFinite(time) || time <= 0 || time > 36000) return '0:00';
    const m = Math.floor(time / 60);
    const s = Math.floor(time % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const buttonBg = isMe ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-600';
  const waveColor = isMe ? 'bg-emerald-600/40' : 'bg-slate-300';
  const waveActiveColor = isMe ? 'bg-emerald-700' : 'bg-slate-600';

  return (
    <div
      className="flex items-center gap-2 w-full min-w-[200px] max-w-[250px] py-0.5"
      onClick={(e) => e.stopPropagation()}
    >
      {src && <audio ref={audioRef} src={src} preload="auto" />}
      <button
        type="button"
        onClick={togglePlay}
        className={`w-9 h-9 flex items-center justify-center rounded-full shrink-0 shadow-sm transition-transform active:scale-90 ${buttonBg}`}
      >
        {isPlaying ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="4" width="4" height="16" />
            <rect x="14" y="4" width="4" height="16" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="ml-0.5">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <div className="flex-1 flex flex-col justify-center overflow-hidden">
        <div className="flex items-center gap-[2px] h-6 overflow-hidden">
          {[...Array(30)].map((_, i) => {
            const isActive = (i / 30) <= (currentTime / (duration || 1));
            const h = 20 + Math.abs(Math.sin(i * 0.5)) * 60 + (i % 3 === 0 ? 20 : 0);
            return (
              <div
                key={i}
                className={`w-[2.5px] rounded-full transition-colors duration-200 ${
                  isActive ? waveActiveColor : waveColor
                }`}
                style={{ height: `${h}%` }}
              />
            );
          })}
        </div>
        <div className={`text-[10px] font-medium mt-1 ${isMe ? 'text-emerald-800' : 'text-slate-400'}`}>
          {formatTime(currentTime > 0 ? currentTime : duration)}
        </div>
      </div>
    </div>
  );
});
CustomAudioPlayer.displayName = 'CustomAudioPlayer';