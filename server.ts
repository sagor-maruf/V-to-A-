import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import { createHash } from 'crypto';
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
    const proc = spawn('ffprobe', [
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
    const proc = spawn('ffprobe', [
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
    const ffmpegProc = spawn('ffmpeg', [
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

// ---------------------------------------------------------------------------
// Multi-Platform Downloader (Facebook / TikTok / Instagram) — yt-dlp ইঞ্জিন
// ---------------------------------------------------------------------------

const PLATFORM_NAMES: Record<string, string> = {
  youtube: 'ইউটিউব',
  facebook: 'ফেসবুক',
  tiktok: 'টিকটক',
  instagram: 'ইনস্টাগ্রাম',
};

const YTDLP_BIN = process.env.YTDLP_PATH || 'yt-dlp';

// অপশনাল: ইনস্টাগ্রাম/ফেসবুক লগইন-ওয়াল চাইলে Render-এর Environment-এ
// YTDLP_COOKIES সেট করুন (cookies.txt ফাইলের কনটেন্ট বা base64 করতে হবে — গাইড দেখুন)
const YTDLP_COOKIE_FILE = setupYtDlpCookies();

function setupYtDlpCookies(): string | null {
  try {
    const raw = (process.env.YTDLP_COOKIES || '').trim();
    if (!raw) return null;
    if (raw.startsWith('/') && fs.existsSync(raw)) return raw; // সরাসরি ফাইল-পাথ দেওয়া হলে
    let content = raw.replace(/\\n/g, '\n');
    if (!content.includes('\n') && !content.startsWith('# Netscape')) {
      try {
        const decoded = Buffer.from(content, 'base64').toString('utf8');
        if (decoded.includes('\t') || decoded.startsWith('# Netscape')) content = decoded;
      } catch {}
    }
    if (!content.includes('\t') && !content.startsWith('# Netscape')) return null;
    const p = path.join(os.tmpdir(), 'ytdlp-cookies.txt');
    fs.writeFileSync(p, content, 'utf8');
    return p;
  } catch {
    return null;
  }
}

function ytDlpBaseArgs(withImpersonate: boolean): string[] {
  const args = ['--no-warnings', '--no-playlist', '--no-part', '--retries', '3', '--max-filesize', '400M'];
  if (withImpersonate) args.push('--impersonate', 'chrome');
  if (YTDLP_COOKIE_FILE) args.push('--cookies', YTDLP_COOKIE_FILE);
  return args;
}

function runYtDlp(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const proc = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      if (!done) {
        try {
          proc.kill('SIGKILL');
        } catch {}
      }
    }, timeoutMs);
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > 200000) stdout = stdout.slice(-200000);
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    proc.on('close', (code) => {
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    proc.on('error', (err) => {
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message });
    });
  });
}

// yt-dlp-এর এররকে ইউজারের বোঝার মতো বাংলায় অনুবাদ করি
function friendlyYtDlpError(stderr: string): string {
  const s = (stderr || '').toLowerCase();
  if (s.includes('empty media response') || s.includes('login required') || s.includes('rate-limit') || s.includes('login needed')) {
    return 'এই ভিডিওটি লগইন ছাড়া পাওয়া যাচ্ছে না (প্রাইভেট বা সীমাবদ্ধ)। পাবলিক পোস্ট/রিল দিয়ে চেষ্টা করুন।';
  }
  if (s.includes('private video') || s.includes('this video is private') || s.includes('not available') || s.includes('removed') || s.includes('unavailable')) {
    return 'ভিডিওটি প্রাইভেট বা মুছে ফেলা হয়েছে।';
  }
  if (s.includes('unsupported url')) {
    return 'এই লিংকটি সাপোর্টেড না।';
  }
  if (s.includes('max-filesize') || s.includes('larger than')) {
    return 'ফাইলটি অনেক বড় (৪০০MB-এর বেশি)। ছোট ভিডিও/রিল দিয়ে চেষ্টা করুন।';
  }
  if (s.includes('enoent') || s.includes('no such file or directory')) {
    return 'ডাউনলোড ইঞ্জিন (yt-dlp) পাওয়া যায়নি — সার্ভার আপডেট করা দরকার।';
  }
  if (s.includes('urlopen error') || s.includes('failed to resolve') || s.includes('timed out') || s.includes('timeout')) {
    return 'নেটওয়ার্ক সমস্যা হয়েছে — একটু পরে আবার চেষ্টা করুন।';
  }
  const lastLine = (stderr || '').trim().split('\n').filter(Boolean).pop() || '';
  return `ভিডিও ডাউনলোড ব্যর্থ হয়েছে। ${lastLine.slice(0, 160)}`;
}

// Facebook / TikTok / Instagram থেকে অডিও (বা ভিডিও) ডাউনলোড + ক্যাশ
async function fetchMasterAudioForYtDlp(
  platform: string,
  url: string
): Promise<{ success: boolean; cachedPath?: string; title?: string; error?: string }> {
  const cacheKey = `ytdlp-${platform}-${createHash('md5').update(url).digest('hex').slice(0, 16)}`;

  // 1. ক্যাশে আগে থেকে থাকলে সেটাই দিই
  try {
    const cachedFiles = fs.readdirSync(CACHE_DIR).filter((f) => f.startsWith(cacheKey + '.'));
    for (const f of cachedFiles) {
      const p = path.join(CACHE_DIR, f);
      if (fs.statSync(p).size > 1024) {
        return { success: true, cachedPath: p };
      }
    }
  } catch {}

  // 2. একই URL-এর ডাউনলোড আগেই চলছে কি না (ডাবল কাজ ঠেকাতে)
  const inflightKey = `url:${url}`;
  if (inFlightConversions.has(inflightKey)) {
    return inFlightConversions.get(inflightKey)!;
  }

  const conversionPromise = (async () => {
    const attempts = platform === 'facebook' ? [false, true] : [true, false]; // [impersonate on/off ক্রম]
    let lastError = '';

    for (const withImpersonate of attempts) {
      const tmpDir = path.join(CACHE_DIR, `tmp-${cacheKey}-${Date.now()}`);
      try {
        fs.mkdirSync(tmpDir, { recursive: true });
      } catch {}

      const args = [
        ...ytDlpBaseArgs(withImpersonate),
        '--no-simulate',
        '-f', 'bestaudio/best',
        '-o', path.join(tmpDir, 'media.%(ext)s'),
        '--print', '%(title)s',
        '--print', 'after_move:filepath',
        url,
      ];

      const result = await runYtDlp(args, 330000);
      const lines = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      let filePath: string | null = null;
      for (const line of lines) {
        try {
          if (line.startsWith('/') && fs.existsSync(line) && fs.statSync(line).isFile()) filePath = line;
        } catch {}
      }

      if (result.code === 0 && filePath && fs.existsSync(filePath) && fs.statSync(filePath).size > 1024) {
        const pathIdx = lines.findIndex((l) => l === filePath);
        const title =
          (pathIdx > 0 ? lines.slice(0, pathIdx).join(' ') : lines[0] || '').slice(0, 180).trim() || undefined;

        const finalPath = path.join(CACHE_DIR, `${cacheKey}${path.extname(filePath)}`);
        try {
          fs.renameSync(filePath, finalPath);
        } catch {
          fs.copyFileSync(filePath, finalPath);
        }
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
        return { success: true, cachedPath: finalPath, title };
      }

      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
      lastError = result.stderr || result.stdout || lastError;
      console.error(`yt-dlp attempt (impersonate=${withImpersonate}) failed for ${url}:`, lastError.slice(0, 400));
    }

    return { success: false, error: friendlyYtDlpError(lastError) };
  })();

  inFlightConversions.set(inflightKey, conversionPromise);
  try {
    return await conversionPromise;
  } finally {
    inFlightConversions.delete(inflightKey);
  }
}

// Facebook / TikTok / Instagram — ভিডিওর তথ্য (টাইটেল, দৈর্ঘ্য, থাম্বনেইল, সাইজ)
async function getYtDlpMediaInfo(
  platform: string,
  url: string
): Promise<{ ok: boolean; error?: string; data?: Record<string, any> }> {
  const attempts = platform === 'facebook' ? [false, true] : [true, false];
  let lastError = '';

  for (const withImpersonate of attempts) {
    const args = [...ytDlpBaseArgs(withImpersonate), '--dump-single-json', '--skip-download', url];
    const result = await runYtDlp(args, 45000);
    if (result.code === 0 && result.stdout.trim()) {
      try {
        const data = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
        const durNum = typeof data.duration === 'number' && data.duration > 0 ? Math.round(data.duration) : null;

        let duration: string | null = null;
        if (durNum) {
          const mins = Math.floor(durNum / 60);
          const secs = durNum % 60;
          duration = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
        }

        // আসল ফাইল-সাইজ থাকলে সেটাই, নাহলে দৈর্ঘ্য থেকে অনুপাতিক হিসাব
        const formats: any[] = data.formats || [];
        const withSizes = (list: any[]) =>
          list
            .filter((f) => f.filesize || f.filesize_approx)
            .sort((a, b) => (b.filesize || b.filesize_approx) - (a.filesize || a.filesize_approx));

        let audioSize: string | null = null;
        let videoSize: string | null = null;
        const audioFormats = formats.filter((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none');
        const audioPick = withSizes(audioFormats)[0];
        if (audioPick) {
          const size = audioPick.filesize || audioPick.filesize_approx;
          if (size) audioSize = (size / (1024 * 1024)).toFixed(1) + ' MB';
        }
        const videoPick = withSizes(formats.filter((f) => f.vcodec && f.vcodec !== 'none'))[0];
        if (videoPick) {
          const size = videoPick.filesize || videoPick.filesize_approx;
          if (size) videoSize = (size / (1024 * 1024)).toFixed(1) + ' MB';
        }
        if (durNum) {
          if (!audioSize) audioSize = '~' + ((durNum * 32) / 1024).toFixed(1) + ' MB';
          if (!videoSize) videoSize = '~' + ((durNum * 120) / 1024).toFixed(1) + ' MB';
        }

        return {
          ok: true,
          data: {
            videoId: data.id || url,
            platform,
            title: (data.title || data.description || 'video').slice(0, 200),
            author: data.uploader || data.channel || data.creator || platform,
            thumbnail: data.thumbnail || null,
            duration,
            videoSize,
            audioSize,
          },
        };
      } catch {
        // JSON পার্স ব্যর্থ — পরের অ্যাটেম্পটে চেষ্টা করি
      }
    }
    lastError = result.stderr || lastError;
  }

  return { ok: false, error: friendlyYtDlpError(lastError) };
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

    const videoInfo = extractVideoId(rawUrl);

    // NEW: Facebook / TikTok / Instagram — yt-dlp দিয়ে ভিডিওর তথ্য আনি
    if (videoInfo.platform === 'facebook' || videoInfo.platform === 'tiktok' || videoInfo.platform === 'instagram') {
      const info = await getYtDlpMediaInfo(videoInfo.platform, videoInfo.url);
      if (!info.ok) {
        return res.status(404).json({ ok: false, error: info.error || 'ভিডিওর তথ্য পাওয়া যায়নি।' });
      }
      return res.json({ ok: true, ...info.data });
    }

    const videoId = videoInfo.platform === 'youtube' ? videoInfo.id : null;
    
    if (!videoId) {
      return res.status(400).json({ ok: false, error: 'সাপোর্টেড প্ল্যাটফর্ম: ইউটিউব, ফেসবুক, টিকটক, ইনস্টাগ্রাম। সঠিক লিঙ্ক দিন।' });
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
app.post('/api/convert-video', async (req, res, next) => {
  // FIX: ফাইল আপলোড (multipart/form-data) রিকোয়েস্ট হলে এই রাউট বাদ দিয়ে
  // নিচের ফাইল-আপলোড রাউটে (multer) পাঠাই — আগে আপলোডগুলো এখানেই
  // "লিঙ্ক আবশ্যক" এররে আটকে যেত (ফাইল-আপলোড ফিচার ভাঙা ছিল)।
  if (req.is('multipart/form-data')) return next();

  const { url, format = 'mp3', customName, bitrate } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'লিঙ্ক আবশ্যক।' });

  const videoInfo = extractVideoId(url);
  if (!videoInfo.url) return res.status(400).json({ ok: false, error: 'সঠিক লিঙ্ক পাওয়া যায়নি।' });

  const SUPPORTED_PLATFORMS = ['youtube', 'facebook', 'tiktok', 'instagram'];
  if (!SUPPORTED_PLATFORMS.includes(videoInfo.platform)) {
    return res.status(501).json({ ok: false, error: 'এই লিঙ্কটি সাপোর্টেড না। ইউটিউব, ফেসবুক, টিকটক বা ইনস্টাগ্রাম লিঙ্ক দিন।' });
  }
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  jobRegistry.set(jobId, { status: 'pending', progress: 0 });

  // Run conversion in background
  (async () => {
    try {
      jobRegistry.set(jobId, { status: 'downloading', progress: 10 });
      // 1. Fetch title (ইউটিউব: oEmbed | FB/TikTok/IG: yt-dlp ডাউনলোড থেকেই আসবে)
      let videoTitle = 'audio-track';
      if (videoInfo.platform === 'youtube') {
        try {
          const oembed = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoInfo.id}&format=json`, { signal: AbortSignal.timeout(3000) });
          if (oembed.ok) {
            const d = await oembed.json();
            if (d.title) videoTitle = d.title;
          }
        } catch {}
      }

      const targetFormat = format && format !== 'auto' ? format.toLowerCase() : 'mp3';
      const fmtDetails = getFormatDetails(targetFormat);
      const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const outputFilePath = path.join(OUTPUTS_DIR, `${fileId}${fmtDetails.ext}`);

      jobRegistry.set(jobId, { status: 'downloading', progress: 30 });
      // Fetch or reuse master audio stream (ইউটিউব = লোডার ইঞ্জিন | FB/TikTok/IG = yt-dlp)
      const masterResult =
        videoInfo.platform === 'youtube'
          ? await fetchMasterAudioForVideo(videoInfo.id!)
          : await fetchMasterAudioForYtDlp(videoInfo.platform, videoInfo.url);

      if (!masterResult.success || !masterResult.cachedPath || !fs.existsSync(masterResult.cachedPath)) {
        jobRegistry.set(jobId, {
          status: 'error',
          progress: 0,
          error: masterResult.error || `${PLATFORM_NAMES[videoInfo.platform] || ''} থেকে অডিও পাওয়া যায়নি।`,
        });
        return;
      }

      // yt-dlp থেকে টাইটেল পেলে সেটাও ব্যবহার করি
      if (masterResult.title && (!customName || customName === 'audio-track')) {
        videoTitle = masterResult.title;
      }
      const baseName = sanitizeFilename(customName || videoTitle || 'video-audio');
      const finalFilename = `${baseName}${fmtDetails.ext}`;

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

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  ffmpegProcess.on('close', async (code) => {
    try {
      if (fs.existsSync(inputFilePath)) fs.unlinkSync(inputFilePath);
    } catch {}

    // CRASH FIX: spawn fail করলে 'error' হ্যান্ডলার আগেই রেসপন্স দেয়;
    // তখন এখানে আরেকবার রেসপন্স দিলে সার্ভার ক্র্যাশ করত (ERR_HTTP_HEADERS_SENT)
    if (res.headersSent) return;

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
    if (res.headersSent) return;
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
  // RENDER FIX: NODE_ENV সেট না থাকলেও, বিল্ড করা dist ফোল্ডার থাকলে
  // প্রোডাকশন মোডে চলবে (Vite dev server চালু হবেই না → "Blocked request" এরর অসম্ভব)।
  const isProd =
    process.env.NODE_ENV === 'production' ||
    fs.existsSync(path.join(__dirname, 'dist', 'index.html'));

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

  // yt-dlp উপলব্ধ কিনা চেক (Facebook/TikTok/Instagram সাপোর্টের জন্য দরকার)
  const ytdlpProbe = await runYtDlp(['--version'], 15000);
  console.log(
    ytdlpProbe.code === 0
      ? `yt-dlp ready: v${ytdlpProbe.stdout.trim()}`
      : 'yt-dlp NOT FOUND — Facebook/TikTok/Instagram সাপোর্ট নিষ্ক্রিয় থাকবে'
  );

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

startServer();