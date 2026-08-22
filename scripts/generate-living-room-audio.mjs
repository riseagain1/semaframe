import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const sampleRate = 48_000;
const channels = 2;
const durationSeconds = 40;
const output = resolve("video/public/audio/semaframe-living-room-demo.wav");
const samples = new Float32Array(sampleRate * durationSeconds * channels);

const chords = [
  [110, 138.59, 164.81],
  [130.81, 164.81, 196],
  [98, 123.47, 164.81],
  [116.54, 146.83, 174.61],
];

const assemblyHits = [5.3, 6.1, 7.2, 8.8, 10.1, 11.5, 12.9, 14.1];

function decayTone(time, start, frequency, decay, gain) {
  const offset = time - start;
  if (offset < 0 || offset > 1.4) return 0;
  return Math.sin(Math.PI * 2 * frequency * offset) * Math.exp(-offset * decay) * gain;
}

function deterministicNoise(frame) {
  const value = Math.sin(frame * 12.9898 + 78.233) * 43_758.5453;
  return (value - Math.floor(value)) * 2 - 1;
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
    buffer.writeInt16LE(Math.round(value * 32767), 44 + index * bytesPerSample);
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, buffer);
}

for (let frame = 0; frame < sampleRate * durationSeconds; frame += 1) {
  const time = frame / sampleRate;
  const chord = chords[Math.floor(time / 5) % chords.length];
  const fadeIn = Math.min(1, time / 1.2);
  const fadeOut = Math.min(1, (durationSeconds - time) / 2.3);
  const master = Math.max(0, Math.min(fadeIn, fadeOut));
  let left = 0;
  let right = 0;

  chord.forEach((frequency, index) => {
    const phase = index * 0.64;
    const body = Math.sin(Math.PI * 2 * frequency * time + phase);
    const air = Math.sin(Math.PI * 2 * frequency * 2 * time + phase * 0.8) * 0.14;
    left += (body + air) * (0.048 - index * 0.005);
    right += (body + air) * (0.043 + index * 0.003);
  });

  const beatOffset = time % 0.5;
  const kick = beatOffset < 0.11
    ? Math.sin(Math.PI * 2 * (58 - beatOffset * 115) * beatOffset) * Math.exp(-beatOffset * 31) * 0.075
    : 0;
  let construction = 0;
  for (const hit of assemblyHits) construction += decayTone(time, hit, 690, 28, 0.045);

  const collisionOffset = time - 19.2;
  const collision = collisionOffset >= 0 && collisionOffset < 0.85
    ? Math.sin(Math.PI * 2 * (330 - collisionOffset * 180) * collisionOffset)
      * Math.sin(Math.PI * Math.min(1, collisionOffset / 0.85)) * 0.14
    : 0;
  const stopNoise = collisionOffset >= 0 && collisionOffset < 0.18
    ? deterministicNoise(frame) * Math.exp(-collisionOffset * 24) * 0.05
    : 0;

  const success = decayTone(time, 23.5, 440, 4.5, 0.08)
    + decayTone(time, 23.68, 659.25, 4.1, 0.07);
  const click = decayTone(time, 29.3, 1_150, 42, 0.085);
  const powerOffset = time - 29.35;
  const power = powerOffset >= 0 && powerOffset < 1.2
    ? Math.sin(Math.PI * 2 * (120 + powerOffset * 390) * powerOffset)
      * Math.sin(Math.PI * powerOffset / 1.2) * 0.055
    : 0;
  const undo = decayTone(time, 33.0, 520, 22, 0.04);
  const redo = decayTone(time, 34.7, 780, 20, 0.045);
  const finaleOffset = Math.max(0, time - 36);
  const finale = finaleOffset > 0
    ? Math.sin(Math.PI * 2 * 220 * time) * Math.min(1, finaleOffset / 2) * 0.012
    : 0;

  const shared = kick + construction + collision + stopNoise + success + click + power + undo + redo + finale;
  samples[frame * 2] = (left + shared) * master;
  samples[frame * 2 + 1] = (right + shared * 0.92) * master;
}

writeWav(samples);
console.log(`Generated SemaFrame living-room demo score: ${output}`);
