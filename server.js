// server.ts
import express from "express";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { pipeline } from "stream/promises";
import multer from "multer";
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
var app = express();
var PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3e3;
var STORAGE_DIR = path.join(os.tmpdir(), "audio_converter_storage");
var UPLOADS_DIR = path.join(STORAGE_DIR, "uploads");
var OUTPUTS_DIR = path.join(STORAGE_DIR, "outputs");
var CACHE_DIR = path.join(STORAGE_DIR, "yt_cache");
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(OUTPUTS_DIR)) fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
setInterval(() => {
  const now = Date.now();
  const maxAge = 2 * 60 * 60 * 1e3;
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
    }
  }
}, 15 * 60 * 1e3);
var storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || ".mp4";
    cb(null, `video-${uniqueSuffix}${ext}`);
  }
});
var upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }
});
app.use(express.json());
var fileRegistry = /* @__PURE__ */ new Map();
var inFlightConversions = /* @__PURE__ */ new Map();
function getFormatDetails(format, bitrate = "320k") {
  const fmt = (format || "mp3").toLowerCase();
  const bRate = bitrate || "320k";
  switch (fmt) {
    case "aac":
    case "m4a":
      return {
        ext: ".m4a",
        mimeType: "audio/mp4",
        ffmpegArgs: ["-c:a", "aac", "-b:a", bRate, "-ar", "44100"]
      };
    case "ogg":
      return {
        ext: ".ogg",
        mimeType: "audio/ogg",
        ffmpegArgs: ["-c:a", "libvorbis", "-b:a", bRate, "-ar", "44100"]
      };
    case "wav":
      return {
        ext: ".wav",
        mimeType: "audio/wav",
        ffmpegArgs: ["-c:a", "pcm_s16le", "-ar", "44100"]
      };
    case "mp3":
    default:
      return {
        ext: ".mp3",
        mimeType: "audio/mpeg",
        ffmpegArgs: [
          "-c:a",
          "libmp3lame",
          "-b:a",
          bRate,
          "-ar",
          "44100",
          "-id3v2_version",
          "3",
          "-write_xing",
          "1"
        ]
      };
  }
}
async function analyzeMediaQuality(filePath) {
  return new Promise((resolve) => {
    const proc = spawn("/usr/bin/ffprobe", [
      "-v",
      "error",
      "-show_streams",
      "-of",
      "json",
      filePath
    ]);
    let output = "";
    proc.stdout.on("data", (d) => {
      output += d.toString();
    });
    proc.on("close", (code) => {
      if (code === 0 && output.trim()) {
        try {
          const data = JSON.parse(output);
          const streams = data.streams || [];
          const audioStream = streams.find((s) => s.codec_type === "audio");
          const videoStream = streams.find((s) => s.codec_type === "video");
          const audioBitrate = audioStream?.bit_rate ? parseInt(audioStream.bit_rate, 10) : null;
          const audioSampleRate = audioStream?.sample_rate ? parseInt(audioStream.sample_rate, 10) : null;
          const audioChannels = audioStream?.channels || null;
          const audioCodec = audioStream?.codec_name || null;
          const videoHeight = videoStream?.height || 0;
          let recommendedBitrate = "320k";
          let qualityGrade = "high";
          if (videoHeight >= 1080 || audioBitrate && audioBitrate >= 256e3) {
            recommendedBitrate = "320k";
            qualityGrade = "ultra-high";
          } else if (videoHeight >= 720 || audioBitrate && audioBitrate >= 128e3) {
            recommendedBitrate = "320k";
            qualityGrade = "high";
          } else {
            recommendedBitrate = "320k";
            qualityGrade = "high";
          }
          resolve({
            videoResolution: videoStream ? `${videoStream.width}x${videoStream.height}` : void 0,
            audioBitrate: audioBitrate || void 0,
            audioSampleRate: audioSampleRate || void 0,
            audioChannels: audioChannels || void 0,
            audioCodec: audioCodec || void 0,
            recommendedBitrate,
            qualityGrade
          });
          return;
        } catch {
        }
      }
      resolve({
        recommendedBitrate: "320k",
        qualityGrade: "high"
      });
    });
    proc.on("error", () => {
      resolve({
        recommendedBitrate: "320k",
        qualityGrade: "high"
      });
    });
  });
}
function sanitizeFilename(name) {
  if (!name) return "audio";
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "").replace(/\s+/g, " ").trim().slice(0, 100) || "audio";
}
function extractYouTubeId(url) {
  if (!url) return null;
  const trimmed = url.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  const match = trimmed.match(
    /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/|live\/|watch\?.+&v=))([\w-]{11})/i
  );
  return match ? match[1] : null;
}
var BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
async function getAudioDurationSeconds(filePath) {
  return new Promise((resolve) => {
    const proc = spawn("/usr/bin/ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath
    ]);
    let output = "";
    proc.stdout.on("data", (d) => {
      output += d.toString();
    });
    proc.on("close", (code) => {
      if (code === 0 && output.trim()) {
        const secs = parseFloat(output.trim());
        if (!isNaN(secs) && secs > 0) {
          resolve(Math.round(secs));
          return;
        }
      }
      resolve(null);
    });
    proc.on("error", () => resolve(null));
  });
}
async function transcodeAudioFile(inputAudioPath, targetFormat, outputPath, bitrate = "320k") {
  const fmtDetails = getFormatDetails(targetFormat, bitrate);
  return new Promise((resolve) => {
    const ffmpegProc = spawn("/usr/bin/ffmpeg", [
      "-i",
      inputAudioPath,
      "-vn",
      ...fmtDetails.ffmpegArgs,
      "-y",
      outputPath
    ]);
    ffmpegProc.on("close", (code) => {
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    ffmpegProc.on("error", () => resolve(false));
  });
}
async function downloadToFile(url, destPath) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "*/*"
      },
      signal: AbortSignal.timeout(18e4)
      // 3 minutes max download
    });
    if (!res.ok || !res.body) return false;
    const fileStream = fs.createWriteStream(destPath);
    await pipeline(res.body, fileStream);
    return fs.existsSync(destPath) && fs.statSync(destPath).size > 1024;
  } catch (e) {
    console.error("downloadToFile error:", e);
    return false;
  }
}
async function fetchMasterAudioForVideo(videoId) {
  const cachedMp3Path = path.join(CACHE_DIR, `${videoId}.mp3`);
  if (fs.existsSync(cachedMp3Path) && fs.statSync(cachedMp3Path).size > 1024) {
    return { success: true, cachedPath: cachedMp3Path };
  }
  if (inFlightConversions.has(videoId)) {
    return inFlightConversions.get(videoId);
  }
  const conversionPromise = (async () => {
    const fullYtUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const hosts = [
      "https://lto2.affadaffa.com",
      "https://p.savenow.to",
      "https://loader.to",
      "https://en.loader.to"
    ];
    let lastError = "\u0995\u09A8\u09AD\u09BE\u09B0\u09CD\u099F \u0987\u099E\u09CD\u099C\u09BF\u09A8 \u09A5\u09C7\u0995\u09C7 \u09B0\u09C7\u09B8\u09AA\u09A8\u09CD\u09B8 \u09AA\u09BE\u0993\u09DF\u09BE \u09AF\u09BE\u09DF\u09A8\u09BF\u0964";
    let videoTitle;
    for (const host of hosts) {
      try {
        let initData = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const initRes = await fetch(
              `${host}/ajax/download.php?button=1&start=1&end=1&format=mp3&url=${encodeURIComponent(fullYtUrl)}`,
              {
                headers: {
                  "User-Agent": BROWSER_UA,
                  Referer: `${host}/`
                },
                signal: AbortSignal.timeout(8e3)
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
        if (!initData || !initData.progress_url && !initData.download_url) continue;
        if (initData.title || initData.info?.title) {
          videoTitle = initData.title || initData.info?.title;
        }
        let directDownloadUrl = initData.download_url || null;
        if (!directDownloadUrl && initData.progress_url) {
          for (let i = 0; i < 45; i++) {
            await new Promise((r) => setTimeout(r, 1200));
            try {
              const pRes = await fetch(initData.progress_url, {
                headers: { "User-Agent": BROWSER_UA },
                signal: AbortSignal.timeout(7e3)
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
              }
            } catch {
            }
          }
        }
        if (!directDownloadUrl) continue;
        const tempDlPath = path.join(CACHE_DIR, `temp-${videoId}-${Date.now()}.mp3`);
        const dlOk = await downloadToFile(directDownloadUrl, tempDlPath);
        if (dlOk && fs.existsSync(tempDlPath) && fs.statSync(tempDlPath).size > 1024) {
          fs.renameSync(tempDlPath, cachedMp3Path);
          return { success: true, cachedPath: cachedMp3Path, title: videoTitle };
        } else {
          try {
            if (fs.existsSync(tempDlPath)) fs.unlinkSync(tempDlPath);
          } catch {
          }
        }
      } catch (err) {
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
app.get("/api/youtube-info", async (req, res) => {
  try {
    const rawUrl = req.query.url;
    if (!rawUrl) {
      return res.status(400).json({ ok: false, error: "\u0987\u0989\u099F\u09BF\u0989\u09AC \u09B2\u09BF\u0999\u09CD\u0995 \u09AA\u09CD\u09B0\u09A6\u09BE\u09A8 \u0995\u09B0\u09C1\u09A8\u0964" });
    }
    const videoId = extractYouTubeId(rawUrl);
    if (!videoId) {
      return res.status(400).json({ ok: false, error: "\u09B8\u09A0\u09BF\u0995 \u0987\u0989\u099F\u09BF\u0989\u09AC \u09B2\u09BF\u0999\u09CD\u0995 \u09AC\u09BE \u09AD\u09BF\u09A1\u09BF\u0993 \u0986\u0987\u09A1\u09BF \u09AA\u09BE\u0993\u09DF\u09BE \u09AF\u09BE\u09DF\u09A8\u09BF\u0964" });
    }
    const cachedMp3Path = path.join(CACHE_DIR, `${videoId}.mp3`);
    let cachedDuration = null;
    if (fs.existsSync(cachedMp3Path)) {
      cachedDuration = await getAudioDurationSeconds(cachedMp3Path);
    }
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const oembedRes = await fetch(oembedUrl, { signal: AbortSignal.timeout(5e3) });
    if (!oembedRes.ok) {
      return res.status(404).json({
        ok: false,
        error: "\u09AD\u09BF\u09A1\u09BF\u0993\u099F\u09BF \u09AA\u09BE\u0993\u09DF\u09BE \u09AF\u09BE\u09DF\u09A8\u09BF \u09AC\u09BE \u09AA\u09CD\u09B0\u09BE\u0987\u09AD\u09C7\u099F \u0995\u09B0\u09BE \u0986\u099B\u09C7\u0964 \u0985\u09A8\u09C1\u0997\u09CD\u09B0\u09B9 \u0995\u09B0\u09C7 \u09B2\u09BF\u0999\u09CD\u0995\u099F\u09BF \u099A\u09C7\u0995 \u0995\u09B0\u09C1\u09A8\u0964"
      });
    }
    const data = await oembedRes.json();
    let duration = null;
    let videoSize = null;
    let audioSize = null;
    if (cachedDuration && cachedDuration > 0) {
      const mins = Math.floor(cachedDuration / 60);
      const secs = cachedDuration % 60;
      duration = `${mins}:${secs < 10 ? "0" : ""}${secs}`;
      const mb = (cachedDuration * 24 / 1024).toFixed(1);
      audioSize = `${mb} MB`;
      videoSize = `~${(cachedDuration * 120 / 1024).toFixed(1)} MB`;
    } else {
      try {
        let lengthSeconds = null;
        for (const base of ["https://invidious.f5.si", "https://invidious.ducks.party"]) {
          try {
            const invRes = await fetch(`${base}/api/v1/videos/${videoId}`, { signal: AbortSignal.timeout(1800) });
            if (invRes.ok) {
              const invData = await invRes.json();
              if (invData.lengthSeconds) lengthSeconds = parseInt(invData.lengthSeconds, 10);
              const a = invData.adaptiveFormats?.find((f) => f.type?.startsWith("audio/"));
              if (a?.clen) audioSize = (parseInt(a.clen, 10) / (1024 * 1024)).toFixed(1) + " MB";
              break;
            }
          } catch {
          }
        }
        if (lengthSeconds && lengthSeconds > 0) {
          const mins = Math.floor(lengthSeconds / 60);
          const secs = lengthSeconds % 60;
          duration = `${mins}:${secs < 10 ? "0" : ""}${secs}`;
          if (!audioSize) {
            audioSize = "~" + (lengthSeconds * 24 / 1024).toFixed(1) + " MB";
          }
          videoSize = "~" + (lengthSeconds * 120 / 1024).toFixed(1) + " MB";
        }
      } catch {
      }
    }
    return res.json({
      ok: true,
      videoId,
      title: data.title || "YouTube Video",
      author: data.author_name || "YouTube Channel",
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      duration,
      videoSize,
      audioSize
    });
  } catch (error) {
    console.error("Error fetching youtube-info:", error);
    return res.status(500).json({
      ok: false,
      error: "\u09AD\u09BF\u09A1\u09BF\u0993\u09B0 \u09A4\u09A5\u09CD\u09AF \u09B2\u09CB\u09A1 \u0995\u09B0\u09A4\u09C7 \u09B8\u09AE\u09B8\u09CD\u09AF\u09BE \u09B9\u09DF\u09C7\u099B\u09C7\u0964 \u09A6\u09DF\u09BE \u0995\u09B0\u09C7 \u0986\u09AC\u09BE\u09B0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09B0\u09C1\u09A8\u0964"
    });
  }
});
app.post("/api/convert-youtube", async (req, res) => {
  const { url, format = "mp3", customName } = req.body;
  if (!url) {
    return res.status(400).json({ ok: false, error: "\u0987\u0989\u099F\u09BF\u0989\u09AC \u09B2\u09BF\u0999\u09CD\u0995 \u0986\u09AC\u09B6\u09CD\u09AF\u0995\u0964" });
  }
  const videoId = extractYouTubeId(url);
  if (!videoId) {
    return res.status(400).json({ ok: false, error: "\u09B8\u09A0\u09BF\u0995 \u0987\u0989\u099F\u09BF\u0989\u09AC \u09B2\u09BF\u0999\u09CD\u0995 \u09AA\u09BE\u0993\u09DF\u09BE \u09AF\u09BE\u09DF\u09A8\u09BF\u0964" });
  }
  try {
    let videoTitle = "youtube-audio";
    try {
      const oembed = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
        { signal: AbortSignal.timeout(3e3) }
      );
      if (oembed.ok) {
        const d = await oembed.json();
        if (d.title) videoTitle = d.title;
      }
    } catch {
    }
    const targetFormat = format && format !== "auto" ? format.toLowerCase() : "mp3";
    const fmtDetails = getFormatDetails(targetFormat);
    const baseName = sanitizeFilename(customName || videoTitle || "youtube-audio");
    const finalFilename = `${baseName}${fmtDetails.ext}`;
    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const outputFilePath = path.join(OUTPUTS_DIR, `${fileId}${fmtDetails.ext}`);
    const masterResult = await fetchMasterAudioForVideo(videoId);
    if (!masterResult.success || !masterResult.cachedPath || !fs.existsSync(masterResult.cachedPath)) {
      return res.status(500).json({
        ok: false,
        error: "\u0987\u0989\u099F\u09BF\u0989\u09AC \u09AD\u09BF\u09A1\u09BF\u0993 \u09A5\u09C7\u0995\u09C7 \u0985\u09A1\u09BF\u0993 \u09AA\u09BE\u0993\u09DF\u09BE \u09AF\u09BE\u09DF\u09A8\u09BF\u0964 \u09AD\u09BF\u09A1\u09BF\u0993\u099F\u09BF \u09B0\u09C7\u09B8\u09CD\u099F\u09CD\u09B0\u09BF\u0995\u09CD\u099F\u09C7\u09A1 \u09AC\u09BE \u09AA\u09CD\u09B0\u09BE\u0987\u09AD\u09C7\u099F \u09B9\u09A4\u09C7 \u09AA\u09BE\u09B0\u09C7\u0964"
      });
    }
    const qualityAnalysis = await analyzeMediaQuality(masterResult.cachedPath);
    const targetBitrate = qualityAnalysis.recommendedBitrate || "320k";
    const transcodeOk = await transcodeAudioFile(
      masterResult.cachedPath,
      targetFormat,
      outputFilePath,
      targetBitrate
    );
    if (!transcodeOk || !fs.existsSync(outputFilePath)) {
      return res.status(500).json({
        ok: false,
        error: "\u0985\u09A1\u09BF\u0993 \u099F\u09CD\u09B0\u09BE\u09A8\u09CD\u09B8\u0995\u09CB\u09A1\u09BF\u0982 \u09AC\u09CD\u09AF\u09B0\u09CD\u09A5 \u09B9\u09DF\u09C7\u099B\u09C7\u0964 \u0985\u09A8\u09C1\u0997\u09CD\u09B0\u09B9 \u0995\u09B0\u09C7 \u0986\u09AC\u09BE\u09B0 \u099A\u09C7\u09B7\u09CD\u099F\u09BE \u0995\u09B0\u09C1\u09A8\u0964"
      });
    }
    const stat = fs.statSync(outputFilePath);
    const exactDuration = await getAudioDurationSeconds(outputFilePath);
    const record = {
      id: fileId,
      filePath: outputFilePath,
      fileName: finalFilename,
      format: targetFormat,
      mimeType: fmtDetails.mimeType,
      fileSize: stat.size,
      duration: exactDuration || void 0,
      createdAt: Date.now()
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
      streamUrl: `/api/stream/${fileId}`
    });
  } catch (error) {
    console.error("Convert youtube error:", error);
    return res.status(500).json({ ok: false, error: error.message || "\u0995\u09A8\u09AD\u09BE\u09B0\u09CD\u099F \u09AC\u09CD\u09AF\u09B0\u09CD\u09A5 \u09B9\u09DF\u09C7\u099B\u09C7\u0964" });
  }
});
app.post("/api/convert-video", upload.single("video"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "\u09AD\u09BF\u09A1\u09BF\u0993 \u09AB\u09BE\u0987\u09B2 \u09B8\u09BF\u09B2\u09C7\u0995\u09CD\u099F \u0995\u09B0\u09C1\u09A8\u0964" });
  }
  const { format = "mp3", customName } = req.body;
  const inputFilePath = req.file.path;
  const originalBase = path.parse(req.file.originalname).name;
  const baseName = sanitizeFilename(customName || originalBase || "converted-audio");
  const targetFormat = format && format !== "auto" ? format.toLowerCase() : "mp3";
  const qualityAnalysis = await analyzeMediaQuality(inputFilePath);
  const targetBitrate = qualityAnalysis.recommendedBitrate || "320k";
  const fmtDetails = getFormatDetails(targetFormat, targetBitrate);
  const finalFilename = `${baseName}${fmtDetails.ext}`;
  const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const outputFilePath = path.join(OUTPUTS_DIR, `${fileId}${fmtDetails.ext}`);
  const ffmpegArgs = [
    "-i",
    inputFilePath,
    "-vn",
    ...fmtDetails.ffmpegArgs,
    "-y",
    outputFilePath
  ];
  const ffmpegProcess = spawn("/usr/bin/ffmpeg", ffmpegArgs);
  ffmpegProcess.on("close", async (code) => {
    try {
      if (fs.existsSync(inputFilePath)) fs.unlinkSync(inputFilePath);
    } catch {
    }
    if (code === 0 && fs.existsSync(outputFilePath)) {
      const stat = fs.statSync(outputFilePath);
      const exactDuration = await getAudioDurationSeconds(outputFilePath);
      const record = {
        id: fileId,
        filePath: outputFilePath,
        fileName: finalFilename,
        format: targetFormat,
        mimeType: fmtDetails.mimeType,
        fileSize: stat.size,
        duration: exactDuration || void 0,
        createdAt: Date.now()
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
        streamUrl: `/api/stream/${fileId}`
      });
    } else {
      return res.status(500).json({
        ok: false,
        error: "\u09AD\u09BF\u09A1\u09BF\u0993 \u0995\u09A8\u09AD\u09BE\u09B0\u09CD\u099F \u0995\u09B0\u09A4\u09C7 \u09B8\u09AE\u09B8\u09CD\u09AF\u09BE \u09B9\u09DF\u09C7\u099B\u09C7\u0964 \u09B8\u09A0\u09BF\u0995 \u09AD\u09BF\u09A1\u09BF\u0993 \u09AB\u09B0\u09AE\u09CD\u09AF\u09BE\u099F \u09A6\u09BF\u09A8\u0964"
      });
    }
  });
  ffmpegProcess.on("error", (err) => {
    try {
      if (fs.existsSync(inputFilePath)) fs.unlinkSync(inputFilePath);
    } catch {
    }
    return res.status(500).json({
      ok: false,
      error: "\u0995\u09A8\u09AD\u09BE\u09B0\u09CD\u09B8\u09A8 \u09AA\u09CD\u09B0\u09B8\u09C7\u09B8 \u09B6\u09C1\u09B0\u09C1 \u0995\u09B0\u09BE \u09AF\u09BE\u09DF\u09A8\u09BF: " + err.message
    });
  });
});
app.get("/api/download/:fileId", (req, res) => {
  const { fileId } = req.params;
  const record = fileRegistry.get(fileId);
  if (!record || !fs.existsSync(record.filePath)) {
    return res.status(404).send("\u0985\u09A1\u09BF\u0993 \u09AB\u09BE\u0987\u09B2\u099F\u09BF \u09AA\u09BE\u0993\u09DF\u09BE \u09AF\u09BE\u09DF\u09A8\u09BF \u09AC\u09BE \u09AE\u09C7\u09AF\u09BC\u09BE\u09A6 \u0989\u09A4\u09CD\u09A4\u09C0\u09B0\u09CD\u09A3 \u09B9\u09AF\u09BC\u09C7\u099B\u09C7\u0964");
  }
  const stat = fs.statSync(record.filePath);
  res.setHeader("Content-Type", record.mimeType);
  res.setHeader("Content-Length", stat.size);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(record.fileName)}"; filename*=UTF-8''${encodeURIComponent(record.fileName)}`
  );
  res.setHeader("Cache-Control", "public, max-age=3600");
  const stream = fs.createReadStream(record.filePath);
  stream.pipe(res);
});
app.get("/api/stream/:fileId", (req, res) => {
  const { fileId } = req.params;
  const record = fileRegistry.get(fileId);
  if (!record || !fs.existsSync(record.filePath)) {
    return res.status(404).send("\u0985\u09A1\u09BF\u0993 \u09AB\u09BE\u0987\u09B2\u099F\u09BF \u09AA\u09BE\u0993\u09DF\u09BE \u09AF\u09BE\u09DF\u09A8\u09BF\u0964");
  }
  const stat = fs.statSync(record.filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = end - start + 1;
    const file = fs.createReadStream(record.filePath, { start, end });
    const head = {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunksize,
      "Content-Type": record.mimeType
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      "Content-Length": fileSize,
      "Content-Type": record.mimeType,
      "Accept-Ranges": "bytes"
    };
    res.writeHead(200, head);
    fs.createReadStream(record.filePath).pipe(res);
  }
});
async function startServer() {
  const isProd = process.env.NODE_ENV === "production";
  if (!isProd) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
    app.use("*", async (req, res, next) => {
      const url = req.originalUrl;
      try {
        let template = fs.readFileSync(path.resolve(__dirname, "index.html"), "utf-8");
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ "Content-Type": "text/html" }).end(template);
      } catch (e) {
        vite.ssrFixStacktrace(e);
        next(e);
      }
    });
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on port ${PORT}`);
  });
}
startServer();
