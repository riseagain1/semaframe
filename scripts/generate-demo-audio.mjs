import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const sampleRate = 48_000;
const channels = 2;
const durationSeconds = 78;
const frameCount = sampleRate * durationSeconds;
const output = resolve("video/public/audio/semaframe-original-bed.wav");

function writeWav(samples) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + index * 2);
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, buffer);
}

const chordProgression = [
  [110, 138.59, 164.81],
  [98, 123.47, 146.83],
  [82.41, 110, 138.59],
  [92.5, 116.54, 146.83],
];
const samples = new Float32Array(frameCount * channels);

for (let frame = 0; frame < frameCount; frame += 1) {
  const time = frame / sampleRate;
  const chord = chordProgression[Math.floor(time / 8) % chordProgression.length];
  const fadeIn = Math.min(1, time / 2.2);
  const fadeOut = Math.min(1, (durationSeconds - time) / 3.5);
  const master = Math.max(0, Math.min(fadeIn, fadeOut));
  const slowPulse = 0.76 + 0.24 * Math.sin(time * Math.PI / 2);
  let padLeft = 0;
  let padRight = 0;
  chord.forEach((frequency, index) => {
    const phase = index * 0.75;
    const base = Math.sin(2 * Math.PI * frequency * time + phase);
    const harmonic = Math.sin(2 * Math.PI * frequency * 2 * time + phase * 0.7) * 0.16;
    padLeft += (base + harmonic) * (0.052 - index * 0.006);
    padRight += (base + harmonic) * (0.045 + index * 0.004);
  });
  const beatPhase = time % 0.5;
  const kick = beatPhase < 0.12
    ? Math.sin(2 * Math.PI * (54 - beatPhase * 120) * beatPhase) * Math.exp(-beatPhase * 32) * 0.09
    : 0;
  const tickPhase = (time + 0.25) % 1;
  const tick = tickPhase < 0.045
    ? Math.sin(2 * Math.PI * 880 * tickPhase) * Math.exp(-tickPhase * 85) * 0.018
    : 0;
  const shimmerWindow = time % 4;
  const shimmer = shimmerWindow < 1.4
    ? Math.sin(2 * Math.PI * 440 * time) * Math.sin(Math.PI * shimmerWindow / 1.4) * 0.008
    : 0;
  samples[frame * 2] = (padLeft * slowPulse + kick + tick + shimmer) * master;
  samples[frame * 2 + 1] = (padRight * slowPulse + kick * 0.92 + tick * 0.72 - shimmer) * master;
}

writeWav(samples);
mkdirSync(resolve("video/public/brand"), { recursive: true });
copyFileSync(resolve("public/semaframe-mark.svg"), resolve("video/public/brand/semaframe-mark.svg"));
copyFileSync(resolve("public/semaframe-lockup.svg"), resolve("video/public/brand/semaframe-lockup.svg"));
console.log(`Generated original SemaFrame demo score: ${output}`);
