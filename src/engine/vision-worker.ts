import { clamp } from "./geometry";
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
};

type WorkerComplete = {
  kind: "complete";
  id: number;
  packedCandidates: Float64Array;
  packedGlow: Float64Array;
  engine: "wasm" | "typescript";
};

type WorkerError = {
  kind: "error";
  id: number;
  message: string;
};

type WorkerResponse = WorkerComplete | WorkerError;

type PendingRequest = {
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

function captureRect(context: CanvasRenderingContext2D, rect: Rect): CapturedPixels | null {
  const x0 = clamp(Math.floor(rect.x), 0, context.canvas.width - 1);
  const y0 = clamp(Math.floor(rect.y), 0, context.canvas.height - 1);
  const x1 = clamp(Math.ceil(rect.x + rect.w), 0, context.canvas.width);
  const y1 = clamp(Math.ceil(rect.y + rect.h), 0, context.canvas.height);
  if (x1 <= x0 || y1 <= y0) return null;
  const image = context.getImageData(x0, y0, x1 - x0, y1 - y0);
  return { x: x0, y: y0, width: image.width, height: image.height, data: image.data };
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
  private worker: Worker;
  private requestId = 1;
  private pending = new Map<number, PendingRequest>();

  constructor() {
    this.worker = this.createWorker();
  }

  private createWorker() {
    const worker = new Worker(
      new URL("../workers/vision-analysis.worker.ts", import.meta.url),
      { type: "module", name: "piano-vision-analysis" },
    );
    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.kind === "error") {
        pending.reject(new Error(message.message));
        return;
      }
      pending.resolve({
        candidates: unpackCandidates(message.packedCandidates),
        glowScores: unpackGlow(message.packedGlow),
        engine: message.engine,
      });
    });
    worker.addEventListener("error", (event) => {
      const error = event.error ?? new Error(event.message);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
    return worker;
  }

  analyze(
    context: CanvasRenderingContext2D,
    keyboardRect: Rect,
    keys: PianoKey[],
    hitLineY: number,
    lineHeight: number,
    settings: VisionWorkerSettings,
  ) {
    const line = captureRect(context, {
      x: keyboardRect.x,
      y: hitLineY,
      w: keyboardRect.w,
      h: Math.max(1, lineHeight),
    });
    const keyboard = captureRect(context, keyboardRect);
    if (!line || !keyboard) {
      return Promise.resolve<VisionFrameAnalysis>({
        candidates: new Map(),
        glowScores: new Map(),
        engine: "typescript",
      });
    }

    const id = this.requestId;
    this.requestId += 1;
    const promise = new Promise<VisionFrameAnalysis>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    const wasmModuleUrl = new URL("wasm/piano_core.js", document.baseURI).href;
    this.worker.postMessage(
      {
        kind: "analyze",
        id,
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
    return promise;
  }

  reset() {
    this.worker.terminate();
    const error = new DOMException("Vision analysis cancelled", "AbortError");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.worker = this.createWorker();
  }

  dispose() {
    this.worker.terminate();
    const error = new DOMException("Vision analysis disposed", "AbortError");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
