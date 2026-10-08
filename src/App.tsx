import React, { useState, useRef, useEffect } from 'react';
import {
  Play,
  Pause,
  X,
  Upload,
  Music,
  Download,
} from 'lucide-react';
import { saveAudio, getAudio, hasAudio } from './utils/audioStorage.ts';
import { decodeVideoFile, encodeAudioBufferToMp3, encodeAudioBufferToWav } from './utils/audioEncoder.ts';

interface HistoryItem {
  id: string;
  title: string;
  fileName: string;
  downloadUrl: string;
  streamUrl: string;
  fileSize: number; // in bytes
  format: string;
  duration?: number;
  timestamp: number;
  storedLocally?: boolean; // NEW: ডিভাইসের স্টোরেজে কপি আছে কি না
}

interface YouTubeInfo {
  videoId: string;
  title: string;
  author: string;
  thumbnail: string;
  duration?: string | null;
  videoSize?: string | null;
  audioSize?: string | null;
}

type ProcessStatus = 'idle' | 'fetching' | 'downloading' | 'completed' | 'error';

// Signature 3x3 Dot-Matrix icon representing Black Hole's bottom navigation
function DotMatrixIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="5" r="2" />
      <circle cx="12" cy="5" r="2" />
      <circle cx="19" cy="5" r="2" />
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="12" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
    </svg>
  );
}

function extractUrlFromString(text: string): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  
  // YouTube 11-char ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return `https://www.youtube.com/watch?v=${trimmed}`;
  }

  // General URL validation for supported platforms
  const supportedDomains = [
    'youtube.com', 'youtu.be', 
    'facebook.com', 'fb.watch', 
    'tiktok.com', 
    'instagram.com'
  ];

  const match = trimmed.match(/(https?:\/\/[^\s]+)/i);
  if (match) {
    const url = match[1];
    if (supportedDomains.some(domain => url.includes(domain))) {
      return url;
    }
  }

  return null;
}

export default function App() {
  // Main states
  const [status, setStatus] = useState<ProcessStatus>('idle');
  const [progressPercent, setProgressPercent] = useState<number>(0);
  const [currentMb, setCurrentMb] = useState<number>(0);
  const [totalMb, setTotalMb] = useState<number>(4.2);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Audios history drawer
  const [showAudiosDrawer, setShowAudiosDrawer] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    try {
      const saved = localStorage.getItem('v_to_a_history');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Audio player inside drawer
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Hidden file input for uploading local video
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // NEW: ডিভাইস স্টোর + অটো-নেক্সট প্লেয়ার + মেমরি ক্যাশের রেফ
  const historyRef = useRef<HistoryItem[]>([]);
  const playingIdRef = useRef<string | null>(null);
  const togglePlayRef = useRef<(item: HistoryItem) => void>(() => {});
  const blobUrlCache = useRef<Map<string, string>>(new Map());

  // Persist history on change
  useEffect(() => {
    try {
      localStorage.setItem('v_to_a_history', JSON.stringify(history));
    } catch {}
  }, [history]);

  // stale closure এড়াতে রেফ সিঙ্ক (অটো-নেক্সটের জন্য)
  useEffect(() => {
    historyRef.current = history;
  }, [history]);
  useEffect(() => {
    playingIdRef.current = playingId;
  }, [playingId]);

  // DEVICE FIX: একবারই চলে — পুরনো ইতিহাসের গানগুলো ডিভাইস স্টোরেজে কপি করে আনি,
  // আর যেগুলো আর কোথাও নেই (মৃত এন্ট্রি) তালিকা থেকে বাদ দিই।
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = JSON.parse(localStorage.getItem('v_to_a_history') || '[]') as HistoryItem[];
        if (!stored.length) return;
        const aliveIds = new Set<string>();
        for (const item of stored) {
          if (await hasAudio(item.id)) {
            aliveIds.add(item.id);
            continue;
          }
          const url =
            item.downloadUrl && !item.downloadUrl.startsWith('blob:')
              ? item.downloadUrl
              : item.streamUrl && !item.streamUrl.startsWith('blob:')
                ? item.streamUrl
                : null;
          if (url) {
            try {
              const res = await fetch(url);
              if (res.ok) {
                const blob = await res.blob();
                if (blob.size > 0 && (await saveAudio(item.id, item.fileName, blob.type || 'audio/mpeg', blob))) {
                  aliveIds.add(item.id);
                }
              }
            } catch {}
          }
        }
        if (cancelled) return;
        const storedIds = new Set(stored.map((x) => x.id));
        setHistory((prev) =>
          prev
            .filter((item) => aliveIds.has(item.id) || !storedIds.has(item.id))
            .map((item) => (aliveIds.has(item.id) ? { ...item, storedLocally: true } : item))
        );
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Audio playback event listeners — এক গান শেষ হলে পরেরটা অটোমেটিক চালু হবে
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleEnded = () => {
      const curId = playingIdRef.current;
      const list = historyRef.current;
      const idx = curId ? list.findIndex((h) => h.id === curId) : -1;
      const next = idx >= 0 && idx + 1 < list.length ? list[idx + 1] : null;
      if (next) {
        togglePlayRef.current(next); // AUTO-NEXT
      } else {
        setIsPlaying(false);
        setPlayingId(null);
      }
    };
    const handlePause = () => {
      setIsPlaying(false);
    };
    const handlePlay = () => {
      setIsPlaying(true);
    };

    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('play', handlePlay);

    return () => {
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('play', handlePlay);
    };
  }, []);

  // Tactical feedback helper
  const triggerVibration = (type: 'light' | 'heavy' | 'double') => {
    if (!('vibrate' in navigator)) return;
    if (type === 'light') navigator.vibrate(50);
    if (type === 'heavy') navigator.vibrate(200);
    if (type === 'double') navigator.vibrate([100, 50, 100]);
  };

  // Notification helper
  const showNotification = (title: string, body: string) => {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      new Notification(title, { body });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((permission) => {
        if (permission === 'granted') {
          new Notification(title, { body });
        }
      });
    }
  };

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((current) => (current === msg ? null : current));
    }, 4000);
  };

  // Direct programmatic download helper without annoying popup prompt
  const triggerAutoDownload = (downloadUrl: string, fileName: string, blob?: Blob) => {
    try {
      if (blob) {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 35000);
        return;
      }

      // SAFETY FIX: খালি/ব্লব-ডেড URL-এ ক্লিক করলে পেজ রিলোড হয়ে HTML ফাইল নামত —
      // তাই এখন URL না থাকলে কিছুই করা হয় না (পপআপ/ভুল ফাইল দুটোই বন্ধ)।
      if (!downloadUrl || downloadUrl.startsWith('blob:')) return;

      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      console.error('Auto download trigger failed:', err);
    }
  };

  // DEVICE FIX: ডাউনলোড হওয়া অডিও ডিভাইস স্টোরেজে (IndexedDB) রাখি + সাইলেন্টলি
  // ফোনের Downloads/Files-এ সেভ করি — কোনো popup/fullscreen preview ছাড়াই।
  const downloadAndStore = async (fileId: string, downloadUrl: string, fileName: string): Promise<boolean> => {
    try {
      const res = await fetch(downloadUrl);
      if (!res.ok) return false;
      const blob = await res.blob();
      if (!blob.size) return false;
      const mime = blob.type || 'audio/mpeg';
      const ok = await saveAudio(fileId, fileName, mime, blob);
      if (ok) {
        const url = URL.createObjectURL(blob);
        const old = blobUrlCache.current.get(fileId);
        if (old) URL.revokeObjectURL(old);
        blobUrlCache.current.set(fileId, url);
        // সাইলেন্ট সেভ — ব্লব থেকে, তাই কখনোই HTML পেজ খুলবে না
        triggerAutoDownload('', fileName, blob);
      }
      return ok;
    } catch (err) {
      console.warn('Local store failed, keeping server link:', err);
      return false;
    }
  };

  // প্লে করার URL: আগে ডিভাইস স্টোরেজ (স্থায়ী) → তারপর পুরনো সার্ভার লিংক
  const resolvePlayableUrl = async (item: HistoryItem): Promise<string | null> => {
    const cached = blobUrlCache.current.get(item.id);
    if (cached) return cached;
    const stored = await getAudio(item.id);
    if (stored) {
      const url = URL.createObjectURL(stored.blob);
      blobUrlCache.current.set(item.id, url);
      return url;
    }
    if (item.streamUrl && !item.streamUrl.startsWith('blob:')) return item.streamUrl;
    if (item.downloadUrl && !item.downloadUrl.startsWith('blob:')) return item.downloadUrl;
    return null;
  };

  // তালিকার ডাউনলোড বাটন — ডিভাইস কপি থেকে সাইলেন্ট সেভ
  const handleSaveToDevice = async (item: HistoryItem) => {
    const stored = await getAudio(item.id);
    if (stored) {
      triggerAutoDownload('', stored.fileName || item.fileName, stored.blob);
      return;
    }
    triggerAutoDownload(item.downloadUrl, item.fileName);
  };

  // Handle clicking the central circular button
  const handleCircleClick = async () => {
    // If currently running, prevent multiple clicks
    if (status === 'fetching' || status === 'downloading') {
      return;
    }

    // Vibration on click
    triggerVibration('light');

    // If completed or error, reset to idle on tap
    if (status === 'completed' || status === 'error') {
      setStatus('idle');
      setProgressPercent(0);
      setErrorMessage(null);
      return;
    }

    setErrorMessage(null);

    // Read clipboard URL automatically
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        throw new Error('Clipboard API not available');
      }
      const clipboardText = await navigator.clipboard.readText();

      const cleanUrl = extractUrlFromString(clipboardText);
      if (!cleanUrl) {
        showToast('ক্লিপবোর্ডে কোনো লিঙ্ক নেই!');
        return;
      }

      // Start conversion flow
      startDownloadFromUrl(cleanUrl);
    } catch (err: any) {
      console.warn('Clipboard readText failed or restricted:', err);
      showToast('ক্লিপবোর্ড থেকে লিঙ্ক পড়া সম্ভব হয়নি।');
    }
  };

  // ... (keeping existing logic) ...

  const startDownloadFromUrl = async (targetUrl: string) => {
    try {
      setStatus('fetching');
      setErrorMessage(null);
      setProgressPercent(0);
      setCurrentMb(0);

      // 1. Fetch metadata
      let videoTitle = 'audio-track';
      let estimatedSize = 4.5;
      try {
        const infoRes = await fetch(`/api/youtube-info?url=${encodeURIComponent(targetUrl)}`, { signal: AbortSignal.timeout(9000) });
        if (infoRes.ok) {
          let infoData: YouTubeInfo;
          try {
            infoData = await infoRes.json();
          } catch {
            throw new Error('সার্ভার থেকে সঠিক রেসপন্স পাওয়া যায়নি।');
          }
          if (infoData.title) videoTitle = infoData.title;
          if (infoData.audioSize) {
            const parsed = parseFloat(infoData.audioSize.replace(/[^\d.]/g, ''));
            if (!isNaN(parsed) && parsed > 0) estimatedSize = parsed;
          }
        }
      } catch {}
      setTotalMb(estimatedSize);

      // 2. Request conversion (Async)
      setStatus('downloading');
      const convertRes = await fetch('/api/convert-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl, format: 'mp3', customName: videoTitle, bitrate: '320k' }),
      });
      let convertResult;
      try {
        convertResult = await convertRes.json();
      } catch {
        throw new Error('সার্ভার কানেকশন ব্যর্থ হয়েছে।');
      }
      const { ok, jobId, error } = convertResult;
      if (!ok) throw new Error(error || 'কনভার্ট শুরু করা যায়নি।');

      // 3. SSE Progress tracking
      // ... (rest is unchanged)
      const eventSource = new EventSource(`/api/convert-progress/${jobId}`);
      
      const progressPromise = new Promise<any>((resolve, reject) => {
        eventSource.onmessage = (event) => {
          const job = JSON.parse(event.data);
          if (job.status === 'completed') {
            setProgressPercent(99);
            eventSource.close();
            resolve(job.result);
          } else if (job.status === 'error') {
            eventSource.close();
            reject(new Error(job.error || 'কনভার্ট ব্যর্থ হয়েছে।'));
          } else {
            setProgressPercent(Math.min(job.progress, 98)); // Cap at 98%
            setCurrentMb(parseFloat((estimatedSize * (job.progress / 100)).toFixed(1)));
          }
        };
        eventSource.onerror = () => {
          eventSource.close();
          reject(new Error('প্রোগ্রেস ট্র্যাকিংয়ে সমস্যা হয়েছে।'));
        };
      });

      const convertData = await progressPromise;

      // 4. Completed state
      setProgressPercent(100);
      setStatus('completed');
      triggerVibration('double');
      if (document.visibilityState === 'hidden') {
        showNotification('Download Completed!', `${videoTitle} is ready.`);
      }
      // DEVICE + SILENT SAVE: ডিভাইসে কপি রাখি + ফোনের Files/Downloads-এ পপআপ ছাড়া সেভ
      const storedLocally = await downloadAndStore(convertData.fileId, convertData.downloadUrl, convertData.fileName);

      // Add to history
      const newHistoryItem: HistoryItem = {
        id: convertData.fileId,
        title: videoTitle,
        fileName: convertData.fileName,
        downloadUrl: convertData.downloadUrl,
        streamUrl: convertData.streamUrl,
        fileSize: convertData.fileSize,
        format: 'MP3 320kbps',
        duration: convertData.duration,
        timestamp: Date.now(),
        storedLocally,
      };
      setHistory((prev) => [newHistoryItem, ...prev.filter((i) => i.id !== newHistoryItem.id)]);
      
      setTimeout(() => setStatus((cur) => (cur === 'completed' ? 'idle' : cur)), 4000);
    } catch (err: any) {
      console.error(err);
      setStatus('error');
      setErrorMessage(err.message || 'একটি ত্রুটি ঘটেছে।');
    }
  };

  // Convert uploaded local video file
  const handleLocalFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setShowAudiosDrawer(false);
    setStatus('downloading');
    setErrorMessage(null);
    setProgressPercent(10);

    const estMb = parseFloat(((file.size * 0.12) / (1024 * 1024)).toFixed(1)) || 3.8;
    setTotalMb(estMb);
    setCurrentMb(parseFloat((estMb * 0.1).toFixed(1)));

    try {
      const formData = new FormData();
      formData.append('video', file);
      formData.append('format', 'mp3');
      formData.append('bitrate', '320k');

      let currentP = 15;
      const progressTimer = setInterval(() => {
        currentP += 4;
        if (currentP > 92) currentP = 92;
        setProgressPercent(currentP);
        setCurrentMb(parseFloat((estMb * (currentP / 100)).toFixed(1)));
      }, 300);

      const res = await fetch('/api/convert-video', {
        method: 'POST',
        body: formData,
      });

      clearInterval(progressTimer);

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          const finalSize = data.fileSize || file.size * 0.1;
          const finalMb = parseFloat((finalSize / (1024 * 1024)).toFixed(1));
          setTotalMb(finalMb);
          setCurrentMb(finalMb);
          setProgressPercent(100);
          setStatus('completed');

          const storedLocally = await downloadAndStore(data.fileId, data.downloadUrl, data.fileName);

          const newHistoryItem: HistoryItem = {
            id: data.fileId,
            title: file.name.replace(/\.[^/.]+$/, ''),
            fileName: data.fileName,
            downloadUrl: data.downloadUrl,
            streamUrl: data.streamUrl,
            fileSize: finalSize,
            format: 'MP3 320kbps',
            timestamp: Date.now(),
            storedLocally,
          };
          setHistory((prev) => [newHistoryItem, ...prev.filter((i) => i.id !== newHistoryItem.id)]);

          setTimeout(() => {
            setStatus((cur) => (cur === 'completed' ? 'idle' : cur));
          }, 4000);
          return;
        }
      }

      // Client-side fallback if server ffmpeg not available
      setProgressPercent(50);
      const audioBuffer = await decodeVideoFile(file);
      setProgressPercent(80);
      const mp3Blob = await encodeAudioBufferToMp3(audioBuffer, undefined, 320);

      setProgressPercent(100);
      setStatus('completed');

      const outName = `${file.name.replace(/\.[^/.]+$/, '')}.mp3`;
      triggerAutoDownload('', outName, mp3Blob);

      // DEVICE FIX: ইনকোড করা অডিওটাও ডিভাইস স্টোরেজে রাখি (রিলোডের পরেও চলবে)
      const localId = `${Date.now()}`;
      const storedOk = await saveAudio(localId, outName, 'audio/mpeg', mp3Blob);
      const localBlobUrl = URL.createObjectURL(mp3Blob);
      blobUrlCache.current.set(localId, localBlobUrl);
      const newHistoryItem: HistoryItem = {
        id: localId,
        title: file.name.replace(/\.[^/.]+$/, ''),
        fileName: outName,
        downloadUrl: '',
        streamUrl: '',
        fileSize: mp3Blob.size,
        format: 'MP3 320kbps',
        duration: audioBuffer.duration,
        timestamp: Date.now(),
        storedLocally: storedOk,
      };
      setHistory((prev) => [newHistoryItem, ...prev.filter((i) => i.id !== newHistoryItem.id)]);

      setTimeout(() => {
        setStatus((cur) => (cur === 'completed' ? 'idle' : cur));
      }, 4000);
    } catch (err: any) {
      console.error(err);
      setStatus('error');
      setErrorMessage(err.message || 'ভিডিও রূপান্তর ব্যর্থ হয়েছে।');
    } finally {
      if (e.target) e.target.value = '';
    }
  };

  // Audio playback in drawer — ডিভাইস স্টোরেজ থেকে চলে; এক গান শেষ → পরেরটা অটো
  const togglePlayAudio = async (item: HistoryItem) => {
    const audio = audioRef.current;
    if (!audio) return;

    if (playingId === item.id && isPlaying) {
      audio.pause();
      setIsPlaying(false);
      return;
    }

    const url = await resolvePlayableUrl(item);

    // FIX: আগে এখানে window.open() ছিল — সেটাই iOS-এ ফুলস্ক্রিন HTML পেজ খুলত!
    if (!url) {
      showToast('এই অডিওটি আর পাওয়া যাচ্ছে না।');
      return;
    }

    audio.src = url;
    try {
      await audio.play();
      setPlayingId(item.id);
      setIsPlaying(true);

      // Media Session API for background control
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: item.title,
          artist: 'V to A App',
        });
        navigator.mediaSession.setActionHandler('play', () => audio.play());
        navigator.mediaSession.setActionHandler('pause', () => audio.pause());
        try {
          navigator.mediaSession.setActionHandler('nexttrack', () => {
            const list = historyRef.current;
            const idx = list.findIndex((h) => h.id === item.id);
            if (idx >= 0 && idx + 1 < list.length) togglePlayRef.current(list[idx + 1]);
          });
        } catch {}
      }
    } catch (e) {
      console.error('Audio play error:', e);
      showToast('অডিও চালু করা যায়নি।');
    }
  };

  // অটো-নেক্সটের জন্য রেফ হালনাগাদ
  togglePlayRef.current = togglePlayAudio;

  const formatBytes = (bytes: number) => {
    if (!bytes || bytes === 0) return '0 MB';
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const isDownloadingOrFetching = status === 'downloading' || status === 'fetching';

  return (
    <div
      className="fixed inset-0 w-full h-[100dvh] max-h-[100dvh] overflow-hidden overscroll-none text-white flex flex-col justify-between items-center px-4 select-none font-['Plus_Jakarta_Sans',sans-serif] touch-none"
      style={{
        background: '#0f0f0f',
      }}
    >
      {/* Ambient soft silver/grey vignette and subtle texture lighting */}
      <div
        className="fixed inset-0 pointer-events-none opacity-40 mix-blend-screen"
        style={{
          background: 'radial-gradient(circle at 50% 30%, rgba(255, 255, 255, 0.08) 0%, transparent 65%)',
        }}
      />

      {/* Hidden Audio Element for Preview Player */}
      <audio ref={audioRef} preload="none" />

      {/* Hidden File Input for Video Conversion */}
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={handleLocalFileSelect}
      />

      {/* TOP HEADER - 'V to A' & 'FAKE DEVELOPER' */}
      <header className="w-full pt-16 sm:pt-20 pb-2 flex flex-col items-center justify-center z-10 flex-shrink-0">
        <h1 className="text-xl sm:text-2xl font-light tracking-[0.2em] text-white uppercase transition-all duration-300 drop-shadow-sm">
          V to A
        </h1>
        <p className="text-[8px] sm:text-[10px] font-medium tracking-[0.4em] text-[#8e92a2] uppercase mt-2">
          FAKE DEVELOPER
        </p>
      </header>

      {/* CENTER SLEEK CIRCULAR BUTTON */}
      <main className="flex-1 w-full max-w-md flex flex-col items-center justify-center z-10 px-4">
        <div
          className={`relative flex flex-col items-center justify-center transition-transform ${
            isDownloadingOrFetching ? 'animate-bob' : ''
          }`}
        >
          {/* Subtle Ambient Halo */}
          <div
            className={`absolute rounded-full transition-all duration-700 pointer-events-none ${
              isDownloadingOrFetching
                ? 'w-48 h-48 sm:w-56 sm:h-56 bg-white/10 blur-2xl'
                : status === 'completed'
                ? 'w-48 h-48 sm:w-56 sm:h-56 bg-white/15 blur-2xl'
                : 'w-40 h-40 sm:w-48 sm:h-48 bg-white/[0.03] blur-xl'
            }`}
          />

          {/* Clean Tactile Metallic Circular Button */}
          <button
            onClick={handleCircleClick}
            disabled={status === 'fetching' || status === 'downloading'}
            aria-label="Download copied video link"
            className={`group relative w-40 h-40 sm:w-48 sm:h-48 rounded-full p-[2px] metallic-chrome-outer transition-all duration-300 active:scale-95 cursor-pointer select-none ${
              isDownloadingOrFetching
                ? 'brightness-110'
                : 'hover:brightness-110'
            }`}
          >
            {/* Intermediate Metallic Chamfer / Bevel Step */}
            <div className="w-full h-full rounded-full p-[2px] metallic-chrome-inner-rim flex items-center justify-center relative">
              {/* Deep Concave Black Hole Void Surface */}
              <div className="w-full h-full rounded-full blackhole-void-surface relative flex items-center justify-center overflow-hidden">
                {/* Concentric Subtle Machined Depth Rings */}
                <div className="absolute inset-4 sm:inset-5 rounded-full border border-white/[0.05] pointer-events-none" />
                <div className="absolute inset-10 sm:inset-12 rounded-full border border-white/[0.03] pointer-events-none" />

                {/* Micro Ambient Specular Glint */}
                <div
                  className="absolute inset-0 rounded-full pointer-events-none opacity-40 group-hover:opacity-70 transition-opacity duration-500"
                  style={{
                    background:
                      'radial-gradient(circle at 75% 25%, rgba(255,255,255,0.08) 0%, transparent 60%)',
                  }}
                />
              </div>
            </div>
          </button>
        </div>

        {/* DYNAMIC TEXT & PROGRESS INDICATORS BELOW CIRCLE */}
        <div className="w-full flex flex-col items-center justify-center text-center min-h-[90px] mt-8">
          {/* 1. Idle state hint */}
          {status === 'idle' && (
            <div className="h-6" />
          )}

          {/* 2. Fetching state: Link is hidden, display 'Loading...' */}
          {status === 'fetching' && (
            <p className="text-[#c2c5d4] text-sm sm:text-base font-light tracking-widest animate-pulse">
              Loading...
            </p>
          )}

          {/* 3. Downloading state: '11% · 3.6 MB of 30.5 MB' + thin sleek progress bar */}
          {status === 'downloading' && (
            <div className="w-full flex flex-col items-center justify-center animate-in fade-in duration-300">
              <p className="text-[#e2e5f1] text-xs sm:text-sm font-mono tracking-wider font-light">
                {progressPercent}% · {currentMb.toFixed(1)} MB of {totalMb.toFixed(1)} MB
              </p>

              {/* Thin Sleek Progress Bar */}
              <div className="w-60 sm:w-68 h-1 bg-[#252833] rounded-full overflow-hidden mt-3 shadow-inner">
                <div
                  className="bg-white h-full transition-all duration-300 ease-out shadow-[0_0_8px_rgba(255,255,255,0.8)]"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}

          {/* 4. Completed state: 'Completed!' */}
          {status === 'completed' && (
            <div className="flex flex-col items-center justify-center animate-in fade-in duration-300">
              <p className="text-white text-base sm:text-lg font-light tracking-widest">
                Completed!
              </p>
            </div>
          )}

          {/* 5. Error state */}
          {status === 'error' && (
            <div className="flex flex-col items-center justify-center px-4 max-w-xs">
              <p className="text-[#a5a9ba] text-xs sm:text-sm font-light">
                {errorMessage || 'ডাউনলোড ব্যর্থ হয়েছে।'}
              </p>
              <button
                onClick={() => setStatus('idle')}
                className="mt-2 text-[11px] text-[#8e92a4] hover:text-white uppercase tracking-widest underline underline-offset-4 cursor-pointer"
              >
                Try Again
              </button>
            </div>
          )}

          {/* Sleek toast notification */}
          {toastMessage && (
            <div className="mt-3 px-4 py-2 bg-[#20222b]/95 border border-[#353946] rounded-full text-xs text-[#c5c8d6] tracking-wide animate-in fade-in slide-in-from-bottom-2 duration-200 shadow-lg">
              {toastMessage}
            </div>
          )}
        </div>
      </main>

      {/* BOTTOM SECTION - DOT-MATRIX & 'AUDIOS' BUTTON */}
      <footer className="w-full pb-5 sm:pb-8 pt-2 flex flex-col items-center justify-center z-10 flex-shrink-0">
        <button
          onClick={() => setShowAudiosDrawer(true)}
          className="group flex flex-col items-center gap-2 text-[#d4af37] hover:text-white transition-all duration-300 py-2.5 px-6 rounded-full hover:bg-white/[0.06] active:scale-95 cursor-pointer touch-manipulation"
        >
          <DotMatrixIcon className="w-8 h-8 text-[#d4af37] group-hover:text-white transition-colors duration-300" />
          <span className="text-[10px] sm:text-xs font-medium tracking-[0.25em] uppercase">
            AUDIOS
          </span>
          {history.length > 0 && (
            <span className="ml-1 text-[10px] text-[#7d8293] group-hover:text-[#b8bcd0] font-mono">
              ({history.length})
            </span>
          )}
        </button>
      </footer>


      {/* AUDIOS DRAWER / LIST (DOWNLOADED HISTORY) */}
      {showAudiosDrawer && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-md transition-all duration-300 touch-none overscroll-none"
          onClick={() => setShowAudiosDrawer(false)}
        >
          <div
            className="w-full max-w-lg max-h-[85vh] bg-[#17181e] border-t sm:border border-[#2e313d] rounded-t-3xl sm:rounded-3xl flex flex-col overflow-hidden shadow-[0_-10px_45px_rgba(0,0,0,0.85)] animate-in slide-in-from-bottom duration-300 touch-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Drawer Header */}
            <div className="px-6 py-5 border-b border-[#252833] flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-3">
                <DotMatrixIcon className="w-4 h-4 text-[#8e92a2]" />
                <h2 className="text-sm font-medium tracking-[0.25em] text-white uppercase">
                  AUDIOS
                </h2>
                <span className="text-[11px] font-mono text-[#767a8a]">
                  {history.length} {history.length === 1 ? 'file' : 'files'}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowAudiosDrawer(false)}
                  className="p-1.5 text-[#8e92a2] hover:text-white rounded-full hover:bg-white/[0.08] transition-colors cursor-pointer"
                  aria-label="Close drawer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Drawer Body - History list */}
            <div className="flex-1 overflow-y-auto overscroll-contain touch-auto px-4 py-3 divide-y divide-[#232631] max-h-[60vh]">
              {history.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center px-6">
                  <div className="w-12 h-12 rounded-full border border-[#2e313d] flex items-center justify-center text-[#737788] mb-4">
                    <Music className="w-5 h-5" />
                  </div>
                  <p className="text-sm font-light text-[#c3c6d6]">
                    No downloaded audios yet
                  </p>
                  <p className="text-xs text-[#7e8395] font-light mt-1 max-w-xs">
                    Copy any video link and tap the central circle on the home screen.
                  </p>
                </div>
              ) : (
                history.map((item) => (
                  <div
                    key={item.id}
                    className="py-3 px-3 rounded-xl hover:bg-[#20222a] transition-colors flex items-center justify-between gap-3 group"
                  >
                    {/* Play/Pause Button - Hexagonal Shape */}
                    <button
                      onClick={() => togglePlayAudio(item)}
                      className={`w-9 h-9 flex-shrink-0 flex items-center justify-center transition-all cursor-pointer ${
                        playingId === item.id && isPlaying
                          ? 'bg-white text-black shadow-md'
                          : 'bg-[#262832] text-[#d5d8e6] hover:bg-[#323542] hover:text-white'
                      }`}
                      style={{
                        clipPath: 'polygon(50% 0%, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%)',
                      }}
                      aria-label="Play audio preview"
                    >
                      {playingId === item.id && isPlaying ? (
                        <Pause className="w-4 h-4 fill-current" />
                      ) : (
                        <Play className="w-4 h-4 fill-current ml-0.5" />
                      )}
                    </button>

                    {/* Metadata */}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs sm:text-sm font-normal text-[#e6e8f2] truncate">
                        {item.title}
                      </p>
                      <div className="flex items-center gap-2 text-[10px] sm:text-xs text-[#7d8293] font-light mt-0.5">
                        <span>{item.format}</span>
                        <span>·</span>
                        <span>{formatBytes(item.fileSize)}</span>
                        <span>·</span>
                        <span>{formatDate(item.timestamp)}</span>
                      </div>
                    </div>

                    {/* Action buttons — ডিভাইস কপি থেকে সাইলেন্ট সেভ (popup নেই) */}
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleSaveToDevice(item)}
                        className="p-2 text-[#7d8293] hover:text-white rounded-lg hover:bg-white/[0.08] transition-colors cursor-pointer"
                        title="Save to device"
                        aria-label="Save to device"
                      >
                        <Download className="w-4 h-4 stroke-[1.5]" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Drawer Footer - Secondary Local Video Upload */}
            <div className="p-4 border-t border-[#252833] bg-[#121318] flex items-center justify-between text-xs text-[#7e8293]">
              <span>Have a local video file?</span>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 text-[#a8adc0] hover:text-white transition-colors cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Upload Video</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MANUAL PASTE MODAL (FALLBACK IF BROWSER RESTRICTS CLIPBOARD READTEXT) */}
    </div>
  );
}