import { clamp } from "./geometry";
import {
  AnalysisWorkerError,
  WORKER_PROTOCOL_VERSION,
  assertProtocolVersion,
  errorMessage,
  validatePackedCandidates,
  validatePackedGlow,
} from "./reliability";
import type { DetectionCandidate, PianoKey, Rect } from "./types";

export type VisionWorkerSettings = {
  threshold: number;
  colorTolerance: number;
  blackGuard: number;
  handSplit: number;
  leftHue: number;
  rightHue: number;
};

export type VisionFrameAnalysis = {
  candidates: Map<number, DetectionCandidate>;
  glowScores: Map<number, number>;
  engine: "wasm" | "typescript";
  fallbackReason?: string;
  elapsedMs?: number;
};

type WorkerComplete = {
  kind: "complete";
  id: number;
  packedCandidates: Float64Array;
  packedGlow: Float64Array;
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

type WorkerResponse = WorkerComplete | WorkerError;

type PendingRequest = {
  keys: PianoKey[];
  timeoutId: number;
  resolve: (value: VisionFrameAnalysis) => void;
  reject: (reason?: unknown) => void;
};

type CapturedPixels = {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

const VISION_TIMEOUT_MS = 8_000;

function captureRect(context: CanvasRenderingContext2D, rect: Rect): CapturedPixels | null {
  const x0 = clamp(Math.floor(rect.x), 0, context.canvas.width - 1);
  const y0 = clamp(Math.floor(rect.y), 0, context.canvas.height - 1);
  const x1 = clamp(Math.ceil(rect.x + rect.w), 0, context.canvas.width);
  const y1 = clamp(Math.ceil(rect.y + rect.h), 0, context.canvas.height);
  if (x1 <= x0 || y1 <= y0) return null;
  try {
    const image = context.getImageData(x0, y0, x1 - x0, y1 - y0);
    return { x: x0, y: y0, width: image.width, height: image.height, data: image.data };
  } catch (error) {
    throw new AnalysisWorkerError(
      "invalid-input",
      `動画フレームを読み取れませんでした: ${errorMessage(error)}`,
      true,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<WorkerResponse>;
  return (message.kind === "complete" || message.kind === "error")
    && typeof message.id === "number";
}

function unpackCandidates(packed: Float64Array) {
  const candidates = new Map<number, DetectionCandidate>();
  for (let index = 0; index + 5 < packed.length; index += 6) {
    const candidate: DetectionCandidate = {
      midi: packed[index],
      strength: packed[index + 1],
      confidence: packed[index + 2],
      centerX: packed[index + 3],
      width: packed[index + 4],
      darkRatio: packed[index + 5],
    };
    candidates.set(candidate.midi, candidate);
  }
  return candidates;
}

function unpackGlow(packed: Float64Array) {
  const glowScores = new Map<number, number>();
  for (let index = 0; index + 1 < packed.length; index += 2) {
    glowScores.set(packed[index], packed[index + 1]);
  }
  return glowScores;
}

export class VisionWorkerClient {
  private worker: Worker | null = null;
  private requestId = 1;
  private pending = new Map<number, PendingRequest>();

  private rejectPending(error: unknown) {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private invalidateWorker(error: unknown, worker = this.worker) {
    worker?.terminate();
    if (this.worker === worker) this.worker = null;
    this.rejectPending(error);
  }

  private createWorker() {
    const worker = new Worker(
      new URL("../workers/vision-analysis.worker.ts", import.meta.url),
      { type: "module", name: "piano-vision-analysis" },
    );
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!isWorkerResponse(event.data)) {
        this.invalidateWorker(new AnalysisWorkerError(
          "worker-message",
          "映像Workerから不正なメッセージを受信しました",
        ), worker);
        return;
      }
      const message = event.data;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      window.clearTimeout(pending.timeoutId);
      this.pending.delete(message.id);
      try {
        assertProtocolVersion(message.protocolVersion);
        if (message.kind === "error") {
          pending.reject(new AnalysisWorkerError(
            message.code === "invalid-input" ? "invalid-input" : "worker-crash",
            message.message || "映像Workerでエラーが発生しました",
          ));
          return;
        }
        validatePackedCandidates(message.packedCandidates, pending.keys);
        validatePackedGlow(message.packedGlow, pending.keys);
        pending.resolve({
          candidates: unpackCandidates(message.packedCandidates),
          glowScores: unpackGlow(message.packedGlow),
          engine: message.engine,
          fallbackReason: message.fallbackReason,
          elapsedMs: message.elapsedMs,
        });
      } catch (error) {
        pending.reject(error);
        worker.terminate();
        if (this.worker === worker) this.worker = null;
      }
    });
    worker.addEventListener("messageerror", () => {
      this.invalidateWorker(new AnalysisWorkerError(
        "worker-message",
        "映像Workerとのメッセージ転送に失敗しました",
      ), worker);
    });
    worker.addEventListener("error", (event) => {
      this.invalidateWorker(new AnalysisWorkerError(
        "worker-crash",
        event.message || "映像解析Workerが異常終了しました",
        true,
        event.error ? { cause: event.error } : undefined,
      ), worker);
    });
    return worker;
  }

  private ensureWorker() {
    if (!this.worker) this.worker = this.createWorker();
    return this.worker;
  }

  private analyzeOnce(
    context: CanvasRenderingContext2D,
    keyboardRect: Rect,
    keys: PianoKey[],
    hitLineY: number,
    lineHeight: number,
    settings: VisionWorkerSettings,
  ) {
    if (!keys.length || keyboardRect.w <= 0 || keyboardRect.h <= 0) {
      return Promise.reject<VisionFrameAnalysis>(new AnalysisWorkerError(
        "invalid-input",
        "鍵盤範囲または鍵盤情報が不正です",
        false,
      ));
    }
    const line = captureRect(context, {
      x: keyboardRect.x,
      y: hitLineY,
      w: keyboardRect.w,
      h: Math.max(1, lineHeight),
    });
    const keyboard = captureRect(context, keyboardRect);
    if (!line || !keyboard) {
      return Promise.reject<VisionFrameAnalysis>(new AnalysisWorkerError(
        "invalid-input",
        "解析対象の動画領域が空です",
      ));
    }

    const id = this.requestId;
    this.requestId += 1;
    const worker = this.ensureWorker();
    const promise = new Promise<VisionFrameAnalysis>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        worker.terminate();
        if (this.worker === worker) this.worker = null;
        reject(new AnalysisWorkerError(
          "timeout",
          `映像解析Workerが${VISION_TIMEOUT_MS / 1_000}秒以内に応答しませんでした`,
        ));
      }, VISION_TIMEOUT_MS);
      this.pending.set(id, { keys, timeoutId, resolve, reject });
    });
    const wasmModuleUrl = new URL("wasm/piano_core.js", document.baseURI).href;
    try {
      worker.postMessage(
        {
          kind: "analyze",
          id,
          protocolVersion: WORKER_PROTOCOL_VERSION,
          linePixels: line.data,
          lineWidth: line.width,
          lineHeight: line.height,
          lineX: line.x,
          keyboardPixels: keyboard.data,
          keyboardWidth: keyboard.width,
          keyboardHeight: keyboard.height,
          keyboardX: keyboard.x,
          keyboardY: keyboard.y,
          keyboardLogicalWidth: keyboardRect.w,
          keys,
          settings,
          wasmModuleUrl,
        },
        [line.data.buffer, keyboard.data.buffer],
      );
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) window.clearTimeout(pending.timeoutId);
      this.pending.delete(id);
      worker.terminate();
      if (this.worker === worker) this.worker = null;
      return Promise.reject<VisionFrameAnalysis>(new AnalysisWorkerError(
        "worker-message",
        `映像データをWorkerへ転送できませんでした: ${errorMessage(error)}`,
        true,
        error instanceof Error ? { cause: error } : undefined,
      ));
    }
    return promise;
  }

  async analyze(
    context: CanvasRenderingContext2D,
    keyboardRect: Rect,
    keys: PianoKey[],
    hitLineY: number,
    lineHeight: number,
    settings: VisionWorkerSettings,
  ) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.analyzeOnce(context, keyboardRect, keys, hitLineY, lineHeight, settings);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        lastError = error;
        this.worker?.terminate();
        this.worker = null;
        if (attempt === 0) await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new AnalysisWorkerError("unknown", `映像解析に失敗しました: ${errorMessage(lastError)}`);
  }

  reset() {
    const error = new DOMException("Vision analysis cancelled", "AbortError");
    this.invalidateWorker(error);
  }

  dispose() {
    const error = new DOMException("Vision analysis disposed", "AbortError");
    this.invalidateWorker(error);
  }
}
