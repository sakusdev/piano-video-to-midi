import {
  AnalysisWorkerError,
  WORKER_PROTOCOL_VERSION,
  assertProtocolVersion,
  audioWorkerTimeoutMs,
  errorMessage,
  validatePackedOnsets,
} from "./reliability";
import type { AudioOnset } from "./types";

export type AudioAnalysisProgress = {
  progress: number;
  stage: "decode" | "fft" | "done" | "error";
  engine?: "wasm" | "typescript";
  message?: string;
  degraded?: boolean;
};

type WorkerProgress = {
  kind: "progress";
  id: number;
  progress: number;
  engine: "wasm" | "typescript";
  protocolVersion?: number;
};

type WorkerComplete = {
  kind: "complete";
  id: number;
  packedOnsets: Float64Array;
  engine: "wasm" | "typescript";
  protocolVersion?: number;
  fallbackReason?: string;
  elapsedMs?: number;
};

type WorkerError = {
  kind: "error";
  id: number;
  message: string;
  code?: string;
  protocolVersion?: number;
};

type WorkerResponse = WorkerProgress | WorkerComplete | WorkerError;

let nextRequestId = 1;

function yieldToBrowser() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<WorkerResponse>;
  return (message.kind === "progress" || message.kind === "complete" || message.kind === "error")
    && typeof message.id === "number";
}

async function mixToMono(
  buffer: AudioBuffer,
  onProgress?: (progress: AudioAnalysisProgress) => void,
  signal?: AbortSignal,
) {
  if (!Number.isFinite(buffer.sampleRate) || buffer.sampleRate <= 0 || buffer.length <= 0) {
    throw new AnalysisWorkerError("invalid-input", "デコードされた音声バッファが不正です", false);
  }
  const channels = Array.from(
    { length: buffer.numberOfChannels },
    (_, channel) => buffer.getChannelData(channel),
  );
  if (!channels.length) throw new AnalysisWorkerError("invalid-input", "音声チャンネルがありません", false);
  const mono = new Float32Array(buffer.length);
  const chunkSize = 131_072;

  for (let start = 0; start < buffer.length; start += chunkSize) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const end = Math.min(buffer.length, start + chunkSize);
    for (let index = start; index < end; index += 1) {
      let mixed = 0;
      for (const channel of channels) mixed += channel[index] ?? 0;
      const value = mixed / channels.length;
      mono[index] = Number.isFinite(value) ? value : 0;
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
    if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 384_000 || !samples.length) {
      reject(new AnalysisWorkerError("invalid-input", "音声解析パラメータが不正です", false));
      return;
    }

    const id = nextRequestId;
    nextRequestId += 1;
    const worker = new Worker(
      new URL("../workers/audio-analysis.worker.ts", import.meta.url),
      { type: "module", name: "piano-audio-analysis" },
    );
    const durationMs = samples.length / sampleRate * 1_000;
    const timeoutMs = audioWorkerTimeoutMs(samples.length, sampleRate);
    let settled = false;
    let timeoutId = 0;

    const cleanup = () => {
      window.clearTimeout(timeoutId);
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
    const timeout = () => finish(() => reject(new AnalysisWorkerError(
      "timeout",
      `音声解析Workerが${Math.round(timeoutMs / 1_000)}秒以内に完了しませんでした`,
    )));

    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    timeoutId = window.setTimeout(timeout, timeoutMs);

    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (settled || !isWorkerResponse(event.data)) {
        if (!settled) finish(() => reject(new AnalysisWorkerError("worker-message", "音声Workerから不正なメッセージを受信しました")));
        return;
      }
      const message = event.data;
      if (message.id !== id) return;
      try {
        assertProtocolVersion(message.protocolVersion);
        if (message.kind === "progress") {
          onProgress?.({
            progress: 0.2 + Math.max(0, Math.min(1, message.progress)) * 0.78,
            stage: "fft",
            engine: message.engine,
            degraded: message.engine === "typescript",
          });
          return;
        }
        if (message.kind === "error") {
          finish(() => reject(new AnalysisWorkerError(
            message.code === "invalid-input" ? "invalid-input" : "worker-crash",
            message.message || "音声Workerでエラーが発生しました",
          )));
          return;
        }
        validatePackedOnsets(message.packedOnsets, durationMs);
        onProgress?.({
          progress: 1,
          stage: "done",
          engine: message.engine,
          degraded: message.engine === "typescript",
          message: message.fallbackReason,
        });
        finish(() => resolve(unpackOnsets(message.packedOnsets)));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    worker.addEventListener("messageerror", () => {
      finish(() => reject(new AnalysisWorkerError("worker-message", "音声Workerとのメッセージ転送に失敗しました")));
    });
    worker.addEventListener("error", (event) => {
      finish(() => reject(new AnalysisWorkerError(
        "worker-crash",
        event.message || "音声解析Workerが異常終了しました",
        true,
        event.error ? { cause: event.error } : undefined,
      )));
    });

    const wasmModuleUrl = new URL("wasm/piano_core.js", document.baseURI).href;
    try {
      worker.postMessage(
        {
          kind: "analyze",
          id,
          protocolVersion: WORKER_PROTOCOL_VERSION,
          samples,
          sampleRate,
          wasmModuleUrl,
        },
        [samples.buffer],
      );
    } catch (error) {
      finish(() => reject(new AnalysisWorkerError(
        "worker-message",
        `音声データをWorkerへ転送できませんでした: ${errorMessage(error)}`,
        true,
        error instanceof Error ? { cause: error } : undefined,
      )));
    }
  });
}

export async function analyzeAudioOnsets(
  file: File,
  onProgress?: (progress: AudioAnalysisProgress) => void,
  signal?: AbortSignal,
): Promise<AudioOnset[]> {
  const AudioContextClass = window.AudioContext
    || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) {
    throw new AnalysisWorkerError("invalid-input", "このブラウザはWeb Audio APIに対応していません", false);
  }
  if (!file.size) throw new AnalysisWorkerError("invalid-input", "動画ファイルが空です", false);

  const context = new AudioContextClass();
  try {
    onProgress?.({ progress: 0, stage: "decode" });
    const bytes = await file.arrayBuffer();
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const buffer = await context.decodeAudioData(bytes);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    onProgress?.({ progress: 0.08, stage: "decode" });
    const mono = await mixToMono(buffer, onProgress, signal);
    return await analyzeInWorker(mono, buffer.sampleRate, onProgress, signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const message = errorMessage(error);
    onProgress?.({ progress: 0, stage: "error", message });
    throw error instanceof Error
      ? error
      : new AnalysisWorkerError("unknown", `音声解析に失敗しました: ${message}`);
  } finally {
    try {
      await context.close();
    } catch {
      // Closing an already-closed AudioContext is harmless.
    }
  }
}
