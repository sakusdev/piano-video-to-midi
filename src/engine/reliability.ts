import type { PianoKey } from "./types";

export const WORKER_PROTOCOL_VERSION = 1;
export const WASM_ENGINE_VERSION = "0.1.0";

export type AnalysisFailureCode =
  | "aborted"
  | "invalid-input"
  | "invalid-response"
  | "timeout"
  | "worker-crash"
  | "worker-message"
  | "wasm-version"
  | "unknown";

export class AnalysisWorkerError extends Error {
  readonly code: AnalysisFailureCode;
  readonly recoverable: boolean;

  constructor(code: AnalysisFailureCode, message: string, recoverable = true, options?: ErrorOptions) {
    super(message, options);
    this.name = "AnalysisWorkerError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error || "不明なエラー");
}

export function audioWorkerTimeoutMs(sampleCount: number, sampleRate: number) {
  const durationMs = sampleRate > 0 ? sampleCount / sampleRate * 1_000 : 0;
  return Math.round(Math.max(90_000, Math.min(15 * 60_000, 45_000 + durationMs * 0.35)));
}

export function assertFiniteNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AnalysisWorkerError("invalid-response", `${label} が有限数ではありません`);
  }
  return value;
}

export function validatePackedOnsets(packed: Float64Array, durationMs: number) {
  if (!(packed instanceof Float64Array) || packed.length % 2 !== 0) {
    throw new AnalysisWorkerError("invalid-response", "音声解析結果の配列形式が壊れています");
  }
  let previousMs = -Infinity;
  const maximumMs = Math.max(0, durationMs) + 2_000;
  for (let index = 0; index < packed.length; index += 2) {
    const ms = assertFiniteNumber(packed[index], `onset[${index / 2}].ms`);
    const strength = assertFiniteNumber(packed[index + 1], `onset[${index / 2}].strength`);
    if (ms < 0 || ms > maximumMs || ms < previousMs) {
      throw new AnalysisWorkerError("invalid-response", "音声解析結果の時刻順序または範囲が不正です");
    }
    if (strength < 0 || strength > 1.000_001) {
      throw new AnalysisWorkerError("invalid-response", "音声解析結果の強度が範囲外です");
    }
    previousMs = ms;
  }
}

export function validatePackedCandidates(packed: Float64Array, keys: PianoKey[]) {
  if (!(packed instanceof Float64Array) || packed.length % 6 !== 0) {
    throw new AnalysisWorkerError("invalid-response", "映像解析候補の配列形式が壊れています");
  }
  const expected = new Set(keys.map((key) => key.midi));
  const seen = new Set<number>();
  for (let index = 0; index < packed.length; index += 6) {
    const midi = assertFiniteNumber(packed[index], `candidate[${index / 6}].midi`);
    const strength = assertFiniteNumber(packed[index + 1], `candidate[${index / 6}].strength`);
    const confidence = assertFiniteNumber(packed[index + 2], `candidate[${index / 6}].confidence`);
    const centerX = assertFiniteNumber(packed[index + 3], `candidate[${index / 6}].centerX`);
    const width = assertFiniteNumber(packed[index + 4], `candidate[${index / 6}].width`);
    const darkRatio = assertFiniteNumber(packed[index + 5], `candidate[${index / 6}].darkRatio`);
    if (!Number.isInteger(midi) || !expected.has(midi) || seen.has(midi)) {
      throw new AnalysisWorkerError("invalid-response", "映像解析候補のMIDI番号が不正です");
    }
    if (strength < 0 || confidence < 0 || confidence > 1.000_001 || width <= 0 || darkRatio < 0 || darkRatio > 1.000_001) {
      throw new AnalysisWorkerError("invalid-response", "映像解析候補の数値範囲が不正です");
    }
    if (!Number.isFinite(centerX)) {
      throw new AnalysisWorkerError("invalid-response", "映像解析候補の位置が不正です");
    }
    seen.add(midi);
  }
}

export function validatePackedGlow(packed: Float64Array, keys: PianoKey[]) {
  if (!(packed instanceof Float64Array) || packed.length % 2 !== 0) {
    throw new AnalysisWorkerError("invalid-response", "鍵盤発光結果の配列形式が壊れています");
  }
  const expected = new Set(keys.map((key) => key.midi));
  const seen = new Set<number>();
  for (let index = 0; index < packed.length; index += 2) {
    const midi = assertFiniteNumber(packed[index], `glow[${index / 2}].midi`);
    const score = assertFiniteNumber(packed[index + 1], `glow[${index / 2}].score`);
    if (!Number.isInteger(midi) || !expected.has(midi) || seen.has(midi) || score < 0) {
      throw new AnalysisWorkerError("invalid-response", "鍵盤発光結果の内容が不正です");
    }
    seen.add(midi);
  }
  if (seen.size !== expected.size) {
    throw new AnalysisWorkerError("invalid-response", "鍵盤発光結果の鍵数が一致しません");
  }
}

export function assertProtocolVersion(value: unknown) {
  if (value !== undefined && value !== WORKER_PROTOCOL_VERSION) {
    throw new AnalysisWorkerError(
      "invalid-response",
      `Worker protocol mismatch: expected ${WORKER_PROTOCOL_VERSION}, received ${String(value)}`,
      false,
    );
  }
}
