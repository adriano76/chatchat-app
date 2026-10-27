// Caminho: src/lib/chatMediaUtils.ts

import { supabase } from '@/lib/supabase';
import {
  processFileForP2P,
  generateMasterKey,
  encryptChunk
} from '@/hooks/useWebRTC';
import type { ImageMetadata, ChatMessage } from '@/app/types/chat';

/**
 * Restrições de Áudio HD (48.000 Hz) ajustadas para Mobile.
 * Cancelamento de Eco (Anti-Microfonia) LIGADO, 
 * Supressão de Ruído e Controle Automático de Ganho DESLIGADOS
 * para evitar voz robótica/abafada no sistema Android.
 */
export const HD_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  sampleRate: { ideal: 48000 },
  sampleSize: { ideal: 16 },
  channelCount: { ideal: 1 },
  echoCancellation: { ideal: true },
  noiseSuppression: false, // <-- Desligado para evitar distorção da voz no Android
  autoGainControl: false   // <-- Desligado para evitar flutuações forçadas de volume
};

export const getStatusDisplay = (status?: string) => {
  switch (status?.toLowerCase()) {
    case 'online': return { color: 'bg-emerald-500', pulse: true, text: 'Online' };
    case 'ausente': return { color: 'bg-amber-500', pulse: false, text: 'Ausente' };
    case 'ocupado': return { color: 'bg-rose-500', pulse: false, text: 'Ocupado' };
    case 'invisivel': return { color: 'bg-slate-400', pulse: false, text: 'Invisível' };
    default: return { color: 'bg-slate-400', pulse: false, text: status || 'Offline' };
  }
};

export const formatBytes = (bytes?: number): string => {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const formatDuration = (sec?: number): string => {
  if (!sec || sec <= 0 || !isFinite(sec) || sec > 36000) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

export const isVideoFileCheck = (file: { type?: string; name?: string }): boolean => {
  return (
    Boolean(file.type && file.type.startsWith('video/')) ||
    /\.(mp4|webm|mov|avi|mkv|3gp|m4v)$/i.test(file.name || '')
  );
};

export const getNormalizedMimeType = (
  file: { type?: string; name?: string },
  isVideo: boolean,
  isAudio: boolean
): string => {
  if (isAudio) {
    if ((file.type || '').includes('mp4') || /\.m4a$/i.test(file.name || '')) return 'audio/mp4';
    return 'audio/webm';
  }
  if (isVideo) {
    if (/\.webm$/i.test(file.name || '') || (file.type || '').toLowerCase().includes('webm')) {
      return 'video/webm';
    }
    return 'video/mp4';
  }
  const baseType = (file.type || '').split(';')[0].trim().toLowerCase();
  if (baseType === 'image/png' || /\.png$/i.test(file.name || '')) return 'image/png';
  if (baseType === 'image/gif' || /\.gif$/i.test(file.name || '')) return 'image/gif';
  if (baseType === 'image/webp' || /\.webp$/i.test(file.name || '')) return 'image/webp';
  return 'image/jpeg';
};

/**
 * Inspeciona os Magic Bytes reais do buffer binário para descobrir o formato verdadeiro
 * (evita que um vídeo WebM seja montado como MP4 ou vice-versa, o que causava tela preta).
 */
export const detectMimeFromBinary = (
  buffer: ArrayBuffer,
  fallbackName?: string,
  isVideo?: boolean,
  isAudio?: boolean
): string => {
  const bytes = new Uint8Array(buffer.slice(0, 16));

  // Assinatura EBML (WebM / MKV): 1A 45 DF A3
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return isAudio ? 'audio/webm' : 'video/webm';
  }
  // Assinatura MP4 / QuickTime ('ftyp' nos bytes 4..7)
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return isAudio ? 'audio/mp4' : 'video/mp4';
  }
  // Assinatura OGG ('OggS')
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return isAudio ? 'audio/ogg' : 'video/ogg';
  }
  // Assinatura PNG: 89 50 4E 47
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  // Assinatura GIF: 47 49 46 38
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  // Assinatura WEBP ('RIFF'....'WEBP')
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  return getNormalizedMimeType({ name: fallbackName }, Boolean(isVideo), Boolean(isAudio));
};

/**
 * Clona imediatamente um File do sistema mobile (content://) para a memória RAM (Blob desacoplado)
 */
export const cloneFileToRamSafely = async (rawFile: File, targetMime: string): Promise<Blob> => {
  try {
    const res = new Response(rawFile);
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > 0) {
      const detectedMime = detectMimeFromBinary(buffer, rawFile.name, targetMime.startsWith('video/'), targetMime.startsWith('audio/'));
      return new Blob([new Uint8Array(buffer)], { type: detectedMime || targetMime });
    }
  } catch {}

  try {
    const buffer = await rawFile.arrayBuffer();
    if (buffer.byteLength > 0) {
      const detectedMime = detectMimeFromBinary(buffer, rawFile.name, targetMime.startsWith('video/'), targetMime.startsWith('audio/'));
      return new Blob([new Uint8Array(buffer)], { type: detectedMime || targetMime });
    }
  } catch {}

  return await new Promise<Blob>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        const detectedMime = detectMimeFromBinary(reader.result, rawFile.name, targetMime.startsWith('video/'), targetMime.startsWith('audio/'));
        resolve(new Blob([new Uint8Array(reader.result)], { type: detectedMime || targetMime }));
      } else {
        reject(new Error('Falha ao converter ficheiro para memória.'));
      }
    };
    reader.onerror = () => reject(reader.error || new Error('Permissão de leitura expirada no dispositivo.'));
    reader.readAsArrayBuffer(rawFile.slice(0, rawFile.size, targetMime));
  });
};

/**
 * Corrige a reprodução de vídeo:
 * - Remove o poster borrado de baixa resolução para exibir o frame nativo nítido do vídeo.
 * - Corrige durações infinitas (bug de WebM mobile) sem travar o vídeo no final (0:02).
 * - Reposiciona no segundo 0 quando a reprodução chega ao fim.
 */
export const fixVideoDurationAndPlayback = (videoEl: HTMLVideoElement) => {
  if (!videoEl) return;

  // Remove a miniatura base64 de baixa resolução para que o navegador mostre o frame real em HD
  if (videoEl.poster && videoEl.poster.startsWith('data:image/')) {
    videoEl.removeAttribute('poster');
  }

  videoEl.preload = 'auto';

  const dur = videoEl.duration;

  // Só faz o ajuste de seek se o container for um WebM com duração estritamente Infinita
  if (dur === Infinity) {
    const onSeekedFix = () => {
      videoEl.removeEventListener('seeked', onSeekedFix);
      videoEl.currentTime = 0;
    };
    videoEl.addEventListener('seeked', onSeekedFix);
    try {
      videoEl.currentTime = 1e101;
    } catch {
      videoEl.removeEventListener('seeked', onSeekedFix);
    }
    return;
  }

  // Se o vídeo abriu posicionado no fim, rebobina para o início (0:00)
  if (isFinite(dur) && dur > 0 && videoEl.currentTime >= dur - 0.1) {
    try {
      videoEl.currentTime = 0;
    } catch {}
  }

  // Garante que ao terminar de tocar, o vídeo volte ao início para permitir novo Play imediato
  if (!videoEl.dataset.rewindAttached) {
    videoEl.dataset.rewindAttached = 'true';
    videoEl.addEventListener('ended', () => {
      try {
        videoEl.currentTime = 0;
      } catch {}
    });
  }
};

/**
 * Prepara chunks P2P com tamanho seguro de 64 KB para o RTCDataChannel (SCTP),
 * evitando falhas de envio na criptografia WebRTC.
 */
export const prepareFileForP2PSafe = async (
  file: File | Blob,
  userPassword?: string
): Promise<Awaited<ReturnType<typeof processFileForP2P>>> => {
  const SAFE_SCTP_CHUNK_SIZE = 64 * 1024; // 64 KB
  const totalChunks = Math.ceil(file.size / SAFE_SCTP_CHUNK_SIZE);
  const chunkMetadata: { part: string; hash: string; size: number }[] = [];
  const encryptedChunks: ArrayBuffer[] = [];
  const key = await generateMasterKey(userPassword);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * SAFE_SCTP_CHUNK_SIZE;
    const end = Math.min(start + SAFE_SCTP_CHUNK_SIZE, file.size);
    const chunkBlob = file.slice(start, end);
    const buffer = await chunkBlob.arrayBuffer();
    const encryptedBuffer = await encryptChunk(buffer, key);

    chunkMetadata.push({
      part: `P${String(i + 1).padStart(4, '0')}`,
      hash: '',
      size: encryptedBuffer.byteLength
    });
    encryptedChunks.push(encryptedBuffer);
  }

  return { totalChunks, encrypted: true, chunks: chunkMetadata, encryptedChunks };
};

/**
 * Fotos: Gera miniatura preview_base64 compacta + dimensões.
 * Vídeos: Extrai duração real validada e frame nítido (320px) sem tela preta e sem borrar.
 */
export const generateMediaThumbnailAndMeta = (
  blob: Blob,
  isVideo: boolean
): Promise<{ previewBase64: string; width?: number; height?: number; durationSec?: number }> => {
  return new Promise((resolve) => {
    if (isVideo) {
      const objectUrl = URL.createObjectURL(blob);
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;

      let finished = false;
      const done = (result: { previewBase64: string; width?: number; height?: number; durationSec?: number }) => {
        if (finished) return;
        finished = true;
        URL.revokeObjectURL(objectUrl);
        resolve(result);
      };

      const timeoutId = setTimeout(() => {
        done({ previewBase64: '' });
      }, 2500);

      video.onloadeddata = () => {
        try {
          const validDur = isFinite(video.duration) && video.duration > 0 && video.duration < 7200 ? video.duration : 1;
          video.currentTime = Math.min(0.2, validDur * 0.1);
        } catch {
          clearTimeout(timeoutId);
          const validDur = isFinite(video.duration) && video.duration > 0 && video.duration < 7200
            ? Math.round(video.duration)
            : undefined;
          done({
            previewBase64: '',
            width: video.videoWidth || 1280,
            height: video.videoHeight || 720,
            durationSec: validDur
          });
        }
      };

      video.onseeked = () => {
        try {
          clearTimeout(timeoutId);
          const vw = video.videoWidth || 1280;
          const vh = video.videoHeight || 720;
          const durationSec = isFinite(video.duration) && video.duration > 0 && video.duration < 7200
            ? Math.round(video.duration)
            : undefined;

          const canvas = document.createElement('canvas');
          const targetWidth = Math.min(320, vw);
          const scale = targetWidth / vw;
          canvas.width = targetWidth;
          canvas.height = Math.max(40, Math.round(vh * scale));
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            done({ previewBase64: '', width: vw, height: vh, durationSec });
            return;
          }

          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let lumaSum = 0;
          for (let i = 0; i < pixels.length; i += 64) {
            lumaSum += pixels[i] + pixels[i + 1] + pixels[i + 2];
          }

          const previewBase64 = lumaSum > 300 ? canvas.toDataURL('image/jpeg', 0.75) : '';
          done({ previewBase64, width: vw, height: vh, durationSec });
        } catch {
          done({ previewBase64: '' });
        }
      };

      video.onerror = () => {
        clearTimeout(timeoutId);
        done({ previewBase64: '' });
      };

      video.src = objectUrl;
      return;
    }

    if (!blob.type.startsWith('image/')) {
      resolve({ previewBase64: '' });
      return;
    }

    const objectUrl = URL.createObjectURL(blob);
    const timeoutId = setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
      resolve({ previewBase64: '' });
    }, 2000);

    const img = new Image();
    img.onload = () => {
      try {
        clearTimeout(timeoutId);
        const canvas = document.createElement('canvas');
        const targetWidth = 64;
        const scaleSize = targetWidth / (img.width || targetWidth);
        canvas.width = targetWidth;
        canvas.height = Math.max(1, Math.round((img.height || targetWidth) * scaleSize));
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
        URL.revokeObjectURL(objectUrl);
        resolve({
          previewBase64: dataUrl,
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height
        });
      } catch {
        URL.revokeObjectURL(objectUrl);
        resolve({ previewBase64: '' });
      }
    };
    img.onerror = () => {
      clearTimeout(timeoutId);
      URL.revokeObjectURL(objectUrl);
      resolve({ previewBase64: '' });
    };
    img.src = objectUrl;
  });
};

export const compressImageBlobForMobile = (blob: Blob, originalName: string): Promise<Blob> => {
  return new Promise((resolve) => {
    if (blob.type === 'image/gif' || /\.gif$/i.test(originalName)) {
      resolve(blob);
      return;
    }
    const img = new Image();
    const objectUrl = URL.createObjectURL(blob);

    img.onload = () => {
      try {
        const MAX_WIDTH = 1280;
        const MAX_HEIGHT = 1280;
        let width = img.naturalWidth || img.width;
        let height = img.naturalHeight || img.height;

        if (!width || !height) {
          URL.revokeObjectURL(objectUrl);
          resolve(blob);
          return;
        }

        if (width > height) {
          if (width > MAX_WIDTH) {
            height = Math.round((height * MAX_WIDTH) / width);
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width = Math.round((width * MAX_HEIGHT) / height);
            height = MAX_HEIGHT;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          URL.revokeObjectURL(objectUrl);
          resolve(blob);
          return;
        }

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob(
          (compressed) => {
            URL.revokeObjectURL(objectUrl);
            if (compressed && compressed.size > 0) {
              resolve(compressed);
            } else {
              resolve(blob);
            }
          },
          'image/jpeg',
          0.85
        );
      } catch {
        URL.revokeObjectURL(objectUrl);
        resolve(blob);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(blob);
    };

    img.src = objectUrl;
  });
};

/**
 * Motor de Upload Resiliente:
 * - Arquivos até 8 MB sobem íntegros num único arquivo com o Content-Type correto.
 * - Arquivos maiores que 8 MB são divididos em partes seguras (cloud_parts) com rollback automático.
 */
export const uploadToStorageWithAutoChunking = async (
  baseFileName: string,
  fileBlob: Blob,
  contentType: string,
  _isVideo: boolean,
  onProgress?: (percent: number) => void
): Promise<{ publicUrl: string | null; cloudParts: string[] | null }> => {
  const SINGLE_UPLOAD_LIMIT = 8 * 1024 * 1024; // 8 MB íntegro
  const CHUNK_LIMIT = 2 * 1024 * 1024; // 2 MB por parte para vídeos grandes
  onProgress?.(10);

  if (fileBlob.size <= SINGLE_UPLOAD_LIMIT) {
    const { error: singleError } = await supabase.storage
      .from('chat_images')
      .upload(baseFileName, fileBlob, { contentType, upsert: false });

    if (!singleError) {
      onProgress?.(100);
      const { data } = supabase.storage.from('chat_images').getPublicUrl(baseFileName);
      return { publicUrl: data.publicUrl, cloudParts: null };
    }
  }

  const totalParts = Math.ceil(fileBlob.size / CHUNK_LIMIT);
  const partUrls: string[] = new Array(totalParts);
  const uploadedPartNames: string[] = [];
  let completedParts = 0;
  const BATCH_SIZE = 3;

  try {
    for (let i = 0; i < totalParts; i += BATCH_SIZE) {
      const batch = [];
      for (let j = i; j < Math.min(i + BATCH_SIZE, totalParts); j++) {
        const start = j * CHUNK_LIMIT;
        const end = Math.min(start + CHUNK_LIMIT, fileBlob.size);
        const partBlob = fileBlob.slice(start, end, 'application/octet-stream');
        const partName = `${baseFileName}.part${String(j).padStart(4, '0')}`;

        batch.push(
          (async (idx: number, pName: string, pBlob: Blob) => {
            let lastErr: any = null;
            for (let attempt = 0; attempt < 3; attempt++) {
              const { error: partErr } = await supabase.storage
                .from('chat_images')
                .upload(pName, pBlob, { contentType: 'application/octet-stream', upsert: true });
              if (!partErr) {
                lastErr = null;
                break;
              }
              lastErr = partErr;
              await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
            }
            if (lastErr) throw lastErr;

            uploadedPartNames.push(pName);
            const { data } = supabase.storage.from('chat_images').getPublicUrl(pName);
            partUrls[idx] = data.publicUrl;
            completedParts++;
            onProgress?.(Math.min(99, Math.round((completedParts / totalParts) * 100)));
          })(j, partName, partBlob)
        );
      }
      await Promise.all(batch);
    }
  } catch (err) {
    if (uploadedPartNames.length > 0) {
      await supabase.storage.from('chat_images').remove(uploadedPartNames).catch(() => {});
    }
    throw err;
  }

  onProgress?.(100);
  return { publicUrl: null, cloudParts: partUrls };
};

/**
 * Baixa e reconstrói ficheiros normais ou vídeos divididos em partes (cloud_parts),
 * garantindo a ordem exata dos bytes.
 */
export const downloadMediaBufferFromMetadata = async (
  meta: ImageMetadata,
  fallbackUrl?: string,
  onProgress?: (percent: number) => void
): Promise<ArrayBuffer> => {
  const parts: string[] | undefined = meta.p2p_info?.cloud_parts || undefined;
  if (Array.isArray(parts) && parts.length > 0) {
    const buffers: ArrayBuffer[] = new Array(parts.length);
    let loaded = 0;
    const BATCH_SIZE = 4;

    for (let i = 0; i < parts.length; i += BATCH_SIZE) {
      const batch = [];
      for (let j = i; j < Math.min(i + BATCH_SIZE, parts.length); j++) {
        batch.push(
          (async (idx: number, partUrl: string) => {
            const res = await fetch(partUrl);
            if (!res.ok) throw new Error('Falha ao transferir segmento da mídia.');
            buffers[idx] = await res.arrayBuffer();
            loaded++;
            onProgress?.(Math.round((loaded / parts.length) * 100));
          })(j, parts[j])
        );
      }
      await Promise.all(batch);
    }

    const totalLength = buffers.reduce((acc, b) => acc + b.byteLength, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const buf of buffers) {
      merged.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    }
    return merged.buffer;
  }

  const targetUrl = meta.url || fallbackUrl;
  if (!targetUrl) throw new Error('URL da mídia indisponível.');
  onProgress?.(25);
  const res = await fetch(targetUrl);
  if (!res.ok) throw new Error('Falha ao transferir mídia.');
  const buffer = await res.arrayBuffer();
  onProgress?.(100);
  return buffer;
};

/**
 * Remove ficheiros do bucket `chat_images` quando o utilizador decide apagar a mídia/conversa.
 */
export const purgeCloudStorageForMsg = async (msg: ChatMessage) => {
  if (!msg.image_metadata) return;
  const filesToRemove: string[] = [];
  const cloudParts = msg.image_metadata.p2p_info?.cloud_parts;

  if (Array.isArray(cloudParts) && cloudParts.length > 0) {
    cloudParts.forEach((u: string) => {
      const segments = u.split('/');
      const name = segments[segments.length - 1];
      if (name) filesToRemove.push(name);
    });
  }
  if (msg.image_metadata.url) {
    const segments = msg.image_metadata.url.split('/');
    const name = segments[segments.length - 1];
    if (name && !filesToRemove.includes(name)) filesToRemove.push(name);
  }

  if (filesToRemove.length > 0) {
    await supabase.storage.from('chat_images').remove(filesToRemove);
  }

  const tableName = msg.group_id ? 'group_messages' : 'private_messages';
  await supabase
    .from(tableName)
    .update({
      image_metadata: {
        ...msg.image_metadata,
        url: null,
        p2p_info: msg.image_metadata.p2p_info
          ? { ...msg.image_metadata.p2p_info, cloud_parts: null }
          : null,
        status: 'p2p_secured_and_deleted_from_vault'
      }
    })
    .eq('id', msg.id);
};

export const sendP2PChunksWithBackpressure = async (
  channel: RTCDataChannel,
  headerPayload: string,
  chunks: ArrayBuffer[]
) => {
  try {
    if (channel.readyState !== 'open') return;
    channel.send(headerPayload);
    const HIGH_WATER_MARK = 256 * 1024;

    for (let i = 0; i < chunks.length; i++) {
      if (channel.readyState !== 'open') break;
      while (channel.bufferedAmount > HIGH_WATER_MARK && channel.readyState === 'open') {
        await new Promise((r) => setTimeout(r, 15));
      }
      channel.send(chunks[i]);
    }
  } catch (err) {
    console.warn('Atraso ou interrupção no canal P2P:', err);
  }
};