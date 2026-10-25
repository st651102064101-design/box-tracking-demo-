/* Run with PLAYWRIGHT_PACKAGE set to an installed Playwright package path.
 * Usage: node scripts/build-warehouse-audio.cjs <directory containing source MP3s>
 * Chrome performs MP3 decoding/resampling; no external encoder is required.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const sampleRate = 22050;
const sources = {
  engine: 'freesound_community-forklift-62407.mp3',
  reverse: 'forza1903-forkliftin-ilerigeri-hareket-sesi-328411.mp3',
  hydraulics: 'freesound_community-hydraulics-87154.mp3',
  gate: 'door-open-by-freesound-community-royalty-free-music-827701.mp3',
};
const segments = [
  { name: 'engine-start', source: 'engine', start: 0.26, end: 2.66, fade: 0.012, peak: 0.76 },
  { name: 'engine-idle', source: 'engine', start: 12.8, end: 20.8, crossfade: 0.24, peak: 0.76 },
  { name: 'engine-stop', source: 'engine', start: 36.6, end: 38.25, fade: 0.02, peak: 0.76 },
  { name: 'reverse', source: 'reverse', start: 0.68, end: 1.9, crossfade: 0.015, peak: 0.76 },
  { name: 'hydraulics', source: 'hydraulics', start: 0, end: 1.5, fade: 0.012, peak: 0.76 },
  // Use the complete supplied recording for both directions at its natural speed.
  { name: 'gate-open', source: 'gate', start: 0, fade: 0.012, peak: 0.7 },
  { name: 'gate-close', source: 'gate', start: 0, fade: 0.012, peak: 0.7 },
];

function crossfadeLoop(pcm, seconds) {
  const overlap = Math.round(seconds * sampleRate);
  const output = new Float32Array(pcm.length - overlap);
  output.set(pcm.subarray(overlap, pcm.length - overlap));
  for (let i = 0; i < overlap; i++) {
    const angle = i / (overlap - 1) * Math.PI / 2;
    output[pcm.length - 2 * overlap + i] = pcm[pcm.length - overlap + i] * Math.cos(angle) + pcm[i] * Math.sin(angle);
  }
  return output;
}

function encodeWav(pcm) {
  const result = Buffer.alloc(44 + pcm.length * 2);
  result.write('RIFF', 0); result.writeUInt32LE(result.length - 8, 4);
  result.write('WAVEfmt ', 8); result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24); result.writeUInt32LE(sampleRate * 2, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34);
  result.write('data', 36); result.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) result.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
  return result;
}

(async () => {
  const directory = process.argv[2];
  if (!directory) throw new Error('Supply the directory containing the four source MP3s.');
  const destination = path.resolve(__dirname, '../frontend/public/audio/warehouse');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const decoded = {};
  const metadata = { sampleRate, channels: 1, bitsPerSample: 16, sources: {}, assets: {} };
  try {
    const page = await browser.newPage();
    for (const [key, filename] of Object.entries(sources)) {
      const input = fs.readFileSync(path.join(directory, filename));
      const result = await page.evaluate(async ({ base64, sampleRate }) => {
        const context = new OfflineAudioContext(1, 1, sampleRate);
        const buffer = await context.decodeAudioData(Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer);
        const pcm = new Float32Array(buffer.length);
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
          const source = buffer.getChannelData(channel);
          for (let i = 0; i < pcm.length; i++) pcm[i] += source[i] / buffer.numberOfChannels;
        }
        const bytes = new Uint8Array(pcm.buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
        return { pcm: btoa(binary), duration: buffer.duration, sourceChannels: buffer.numberOfChannels };
      }, { base64: input.toString('base64'), sampleRate });
      const bytes = Buffer.from(result.pcm, 'base64');
      decoded[key] = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      metadata.sources[key] = { filename, sha256: crypto.createHash('sha256').update(input).digest('hex'), duration: result.duration, channels: result.sourceChannels };
    }
    fs.mkdirSync(destination, { recursive: true });
    for (const segment of segments) {
      const sourceEnd = segment.end ?? decoded[segment.source].length / sampleRate;
      let pcm = decoded[segment.source].slice(Math.round(segment.start * sampleRate), Math.round(sourceEnd * sampleRate));
      const mean = pcm.reduce((sum, value) => sum + value, 0) / pcm.length;
      pcm = pcm.map(value => value - mean);
      if (segment.crossfade) {
        pcm = crossfadeLoop(pcm, segment.crossfade);
      } else {
        const fade = Math.round(segment.fade * sampleRate);
        for (let i = 0; i < fade; i++) {
          const amount = i / (fade - 1);
          pcm[i] *= amount;
          pcm[pcm.length - 1 - i] *= amount;
        }
      }
      const maximum = pcm.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
      pcm = pcm.map(value => value * segment.peak / maximum);
      const output = encodeWav(pcm);
      fs.writeFileSync(path.join(destination, `${segment.name}.wav`), output);
      metadata.assets[segment.name] = {
        source: sources[segment.source], sourceStart: segment.start, sourceEnd,
        duration: pcm.length / sampleRate, crossfade: segment.crossfade || 0,
        edgeFade: segment.fade || 0, frames: pcm.length, bytes: output.length,
        sha256: crypto.createHash('sha256').update(output).digest('hex'),
      };
    }
    fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(metadata, null, 2) + '\n');
    console.log(JSON.stringify(metadata.assets, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
