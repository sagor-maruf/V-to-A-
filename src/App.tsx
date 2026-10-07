import React, { useState, useRef, useEffect } from 'react';
import {
  ArrowDown,
  Check,
  Loader2,
  Play,
  Pause,
  Trash2,
  X,
  Upload,
  Music,
  ExternalLink,
  Volume2,
  AlertCircle,
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

// Custom 3x3 Dot-Matrix icon representing Black Hole's signature button
function DotMatrixIcon({ className = 'w-5 h-5' }: { className?: string }) {
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
  // URL pattern
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

  // Manual fallback paste dialog (in case clipboard API is denied by browser)
  const [showManualPasteModal, setShowManualPasteModal] = useState(false);
  const [manualUrlInput, setManualUrlInput] = useState('');

  // Audio player inside drawer
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Hidden file input for uploading local video
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Save history on changes
  useEffect(() => {
    try {
      localStorage.setItem('v_to_a_history', JSON.stringify(history));
    } catch {}
  }, [history]);

  // Audio element event listeners
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

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((current) => (current === msg ? null : current));
    }, 4000);
  };

  // Direct programmatic download helper without annoying prompts
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

  // Handle clicking the glowing circle
  const handleCircleClick = async () => {
    // If currently running, prevent accidental click
    if (status === 'fetching' || status === 'downloading') {
      return;
    }

    // If completed or error, reset to idle immediately on tap
    if (status === 'completed' || status === 'error') {
      setStatus('idle');
      setProgressPercent(0);
      setErrorMessage(null);
      return;
    }

    setErrorMessage(null);

    // Read clipboard automatically
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
      showToast('ক্লিপবোর্ডে কোনো ভিডিও লিঙ্ক পাওয়া যায়নি। প্রথমে লিঙ্ক কপি করুন।');
      return;
    }

    // Start conversion flow
    startDownloadFromUrl(cleanUrl);
  };

  // Main download & conversion pipeline
  const startDownloadFromUrl = async (targetUrl: string) => {
    try {
      setStatus('fetching');
      setErrorMessage(null);
      setProgressPercent(0);
      setCurrentMb(0);

      // 1. Fetch metadata (oEmbed / YouTube info)
      let videoTitle = 'audio-track';
      let estimatedSize = 4.5;

      try {
        const infoRes = await fetch(`/api/youtube-info?url=${encodeURIComponent(targetUrl)}`, {
          signal: AbortSignal.timeout(6000),
        });
        if (infoRes.ok) {
          const infoData: YouTubeInfo = await infoRes.json();
          if (infoData.title) videoTitle = infoData.title;
          if (infoData.audioSize) {
            const parsed = parseFloat(infoData.audioSize.replace(/[^\d.]/g, ''));
            if (!isNaN(parsed) && parsed > 0) estimatedSize = parsed;
          } else if (infoData.duration) {
            const parts = infoData.duration.split(':').map((p) => parseInt(p, 10));
            const sec = parts.length === 2 ? parts[0] * 60 + parts[1] : 200;
            estimatedSize = parseFloat(((sec * 24) / 1024).toFixed(1));
          }
        }
      } catch {
        // Fallback info if timeout
      }

      setTotalMb(estimatedSize);

      // 2. Switch to downloading state
      setStatus('downloading');
      setProgressPercent(11);
      setCurrentMb(parseFloat((estimatedSize * 0.11).toFixed(1)));

      // Smooth progress simulation while server transcodes high-quality 320kbps audio
      let currentP = 11;
      const progressInterval = setInterval(() => {
        currentP += Math.floor(Math.random() * 5) + 3;
        if (currentP > 94) currentP = 94;
        setProgressPercent(currentP);
        setCurrentMb(parseFloat((estimatedSize * (currentP / 100)).toFixed(1)));
      }, 350);

      // 3. Request conversion
      const convertRes = await fetch('/api/convert-youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetUrl,
          format: 'mp3',
          customName: videoTitle,
        }),
      });

      clearInterval(progressInterval);

      if (!convertRes.ok) {
        const errData = await convertRes.json().catch(() => ({}));
        throw new Error(errData.error || 'কনভার্ট ব্যর্থ হয়েছে। লিঙ্কটি পুনরায় পরীক্ষা করুন।');
      }

      const convertData = await convertRes.json();
      if (!convertData.ok) {
        throw new Error(convertData.error || 'অডিও তৈরি করা যায়নি।');
      }

      const finalSize = convertData.fileSize || Math.round(estimatedSize * 1024 * 1024);
      const finalSizeMb = parseFloat((finalSize / (1024 * 1024)).toFixed(1));

      // 4. Finished state
      setTotalMb(finalSizeMb);
      setCurrentMb(finalSizeMb);
      setProgressPercent(100);
      setStatus('completed');

      // Auto-trigger audio download
      triggerAutoDownload(convertData.downloadUrl, convertData.fileName);

      // Add to history
      const newHistoryItem: HistoryItem = {
        id: convertData.fileId || `${Date.now()}`,
        title: videoTitle,
        fileName: convertData.fileName,
        downloadUrl: convertData.downloadUrl,
        streamUrl: convertData.streamUrl || convertData.downloadUrl,
        fileSize: finalSize,
        format: 'MP3 320kbps',
        duration: convertData.duration,
        timestamp: Date.now(),
      };

      setHistory((prev) => [newHistoryItem, ...prev.filter((i) => i.id !== newHistoryItem.id)]);

      // Auto return to idle after 4 seconds
      setTimeout(() => {
        setStatus((cur) => (cur === 'completed' ? 'idle' : cur));
      }, 4000);
    } catch (err: any) {
      console.error(err);
      setStatus('error');
      setErrorMessage(err.message || 'একটি ত্রুটি ঘটেছে। পুনরায় চেষ্টা করুন।');
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
      // 1. Try server upload
      const formData = new FormData();
      formData.append('video', file);
      formData.append('format', 'mp3');

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
          const actualMb = parseFloat((data.fileSize / (1024 * 1024)).toFixed(1));
          setTotalMb(actualMb);
          setCurrentMb(actualMb);
          setProgressPercent(100);
          setStatus('completed');

          triggerAutoDownload(data.downloadUrl, data.fileName);

          const newHistoryItem: HistoryItem = {
            id: data.fileId || `${Date.now()}`,
            title: file.name.replace(/\.[^/.]+$/, ''),
            fileName: data.fileName,
            downloadUrl: data.downloadUrl,
            streamUrl: data.streamUrl || data.downloadUrl,
            fileSize: data.fileSize,
            format: 'MP3 320kbps',
            duration: data.duration,
            timestamp: Date.now(),
          };

          setHistory((prev) => [newHistoryItem, ...prev]);

          setTimeout(() => {
            setStatus((cur) => (cur === 'completed' ? 'idle' : cur));
          }, 4000);
          return;
        }
      }

      // Browser WebAudio fallback
      setProgressPercent(40);
      const audioBuffer = await decodeVideoFile(file);
      setProgressPercent(70);
      const audioBlob = await encodeAudioBufferToMp3(audioBuffer, (p) => {
        setProgressPercent(Math.round(70 + p * 0.28));
      });

      const finalSizeMb = parseFloat((audioBlob.size / (1024 * 1024)).toFixed(1));
      setTotalMb(finalSizeMb);
      setCurrentMb(finalSizeMb);
      setProgressPercent(100);
      setStatus('completed');

      const fileName = `${file.name.replace(/\.[^/.]+$/, '')}.mp3`;
      triggerAutoDownload('', fileName, audioBlob);

      const blobUrl = URL.createObjectURL(audioBlob);
      const newHistoryItem: HistoryItem = {
        id: `${Date.now()}`,
        title: file.name.replace(/\.[^/.]+$/, ''),
        fileName,
        downloadUrl: blobUrl,
        streamUrl: blobUrl,
        fileSize: audioBlob.size,
        format: 'MP3 320kbps',
        timestamp: Date.now(),
      };
      setHistory((prev) => [newHistoryItem, ...prev]);

      setTimeout(() => {
        setStatus((cur) => (cur === 'completed' ? 'idle' : cur));
      }, 4000);
    } catch (err: any) {
      console.error(err);
      setStatus('error');
      setErrorMessage(err.message || 'ভিডিও কনভার্ট ব্যর্থ হয়েছে।');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Audio preview playback inside drawer
  const togglePlayAudio = (item: HistoryItem) => {
    if (!audioRef.current) return;

    if (playingId === item.id) {
      if (isPlaying) {
        audioRef.current.pause();
        setIsPlaying(false);
      } else {
        audioRef.current.play();
        setIsPlaying(true);
      }
    } else {
      setPlayingId(item.id);
      audioRef.current.src = item.streamUrl || item.downloadUrl;
      audioRef.current.play().catch((e) => console.error('Play error:', e));
      setIsPlaying(true);
    }
  };

  const deleteHistoryItem = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (playingId === id && audioRef.current) {
      audioRef.current.pause();
      setPlayingId(null);
      setIsPlaying(false);
    }
    setHistory((prev) => prev.filter((i) => i.id !== id));
  };

  const clearAllHistory = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      setPlayingId(null);
      setIsPlaying(false);
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

  return (
    <div className="min-h-screen bg-black text-white flex flex-col justify-between items-center px-4 select-none relative overflow-x-hidden font-['Plus_Jakarta_Sans',sans-serif]">
      {/* Background subtle radial glow */}
      <div className="fixed inset-0 pointer-events-none bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.03)_0%,rgba(0,0,0,1)_70%)]" />

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

      {/* TOP HEADER */}
      <header className="w-full pt-10 sm:pt-14 pb-4 flex flex-col items-center justify-center z-10">
        <h1 className="text-3xl sm:text-4xl font-light tracking-[0.26em] text-white uppercase transition-all duration-300">
          V to A
        </h1>
        <p className="text-[10px] sm:text-xs font-medium tracking-[0.35em] text-neutral-500 uppercase mt-2">
          FAKE DEVELOPER
        </p>
      </header>

      {/* CENTER GLOWING BLACK HOLE BUTTON */}
      <main className="flex-1 w-full max-w-md flex flex-col items-center justify-center my-auto z-10 px-4">
        <div className="relative flex flex-col items-center justify-center">
          {/* Outer glowing halo ring */}
          <div
            className={`absolute rounded-full transition-all duration-700 pointer-events-none ${
              status === 'fetching'
                ? 'w-64 h-64 sm:w-72 sm:h-72 bg-white/10 blur-2xl animate-pulse'
                : status === 'downloading'
                ? 'w-64 h-64 sm:w-72 sm:h-72 bg-white/15 blur-2xl'
                : status === 'completed'
                ? 'w-64 h-64 sm:w-72 sm:h-72 bg-white/20 blur-2xl'
                : 'w-56 h-56 sm:w-64 sm:h-64 bg-white/[0.04] blur-xl'
            }`}
          />

          {/* Interactive Circular Button */}
          <button
            onClick={handleCircleClick}
            disabled={status === 'fetching' || status === 'downloading'}
            aria-label="Download copied video link"
            className={`group relative w-48 h-48 sm:w-56 sm:h-56 md:w-60 md:h-60 rounded-full bg-[#050505] flex items-center justify-center transition-all duration-300 active:scale-95 cursor-pointer border border-neutral-800/80 shadow-[0_0_50px_rgba(255,255,255,0.08),inset_0_0_30px_rgba(255,255,255,0.03)] hover:shadow-[0_0_70px_rgba(255,255,255,0.18)] hover:border-neutral-700/80 ${
              status === 'fetching'
                ? 'animate-pulse border-white/40 shadow-[0_0_75px_rgba(255,255,255,0.22)]'
                : status === 'downloading'
                ? 'border-white/50 shadow-[0_0_80px_rgba(255,255,255,0.25)]'
                : status === 'completed'
                ? 'border-white shadow-[0_0_85px_rgba(255,255,255,0.35)]'
                : ''
            }`}
          >
            {/* Concentric inner subtle circle */}
            <div className="absolute inset-3 sm:inset-4 rounded-full border border-neutral-900 pointer-events-none" />

            {/* Icon & Content inside circle based on status */}
            {status === 'idle' && (
              <div className="flex flex-col items-center justify-center text-neutral-300 group-hover:text-white transition-colors duration-300">
                <ArrowDown className="w-8 h-8 sm:w-9 sm:h-9 stroke-[1.5] transition-transform duration-300 group-hover:translate-y-1" />
              </div>
            )}

            {status === 'fetching' && (
              <div className="flex flex-col items-center justify-center text-white">
                <Loader2 className="w-8 h-8 sm:w-9 sm:h-9 animate-spin stroke-[1.5]" />
              </div>
            )}

            {status === 'downloading' && (
              <div className="flex flex-col items-center justify-center">
                <span className="text-2xl sm:text-3xl font-light tracking-wider text-white font-mono">
                  {progressPercent}%
                </span>
              </div>
            )}

            {status === 'completed' && (
              <div className="flex flex-col items-center justify-center text-white animate-in zoom-in-75 duration-300">
                <Check className="w-9 h-9 sm:w-10 sm:h-10 stroke-[2]" />
              </div>
            )}

            {status === 'error' && (
              <div className="flex flex-col items-center justify-center text-neutral-400 group-hover:text-white">
                <AlertCircle className="w-8 h-8 sm:w-9 sm:h-9 stroke-[1.5]" />
              </div>
            )}
          </button>
        </div>

        {/* DYNAMIC TEXT & PROGRESS INDICATORS BELOW CIRCLE */}
        <div className="w-full flex flex-col items-center justify-center text-center min-h-[85px] mt-8">
          {/* 1. Idle state hint */}
          {status === 'idle' && (
            <p className="text-neutral-500 text-xs sm:text-sm tracking-widest font-light uppercase transition-opacity">
              Tap circle to download copied link
            </p>
          )}

          {/* 2. Fetching state: Link is hidden, display 'Loading...' */}
          {status === 'fetching' && (
            <p className="text-neutral-300 text-sm sm:text-base font-light tracking-widest animate-pulse">
              Loading...
            </p>
          )}

          {/* 3. Downloading state: '11% · 3.6 MB of 30.5 MB' + thin sleek progress bar */}
          {status === 'downloading' && (
            <div className="w-full flex flex-col items-center justify-center animate-in fade-in duration-300">
              <p className="text-neutral-300 text-xs sm:text-sm font-mono tracking-wider font-light">
                {progressPercent}% · {currentMb.toFixed(1)} MB of {totalMb.toFixed(1)} MB
              </p>

              {/* Thin Sleek Progress Bar */}
              <div className="w-60 sm:w-68 h-1 bg-neutral-900 rounded-full overflow-hidden mt-3 shadow-inner">
                <div
                  className="bg-white h-full transition-all duration-300 ease-out shadow-[0_0_8px_rgba(255,255,255,0.7)]"
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
              <p className="text-neutral-400 text-xs sm:text-sm font-light">
                {errorMessage || 'ডাউনলোড ব্যর্থ হয়েছে।'}
              </p>
              <button
                onClick={() => setStatus('idle')}
                className="mt-2 text-[11px] text-neutral-500 hover:text-white uppercase tracking-widest underline underline-offset-4 cursor-pointer"
              >
                Try Again
              </button>
            </div>
          )}

          {/* Sleek toast notification */}
          {toastMessage && (
            <div className="mt-3 px-4 py-2 bg-neutral-900/90 border border-neutral-800 rounded-full text-xs text-neutral-300 tracking-wide animate-in fade-in slide-in-from-bottom-2 duration-200">
              {toastMessage}
            </div>
          )}
        </div>
      </main>

      {/* BOTTOM SECTION - DOT-MATRIX & 'AUDIOS' BUTTON */}
      <footer className="w-full pb-8 sm:pb-12 flex flex-col items-center justify-center z-10">
        <button
          onClick={() => setShowAudiosDrawer(true)}
          className="group flex items-center gap-2.5 text-neutral-400 hover:text-white transition-all duration-300 py-2.5 px-6 rounded-full hover:bg-neutral-900/60 active:scale-95 cursor-pointer"
        >
          <DotMatrixIcon className="w-4 h-4 text-neutral-500 group-hover:text-white transition-colors duration-300" />
          <span className="text-xs sm:text-sm font-medium tracking-[0.25em] uppercase">
            AUDIOS
          </span>
          {history.length > 0 && (
            <span className="ml-1 text-[10px] text-neutral-500 group-hover:text-neutral-300 font-mono">
              ({history.length})
            </span>
          )}
        </button>
      </footer>

      {/* AUDIOS DRAWER / LIST (DOWNLOADED HISTORY) */}
      {showAudiosDrawer && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-md transition-all duration-300">
          <div
            className="w-full max-w-lg max-h-[85vh] bg-[#080808] border-t sm:border border-neutral-800 rounded-t-3xl sm:rounded-3xl flex flex-col overflow-hidden shadow-[0_-10px_40px_rgba(0,0,0,0.8)] animate-in slide-in-from-bottom duration-300"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Drawer Header */}
            <div className="px-6 py-5 border-b border-neutral-900 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <DotMatrixIcon className="w-4 h-4 text-neutral-400" />
                <h2 className="text-sm font-medium tracking-[0.25em] text-white uppercase">
                  AUDIOS
                </h2>
                <span className="text-[11px] font-mono text-neutral-500">
                  {history.length} {history.length === 1 ? 'file' : 'files'}
                </span>
              </div>

              <div className="flex items-center gap-2">
                {history.length > 0 && (
                  <button
                    onClick={clearAllHistory}
                    className="text-[11px] text-neutral-500 hover:text-neutral-300 px-2.5 py-1 rounded-md transition-colors cursor-pointer"
                  >
                    Clear All
                  </button>
                )}
                <button
                  onClick={() => setShowAudiosDrawer(false)}
                  className="p-1.5 text-neutral-400 hover:text-white rounded-full hover:bg-neutral-900 transition-colors cursor-pointer"
                  aria-label="Close drawer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Drawer Body - History list */}
            <div className="flex-1 overflow-y-auto px-4 py-3 divide-y divide-neutral-900/60 max-h-[60vh]">
              {history.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center px-6">
                  <div className="w-12 h-12 rounded-full border border-neutral-800 flex items-center justify-center text-neutral-600 mb-4">
                    <Music className="w-5 h-5" />
                  </div>
                  <p className="text-sm font-light text-neutral-400">
                    No downloaded audios yet
                  </p>
                  <p className="text-xs text-neutral-600 font-light mt-1 max-w-xs">
                    Copy any video link and tap the central black circle on the home screen.
                  </p>
                </div>
              ) : (
                history.map((item) => (
                  <div
                    key={item.id}
                    className="py-3 px-3 rounded-xl hover:bg-neutral-900/40 transition-colors flex items-center justify-between gap-3 group"
                  >
                    {/* Play/Pause Button */}
                    <button
                      onClick={() => togglePlayAudio(item)}
                      className={`w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center transition-all cursor-pointer ${
                        playingId === item.id && isPlaying
                          ? 'bg-white text-black'
                          : 'bg-neutral-900 text-neutral-300 hover:bg-neutral-800 hover:text-white'
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
                      <p className="text-xs sm:text-sm font-normal text-neutral-200 truncate">
                        {item.title}
                      </p>
                      <div className="flex items-center gap-2 text-[10px] sm:text-xs text-neutral-500 font-light mt-0.5">
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
                        className="p-2 text-neutral-500 hover:text-white rounded-lg hover:bg-neutral-900 transition-colors cursor-pointer"
                        title="Download again"
                        aria-label="Download again"
                      >
                        <ArrowDown className="w-4 h-4 stroke-[1.5]" />
                      </button>
                      <button
                        onClick={(e) => deleteHistoryItem(item.id, e)}
                        className="p-2 text-neutral-600 hover:text-neutral-400 rounded-lg hover:bg-neutral-900 transition-colors cursor-pointer"
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
            <div className="p-4 border-t border-neutral-900 bg-neutral-950/60 flex items-center justify-between text-xs text-neutral-500">
              <span>Have a local video file?</span>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 text-neutral-400 hover:text-white transition-colors cursor-pointer"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md px-4">
          <div className="w-full max-w-sm bg-[#080808] border border-neutral-800 rounded-2xl p-6 flex flex-col shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium tracking-wider uppercase text-neutral-300">
                Paste Video Link
              </h3>
              <button
                onClick={() => setShowManualPasteModal(false)}
                className="text-neutral-500 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-neutral-500 mb-4 font-light">
              ব্রাউজার ক্লিপবোর্ড অনুমতি দেয়নি। লিঙ্কটি নিচে পেস্ট করে ডাউনলোড করুন:
            </p>

            <input
              type="text"
              value={manualUrlInput}
              onChange={(e) => setManualUrlInput(e.target.value)}
              placeholder="https://youtu.be/..."
              autoFocus
              className="w-full bg-neutral-900/80 border border-neutral-800 rounded-lg px-3 py-2.5 text-xs text-white placeholder-neutral-600 focus:outline-none focus:border-neutral-600 transition-colors font-mono mb-4"
            />

            <div className="flex gap-2">
              <button
                onClick={() => setShowManualPasteModal(false)}
                className="flex-1 py-2 rounded-lg text-xs text-neutral-400 hover:text-white border border-neutral-800 hover:bg-neutral-900 transition-colors cursor-pointer"
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
