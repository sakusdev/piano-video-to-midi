/// <reference lib="webworker" />

import type { AudioOnset } from "../engine/types";

type AnalyzeMessage = {
  kind: "analyze";
  id: number;
  samples: Float32Array;
  sampleRate: number;
  wasmModuleUrl: string;
};

type CancelMessage = {
  kind: "cancel";
  id: number;
};

type WorkerRequest = AnalyzeMessage | CancelMessage;

type WasmAudioModule = {
  default: (input?: unknown) => Promise<unknown>;
  analyze_audio_onsets: (
    samples: Float32Array,
    sampleRate: number,
    fftSize: number,
    hopSize: number,
  ) => Float64Array;
};

type ProgressResponse = {
  kind: "progress";
  id: number;
  progress: number;
  engine: "wasm" | "typescript";
};

type CompleteResponse = {
  kind: "complete";
  id: number;
  packedOnsets: Float64Array;
  engine: "wasm" | "typescript";
};

type ErrorResponse = {
  kind: "error";
  id: number;
  message: string;
};

const cancelled = new Set<number>();
let wasmModulePromise: Promise<WasmAudioModule> | null = null;
let wasmModuleUrl = "";

function postProgress(id: number, progress: number, engine: ProgressResponse["engine"]) {
  const response: ProgressResponse = { kind: "progress", id, progress, engine };
  self.postMessage(response);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function fft(real: Float64Array, imaginary: Float64Array) {
  const size = real.length;
  for (let index = 1, swapIndex = 0; index < size; index += 1) {
    let bit = size >> 1;
    while (swapIndex & bit) {
      swapIndex ^= bit;
      bit >>= 1;
    }
    swapIndex ^= bit;
    if (index < swapIndex) {
      [real[index], real[swapIndex]] = [real[swapIndex], real[index]];
      [imaginary[index], imaginary[swapIndex]] = [imaginary[swapIndex], imaginary[index]];
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
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function packOnsets(onsets: AudioOnset[]) {
  const packed = new Float64Array(onsets.length * 2);
  for (let index = 0; index < onsets.length; index += 1) {
    packed[index * 2] = onsets[index].ms;
    packed[index * 2 + 1] = onsets[index].strength;
  }
  return packed;
}

function findAdaptiveOnsets(envelope: number[], hopMs: number) {
  if (envelope.length < 5) return [];
  const globalMedian = median([...envelope]);
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
    const strength = clamp((value - localMedian) / Math.max(localMad * 6, 1e-6), 0, 1);
    if (ms - lastMs < 34) {
      const previous = onsets[onsets.length - 1];
      if (previous && strength > previous.strength) {
        previous.ms = ms;
        previous.strength = strength;
        lastMs = ms;
      }
      continue;
    }

    onsets.push({ ms, strength });
    lastMs = ms;
  }

  return onsets;
}

async function analyzeWithTypeScript(
  id: number,
  samples: Float32Array,
  sampleRate: number,
  fftSize: number,
  hopSize: number,
) {
  const frameCount = Math.max(0, Math.floor((samples.length - fftSize) / hopSize));
  if (!frameCount) return new Float64Array();

  const analysisWindow = new Float64Array(fftSize);
  for (let index = 0; index < fftSize; index += 1) {
    analysisWindow[index] = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (fftSize - 1));
  }

  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  const previousMagnitude = new Float64Array(fftSize / 2);
  const envelope = new Array<number>(frameCount);
  const lowBin = clamp(Math.floor(27.5 * fftSize / sampleRate), 1, fftSize / 2 - 1);
  const highBin = clamp(Math.ceil(5000 * fftSize / sampleRate), lowBin + 1, fftSize / 2 - 1);
  let previousRms = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    if (cancelled.has(id)) throw new DOMException("Aborted", "AbortError");
    const start = frame * hopSize;
    let energy = 0;
    for (let sample = 0; sample < fftSize; sample += 1) {
      const value = samples[start + sample] ?? 0;
      energy += value * value;
      real[sample] = value * analysisWindow[sample];
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
    envelope[frame] = flux / binCount * 1.55
      + rmsRise * 3.2
      + rms * 0.22
      + spectralEnergy / binCount * 0.01;

    if (frame % 192 === 0) {
      postProgress(id, frame / frameCount, "typescript");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  return packOnsets(findAdaptiveOnsets(envelope, hopSize / sampleRate * 1000));
}

async function loadWasm(url: string) {
  if (!wasmModulePromise || wasmModuleUrl !== url) {
    wasmModuleUrl = url;
    wasmModulePromise = (async () => {
      const module = await import(/* @vite-ignore */ url) as unknown as WasmAudioModule;
      await module.default();
      return module;
    })();
  }
  return wasmModulePromise;
}

async function analyze(message: AnalyzeMessage) {
  const { id, samples, sampleRate, wasmModuleUrl: moduleUrl } = message;
  const fftSize = 2048;
  const hopSize = 512;
  let packedOnsets: Float64Array;
  let engine: CompleteResponse["engine"] = "wasm";

  try {
    postProgress(id, 0.04, "wasm");
    const module = await loadWasm(moduleUrl);
    if (cancelled.has(id)) throw new DOMException("Aborted", "AbortError");
    packedOnsets = new Float64Array(
      module.analyze_audio_onsets(samples, sampleRate, fftSize, hopSize),
    );
  } catch (error) {
    if (cancelled.has(id) || (error instanceof DOMException && error.name === "AbortError")) return;
    engine = "typescript";
    wasmModulePromise = null;
    packedOnsets = await analyzeWithTypeScript(id, samples, sampleRate, fftSize, hopSize);
  }

  if (cancelled.has(id)) return;
  const response: CompleteResponse = { kind: "complete", id, packedOnsets, engine };
  self.postMessage(response, { transfer: [packedOnsets.buffer] });
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.kind === "cancel") {
    cancelled.add(message.id);
    return;
  }

  cancelled.delete(message.id);
  void analyze(message).catch((error: unknown) => {
    if (cancelled.has(message.id)) return;
    const response: ErrorResponse = {
      kind: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  });
});
