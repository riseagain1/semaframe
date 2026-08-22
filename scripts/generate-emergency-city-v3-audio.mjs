import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const sampleRate = 48_000;
const channels = 2;
const contractPath = resolve("video/emergency-city-v3.visual-contract.json");
const contract = JSON.parse(readFileSync(contractPath, "utf8"));

if (contract.version !== "3.0" || contract.silentFirst !== true
  || contract.audioRequiredForComprehension !== false) {
  throw new Error("The V3 score requires the frozen silent-first visual contract.");
}

const outputPaths = {
  landscape: resolve("video/public/audio/semaframe-emergency-city-v3.wav"),
  vertical: resolve("video/public/audio/semaframe-emergency-city-v3-vertical.wav"),
};

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

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const smoothstep = (value) => {
  const bounded = clamp01(value);
  return bounded * bounded * (3 - 2 * bounded);
};
const deterministicNoise = (frame, seed = 0) => {
  const value = Math.sin((frame + seed * 1_013) * 12.9898 + 45.173) * 43_758.5453;
  return (value - Math.floor(value)) * 2 - 1;
};

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

function sineSweep(time, start, duration, fromHz, toHz, gain) {
  const offset = time - start;
  if (offset < 0 || offset >= duration) return 0;
  const progress = offset / duration;
  const frequency = fromHz + (toHz - fromHz) * progress;
  const envelope = Math.sin(Math.PI * progress);
  return Math.sin(Math.PI * 2 * frequency * offset) * envelope * gain;
}

function writeWav(path, interleaved) {
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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buffer);
}

function generateVariant(variantName) {
  const variant = contract.variants?.[variantName];
  if (!variant || variant.fps !== 30 || !Number.isInteger(variant.durationFrames)) {
    throw new Error(`Missing valid ${variantName} V3 contract.`);
  }
  const beatTime = new Map(contract.comprehensionBeats.map((beat) => {
    const range = beat.ranges?.[variantName];
    if (!range) throw new Error(`Beat ${beat.id} has no ${variantName} range.`);
    return [beat.id, {
      start: range.startFrame / variant.fps,
      end: range.endFrame / variant.fps,
      center: (range.startFrame + range.endFrame) / (variant.fps * 2),
    }];
  }));
  const cue = (id) => {
    const range = beatTime.get(id);
    if (!range) throw new Error(`Missing audio cue beat ${id}.`);
    return range;
  };

  const durationSeconds = variant.durationFrames / variant.fps;
  const releaseAt = cue("response").start;
  const samples = new Float32Array(sampleRate * durationSeconds * channels);
  let rawPeak = 0;

  for (let frame = 0; frame < sampleRate * durationSeconds; frame += 1) {
    const time = frame / sampleRate;
    const released = time >= releaseAt;
    const progression = released ? releaseChords : tensionChords;
    const progressionTime = released ? time - releaseAt : time;
    const chord = progression[Math.floor(progressionTime / 2.6) % progression.length];
    const masterFade = Math.min(
      smoothstep(time / 0.25),
      smoothstep((durationSeconds - time) / 1.05),
    );
    const responseLift = released ? 1.13 : 0.8;

    let left = 0;
    let right = 0;
    chord.forEach((frequency, index) => {
      const phase = index * 0.69;
      const motion = Math.sin(time * (0.3 + index * 0.04) + phase) * 0.055;
      const base = Math.sin(Math.PI * 2 * frequency * time + phase + motion);
      const octave = Math.sin(Math.PI * 4 * frequency * time + phase * 0.82) * 0.14;
      const padGain = (0.054 - index * 0.006) * responseLift;
      left += (base + octave) * padGain * (1.02 - index * 0.07);
      right += (base + octave) * padGain * (0.84 + index * 0.1);
    });

    const pulseLength = released ? 0.46 : 0.6;
    const pulseOffset = time % pulseLength;
    const pulse = pulseOffset < 0.12
      ? Math.sin(Math.PI * 2 * (62 - pulseOffset * 150) * pulseOffset)
        * Math.exp(-pulseOffset * 28) * (released ? 0.12 : 0.075)
      : 0;

    const crisis = cue("crisis");
    const crisisWindow = clamp01((time - crisis.start) / 0.2) * clamp01((crisis.end - time) / 0.3);
    const heartbeat = [crisis.start + 0.32, crisis.start + 1.25].reduce(
      (sum, start) => sum + expTone(time, start, 58, 20, 0.17)
        + expTone(time, start + 0.14, 48, 23, 0.11),
      0,
    );
    const openingSiren = crisisWindow
      * Math.sin(Math.PI * 2 * (470 + Math.sin(time * Math.PI * 0.86) * 60) * time) * 0.018;

    const spatial = cue("spatial_read");
    const dataRead = [0, 0.22, 0.48].reduce(
      (sum, offset, index) => sum + expTone(time, spatial.start + 0.28 + offset, 680 + index * 250, 6.3, 0.07 - index * 0.008),
      0,
    );

    const collision = cue("collision_rejection");
    const reject = sineSweep(time, collision.start + 0.38, 0.82, 390, 110, 0.2)
      + noiseBurst(time, collision.start + 0.38, 0.18, 0.11, frame, 17)
      + expTone(time, collision.start + 1.05, 205, 5.8, 0.07);

    const safePlan = cue("safe_plan");
    const validations = [0, 1, 2, 3, 4].reduce(
      (sum, index) => sum + expTone(time, safePlan.start + 0.3 + index * 0.24, 520 + index * 130, 6.4, 0.075),
      0,
    );
    const planLift = sineSweep(time, safePlan.start + 0.25, Math.max(0.8, safePlan.end - safePlan.start - 0.35), 170, 480, 0.05);

    const confirm = cue("human_confirm");
    const confirmClickAt = confirm.end - 8 / variant.fps;
    const click = expTone(time, confirmClickAt, 1_280, 45, 0.23)
      + noiseBurst(time, confirmClickAt, 0.07, 0.1, frame, 31);

    const response = cue("response");
    const responseSpan = Math.max(2.8, response.end - response.start);
    const moves = [0.08, 0.25, 0.43, 0.61].reduce((sum, ratio, index) => {
      const start = response.start + responseSpan * ratio;
      return sum + sineSweep(time, start, 0.68, 105 + index * 14, 410 + index * 38, 0.09)
        + noiseBurst(time, start, 0.48, 0.026, frame, 43 + index);
    }, 0);
    const signalAt = response.start + responseSpan * 0.49;
    const signal = expTone(time, signalAt, 660, 4.3, 0.1)
      + expTone(time, signalAt + 0.16, 990, 4.3, 0.09)
      + expTone(time, signalAt + 0.32, 1_320, 4.3, 0.07);
    const ambulanceStart = response.start + responseSpan * 0.48;
    const ambulanceEnd = response.end - 0.15;
    const ambulanceWindow = clamp01((time - ambulanceStart) / 0.55)
      * clamp01((ambulanceEnd - time) / 0.58);
    const ambulance = ambulanceWindow
      * Math.sin(Math.PI * 2 * (610 + Math.sin((time - ambulanceStart) * Math.PI * 1.28) * 90) * time)
      * 0.047;

    const resolution = cue("resolution");
    const success = expTone(time, resolution.start + 0.18, 440, 2.9, 0.12)
      + expTone(time, resolution.start + 0.36, 659.25, 2.8, 0.11)
      + expTone(time, resolution.start + 0.58, 880, 2.7, 0.09);

    const editability = cue("editability");
    const undo = sineSweep(time, editability.start + 0.2, 0.55, 760, 130, 0.09);
    const redo = sineSweep(time, editability.start + 0.92, 0.55, 140, 800, 0.1)
      + expTone(time, editability.start + 1.18, 1_020, 6.4, 0.07);
    const save = expTone(time, editability.end - 0.62, 760, 7.2, 0.075)
      + expTone(time, editability.end - 0.42, 1_020, 7.4, 0.065);

    const identity = cue("identity");
    const finalLift = time >= identity.start
      ? Math.sin(Math.PI * 2 * 220 * time) * smoothstep((time - identity.start) / 1.1) * 0.022
      : 0;

    const shared = pulse + heartbeat + openingSiren + dataRead + reject + validations
      + planLift + click + moves + signal + ambulance + success + undo + redo + save + finalLift;
    left = (left + shared) * masterFade;
    right = (right + shared * 0.92) * masterFade;
    samples[frame * 2] = left;
    samples[frame * 2 + 1] = right;
    rawPeak = Math.max(rawPeak, Math.abs(left), Math.abs(right));
  }

  const targetPeak = 0.5;
  const normalization = rawPeak > 0 ? targetPeak / rawPeak : 1;
  for (let index = 0; index < samples.length; index += 1) samples[index] *= normalization;
  const output = outputPaths[variantName];
  writeWav(output, samples);
  return { variant: variantName, output, durationSeconds, sampleRate, channels, sourcePeakDbfs: 20 * Math.log10(targetPeak) };
}

const results = [generateVariant("landscape"), generateVariant("vertical")];
process.stdout.write(`${JSON.stringify({ silentFirst: true, narration: false, results }, null, 2)}\n`);
