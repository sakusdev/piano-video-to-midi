import { clamp } from "./geometry";
import type { AudioOnset } from "./types";

export type AudioAnalysisProgress = {
  progress: number;
  stage: "decode" | "fft" | "done";
};

function fft(real: Float32Array, imaginary: Float32Array) {
  const size = real.length;
  for (let index = 1, swapIndex = 0; index < size; index += 1) {
    let bit = size >> 1;
    while (swapIndex & bit) {
      swapIndex ^= bit;
      bit >>= 1;
    }
    swapIndex ^= bit;
    if (index < swapIndex) {
      const realValue = real[index];
      real[index] = real[swapIndex];
      real[swapIndex] = realValue;
      const imaginaryValue = imaginary[index];
      imaginary[index] = imaginary[swapIndex];
      imaginary[swapIndex] = imaginaryValue;
    }
  }

  for (let length = 2; length <= size; length <<= 1) {
    const angle = -2 * Math.PI / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let unitReal = 1;
      let unitImaginary = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const even = start + offset;
        const odd = even + length / 2;
        const oddReal = real[odd] * unitReal - imaginary[odd] * unitImaginary;
        const oddImaginary = real[odd] * unitImaginary + imaginary[odd] * unitReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = unitReal * stepReal - unitImaginary * stepImaginary;
        unitImaginary = unitReal * stepImaginary + unitImaginary * stepReal;
        unitReal = nextReal;
      }
    }
  }
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function findAdaptiveOnsets(envelope: number[], hopMs: number): AudioOnset[] {
  if (envelope.length < 5) return [];
  const globalMedian = median(envelope);
  const globalMad = median(envelope.map((value) => Math.abs(value - globalMedian))) || 1e-6;
  const onsets: AudioOnset[] = [];
  let lastMs = -Infinity;
  const radius = 14;

  for (let index = 2; index < envelope.length - 2; index += 1) {
    const value = envelope[index];
    if (!(value >= envelope[index - 1] && value > envelope[index + 1])) continue;
    const localStart = Math.max(0, index - radius);
    const localEnd = Math.min(envelope.length, index + radius + 1);
    const localValues = envelope.slice(localStart, localEnd);
    const localMedian = median(localValues);
    const localMad = median(localValues.map((item) => Math.abs(item - localMedian))) || globalMad;
    const threshold = localMedian + Math.max(localMad * 2.7, globalMad * 0.72);
    if (value < threshold || value < globalMedian + globalMad * 0.58) continue;

    const ms = index * hopMs;
    if (ms - lastMs < 34) {
      const previous = onsets[onsets.length - 1];
      const strength = clamp((value - localMedian) / Math.max(localMad * 6, 1e-6), 0, 1);
      if (previous && strength > previous.strength) {
        previous.ms = ms;
        previous.strength = strength;
        lastMs = ms;
      }
      continue;
    }

    const strength = clamp((value - localMedian) / Math.max(localMad * 6, 1e-6), 0, 1);
    onsets.push({ ms, strength });
    lastMs = ms;
  }

  return onsets;
}

export async function analyzeAudioOnsets(
  file: File,
  onProgress?: (progress: AudioAnalysisProgress) => void,
  signal?: AbortSignal,
): Promise<AudioOnset[]> {
  const AudioContextClass = (window.AudioContext
    || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!AudioContextClass) return [];

  const context = new AudioContextClass();
  try {
    onProgress?.({ progress: 0, stage: "decode" });
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const sampleRate = buffer.sampleRate;
    const fftSize = 2048;
    const hopSize = 512;
    const frameCount = Math.max(0, Math.floor((buffer.length - fftSize) / hopSize));
    if (!frameCount) return [];

    const channels = Array.from(
      { length: buffer.numberOfChannels },
      (_, channel) => buffer.getChannelData(channel),
    );
    const analysisWindow = new Float32Array(fftSize);
    for (let index = 0; index < fftSize; index += 1) {
      analysisWindow[index] = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (fftSize - 1));
    }

    const real = new Float32Array(fftSize);
    const imaginary = new Float32Array(fftSize);
    const previousMagnitude = new Float32Array(fftSize / 2);
    const envelope = new Array<number>(frameCount);
    const lowBin = clamp(Math.floor(27.5 * fftSize / sampleRate), 1, fftSize / 2 - 1);
    const highBin = clamp(Math.ceil(5000 * fftSize / sampleRate), lowBin + 1, fftSize / 2 - 1);
    let previousRms = 0;

    for (let frame = 0; frame < frameCount; frame += 1) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const start = frame * hopSize;
      let energy = 0;

      for (let sample = 0; sample < fftSize; sample += 1) {
        let mixed = 0;
        for (const channel of channels) mixed += channel[start + sample] ?? 0;
        mixed /= Math.max(1, channels.length);
        energy += mixed * mixed;
        real[sample] = mixed * analysisWindow[sample];
        imaginary[sample] = 0;
      }

      fft(real, imaginary);
      let flux = 0;
      let spectralEnergy = 0;
      for (let bin = lowBin; bin <= highBin; bin += 1) {
        const magnitude = Math.log1p(Math.hypot(real[bin], imaginary[bin]));
        flux += Math.max(0, magnitude - previousMagnitude[bin]);
        spectralEnergy += magnitude;
        previousMagnitude[bin] = magnitude;
      }

      const rms = Math.sqrt(energy / fftSize);
      const rmsRise = Math.max(0, rms - previousRms);
      previousRms = previousRms * 0.7 + rms * 0.3;
      const binCount = Math.max(1, highBin - lowBin + 1);
      envelope[frame] = flux / binCount * 1.55 + rmsRise * 3.2 + rms * 0.22 + spectralEnergy / binCount * 0.01;

      if (frame % 192 === 0) {
        onProgress?.({ progress: frame / frameCount, stage: "fft" });
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }

    const hopMs = hopSize / sampleRate * 1000;
    const onsets = findAdaptiveOnsets(envelope, hopMs);
    onProgress?.({ progress: 1, stage: "done" });
    return onsets;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return [];
  } finally {
    void context.close();
  }
}
