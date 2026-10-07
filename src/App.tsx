import React, { useState, useRef, useEffect } from 'react';
import {
  Youtube,
  Upload,
  Download,
  Music,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FileAudio,
  RotateCcw,
  Check,
  Clock,
  HardDrive,
  Smartphone,
  Share,
  PlusSquare,
  X,
} from 'lucide-react';
import { decodeVideoFile, encodeAudioBufferToMp3, encodeAudioBufferToWav } from './utils/audioEncoder.ts';

type AudioFormat = 'mp3' | 'aac' | 'ogg' | 'wav';
type ActiveTab = 'youtube' | 'upload';

interface ConvertedResult {
  fileId?: string;
  downloadUrl: string;
  streamUrl: string;
  fileName: string;
  format: string;
  fileSize: number;
  blob?: Blob;
  sourceType: 'youtube' | 'upload';
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

async function safeJsonParse<T = any>(res: Response): Promise<T | null> {
  try {
    const text = await res.text();
    if (!text || !text.trim()) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function isPlausibleYouTubeUrl(url: string): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return true;
  return /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/|live\/|watch\?.+&v=))/i.test(trimmed);
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('youtube');

  // YouTube state
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [ytInfo, setYtInfo] = useState<YouTubeInfo | null>(null);
  const [loadingYtInfo, setLoadingYtInfo] = useState(false);

  // Upload state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Common conversion configuration
  const [audioFormat, setAudioFormat] = useState<AudioFormat>('mp3');

  // Processing state & live MB tracking
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressStage, setProgressStage] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [processedMb, setProcessedMb] = useState<number>(0);
  const [totalAudioMb, setTotalAudioMb] = useState<number>(4.2);

  // Result state
  const [result, setResult] = useState<ConvertedResult | null>(null);
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // PWA Install prompt state
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [showIosPrompt, setShowIosPrompt] = useState(false);

  useEffect(() => {
    // Check if running as installed standalone PWA
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true;
    if (isStandalone) {
      setIsInstalled(true);
    }

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
      setNotification({
        message: '🎉 V to A অ্যাপটি আপনার হোম স্ক্রিনে ইনস্টল হয়েছে!',
        type: 'success',
      });
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const handleInstallClick = async () => {
    try {
      if (deferredPrompt) {
        await deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        if (choice && choice.outcome === 'accepted') {
          setIsInstalled(true);
        }
        setDeferredPrompt(null);
      } else {
        setShowIosPrompt(true);
      }
    } catch {
      setShowIosPrompt(true);
    }
  };

  // Auto dismiss toast notification after 6 seconds
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => {
        setNotification(null);
      }, 6000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  // When YouTube URL changes, debounce fetch info
  useEffect(() => {
    const trimmed = youtubeUrl.trim();
    if (!trimmed) {
      setYtInfo(null);
      return;
    }

    if (!isPlausibleYouTubeUrl(trimmed)) {
      setYtInfo(null);
      return;
    }

    const timer = setTimeout(() => {
      fetchYouTubeInfo(trimmed);
    }, 400);

    return () => clearTimeout(timer);
  }, [youtubeUrl]);

  // When file is selected
  const handleFileSelect = (file: File) => {
    setSelectedFile(file);
    setErrorMessage(null);
    setResult(null);
  };

  // Automatically read copied link from clipboard and paste it
  const handlePasteFromClipboard = async () => {
    setActiveTab('youtube');
    setErrorMessage(null);
    setResult(null);

    try {
      if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        const text = await navigator.clipboard.readText();
        if (text && text.trim()) {
          setYoutubeUrl(text.trim());
          return;
        }
      }
    } catch (err) {
      console.warn('Clipboard read error or permission denied:', err);
    }
  };

  const fetchYouTubeInfo = async (url: string) => {
    if (!isPlausibleYouTubeUrl(url)) return;
    setLoadingYtInfo(true);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/youtube-info?url=${encodeURIComponent(url)}`);
      const data = await safeJsonParse<{
        ok: boolean;
        title?: string;
        author?: string;
        thumbnail?: string;
        duration?: string;
        videoSize?: string;
        audioSize?: string;
        error?: string;
      }>(res);
      if (data && data.ok && data.title) {
        setYtInfo({
          videoId: url,
          title: data.title,
          author: data.author || '',
          thumbnail: data.thumbnail || '',
          duration: data.duration,
          videoSize: data.videoSize,
          audioSize: data.audioSize,
        });
      } else {
        setYtInfo(null);
      }
    } catch {
      setYtInfo(null);
    } finally {
      setLoadingYtInfo(false);
    }
  };

  // Helper to estimate total MB from ytInfo or duration
  const getEstimatedAudioMb = (): number => {
    if (ytInfo?.audioSize) {
      const match = ytInfo.audioSize.match(/([\d.]+)/);
      if (match) return parseFloat(match[1]);
    }
    if (ytInfo?.duration) {
      const parts = ytInfo.duration.split(':').map((p) => parseInt(p, 10));
      const totalSec = parts.length === 2 ? parts[0] * 60 + parts[1] : 240;
      return parseFloat(((totalSec * 24) / 1024).toFixed(2));
    }
    return 4.2;
  };

  // Convert YouTube link with real-time continuous MB progression
  const handleConvertYouTube = async () => {
    if (!youtubeUrl.trim()) {
      setErrorMessage('অনুগ্রহ করে একটি ইউটিউব লিঙ্ক দিন।');
      return;
    }

    const estimatedMb = getEstimatedAudioMb();
    setTotalAudioMb(estimatedMb);
    setProcessedMb(0.1);

    setIsProcessing(true);
    setProgressPercent(15);
    setProgressStage('ধাপ ১: ইউটিউব ভিডিও বিশ্লেষণ ও অডিও যাচাই হচ্ছে...');
    setErrorMessage(null);
    setResult(null);

    const timers: NodeJS.Timeout[] = [];

    // Smooth continuous MB counter increment
    const mbInterval = setInterval(() => {
      setProcessedMb((prev) => {
        const next = prev + Math.random() * 0.12 + 0.04;
        return next < estimatedMb * 0.94 ? parseFloat(next.toFixed(2)) : prev;
      });
    }, 450);

    timers.push(
      setTimeout(() => {
        setProgressPercent(45);
        setProgressStage('ধাপ ২: উচ্চমানের অডিও স্ট্রিম ডাউনলোড করা হচ্ছে...');
        setProcessedMb(parseFloat((estimatedMb * 0.45).toFixed(2)));
      }, 1500)
    );

    timers.push(
      setTimeout(() => {
        setProgressPercent(75);
        setProgressStage('ধাপ ৩: স্বয়ংক্রিয় অডিও এনকোডিং ও অপ্টিমাইজেশন চলছে...');
        setProcessedMb(parseFloat((estimatedMb * 0.75).toFixed(2)));
      }, 3500)
    );

    timers.push(
      setTimeout(() => {
        setProgressPercent(90);
        setProgressStage('ধাপ ৪: অডিও ফাইল চূড়ান্ত ও প্রস্তুত করা হচ্ছে...');
        setProcessedMb(parseFloat((estimatedMb * 0.9).toFixed(2)));
      }, 6500)
    );

    try {
      let response = await fetch('/api/convert-youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: youtubeUrl.trim(),
          format: 'auto',
          customName: ytInfo?.title || 'youtube-audio',
        }),
      });

      let data = await safeJsonParse<any>(response);

      // Automatic background retry if first attempt encountered a cold start or transient delay
      if ((!response.ok || !data || !data.ok) && isProcessing) {
        setProgressStage('অডিও স্ট্রিম প্রস্তুত হচ্ছে, চূড়ান্ত রিট্রাই চলছে...');
        await new Promise((r) => setTimeout(r, 1200));
        response = await fetch('/api/convert-youtube', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: youtubeUrl.trim(),
            format: 'auto',
            customName: ytInfo?.title || 'youtube-audio',
          }),
        });
        data = await safeJsonParse<any>(response);
      }

      clearInterval(mbInterval);
      timers.forEach(clearTimeout);

      if (!response.ok || !data || !data.ok) {
        throw new Error((data && data.error) || 'কনভার্ট করতে সমস্যা হয়েছে।');
      }

      const finalSizeMb = parseFloat((data.fileSize / (1024 * 1024)).toFixed(2));
      setTotalAudioMb(finalSizeMb);
      setProcessedMb(finalSizeMb);

      setProgressPercent(100);
      setProgressStage('ধাপ ৪: অডিও কনভার্ট সফল হয়েছে! অডিও প্রস্তুত।');

      const converted: ConvertedResult = {
        fileId: data.fileId,
        downloadUrl: data.downloadUrl,
        streamUrl: data.streamUrl,
        fileName: data.fileName,
        format: data.format,
        fileSize: data.fileSize,
        sourceType: 'youtube',
      };

      setResult(converted);
      handleDirectDownload(converted);
    } catch (err: any) {
      clearInterval(mbInterval);
      timers.forEach(clearTimeout);
      console.error(err);
      setErrorMessage(err.message || 'ইউটিউব ভিডিও কনভার্ট করা সম্ভব হয়নি। ভিডিওটি প্রাইভেট বা সীমাবদ্ধ হতে পারে।');
      setNotification({
        message: 'অডিও কনভার্ট ব্যর্থ হয়েছে। লিঙ্কটি চেক করুন অথবা ভিডিও ফাইল আপলোড করুন।',
        type: 'error',
      });
    } finally {
      setIsProcessing(false);
    }
  };

  // Convert uploaded video file
  const handleConvertUploadedFile = async () => {
    if (!selectedFile) {
      setErrorMessage('একটি ভিডিও ফাইল সিলেক্ট বা আপলোড করুন।');
      return;
    }

    const estimatedMb = parseFloat(((selectedFile.size * 0.15) / (1024 * 1024)).toFixed(2)) || 3.5;
    setTotalAudioMb(estimatedMb);
    setProcessedMb(0.1);

    setIsProcessing(true);
    setProgressPercent(15);
    setProgressStage('ভিডিও ফাইল প্রক্রিয়াকরণ শুরু হয়েছে...');
    setErrorMessage(null);
    setResult(null);

    const mbInterval = setInterval(() => {
      setProcessedMb((prev) => {
        const next = prev + 0.12;
        return next < estimatedMb * 0.9 ? parseFloat(next.toFixed(2)) : prev;
      });
    }, 400);

    try {
      const formData = new FormData();
      formData.append('video', selectedFile);
      formData.append('format', audioFormat);
      formData.append('customName', selectedFile.name.replace(/\.[^/.]+$/, ''));

      setProgressPercent(35);
      setProgressStage('ভিডিও থেকে অডিও এক্সট্র্যাক্ট করা হচ্ছে...');

      const response = await fetch('/api/convert-video', {
        method: 'POST',
        body: formData,
      });

      clearInterval(mbInterval);
      const data = await safeJsonParse<any>(response);

      if (response.ok && data && data.ok) {
        const finalSizeMb = parseFloat((data.fileSize / (1024 * 1024)).toFixed(2));
        setTotalAudioMb(finalSizeMb);
        setProcessedMb(finalSizeMb);

        setProgressPercent(100);
        setProgressStage('অডিও ফাইল প্রস্তুত!');

        const converted: ConvertedResult = {
          fileId: data.fileId,
          downloadUrl: data.downloadUrl,
          streamUrl: data.streamUrl,
          fileName: data.fileName,
          format: data.format,
          fileSize: data.fileSize,
          sourceType: 'upload',
        };

        setResult(converted);
        handleDirectDownload(converted);
        return;
      }

      // Fallback: Web Audio extraction
      setProgressStage('ব্রাউজারে সরাসরি অডিও এনকোডিং করা হচ্ছে...');
      const audioBuffer = await decodeVideoFile(selectedFile, (stage, p) => {
        setProgressStage(stage);
        setProgressPercent(Math.round(20 + p * 0.4));
      });

      let audioBlob: Blob;
      let finalExt = '.mp3';

      if (audioFormat === 'wav') {
        audioBlob = encodeAudioBufferToWav(audioBuffer);
        finalExt = '.wav';
      } else {
        audioBlob = await encodeAudioBufferToMp3(audioBuffer, (p) => {
          setProgressPercent(Math.round(60 + p * 0.38));
        });
        finalExt = '.mp3';
      }

      const finalSizeMb = parseFloat((audioBlob.size / (1024 * 1024)).toFixed(2));
      setTotalAudioMb(finalSizeMb);
      setProcessedMb(finalSizeMb);

      const baseName = selectedFile.name.replace(/\.[^/.]+$/, '');
      const finalFileName = `${baseName}${finalExt}`;
      const blobUrl = URL.createObjectURL(audioBlob);

      setProgressPercent(100);
      setProgressStage('কনভার্ট সফল হয়েছে!');

      const converted: ConvertedResult = {
        downloadUrl: blobUrl,
        streamUrl: blobUrl,
        fileName: finalFileName,
        format: audioFormat.toUpperCase(),
        fileSize: audioBlob.size,
        blob: audioBlob,
        sourceType: 'upload',
      };

      setResult(converted);
      handleDirectDownload(converted);
    } catch (err: any) {
      clearInterval(mbInterval);
      console.error(err);
      setErrorMessage(err.message || 'ভিডিও থেকে অডিও কনভার্ট করতে সমস্যা হয়েছে।');
      setNotification({
        message: 'অডিও কনভার্ট ব্যর্থ হয়েছে। ভিডিও ফরম্যাটটি সমর্থনযোগ্য কি না চেক করুন।',
        type: 'error',
      });
    } finally {
      setIsProcessing(false);
    }
  };

  // Direct, seamless download without annoying browser permission prompt popups
  const handleDirectDownload = async (overrideResult?: ConvertedResult) => {
    const target = overrideResult || result;
    if (!target) return;

    try {
      // If we already have the blob, trigger direct blob save
      if (target.blob) {
        const blobUrl = URL.createObjectURL(target.blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = target.fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
        return;
      }

      // Fetch as blob to download directly without Safari/Chrome permission sheet
      const response = await fetch(target.downloadUrl);
      if (response.ok) {
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = target.fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
        return;
      }
    } catch (err) {
      console.warn('Seamless download fallback:', err);
    }

    // Standard fallback without target="_blank"
    try {
      const link = document.createElement('a');
      link.href = target.downloadUrl;
      link.download = target.fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch {
      window.location.href = target.downloadUrl;
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (!bytes || bytes <= 0) return '0 KB';
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const resetAll = () => {
    setResult(null);
    setErrorMessage(null);
    setProgressPercent(0);
    setProgressStage('');
    setProcessedMb(0);
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 flex flex-col antialiased selection:bg-rose-500 selection:text-white">
      {/* Toast Notification */}
      {notification && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed top-4 right-4 z-50 max-w-md p-4 rounded-xl shadow-2xl border transition-all duration-300 flex items-start gap-3 ${
            notification.type === 'success'
              ? 'bg-white border-emerald-500 text-emerald-950 shadow-emerald-900/10'
              : 'bg-white border-rose-500 text-rose-950 shadow-rose-900/10'
          }`}
        >
          {notification.type === 'success' ? (
            <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5 text-emerald-600" />
          ) : (
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-rose-600" />
          )}
          <div className="flex-1 text-sm font-semibold leading-relaxed">
            {notification.message}
          </div>
          <button
            onClick={() => setNotification(null)}
            className="text-xs px-2 py-1 rounded cursor-pointer font-bold text-slate-500 hover:text-slate-900"
            aria-label="নোটিফিকেশন বন্ধ করুন"
          >
            ✕
          </button>
        </div>
      )}

      {/* iOS / Mobile Add to Home Screen Instructions Modal */}
      {showIosPrompt && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full p-5 shadow-2xl border border-slate-200 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-rose-600 to-indigo-600 flex items-center justify-center text-white shadow-xs">
                  <Music className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-bold text-sm text-slate-900">V to A অ্যাপ ইনস্টল করুন</h3>
                  <p className="text-[11px] text-slate-500">হোম স্ক্রিনে সেভ করে সহজেই ব্যবহার করুন</p>
                </div>
              </div>
              <button
                onClick={() => setShowIosPrompt(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="py-4 space-y-3 text-xs text-slate-700">
              <div className="flex items-start gap-2.5 p-2 rounded-xl bg-slate-50 border border-slate-200">
                <div className="w-6 h-6 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center shrink-0 font-bold text-[11px]">
                  ১
                </div>
                <div className="leading-relaxed">
                  ব্রাউজারের নিচে বা উপরে থাকা <strong className="text-slate-900">শেয়ার (Share)</strong> বাটনে <Share className="w-3.5 h-3.5 inline text-indigo-600 mx-0.5" /> ট্যাপ করুন।
                </div>
              </div>

              <div className="flex items-start gap-2.5 p-2 rounded-xl bg-slate-50 border border-slate-200">
                <div className="w-6 h-6 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center shrink-0 font-bold text-[11px]">
                  ২
                </div>
                <div className="leading-relaxed">
                  তালিকা থেকে <strong className="text-slate-900">"Add to Home Screen"</strong> <PlusSquare className="w-3.5 h-3.5 inline text-indigo-600 mx-0.5" /> অপশনটি বেছে নিন।
                </div>
              </div>

              <div className="flex items-start gap-2.5 p-2 rounded-xl bg-slate-50 border border-slate-200">
                <div className="w-6 h-6 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center shrink-0 font-bold text-[11px]">
                  ৩
                </div>
                <div className="leading-relaxed">
                  উপরে ডানপাশে <strong className="text-emerald-700">"Add"</strong> চাপলেই <strong className="text-slate-900">V to A</strong> অ্যাপ হিসেবে ফোনে যুক্ত হয়ে যাবে!
                </div>
              </div>
            </div>

            <button
              onClick={() => setShowIosPrompt(false)}
              className="w-full py-2.5 rounded-xl bg-slate-900 text-white font-bold text-xs hover:bg-slate-800 transition-colors"
            >
              বুঝেছি (Close)
            </button>
          </div>
        </div>
      )}

      {/* Header - Clean single row with App Name "V to A" and Install Button */}
      <header className="border-b border-slate-200 bg-white/95 sticky top-0 z-40 backdrop-blur-md shadow-xs">
        <div className="max-w-3xl mx-auto px-4 h-14 sm:h-16 flex items-center justify-between">
          {/* Wordmark with Music Logo */}
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-rose-600 to-indigo-600 flex items-center justify-center shadow-xs">
              <Music className="w-4 h-4 text-white" />
            </div>
            <div>
              <span className="text-base sm:text-lg font-extrabold tracking-tight text-slate-900">
                V to A
              </span>
              <span className="hidden sm:inline-block text-xs font-semibold text-slate-500 ml-2 border-l border-slate-200 pl-2">
                ভিডিও টু অডিও কনভার্টার
              </span>
            </div>
          </div>

          {/* Action buttons on header */}
          <div className="flex items-center gap-2">
            {!isInstalled && (
              <button
                onClick={handleInstallClick}
                className="flex items-center gap-1.5 text-xs font-bold text-rose-700 bg-rose-50 hover:bg-rose-100 px-3 py-1.5 rounded-lg border border-rose-200 shadow-2xs transition-all active:scale-95 cursor-pointer"
                title="অ্যাপটি ফোনে বা কম্পিউটারে ইনস্টল করুন"
              >
                <Smartphone className="w-3.5 h-3.5 text-rose-600" />
                <span>ইনস্টল করুন</span>
              </button>
            )}

            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 bg-slate-100 px-2.5 py-1.5 rounded-lg border border-slate-200">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
              <span className="hidden xs:inline">দ্রুত কনভার্সন</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-3xl w-full mx-auto px-4 py-5 sm:py-8 flex flex-col justify-center">
        {/* Card Container */}
        <div className="rounded-2xl p-4 sm:p-6 shadow-md shadow-slate-200/80 bg-white border border-slate-300">
          {/* Two-Option Segmented Tab Switcher */}
          <div className="flex items-center p-1 rounded-xl mb-5 border border-slate-300 bg-slate-100">
            <button
              type="button"
              onClick={handlePasteFromClipboard}
              className={`flex-1 py-2 px-3 rounded-lg text-xs sm:text-sm font-bold flex items-center justify-center gap-2 transition-all cursor-pointer whitespace-nowrap min-h-[38px] ${
                activeTab === 'youtube'
                  ? 'bg-rose-600 text-white shadow-xs'
                  : 'text-slate-700 hover:text-slate-950'
              }`}
            >
              <Youtube className="w-4 h-4" />
              <span>লিঙ্ক পেস্ট করুন</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab('upload');
                setErrorMessage(null);
                setResult(null);
              }}
              className={`flex-1 py-2 px-3 rounded-lg text-xs sm:text-sm font-bold flex items-center justify-center gap-2 transition-all cursor-pointer whitespace-nowrap min-h-[38px] ${
                activeTab === 'upload'
                  ? 'bg-rose-600 text-white shadow-xs'
                  : 'text-slate-700 hover:text-slate-950'
              }`}
            >
              <Upload className="w-4 h-4" />
              <span>vedio আপলোড করুন</span>
            </button>
          </div>

          {/* TAB 1: YouTube Link Input */}
          {activeTab === 'youtube' && (
            <div className="space-y-4">
              <div>
                <div className="relative">
                  <input
                    id="yt-url-input"
                    type="url"
                    value={youtubeUrl}
                    onChange={(e) => setYoutubeUrl(e.target.value)}
                    placeholder="https://www.youtube.com/watch?v=... অথবা https://youtu.be/..."
                    disabled={isProcessing}
                    className="w-full px-3.5 py-2.5 pl-10 pr-16 rounded-xl border border-slate-300 text-slate-950 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-rose-500 focus:border-rose-600 transition-all text-xs sm:text-sm min-h-[42px] bg-white font-medium shadow-2xs"
                  />
                  <Youtube className="w-4 h-4 text-rose-600 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  {!youtubeUrl ? (
                    <button
                      type="button"
                      onClick={handlePasteFromClipboard}
                      className="absolute right-2 top-1/2 -translate-y-1/2 px-2.5 py-1 text-xs rounded-md bg-rose-50 hover:bg-rose-100 text-rose-600 font-bold cursor-pointer transition-colors"
                      title="ক্লিপবোর্ড থেকে লিঙ্ক পেস্ট করুন"
                    >
                      পেস্ট
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setYoutubeUrl('')}
                      disabled={isProcessing}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-xs cursor-pointer font-bold text-slate-500 hover:text-slate-900"
                      title="মুছে ফেলুন"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>

              {/* YouTube Video Info Preview */}
              {loadingYtInfo && (
                <div className="p-3 rounded-xl border border-slate-200 bg-slate-50 flex items-center gap-2.5 text-xs sm:text-sm text-slate-700">
                  <Loader2 className="w-4 h-4 animate-spin text-rose-500 shrink-0" />
                  <span>ভিডিওর তথ্য লোড হচ্ছে...</span>
                </div>
              )}

              {ytInfo && (
                <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 flex flex-col sm:flex-row gap-3">
                  <img
                    src={ytInfo.thumbnail}
                    alt={ytInfo.title}
                    referrerPolicy="no-referrer"
                    className="w-full sm:w-28 h-20 sm:h-20 object-cover rounded-lg shrink-0 border border-slate-300"
                  />
                  <div className="min-w-0 flex-1 flex flex-col justify-between">
                    <div>
                      <div className="text-xs sm:text-sm font-bold text-slate-950 line-clamp-2">
                        {ytInfo.title}
                      </div>
                      <div className="text-[11px] text-slate-600 font-medium mt-0.5">
                        {ytInfo.author}
                      </div>
                    </div>

                    {/* Video Size & Audio Size Info */}
                    <div className="flex flex-wrap items-center gap-2 pt-2 text-[11px] font-semibold text-slate-700">
                      {ytInfo.duration && (
                        <span className="inline-flex items-center gap-1 bg-white px-2 py-0.5 rounded-md border border-slate-200 shadow-2xs">
                          <Clock className="w-3 h-3 text-slate-500" />
                          <span>সময়: {ytInfo.duration}</span>
                        </span>
                      )}
                      {ytInfo.videoSize && (
                        <span className="inline-flex items-center gap-1 bg-white px-2 py-0.5 rounded-md border border-slate-200 shadow-2xs">
                          <HardDrive className="w-3 h-3 text-indigo-500" />
                          <span>ভিডিও সাইজ: {ytInfo.videoSize}</span>
                        </span>
                      )}
                      {ytInfo.audioSize && (
                        <span className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-800 px-2 py-0.5 rounded-md border border-emerald-200 shadow-2xs">
                          <Music className="w-3 h-3 text-emerald-600" />
                          <span>অডিও সাইজ: {ytInfo.audioSize}</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: Upload Video File */}
          {activeTab === 'upload' && (
            <div className="space-y-3">
              <label className="block text-xs sm:text-sm font-bold text-slate-800">
                ভিডিও ফাইল নির্বাচন করুন
              </label>

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragOver(true);
                }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragOver(false);
                  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                    handleFileSelect(e.dataTransfer.files[0]);
                  }
                }}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition-all flex flex-col items-center justify-center min-h-[105px] ${
                  isDragOver
                    ? 'border-rose-500 bg-rose-50'
                    : 'border-slate-300 hover:border-slate-400 bg-slate-50 hover:bg-slate-100/80'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*,.mp4,.mov,.webm,.mkv,.avi,.3gp"
                  onChange={(e) => {
                    if (e.target.files && e.target.files[0]) {
                      handleFileSelect(e.target.files[0]);
                    }
                  }}
                  className="hidden"
                />

                <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center mb-1.5 border border-slate-200 shadow-2xs">
                  <Upload className="w-4 h-4 text-rose-600" />
                </div>

                <div className="text-xs sm:text-sm font-bold text-slate-900">
                  {selectedFile ? 'অন্য ফাইল নির্বাচন করতে ক্লিক করুন' : 'ফাইল ড্রপ করুন অথবা ব্রাউজ করুন'}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5 font-medium">
                  MP4, MOV, WEBM, MKV (সর্বোচ্চ ৫০০MB)
                </div>
              </div>

              {/* Selected File Details */}
              {selectedFile && (
                <div className="p-2.5 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <FileAudio className="w-4 h-4 text-rose-500 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-xs sm:text-sm font-bold truncate text-slate-950">
                        {selectedFile.name}
                      </div>
                      <div className="text-[11px] text-slate-500 font-medium">
                        {formatFileSize(selectedFile.size)}
                      </div>
                    </div>
                  </div>
                  <span className="text-xs text-emerald-600 font-bold whitespace-nowrap flex items-center gap-1">
                    <Check className="w-3.5 h-3.5" /> প্রস্তুত
                  </span>
                </div>
              )}
            </div>
          )}

          {/* COMMON CONVERSION OPTIONS */}
          <div className="mt-4 pt-4 border-t border-slate-200 space-y-4">
            {/* Error Message Alert */}
            {errorMessage && (
              <div className="p-3.5 rounded-xl border border-rose-300 bg-rose-50 text-rose-950 text-xs sm:text-sm space-y-2 font-medium">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                  <div className="flex-1 leading-relaxed">{errorMessage}</div>
                </div>

                {activeTab === 'youtube' && (
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setActiveTab('upload');
                        setErrorMessage(null);
                      }}
                      className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs flex items-center gap-1.5 transition-all cursor-pointer shadow-2xs"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      <span>vedio আপলোড করুন অপশনে যান</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Convert Button with Integrated Background CSS Progress Filler */}
            {!result && (
              <button
                type="button"
                onClick={activeTab === 'youtube' ? handleConvertYouTube : handleConvertUploadedFile}
                disabled={
                  isProcessing ||
                  (activeTab === 'youtube' && !youtubeUrl.trim()) ||
                  (activeTab === 'upload' && !selectedFile)
                }
                className="relative overflow-hidden w-full py-3.5 px-5 rounded-xl bg-slate-900 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-sm sm:text-base shadow-md shadow-rose-950/20 transition-all flex items-center justify-center cursor-pointer min-h-[48px] select-none active:scale-[0.99]"
              >
                {/* Default vibrant gradient background when idle */}
                {!isProcessing && (
                  <div className="absolute inset-0 bg-gradient-to-r from-rose-600 to-indigo-600 hover:from-rose-500 hover:to-indigo-500 transition-colors pointer-events-none" />
                )}

                {/* CSS Progress Filler in the background when converting */}
                {isProcessing && (
                  <>
                    <div className="absolute inset-0 bg-slate-900 pointer-events-none" />
                    <div
                      className="absolute inset-y-0 left-0 bg-gradient-to-r from-rose-600 via-pink-600 to-indigo-600 transition-[width] duration-300 ease-out pointer-events-none"
                      style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
                    >
                      {/* Animated shimmer sweep */}
                      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/25 to-transparent animate-shimmer pointer-events-none" />
                    </div>
                  </>
                )}

                {/* Button Content / Label */}
                <div className="relative z-10 flex items-center justify-center gap-2">
                  {isProcessing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-white shrink-0" />
                      <span>কনভার্ট করা হচ্ছে {Math.round(progressPercent)}%</span>
                    </>
                  ) : (
                    <>
                      <Music className="w-4 h-4" />
                      <span>অডিওতে কনভার্ট করুন</span>
                    </>
                  )}
                </div>
              </button>
            )}
          </div>

          {/* DOWNLOAD ACTION SECTION (Audio preview and success banner removed per request) */}
          {result && (
            <div className="mt-5 pt-5 border-t border-slate-200 space-y-3 animate-fade-in">
              <div>
                <button
                  type="button"
                  onClick={() => handleDirectDownload()}
                  className="w-full py-3.5 px-6 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold text-sm sm:text-base shadow-sm transition-all flex items-center justify-center gap-2 cursor-pointer min-h-[48px] whitespace-nowrap active:scale-[0.99]"
                >
                  <Download className="w-5 h-5" />
                  <span>অডিও ফাইল ডাউনলোড করুন ({formatFileSize(result.fileSize)})</span>
                </button>
              </div>

              {/* Reset to convert another */}
              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={resetAll}
                  className="text-xs transition-colors inline-flex items-center gap-1 cursor-pointer font-bold text-slate-600 hover:text-slate-950"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>আরেকটি ভিডিও কনভার্ট করতে চান? এখানে ক্লিক করুন</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer exactly matching the uploaded screenshot layout (Compact 50% size) */}
        <footer className="mt-auto pt-2.5 pb-2 text-center flex flex-col items-center justify-center space-y-0.5">
          <div className="text-[10px] font-medium text-slate-400 tracking-normal">
            কপিরাইট © ২০২৬ - V to A
          </div>

          <div className="w-16 border-t border-slate-200/70 my-1"></div>

          <div className="text-[10px] text-slate-500 font-normal">
            Developed by <span className="text-slate-700 font-bold">Md. Maruf</span>
          </div>

          {/* Half-sized circular social buttons */}
          <div className="flex items-center justify-center gap-2 pt-1">
            {/* Facebook button */}
            <a
              href="https://www.facebook.com/share/1ByyJW8K8i/?mibextid=wwXIfr"
              target="_blank"
              rel="noopener noreferrer"
              className="w-5 h-5 rounded-full bg-blue-100/70 border border-blue-200/80 flex items-center justify-center text-[#1877F2] hover:bg-blue-200/80 hover:scale-110 transition-all shadow-2xs"
              title="Facebook: Md. Maruf"
              aria-label="Facebook Profile"
            >
              <svg className="w-2.5 h-2.5 fill-current" viewBox="0 0 24 24">
                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
              </svg>
            </a>

            {/* WhatsApp button */}
            <a
              href="https://wa.me/8801410112006"
              target="_blank"
              rel="noopener noreferrer"
              className="w-5 h-5 rounded-full bg-emerald-100/70 border border-emerald-200/80 flex items-center justify-center text-[#25D366] hover:bg-emerald-200/80 hover:scale-110 transition-all shadow-2xs"
              title="WhatsApp: 01410112006"
              aria-label="WhatsApp Contact"
            >
              <svg className="w-2.5 h-2.5 fill-current" viewBox="0 0 24 24">
                <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z" />
              </svg>
            </a>
          </div>
        </footer>
      </main>
    </div>
  );
}
