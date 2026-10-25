import { useState, useRef, useCallback } from 'react';

export function useCamera(onMediaCaptured: (file: File, isVideo: boolean) => void) {
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('environment');

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  const startCamera = useCallback(async () => {
    setIsCameraOpen(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode }, audio: true });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
      }
    } catch (err) {
      alert("Não foi possível aceder à câmara ou ao microfone.");
      setIsCameraOpen(false);
    }
  }, [facingMode]);

  const stopCamera = useCallback(() => {
    if (isRecording) stopRecording();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setIsCameraOpen(false);
    setIsRecording(false);
  }, [isRecording]);

  const toggleFacingMode = useCallback(() => {
    setFacingMode(prev => prev === 'user' ? 'environment' : 'user');
    stopCamera();
    setTimeout(startCamera, 100);
  }, [startCamera, stopCamera]);

  const capturePhoto = useCallback(() => {
    if (!videoRef.current) return;
    const canvas = document.createElement('canvas');
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      if (facingMode === 'user') {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (blob) {
          const file = new File([blob], `photo_${Date.now()}.jpeg`, { type: 'image/jpeg' });
          onMediaCaptured(file, false);
          stopCamera();
        }
      }, 'image/jpeg', 0.9);
    }
  }, [facingMode, onMediaCaptured, stopCamera]);

  const startRecording = useCallback(() => {
    if (!streamRef.current) return;
    recordedChunksRef.current = [];
    try {
      const recorder = new MediaRecorder(streamRef.current);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || 'video/webm';
        const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
        const blob = new Blob(recordedChunksRef.current, { type: mimeType });
        const file = new File([blob], `video_${Date.now()}.${ext}`, { type: mimeType });
        onMediaCaptured(file, true);
        stopCamera();
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch (e) {
      alert("Erro ao gravar vídeo no seu dispositivo.");
    }
  }, [onMediaCaptured, stopCamera]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  }, []);

  const handleCameraPressStart = useCallback(() => {
    pressTimerRef.current = setTimeout(() => {
      startRecording();
    }, 400); 
  }, [startRecording]);

  const handleCameraPressEnd = useCallback(() => {
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
    if (isRecording) {
      stopRecording();
    } else {
      capturePhoto(); 
    }
  }, [isRecording, stopRecording, capturePhoto]);

  return {
    videoRef,
    isCameraOpen,
    isRecording,
    facingMode,
    startCamera,
    stopCamera,
    toggleFacingMode,
    handleCameraPressStart,
    handleCameraPressEnd
  };
}