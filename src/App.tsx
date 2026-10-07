import React, { useState, useRef, useEffect } from 'react';
import {
  Play,
  Pause,
  Trash2,
  X,
  Upload,
  Music,
  Download,
} from 'lucide-react';
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
  // Exact 11-char YouTube ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return `https://www.youtube.com/watch?v=${trimmed}`;
  }
  // Standard URL pattern
  const match = trimmed.match(/(https?:\/\/[^\s]+)/i);
  if (match) return match[1];
  if (trimmed.includes('youtube.com') || trimmed.includes('youtu.be')) {
    return `https://${trimmed.replace(/^https?:\/\//, '')}`;
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

  // Manual fallback paste dialog (in case browser denies clipboard API access)
  const [showManualPasteModal, setShowManualPasteModal] = useState(false);
  const [manualUrlInput, setManualUrlInput] = useState('');

  // Audio player inside drawer
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Hidden file input for uploading local video
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Persist history on change
  useEffect(() => {
    try {
      localStorage.setItem('v_to_a_history', JSON.stringify(history));
    } catch {}
  }, [history]);

  // Audio playback event listeners
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleEnded = () => {
      setIsPlaying(false);
      setPlayingId(null);
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
    let clipboardText = '';
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        throw new Error('Clipboard API not available');
      }
      clipboardText = await navigator.clipboard.readText();
    } catch (err: any) {
      console.warn('Clipboard readText failed or restricted:', err);
      // Open clean fallback prompt if browser blocked clipboard
      setShowManualPasteModal(true);
      return;
    }

    const cleanUrl = extractUrlFromString(clipboardText);
    if (!cleanUrl) {
      showToast('ক্লিপবোর্ডে কোনো লিঙ্ক নেই! যেকোনো ভিডিওর লিঙ্ক কপি করে বৃত্তে চাপুন।');
      return;
    }

    // Start conversion flow
    startDownloadFromUrl(cleanUrl);
  };

  const [audioQuality, setAudioQuality] = useState<string>(() => localStorage.getItem('v_to_a_quality') || '320k');
  const longPressTimer = useRef<NodeJS.Timeout | null>(null);

  const cycleQuality = () => {
    const qualities = ['128k', '192k', '320k'];
    const next = qualities[(qualities.indexOf(audioQuality) + 1) % qualities.length];
    setAudioQuality(next);
    localStorage.setItem('v_to_a_quality', next);
    showToast(`Quality set to ${next}`);
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
        const infoRes = await fetch(`/api/youtube-info?url=${encodeURIComponent(targetUrl)}`, { signal: AbortSignal.timeout(6000) });
        if (infoRes.ok) {
          const infoData: YouTubeInfo = await infoRes.json();
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
      const convertRes = await fetch('/api/convert-youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl, format: 'mp3', customName: videoTitle, bitrate: audioQuality }),
      });
      const { ok, jobId, error } = await convertRes.json();
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
      triggerAutoDownload(convertData.downloadUrl, convertData.fileName);
      
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
      formData.append('bitrate', audioQuality);

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

          triggerAutoDownload(data.downloadUrl, data.fileName);

          const newHistoryItem: HistoryItem = {
            id: data.fileId,
            title: file.name.replace(/\.[^/.]+$/, ''),
            fileName: data.fileName,
            downloadUrl: data.downloadUrl,
            streamUrl: data.streamUrl,
            fileSize: finalSize,
            format: 'MP3 320kbps',
            timestamp: Date.now(),
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

      const localBlobUrl = URL.createObjectURL(mp3Blob);
      const newHistoryItem: HistoryItem = {
        id: `${Date.now()}`,
        title: file.name.replace(/\.[^/.]+$/, ''),
        fileName: outName,
        downloadUrl: localBlobUrl,
        streamUrl: localBlobUrl,
        fileSize: mp3Blob.size,
        format: 'MP3 320kbps',
        duration: audioBuffer.duration,
        timestamp: Date.now(),
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

  // Audio preview playback in drawer
  const togglePlayAudio = (item: HistoryItem) => {
    const audio = audioRef.current;
    if (!audio) return;

    if (playingId === item.id && isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.src = item.streamUrl || item.downloadUrl;
      audio
        .play()
        .then(() => {
          setPlayingId(item.id);
          setIsPlaying(true);
        })
        .catch((e) => {
          console.error('Audio play error:', e);
          window.open(item.downloadUrl, '_blank');
        });
    }
  };

  const deleteHistoryItem = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (playingId === id && audioRef.current) {
      audioRef.current.pause();
      setIsPlaying(false);
      setPlayingId(null);
    }
    setHistory((prev) => prev.filter((item) => item.id !== id));
  };

  const clearAllHistory = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      setIsPlaying(false);
      setPlayingId(null);
    }
    setHistory([]);
  };

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
        background: 'radial-gradient(ellipse 95% 70% at 50% 25%, #2a2d36 0%, #1a1c22 45%, #101115 100%)',
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
      <header className="w-full pt-12 sm:pt-16 pb-2 flex flex-col items-center justify-center z-10 flex-shrink-0">
        <h1 className="text-3xl sm:text-4xl font-light tracking-[0.28em] text-white uppercase transition-all duration-300 drop-shadow-sm">
          V to A
        </h1>
        <p className="text-[10px] sm:text-xs font-medium tracking-[0.35em] text-[#8e92a2] uppercase mt-2">
          FAKE DEVELOPER
        </p>
      </header>

      {/* CENTER SLEEK CIRCULAR BUTTON (CLEAN SURFACE, NO DOWNLOAD ICON, BOBS UP & DOWN WHEN DOWNLOADING) */}
      <main className="flex-1 w-full max-w-md flex flex-col items-center justify-start mt-12 sm:mt-16 my-auto z-10 px-4">
        <div
          className={`relative flex flex-col items-center justify-center transition-transform ${
            isDownloadingOrFetching ? 'animate-bob' : ''
          }`}
        >
          {/* Subtle Ambient Halo */}
          <div
            className={`absolute rounded-full transition-all duration-700 pointer-events-none ${
              isDownloadingOrFetching
                ? 'w-64 h-64 sm:w-72 sm:h-72 bg-white/12 blur-2xl'
                : status === 'completed'
                ? 'w-64 h-64 sm:w-72 sm:h-72 bg-white/18 blur-2xl'
                : 'w-56 h-56 sm:w-64 sm:h-64 bg-white/[0.05] blur-xl'
            }`}
          />

          {/* Clean Tactile Metallic Circular Button (Matching IMG_7043, icon-free) */}
          <button
            onClick={handleCircleClick}
            disabled={status === 'fetching' || status === 'downloading'}
            aria-label="Download copied video link"
            className={`group relative w-52 h-52 sm:w-60 sm:h-60 md:w-64 md:h-64 rounded-full p-[2.5px] sm:p-[3px] metallic-chrome-outer transition-all duration-300 active:scale-95 cursor-pointer select-none ${
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
          onPointerDown={() => {
            longPressTimer.current = setTimeout(cycleQuality, 600);
          }}
          onPointerUp={() => {
            if (longPressTimer.current) clearTimeout(longPressTimer.current);
          }}
          onPointerLeave={() => {
            if (longPressTimer.current) clearTimeout(longPressTimer.current);
          }}
          className="group flex items-center gap-2.5 text-[#9ba0b1] hover:text-white transition-all duration-300 py-2.5 px-6 rounded-full hover:bg-white/[0.06] active:scale-95 cursor-pointer touch-manipulation"
        >
          <DotMatrixIcon className="w-4 h-4 text-[#7d8293] group-hover:text-white transition-colors duration-300" />
          <span className="text-xs sm:text-sm font-medium tracking-[0.25em] uppercase">
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
                {history.length > 0 && (
                  <button
                    onClick={clearAllHistory}
                    className="text-[11px] text-[#8e92a2] hover:text-white px-2.5 py-1 rounded-md transition-colors cursor-pointer"
                  >
                    Clear All
                  </button>
                )}
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
                    {/* Play/Pause Button */}
                    <button
                      onClick={() => togglePlayAudio(item)}
                      className={`w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center transition-all cursor-pointer ${
                        playingId === item.id && isPlaying
                          ? 'bg-white text-black shadow-md'
                          : 'bg-[#262832] text-[#d5d8e6] hover:bg-[#323542] hover:text-white'
                      }`}
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

                    {/* Action buttons */}
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => triggerAutoDownload(item.downloadUrl, item.fileName)}
                        className="p-2 text-[#7d8293] hover:text-white rounded-lg hover:bg-white/[0.08] transition-colors cursor-pointer"
                        title="Download again"
                        aria-label="Download again"
                      >
                        <Download className="w-4 h-4 stroke-[1.5]" />
                      </button>
                      <button
                        onClick={(e) => deleteHistoryItem(item.id, e)}
                        className="p-2 text-[#727685] hover:text-[#ff7878] rounded-lg hover:bg-white/[0.08] transition-colors cursor-pointer"
                        title="Delete from history"
                        aria-label="Delete"
                      >
                        <Trash2 className="w-4 h-4 stroke-[1.5]" />
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
      {showManualPasteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md px-4"
          onClick={() => setShowManualPasteModal(false)}
        >
          <div
            className="w-full max-w-sm bg-[#18191f] border border-[#2e313e] rounded-2xl p-6 flex flex-col shadow-2xl animate-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium tracking-wider uppercase text-[#d2d5e3]">
                Paste Video Link
              </h3>
              <button
                onClick={() => setShowManualPasteModal(false)}
                className="text-[#7d8293] hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-[#8e92a4] mb-4 font-light">
              ব্রাউজার ক্লিপবোর্ড অনুমতি দেয়নি। লিঙ্কটি নিচে পেস্ট করে ডাউনলোড শুরু করুন:
            </p>

            <input
              type="text"
              value={manualUrlInput}
              onChange={(e) => setManualUrlInput(e.target.value)}
              placeholder="https://youtu.be/..."
              autoFocus
              className="w-full bg-[#121317] border border-[#2d303b] rounded-lg px-3 py-2.5 text-xs text-white placeholder-[#5a5d6e] focus:outline-none focus:border-[#4d5265] transition-colors font-mono mb-4"
            />

            <div className="flex gap-2">
              <button
                onClick={() => setShowManualPasteModal(false)}
                className="flex-1 py-2 rounded-lg text-xs text-[#8e92a4] hover:text-white border border-[#2d303b] hover:bg-[#20222a] transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const url = extractUrlFromString(manualUrlInput);
                  if (url) {
                    setShowManualPasteModal(false);
                    setManualUrlInput('');
                    startDownloadFromUrl(url);
                  } else {
                    showToast('সঠিক লিঙ্ক পেস্ট করুন');
                  }
                }}
                className="flex-1 py-2 rounded-lg text-xs font-medium text-black bg-white hover:bg-neutral-200 transition-colors cursor-pointer"
              >
                Download
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
