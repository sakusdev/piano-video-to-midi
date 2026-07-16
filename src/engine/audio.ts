import type { AudioOnset } from "./types";

export type AudioAnalysisProgress = {
  progress: number;
  stage: "decode" | "fft" | "done";
  engine?: "wasm" | "typescript";
};

type WorkerProgress = {
  kind: "progress";
  id: number;
  progress: number;
  engine: "wasm" | "typescript";
};

type WorkerComplete = {
  kind: "complete";
  id: number;
  packedOnsets: Float64Array;
  engine: "wasm" | "typescript";
};

type WorkerError = {
  kind: "error";
  id: number;
  message: string;
};

type WorkerResponse = WorkerProgress | WorkerComplete | WorkerError;

let nextRequestId = 1;

function yieldToBrowser() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

async function mixToMono(
  buffer: AudioBuffer,
  onProgress?: (progress: AudioAnalysisProgress) => void,
  signal?: AbortSignal,
) {
  const channels = Array.from(
    { length: buffer.numberOfChannels },
    (_, channel) => buffer.getChannelData(channel),
  );
  const mono = new Float32Array(buffer.length);
  const chunkSize = 131_072;

  for (let start = 0; start < buffer.length; start += chunkSize) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const end = Math.min(buffer.length, start + chunkSize);
    for (let index = start; index < end; index += 1) {
      let mixed = 0;
      for (const channel of channels) mixed += channel[index] ?? 0;
      mono[index] = mixed / Math.max(1, channels.length);
    }
    onProgress?.({
      progress: 0.08 + (end / Math.max(1, buffer.length)) * 0.12,
      stage: "decode",
    });
    await yieldToBrowser();
  }

  return mono;
}

function unpackOnsets(packed: Float64Array): AudioOnset[] {
  const onsets: AudioOnset[] = [];
  for (let index = 0; index + 1 < packed.length; index += 2) {
    onsets.push({ ms: packed[index], strength: packed[index + 1] });
  }
  return onsets;
}

function analyzeInWorker(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: (progress: AudioAnalysisProgress) => void,
  signal?: AbortSignal,
) {
  return new Promise<AudioOnset[]>((resolve, reject) => {
    const id = nextRequestId;
    nextRequestId += 1;
    const worker = new Worker(
      new URL("../workers/audio-analysis.worker.ts", import.meta.url),
      { type: "module", name: "piano-audio-analysis" },
    );
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const abort = () => finish(() => reject(new DOMException("Aborted", "AbortError")));

    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }

    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.id !== id || settled) return;
      if (message.kind === "progress") {
        onProgress?.({
          progress: 0.2 + message.progress * 0.78,
          stage: "fft",
          engine: message.engine,
        });
        return;
      }
      if (message.kind === "error") {
        finish(() => reject(new Error(message.message)));
        return;
      }
      onProgress?.({ progress: 1, stage: "done", engine: message.engine });
      finish(() => resolve(unpackOnsets(message.packedOnsets)));
    });
    worker.addEventListener("error", (event) => {
      finish(() => reject(event.error ?? new Error(event.message)));
    });

    const wasmModuleUrl = new URL("wasm/piano_core.js", document.baseURI).href;
    worker.postMessage(
      { kind: "analyze", id, samples, sampleRate, wasmModuleUrl },
      [samples.buffer],
    );
  });
}

export async function analyzeAudioOnsets(
  file: File,
  onProgress?: (progress: AudioAnalysisProgress) => void,
  signal?: AbortSignal,
): Promise<AudioOnset[]> {
  const AudioContextClass = window.AudioContext
    || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return [];

  const context = new AudioContextClass();
  try {
    onProgress?.({ progress: 0, stage: "decode" });
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    onProgress?.({ progress: 0.08, stage: "decode" });
    const mono = await mixToMono(buffer, onProgress, signal);
    return await analyzeInWorker(mono, buffer.sampleRate, onProgress, signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return [];
  } finally {
    void context.close();
  }
}
