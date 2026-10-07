import lamejs from '@breezystack/lamejs';

/**
 * Encodes an AudioBuffer to a standard MP3 Blob directly in the browser
 */
export async function encodeAudioBufferToMp3(
  audioBuffer: AudioBuffer,
  onProgress?: (percent: number) => void,
  bitrate: number = 320
): Promise<Blob> {
  const channels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const kbps = bitrate;
  const mp3encoder = new lamejs.Mp3Encoder(channels, sampleRate, kbps);
  const mp3Data: Uint8Array[] = [];

  const leftChannel = audioBuffer.getChannelData(0);
  const rightChannel = channels > 1 ? audioBuffer.getChannelData(1) : leftChannel;

  const sampleCount = leftChannel.length;
  const sampleBlockSize = 1152;

  // Convert float -1.0..1.0 to 16-bit PCM integer -32768..32767
  const leftPCM = new Int16Array(sampleCount);
  const rightPCM = new Int16Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    const sL = Math.max(-1, Math.min(1, leftChannel[i]));
    leftPCM[i] = sL < 0 ? sL * 0x8000 : sL * 0x7fff;

    const sR = Math.max(-1, Math.min(1, rightChannel[i]));
    rightPCM[i] = sR < 0 ? sR * 0x8000 : sR * 0x7fff;
  }

  for (let i = 0; i < sampleCount; i += sampleBlockSize) {
    const leftChunk = leftPCM.subarray(i, i + sampleBlockSize);
    const rightChunk = rightPCM.subarray(i, i + sampleBlockSize);

    let mp3buf: Int8Array | Uint8Array;
    if (channels === 1) {
      mp3buf = mp3encoder.encodeBuffer(leftChunk);
    } else {
      mp3buf = mp3encoder.encodeBuffer(leftChunk, rightChunk);
    }

    if (mp3buf.length > 0) {
      mp3Data.push(new Uint8Array(mp3buf));
    }

    if (onProgress && i % (sampleBlockSize * 10) === 0) {
      onProgress(Math.min(95, Math.round((i / sampleCount) * 100)));
    }
  }

  const endBuf = mp3encoder.flush();
  if (endBuf.length > 0) {
    mp3Data.push(new Uint8Array(endBuf));
  }

  if (onProgress) onProgress(100);

  return new Blob(mp3Data as unknown as BlobPart[], { type: 'audio/mpeg' });
}

/**
 * Encodes an AudioBuffer to an uncompressed 16-bit PCM WAV Blob
 */
export function encodeAudioBufferToWav(audioBuffer: AudioBuffer): Blob {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  const left = audioBuffer.getChannelData(0);
  const right = numChannels > 1 ? audioBuffer.getChannelData(1) : left;
  const length = left.length * numChannels * 2 + 44;
  const out = new DataView(new ArrayBuffer(length));

  function writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  /* RIFF identifier */
  writeString(out, 0, 'RIFF');
  /* file length */
  out.setUint32(4, 36 + left.length * numChannels * 2, true);
  /* RIFF type */
  writeString(out, 8, 'WAVE');
  /* format chunk identifier */
  writeString(out, 12, 'fmt ');
  /* format chunk length */
  out.setUint32(16, 16, true);
  /* sample format (raw) */
  out.setUint16(20, format, true);
  /* channel count */
  out.setUint16(22, numChannels, true);
  /* sample rate */
  out.setUint32(24, sampleRate, true);
  /* byte rate (sample rate * block align) */
  out.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true);
  /* block align (channel count * bytes per sample) */
  out.setUint16(32, numChannels * (bitDepth / 8), true);
  /* bits per sample */
  out.setUint16(34, bitDepth, true);
  /* data chunk identifier */
  writeString(out, 36, 'data');
  /* data chunk length */
  out.setUint32(40, left.length * numChannels * 2, true);

  // Write interleaved PCM samples
  let offset = 44;
  for (let i = 0; i < left.length; i++) {
    let sL = Math.max(-1, Math.min(1, left[i]));
    out.setInt16(offset, sL < 0 ? sL * 0x8000 : sL * 0x7fff, true);
    offset += 2;

    if (numChannels > 1) {
      let sR = Math.max(-1, Math.min(1, right[i]));
      out.setInt16(offset, sR < 0 ? sR * 0x8000 : sR * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([out.buffer], { type: 'audio/wav' });
}

/**
 * Extracts and decodes audio from a video File using in-browser Web Audio API
 */
export async function decodeVideoFile(
  file: File,
  onProgress?: (stage: string, percent: number) => void
): Promise<AudioBuffer> {
  if (onProgress) onProgress('ভিডিও ফাইল পড়া হচ্ছে...', 10);
  const arrayBuffer = await file.arrayBuffer();

  if (onProgress) onProgress('অডিও ডেটা ডিকোড করা হচ্ছে...', 35);
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    if (onProgress) onProgress('ডিকোড সম্পন্ন...', 60);
    return audioBuffer;
  } finally {
    audioContext.close();
  }
}
