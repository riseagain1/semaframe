import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const sampleRate = 48_000;
const channels = 2;
const durationSeconds = 37;
const output = resolve("video/public/audio/semaframe-emergency-city-hero.wav");
const samples = new Float32Array(sampleRate * durationSeconds * channels);

const tensionChords = [
  [82.41, 110, 130.81],
  [73.42, 98, 123.47],
  [87.31, 116.54, 138.59],
  [77.78, 103.83, 130.81],
];
const releaseChords = [
  [98, 123.47, 146.83],
  [110, 138.59, 164.81],
  [116.54, 146.83, 174.61],
  [130.81, 164.81, 196],
];

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(value) {
  const bounded = clamp01(value);
  return bounded * bounded * (3 - 2 * bounded);
}

function deterministicNoise(frame, seed = 0) {
  const value = Math.sin((frame + seed * 1_013) * 12.9898 + 45.173) * 43_758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

function expTone(time, start, frequency, decay, gain, phase = 0) {
  const offset = time - start;
  if (offset < 0 || offset > 2.2) return 0;
  return Math.sin(Math.PI * 2 * frequency * offset + phase) * Math.exp(-offset * decay) * gain;
}

function noiseBurst(time, start, duration, gain, frame, seed) {
  const offset = time - start;
  if (offset < 0 || offset >= duration) return 0;
  const envelope = Math.sin(Math.PI * offset / duration) * Math.exp(-offset * 3.2);
  return deterministicNoise(frame, seed) * envelope * gain;
}

function sineSweep(time, start, duration, fromHz, toHz, gain, reverse = false) {
  const offset = time - start;
  if (offset < 0 || offset >= duration) return 0;
  const progress = offset / duration;
  const shaped = reverse ? 1 - progress : progress;
  const frequency = fromHz + (toHz - fromHz) * shaped;
  const envelope = Math.sin(Math.PI * progress);
  return Math.sin(Math.PI * 2 * frequency * offset) * envelope * gain;
}

function sectionGain(time) {
  if (time < 4) return 0.84;
  if (time < 6) return 0.5;
  if (time < 9) return 0.68;
  if (time < 13) return 0.88;
  if (time < 16) return 0.78 + smoothstep((time - 13) / 3) * 0.25;
  if (time < 26) return 1.22;
  if (time < 29) return 0.74;
  if (time < 32) return 0.62;
  return 0.88 + smoothstep((time - 32) / 4) * 0.2;
}

function writeWav(interleaved) {
  const bytesPerSample = 2;
  const dataSize = interleaved.length * bytesPerSample;
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
  for (let index = 0; index < interleaved.length; index += 1) {
    const value = Math.max(-1, Math.min(1, interleaved[index]));
    buffer.writeInt16LE(Math.round(value * 32_767), 44 + index * bytesPerSample);
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, buffer);
}

let rawPeak = 0;
for (let frame = 0; frame < sampleRate * durationSeconds; frame += 1) {
  const time = frame / sampleRate;
  const released = time >= 17.5;
  const progression = released ? releaseChords : tensionChords;
  const progressionTime = released ? time - 17.5 : time;
  const chord = progression[Math.floor(progressionTime / 3.2) % progression.length];
  const gain = sectionGain(time);
  const masterFade = Math.min(
    smoothstep(time / 0.28),
    smoothstep((durationSeconds - time) / 1.3),
  );
  const preClickDip = time >= 17.05 && time < 17.5
    ? 1 - smoothstep((time - 17.05) / 0.45) * 0.76
    : 1;

  let left = 0;
  let right = 0;
  chord.forEach((frequency, index) => {
    const phase = index * 0.69;
    const slowMotion = Math.sin(time * (0.31 + index * 0.04) + phase) * 0.06;
    const base = Math.sin(Math.PI * 2 * frequency * time + phase + slowMotion);
    const octave = Math.sin(Math.PI * 2 * frequency * 2 * time + phase * 0.82) * 0.16;
    const padGain = (0.066 - index * 0.007) * gain;
    left += (base + octave) * padGain * (1.03 - index * 0.08);
    right += (base + octave) * padGain * (0.82 + index * 0.12);
  });

  const pulseLength = released ? 0.46 : 0.58;
  const pulseOffset = time % pulseLength;
  const kick = pulseOffset < 0.13
    ? Math.sin(Math.PI * 2 * (61 - pulseOffset * 145) * pulseOffset)
      * Math.exp(-pulseOffset * 27)
      * (released ? 0.13 : 0.085)
    : 0;
  const tickOffset = (time + pulseLength / 2) % pulseLength;
  const tick = tickOffset < 0.045
    ? Math.sin(Math.PI * 2 * 1_020 * tickOffset)
      * Math.exp(-tickOffset * 78)
      * (time < 16 ? 0.025 : 0.018)
    : 0;

  const heartbeat = [0.42, 1.34, 2.26, 3.18].reduce(
    (sum, start) => sum
      + expTone(time, start, 58, 20, 0.18)
      + expTone(time, start + 0.14, 48, 23, 0.12),
    0,
  );
  const openingSiren = time < 4
    ? Math.sin(Math.PI * 2 * (468 + Math.sin(time * Math.PI * 0.82) * 62) * time) * 0.022
    : 0;
  const dataRead = expTone(time, 6.38, 720, 6.2, 0.075)
    + expTone(time, 6.58, 960, 6.4, 0.062)
    + expTone(time, 7.16, 1_180, 7.2, 0.048);
  const collision = sineSweep(time, 10.82, 0.95, 390, 118, 0.22, true)
    + noiseBurst(time, 10.82, 0.2, 0.12, frame, 17);
  const rejection = expTone(time, 11.62, 212, 5.6, 0.08);
  const plan = expTone(time, 13.25, 520, 5.7, 0.085)
    + expTone(time, 13.48, 780, 5.5, 0.078)
    + expTone(time, 14.14, 1_040, 6.5, 0.064)
    + sineSweep(time, 14.2, 1.65, 180, 510, 0.068);
  const click = expTone(time, 17.5, 1_280, 45, 0.25)
    + noiseBurst(time, 17.5, 0.075, 0.11, frame, 31);
  const vehicleMoves = [17.85, 18.55, 19.24, 19.86].reduce(
    (sum, start, index) => sum
      + sineSweep(time, start, 0.78, 105 + index * 14, 420 + index * 35, 0.105)
      + noiseBurst(time, start, 0.58, 0.035, frame, 43 + index),
    0,
  );
  const signalChange = expTone(time, 20.42, 660, 4.2, 0.11)
    + expTone(time, 20.59, 990, 4.2, 0.1)
    + expTone(time, 20.77, 1_320, 4.2, 0.08);
  const ambulanceWindow = clamp01((time - 20.95) / 0.7) * clamp01((25.65 - time) / 0.75);
  const ambulanceSiren = ambulanceWindow
    * Math.sin(Math.PI * 2 * (610 + Math.sin((time - 20.95) * Math.PI * 1.32) * 92) * time)
    * 0.062;
  const roadRush = ambulanceWindow * deterministicNoise(frame, 71) * 0.018;
  const success = expTone(time, 24.82, 440, 2.9, 0.13)
    + expTone(time, 25.02, 659.25, 2.8, 0.12)
    + expTone(time, 25.24, 880, 2.7, 0.105)
    + expTone(time, 25.46, 1_100, 2.6, 0.072);
  const undo = sineSweep(time, 26.3, 0.82, 780, 115, 0.12, true)
    + noiseBurst(time, 26.3, 0.62, 0.035, frame, 89);
  const redo = sineSweep(time, 27.72, 0.78, 140, 820, 0.12)
    + expTone(time, 28.02, 1_020, 6.4, 0.085);
  const save = expTone(time, 29.25, 860, 10, 0.085);
  const reopen = expTone(time, 30.55, 520, 4.8, 0.085)
    + expTone(time, 30.73, 780, 4.6, 0.082)
    + expTone(time, 30.92, 1_040, 4.4, 0.075);
  const finalLift = time >= 32
    ? Math.sin(Math.PI * 2 * 220 * time) * smoothstep((time - 32) / 2.2) * 0.025
    : 0;

  const shared = kick + tick + heartbeat + openingSiren + dataRead + collision
    + rejection + plan + click + vehicleMoves + signalChange + ambulanceSiren
    + roadRush + success + undo + redo + save + reopen + finalLift;
  left = (left * preClickDip + shared) * masterFade;
  right = (right * preClickDip + shared * 0.91) * masterFade;

  samples[frame * 2] = left;
  samples[frame * 2 + 1] = right;
  rawPeak = Math.max(rawPeak, Math.abs(left), Math.abs(right));
}

const targetPeak = 0.5;
const normalization = rawPeak > 0 ? targetPeak / rawPeak : 1;
for (let index = 0; index < samples.length; index += 1) {
  samples[index] *= normalization;
}

writeWav(samples);
console.log(`Generated SemaFrame emergency-city V2 score: ${output}`);
console.log(JSON.stringify({
  durationSeconds,
  sampleRate,
  channels,
  sourcePeakLinear: targetPeak,
  sourcePeakDbfs: 20 * Math.log10(targetPeak),
}, null, 2));
