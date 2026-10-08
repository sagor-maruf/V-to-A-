import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Storage setup
const STORAGE_DIR = path.join(os.tmpdir(), 'audio_converter_storage');
const UPLOADS_DIR = path.join(STORAGE_DIR, 'uploads');
const OUTPUTS_DIR = path.join(STORAGE_DIR, 'outputs');
const CACHE_DIR = path.join(STORAGE_DIR, 'yt_cache');

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(OUTPUTS_DIR)) fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Periodic cleanup of files older than 2 hours
setInterval(() => {
  const now = Date.now();
  const maxAge = 2 * 60 * 60 * 1000;
  for (const dir of [UPLOADS_DIR, OUTPUTS_DIR, CACHE_DIR, STORAGE_DIR]) {
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isFile() && now - stat.mtimeMs > maxAge) {
          fs.unlinkSync(filePath);
        }
      }
    } catch {
      // ignore cleanup errors
    }
  }
}, 15 * 60 * 1000);

// Multer upload config for video files (up to 500MB)
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, `video-${uniqueSuffix}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
});

app.use(express.json());

interface AudioFileRecord {
  id: string;
  filePath: string;
  fileName: string;
  format: string;
  mimeType: string;
  fileSize: number;
  duration?: number;
  createdAt: number;
}

const fileRegistry = new Map<string, AudioFileRecord>();

// In-flight conversion deduplication to prevent racing or duplicate requests
const inFlightConversions = new Map<string, Promise<{ success: boolean; cachedPath?: string; title?: string; error?: string }>>();

// Job registry for SSE progress
interface ConversionJob {
  status: 'pending' | 'downloading' | 'extracting' | 'finalizing' | 'completed' | 'error';
  progress: number; // 0-100
  error?: string;
  result?: any;
}
const jobRegistry = new Map<string, ConversionJob>();

function getFormatDetails(format: string, bitrate: string = '320k') {
  const fmt = (format || 'mp3').toLowerCase();
  const bRate = bitrate || '320k';
  switch (fmt) {
    case 'aac':
    case 'm4a':
      return {
        ext: '.m4a',
        mimeType: 'audio/mp4',
        ffmpegArgs: ['-c:a', 'aac', '-b:a', bRate, '-ar', '44100'],
      };
    case 'ogg':
      return {
        ext: '.ogg',
        mimeType: 'audio/ogg',
        ffmpegArgs: ['-c:a', 'libvorbis', '-b:a', bRate, '-ar', '44100'],
      };
    case 'wav':
      return {
        ext: '.wav',
        mimeType: 'audio/wav',
        ffmpegArgs: ['-c:a', 'pcm_s16le', '-ar', '44100'],
      };
    case 'mp3':
    default:
      return {
        ext: '.mp3',
        mimeType: 'audio/mpeg',
        ffmpegArgs: [
          '-c:a', 'libmp3lame',
          '-b:a', bRate,
          '-ar', '44100',
          '-id3v2_version', '3',
          '-write_xing', '1',
        ],
      };
  }
}

interface SourceQualityAnalysis {
  videoResolution?: string;
  audioBitrate?: number;
  audioSampleRate?: number;
  audioChannels?: number;
  audioCodec?: string;
  recommendedBitrate: '320k' | '256k' | '192k';
  qualityGrade: 'ultra-high' | 'high' | 'standard';
}

/**
 * Hidden logic to analyze source video/audio quality with ffprobe
 * and automatically determine the optimal high-fidelity bitrate (e.g. 320kbps)
 */
async function analyzeMediaQuality(filePath: string): Promise<SourceQualityAnalysis> {
  return new Promise((resolve) => {
    const proc = spawn('/usr/bin/ffprobe', [
      '-v', 'error',
      '-show_streams',
      '-of', 'json',
      filePath,
    ]);
    let output = '';
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0 && output.trim()) {
        try {
          const data = JSON.parse(output);
          const streams = data.streams || [];
          const audioStream = streams.find((s: any) => s.codec_type === 'audio');
          const videoStream = streams.find((s: any) => s.codec_type === 'video');

          const audioBitrate = audioStream?.bit_rate ? parseInt(audioStream.bit_rate, 10) : null;
          const audioSampleRate = audioStream?.sample_rate ? parseInt(audioStream.sample_rate, 10) : null;
          const audioChannels = audioStream?.channels || null;
          const audioCodec = audioStream?.codec_name || null;
          const videoHeight = videoStream?.height || 0;

          // Quality analysis: automatically default to 'high' (320kbps) for studio audio fidelity
          let recommendedBitrate: '320k' | '256k' | '192k' = '320k';
          let qualityGrade: 'ultra-high' | 'high' | 'standard' = 'high';

          if (videoHeight >= 1080 || (audioBitrate && audioBitrate >= 256000)) {
            recommendedBitrate = '320k';
            qualityGrade = 'ultra-high';
          } else if (videoHeight >= 720 || (audioBitrate && audioBitrate >= 128000)) {
            recommendedBitrate = '320k';
            qualityGrade = 'high';
          } else {
            recommendedBitrate = '320k';
            qualityGrade = 'high';
          }

          resolve({
            videoResolution: videoStream ? `${videoStream.width}x${videoStream.height}` : undefined,
            audioBitrate: audioBitrate || undefined,
            audioSampleRate: audioSampleRate || undefined,
            audioChannels: audioChannels || undefined,
            audioCodec: audioCodec || undefined,
            recommendedBitrate,
            qualityGrade,
          });
          return;
        } catch {}
      }
      resolve({
        recommendedBitrate: '320k',
        qualityGrade: 'high',
      });
    });
    proc.on('error', () => {
      resolve({
        recommendedBitrate: '320k',
        qualityGrade: 'high',
      });
    });
  });
}

function sanitizeFilename(name: string): string {
  if (!name) return 'audio';
  return (
    name
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100) || 'audio'
  );
}

function extractVideoId(url: string): { platform: string; id: string | null; url: string } {
  if (!url) return { platform: 'unknown', id: null, url };
  const trimmed = url.trim();
  
  // Detect platform
  if (trimmed.includes('youtube.com') || trimmed.includes('youtu.be')) {
    const match = trimmed.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/|live\/|watch\?.+&v=))([\w-]{11})/i);
    return { platform: 'youtube', id: match ? match[1] : null, url: trimmed };
  } else if (trimmed.includes('facebook.com') || trimmed.includes('fb.watch')) {
    return { platform: 'facebook', id: trimmed, url: trimmed };
  } else if (trimmed.includes('tiktok.com')) {
    return { platform: 'tiktok', id: trimmed, url: trimmed };
  } else if (trimmed.includes('instagram.com')) {
    return { platform: 'instagram', id: trimmed, url: trimmed };
  }
  
  return { platform: 'unknown', id: null, url: trimmed };
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Audio Utilities: Transcode & Probe
// ---------------------------------------------------------------------------

async function getAudioDurationSeconds(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn('/usr/bin/ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    let output = '';
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0 && output.trim()) {
        const secs = parseFloat(output.trim());
        if (!isNaN(secs) && secs > 0) {
          resolve(Math.round(secs));
          return;
        }
      }
      resolve(null);
    });
    proc.on('error', () => resolve(null));
  });
}

// Transcode an existing audio file on disk to the desired target format with ffmpeg
async function transcodeAudioFile(
  inputAudioPath: string,
  targetFormat: string,
  outputPath: string,
  bitrate: string = '320k'
): Promise<boolean> {
  const fmtDetails = getFormatDetails(targetFormat, bitrate);
  return new Promise((resolve) => {
    const ffmpegProc = spawn('/usr/bin/ffmpeg', [
      '-i',
      inputAudioPath,
      '-vn',
      ...fmtDetails.ffmpegArgs,
      '-y',
      outputPath,
    ]);
    ffmpegProc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    ffmpegProc.on('error', () => resolve(false));
  });
}

// Download remote file from URL to local file path
async function downloadToFile(url: string, destPath: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: '*/*',
      },
      signal: AbortSignal.timeout(180000), // 3 minutes max download
    });
    if (!res.ok || !res.body) return false;
    const fileStream = fs.createWriteStream(destPath);
    // @ts-ignore
    await pipeline(res.body, fileStream);
    return fs.existsSync(destPath) && fs.statSync(destPath).size > 1024;
  } catch (e) {
    console.error('downloadToFile error:', e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// High-Availability Multi-Cluster YouTube Audio Downloader
// ---------------------------------------------------------------------------

async function fetchMasterAudioForVideo(
  videoId: string
): Promise<{ success: boolean; cachedPath?: string; title?: string; error?: string }> {
  const cachedMp3Path = path.join(CACHE_DIR, `${videoId}.mp3`);

  // 1. Check if we already have this video cached on disk
  if (fs.existsSync(cachedMp3Path) && fs.statSync(cachedMp3Path).size > 1024) {
    return { success: true, cachedPath: cachedMp3Path };
  }

  // 2. Check if a conversion is already in-flight for this videoId
  if (inFlightConversions.has(videoId)) {
    return inFlightConversions.get(videoId)!;
  }

  const conversionPromise = (async () => {
    const fullYtUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const hosts = [
      'https://lto2.affadaffa.com',
      'https://p.savenow.to',
      'https://loader.to',
      'https://en.loader.to',
    ];

    let lastError = 'কনভার্ট ইঞ্জিন থেকে রেসপন্স পাওয়া যায়নি।';
    let videoTitle: string | undefined;

    for (const host of hosts) {
      try {
        let initData: any = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const initRes = await fetch(
              `${host}/ajax/download.php?button=1&start=1&end=1&format=mp3&url=${encodeURIComponent(fullYtUrl)}`,
              {
                headers: {
                  'User-Agent': BROWSER_UA,
                  Referer: `${host}/`,
                },
                signal: AbortSignal.timeout(8000),
              }
            );
            if (initRes.ok) {
              initData = await initRes.json();
              if (initData && (initData.progress_url || initData.download_url)) break;
            }
          } catch {
            await new Promise((r) => setTimeout(r, 600));
          }
        }

        if (!initData || (!initData.progress_url && !initData.download_url)) continue;

        if (initData.title || initData.info?.title) {
          videoTitle = initData.title || initData.info?.title;
        }

        let directDownloadUrl: string | null = initData.download_url || null;

        if (!directDownloadUrl && initData.progress_url) {
          // Poll progress endpoint up to 45 times (55 seconds max)
          for (let i = 0; i < 45; i++) {
            await new Promise((r) => setTimeout(r, 1200));
            try {
              const pRes = await fetch(initData.progress_url, {
                headers: { 'User-Agent': BROWSER_UA },
                signal: AbortSignal.timeout(7000),
              });
              if (pRes.ok) {
                const pData = await pRes.json();
                if (pData.download_url) {
                  directDownloadUrl = pData.download_url;
                  break;
                }
                if (pData.success === 1 && pData.download_url) {
                  directDownloadUrl = pData.download_url;
                  break;
                }
                // Do not prematurely abort on queue/pending messages
              }
            } catch {
              // Ignore single transient network glitch during polling
            }
          }
        }

        if (!directDownloadUrl) continue;

        // Download the master MP3 to cache
        const tempDlPath = path.join(CACHE_DIR, `temp-${videoId}-${Date.now()}.mp3`);
        const dlOk = await downloadToFile(directDownloadUrl, tempDlPath);

        if (dlOk && fs.existsSync(tempDlPath) && fs.statSync(tempDlPath).size > 1024) {
          fs.renameSync(tempDlPath, cachedMp3Path);
          return { success: true, cachedPath: cachedMp3Path, title: videoTitle };
        } else {
          try { if (fs.existsSync(tempDlPath)) fs.unlinkSync(tempDlPath); } catch {}
        }
      } catch (err: any) {
        console.error(`Host ${host} failed for video ${videoId}:`, err.message);
        lastError = err.message;
      }
    }

    return { success: false, error: lastError };
  })();

  inFlightConversions.set(videoId, conversionPromise);

  try {
    const result = await conversionPromise;
    return result;
  } finally {
    inFlightConversions.delete(videoId);
  }
}

// SSE progress endpoint
app.get('/api/convert-progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendProgress = (job: ConversionJob) => {
    res.write(`data: ${JSON.stringify(job)}\n\n`);
  };

  const job = jobRegistry.get(jobId);
  if (job) {
    sendProgress(job);
  }

  // Simple interval-based update for SSE
  const interval = setInterval(() => {
    const currentJob = jobRegistry.get(jobId);
    if (currentJob) {
      sendProgress(currentJob);
      if (currentJob.status === 'completed' || currentJob.status === 'error') {
        clearInterval(interval);
        res.end();
      }
    }
  }, 1000);

  req.on('close', () => clearInterval(interval));
});

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------

// 1. YouTube metadata lookup with duration, video size, and audio size calculation
app.get('/api/youtube-info', async (req, res) => {
  try {
    const rawUrl = req.query.url as string;
    if (!rawUrl) {
      return res.status(400).json({ ok: false, error: 'ইউটিউব লিঙ্ক প্রদান করুন।' });
    }

    const videoId = extractYouTubeId(rawUrl);
    if (!videoId) {
      return res.status(400).json({ ok: false, error: 'সঠিক ইউটিউব লিঙ্ক বা ভিডিও আইডি পাওয়া যায়নি।' });
    }

    // Check if we have cached audio for instant duration
    const cachedMp3Path = path.join(CACHE_DIR, `${videoId}.mp3`);
    let cachedDuration: number | null = null;
    if (fs.existsSync(cachedMp3Path)) {
      cachedDuration = await getAudioDurationSeconds(cachedMp3Path);
    }

    // Call YouTube official oEmbed endpoint (instant, reliable, always works)
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const oembedRes = await fetch(oembedUrl, { signal: AbortSignal.timeout(5000) });

    if (!oembedRes.ok) {
      return res.status(404).json({
        ok: false,
        error: 'ভিডিওটি পাওয়া যায়নি বা প্রাইভেট করা আছে। অনুগ্রহ করে লিঙ্কটি চেক করুন।',
      });
    }

    const data = await oembedRes.json();

    let duration: string | null = null;
    let videoSize: string | null = null;
    let audioSize: string | null = null;

    if (cachedDuration && cachedDuration > 0) {
      const mins = Math.floor(cachedDuration / 60);
      const secs = cachedDuration % 60;
      duration = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
      const mb = ((cachedDuration * 24) / 1024).toFixed(1);
      audioSize = `${mb} MB`;
      videoSize = `~${((cachedDuration * 120) / 1024).toFixed(1)} MB`;
    } else {
      try {
        let lengthSeconds: number | null = null;
        for (const base of ['https://invidious.f5.si', 'https://invidious.ducks.party']) {
          try {
            const invRes = await fetch(`${base}/api/v1/videos/${videoId}`, { signal: AbortSignal.timeout(1800) });
            if (invRes.ok) {
              const invData = await invRes.json();
              if (invData.lengthSeconds) lengthSeconds = parseInt(invData.lengthSeconds, 10);
              const a = invData.adaptiveFormats?.find((f: any) => f.type?.startsWith('audio/'));
              if (a?.clen) audioSize = (parseInt(a.clen, 10) / (1024 * 1024)).toFixed(1) + ' MB';
              break;
            }
          } catch {}
        }

        if (lengthSeconds && lengthSeconds > 0) {
          const mins = Math.floor(lengthSeconds / 60);
          const secs = lengthSeconds % 60;
          duration = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
          if (!audioSize) {
            audioSize = '~' + ((lengthSeconds * 24) / 1024).toFixed(1) + ' MB';
          }
          videoSize = '~' + ((lengthSeconds * 120) / 1024).toFixed(1) + ' MB';
        }
      } catch {
        // ignore duration calculation errors
      }
    }

    return res.json({
      ok: true,
      videoId,
      title: data.title || 'YouTube Video',
      author: data.author_name || 'YouTube Channel',
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      duration,
      videoSize,
      audioSize,
    });
  } catch (error: any) {
    console.error('Error fetching youtube-info:', error);
    return res.status(500).json({
      ok: false,
      error: 'ভিডিওর তথ্য লোড করতে সমস্যা হয়েছে। দয়া করে আবার চেষ্টা করুন।',
    });
  }
});

// 2. Convert YouTube/Social Media to Audio (Async)
app.post('/api/convert-video', async (req, res) => {
  const { url, format = 'mp3', customName, bitrate } = req.body;
  if (!url) return res.status(400).json({ ok: false, error: 'লিঙ্ক আবশ্যক।' });

  const videoInfo = extractVideoId(url);
  if (!videoInfo.url) return res.status(400).json({ ok: false, error: 'সঠিক লিঙ্ক পাওয়া যায়নি।' });

  if (videoInfo.platform !== 'youtube') {
    return res.status(501).json({ ok: false, error: `${videoInfo.platform} বর্তমানে সাপোর্ট করে না। শুধুমাত্র ইউটিউব সাপোর্ট করে।` });
  }

  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  jobRegistry.set(jobId, { status: 'pending', progress: 0 });

  // Run conversion in background
  (async () => {
    try {
      jobRegistry.set(jobId, { status: 'downloading', progress: 10 });
      // 1. Fetch title
      let videoTitle = 'audio-track';
      try {
        const oembed = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoInfo.id}&format=json`, { signal: AbortSignal.timeout(3000) });
        if (oembed.ok) {
          const d = await oembed.json();
          if (d.title) videoTitle = d.title;
        }
      } catch {}

      const targetFormat = format && format !== 'auto' ? format.toLowerCase() : 'mp3';
      const fmtDetails = getFormatDetails(targetFormat);
      const baseName = sanitizeFilename(customName || videoTitle || 'video-audio');
      const finalFilename = `${baseName}${fmtDetails.ext}`;
      const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const outputFilePath = path.join(OUTPUTS_DIR, `${fileId}${fmtDetails.ext}`);

      jobRegistry.set(jobId, { status: 'downloading', progress: 30 });
      // Fetch or reuse master audio stream
      const masterResult = await fetchMasterAudioForVideo(videoInfo.id!);

      if (!masterResult.success || !masterResult.cachedPath || !fs.existsSync(masterResult.cachedPath)) {
        jobRegistry.set(jobId, { status: 'error', progress: 0, error: 'ইউটিউব ভিডিও থেকে অডিও পাওয়া যায়নি।' });
        return;
      }

      jobRegistry.set(jobId, { status: 'extracting', progress: 60 });
      const qualityAnalysis = await analyzeMediaQuality(masterResult.cachedPath);
      const targetBitrate = bitrate || qualityAnalysis.recommendedBitrate || '320k';
      
      jobRegistry.set(jobId, { status: 'finalizing', progress: 85 });
      const transcodeOk = await transcodeAudioFile(
        masterResult.cachedPath,
        targetFormat,
        outputFilePath,
        targetBitrate
      );

      if (!transcodeOk || !fs.existsSync(outputFilePath)) {
        jobRegistry.set(jobId, { status: 'error', progress: 0, error: 'অডিও ট্রান্সকোডিং ব্যর্থ হয়েছে।' });
        return;
      }

      const stat = fs.statSync(outputFilePath);
      const exactDuration = await getAudioDurationSeconds(outputFilePath);

      const record: AudioFileRecord = {
        id: fileId,
        filePath: outputFilePath,
        fileName: finalFilename,
        format: targetFormat,
        mimeType: fmtDetails.mimeType,
        fileSize: stat.size,
        duration: exactDuration || undefined,
        createdAt: Date.now(),
      };
      fileRegistry.set(fileId, record);

      jobRegistry.set(jobId, { 
        status: 'completed', 
        progress: 100,
        result: {
          fileId,
          fileName: finalFilename,
          format: targetFormat.toUpperCase(),
          fileSize: stat.size,
          duration: exactDuration,
          downloadUrl: `/api/download/${fileId}`,
          streamUrl: `/api/stream/${fileId}`,
        }
      });
    } catch (error: any) {
      console.error('Convert video background error:', error);
      jobRegistry.set(jobId, { status: 'error', progress: 0, error: error.message || 'কনভার্ট ব্যর্থ হয়েছে।' });
    }
  })();

  return res.json({ ok: true, jobId });
});

// 3. Convert uploaded video file to audio
app.post('/api/convert-video', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'ভিডিও ফাইল সিলেক্ট করুন।' });
  }

  const { format = 'mp3', customName, bitrate } = req.body;
  const inputFilePath = req.file.path;

  const originalBase = path.parse(req.file.originalname).name;
  const baseName = sanitizeFilename(customName || originalBase || 'converted-audio');
  const targetFormat = format && format !== 'auto' ? format.toLowerCase() : 'mp3';

  // Analyze source video quality and set output bitrate
  const qualityAnalysis = await analyzeMediaQuality(inputFilePath);
  const targetBitrate = bitrate || qualityAnalysis.recommendedBitrate || '320k';
  const fmtDetails = getFormatDetails(targetFormat, targetBitrate);

  const finalFilename = `${baseName}${fmtDetails.ext}`;
  const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const outputFilePath = path.join(OUTPUTS_DIR, `${fileId}${fmtDetails.ext}`);

  const ffmpegArgs = [
    '-i', inputFilePath,
    '-vn',
    ...fmtDetails.ffmpegArgs,
    '-y',
    outputFilePath,
  ];

  const ffmpegProcess = spawn('/usr/bin/ffmpeg', ffmpegArgs);

  ffmpegProcess.on('close', async (code) => {
    try {
      if (fs.existsSync(inputFilePath)) fs.unlinkSync(inputFilePath);
    } catch {}

    if (code === 0 && fs.existsSync(outputFilePath)) {
      const stat = fs.statSync(outputFilePath);
      const exactDuration = await getAudioDurationSeconds(outputFilePath);
      const record: AudioFileRecord = {
        id: fileId,
        filePath: outputFilePath,
        fileName: finalFilename,
        format: targetFormat,
        mimeType: fmtDetails.mimeType,
        fileSize: stat.size,
        duration: exactDuration || undefined,
        createdAt: Date.now(),
      };
      fileRegistry.set(fileId, record);

      return res.json({
        ok: true,
        fileId,
        fileName: finalFilename,
        format: targetFormat.toUpperCase(),
        fileSize: stat.size,
        duration: exactDuration,
        downloadUrl: `/api/download/${fileId}`,
        streamUrl: `/api/stream/${fileId}`,
      });
    } else {
      return res.status(500).json({
        ok: false,
        error: 'ভিডিও কনভার্ট করতে সমস্যা হয়েছে। সঠিক ভিডিও ফরম্যাট দিন।',
      });
    }
  });

  ffmpegProcess.on('error', (err) => {
    try {
      if (fs.existsSync(inputFilePath)) fs.unlinkSync(inputFilePath);
    } catch {}
    return res.status(500).json({
      ok: false,
      error: 'কনভার্সন প্রসেস শুরু করা যায়নি: ' + err.message,
    });
  });
});

// 4. Download endpoint with proper Content-Disposition and Content-Length
app.get('/api/download/:fileId', (req, res) => {
  const { fileId } = req.params;
  const record = fileRegistry.get(fileId);

  if (!record || !fs.existsSync(record.filePath)) {
    return res.status(404).send('অডিও ফাইলটি পাওয়া যায়নি বা মেয়াদ উত্তীর্ণ হয়েছে।');
  }

  const stat = fs.statSync(record.filePath);
  res.setHeader('Content-Type', record.mimeType);
  res.setHeader('Content-Length', stat.size);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(record.fileName)}"; filename*=UTF-8''${encodeURIComponent(record.fileName)}`
  );
  res.setHeader('Cache-Control', 'public, max-age=3600');

  const stream = fs.createReadStream(record.filePath);
  stream.pipe(res);
});

// 5. Audio streaming endpoint with full HTTP 206 Partial Content Range support
app.get('/api/stream/:fileId', (req, res) => {
  const { fileId } = req.params;
  const record = fileRegistry.get(fileId);

  if (!record || !fs.existsSync(record.filePath)) {
    return res.status(404).send('অডিও ফাইলটি পাওয়া যায়নি।');
  }

  const stat = fs.statSync(record.filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = end - start + 1;
    const file = fs.createReadStream(record.filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': record.mimeType,
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': record.mimeType,
      'Accept-Ranges': 'bytes',
    };
    res.writeHead(200, head);
    fs.createReadStream(record.filePath).pipe(res);
  }
});

// ---------------------------------------------------------------------------
// Dev Server vs Production Setup
// ---------------------------------------------------------------------------
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    app.use('*', async (req, res, next) => {
      const url = req.originalUrl;
      try {
        let template = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

startServer();
