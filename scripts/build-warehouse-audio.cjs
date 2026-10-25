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
};
const segments = [
  { name: 'engine-start', source: 'engine', start: 0.26, end: 2.66, fade: 0.012, peak: 0.76 },
  { name: 'engine-idle', source: 'engine', start: 12.8, end: 20.8, crossfade: 0.24, peak: 0.76 },
  { name: 'engine-stop', source: 'engine', start: 36.6, end: 38.25, fade: 0.02, peak: 0.76 },
  { name: 'reverse', source: 'reverse', start: 0.68, end: 1.9, crossfade: 0.015, peak: 0.76 },
  { name: 'hydraulics', source: 'hydraulics', start: 0, end: 1.5, fade: 0.012, peak: 0.76 },
];

// Original procedural effects: a geared electric motor, curtain friction and
// irregular resonant slat impacts. Fixed seeds make the bundled WAVs repeatable.
function shutterPcm(duration, closing) {
  const pcm = new Float32Array(Math.round(duration * sampleRate));
  let seed = closing ? 0x73a19d2b : 0x41f3a5c7;
  let lowNoise = 0, previousNoise = 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000 * 2 - 1; };
  const impacts = [];
  let nextImpact = 0;
  const motorHz = closing ? 57 : 63;
  for (let i = 0; i < pcm.length; i++) {
    const t = i / sampleRate;
    const noise = random();
    lowNoise += (noise - lowNoise) * 0.07;
    const friction = noise - previousNoise;
    previousNoise = noise;
    if (t >= nextImpact) {
      impacts.push({ start: t, strength: 0.55 + Math.abs(random()) * 0.45 });
      nextImpact = t + (closing ? 0.095 : 0.11) + random() * 0.023;
    }
    while (impacts.length && t - impacts[0].start > 0.13) impacts.shift();
    let rattle = 0;
    for (const impact of impacts) {
      const age = t - impact.start;
      rattle += impact.strength * Math.exp(-age * 48) * (
        Math.sin(2 * Math.PI * 830 * age) * 0.12 +
        Math.sin(2 * Math.PI * 1370 * age) * 0.085 +
        Math.sin(2 * Math.PI * 2310 * age) * 0.05 +
        Math.sin(2 * Math.PI * 3460 * age) * 0.025);
    }
    const motor = Math.sin(2 * Math.PI * motorHz * t) * 0.19 +
      Math.sin(2 * Math.PI * motorHz * 2 * t) * 0.1 +
      Math.sin(2 * Math.PI * motorHz * 4 * t) * 0.04 +
      Math.sin(2 * Math.PI * (closing ? 510 : 570) * t) * 0.024;
    const vibration = 0.84 + Math.sin(2 * Math.PI * 8 * t) * 0.16;
    pcm[i] = motor * vibration + lowNoise * 0.24 + friction * 0.026 + rattle;
  }
  return pcm;
}

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
  if (!directory) throw new Error('Supply the directory containing the three source MP3s.');
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
      let pcm = decoded[segment.source].slice(Math.round(segment.start * sampleRate), Math.round(segment.end * sampleRate));
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
        source: sources[segment.source], sourceStart: segment.start, sourceEnd: segment.end,
        duration: pcm.length / sampleRate, crossfade: segment.crossfade || 0,
        edgeFade: segment.fade || 0, frames: pcm.length, bytes: output.length,
        sha256: crypto.createHash('sha256').update(output).digest('hex'),
      };
    }
    for (const [name, duration, closing] of [['gate-open', 3.6, false], ['gate-close', 3.3, true]]) {
      let pcm = crossfadeLoop(shutterPcm(duration + 0.12, closing), 0.12);
      const maximum = pcm.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
      pcm = pcm.map(value => value * 0.7 / maximum);
      const output = encodeWav(pcm);
      fs.writeFileSync(path.join(destination, `${name}.wav`), output);
      metadata.assets[name] = {
        source: 'original-procedural', generator: 'scripts/build-warehouse-audio.cjs#shutterPcm',
        description: 'Electric roller-shutter motor, rolling metal curtain and resonant slat rattle',
        direction: closing ? 'closing' : 'opening', duration: pcm.length / sampleRate,
        crossfade: 0.12, frames: pcm.length, bytes: output.length,
        sha256: crypto.createHash('sha256').update(output).digest('hex'),
      };
    }
    fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(metadata, null, 2) + '\n');
    console.log(JSON.stringify(metadata.assets, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
