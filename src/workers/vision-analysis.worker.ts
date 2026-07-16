/// <reference lib="webworker" />

import type { DetectionCandidate, PianoKey } from "../engine/types";

type VisionSettings = {
  threshold: number;
  colorTolerance: number;
  blackGuard: number;
  handSplit: number;
  leftHue: number;
  rightHue: number;
};

type AnalyzeMessage = {
  kind: "analyze";
  id: number;
  linePixels: Uint8ClampedArray;
  lineWidth: number;
  lineHeight: number;
  lineX: number;
  keyboardPixels: Uint8ClampedArray;
  keyboardWidth: number;
  keyboardHeight: number;
  keyboardX: number;
  keyboardY: number;
  keyboardLogicalWidth: number;
  keys: PianoKey[];
  settings: VisionSettings;
  wasmModuleUrl: string;
};

type WorkerResponse = {
  kind: "complete";
  id: number;
  packedCandidates: Float64Array;
  packedGlow: Float64Array;
  engine: "wasm" | "typescript";
} | {
  kind: "error";
  id: number;
  message: string;
};

type WasmVisionModule = {
  default: (input?: unknown) => Promise<unknown>;
  analyze_color_columns: (
    pixels: Uint8Array,
    width: number,
    height: number,
    absoluteX: number,
    splitX: number,
    threshold: number,
    colorTolerance: number,
    leftHue: number,
    rightHue: number,
  ) => Float64Array;
  measure_key_glow: (
    pixels: Uint8Array,
    width: number,
    height: number,
    keyRects: Float64Array,
  ) => Float64Array;
};

type ColumnHit = {
  x: number;
  score: number;
  strength: number;
  darkRatio: number;
};

let wasmModulePromise: Promise<WasmVisionModule> | null = null;
let wasmModuleUrl = "";

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function rgbToHsv(red: number, green: number, blue: number) {
  const rn = red / 255;
  const gn = green / 255;
  const bn = blue / 255;
  const maximum = Math.max(rn, gn, bn);
  const minimum = Math.min(rn, gn, bn);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta !== 0) {
    if (maximum === rn) hue = ((gn - bn) / delta) % 6;
    else if (maximum === gn) hue = (bn - rn) / delta + 2;
    else hue = (rn - gn) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return { h: hue, s: maximum === 0 ? 0 : delta / maximum, v: maximum };
}

function hueDistance(left: number, right: number) {
  const distance = Math.abs(left - right) % 360;
  return distance > 180 ? 360 - distance : distance;
}

function analyzeColumnsTypeScript(message: AnalyzeMessage) {
  const {
    linePixels,
    lineWidth,
    lineHeight,
    lineX,
    keyboardX,
    keyboardLogicalWidth,
    settings,
  } = message;
  const splitX = keyboardX + keyboardLogicalWidth * (settings.handSplit / 100);
  const minimumSaturation = 0.15 + settings.colorTolerance * 0.006;
  const minimumValue = 0.22 + settings.colorTolerance * 0.002;
  const hueWindow = Math.max(7, 34 - settings.colorTolerance * 0.55);
  const minimumRatio = clamp(settings.threshold / 115, 0.025, 0.7);
  const columns: ColumnHit[] = [];

  for (let localX = 0; localX < lineWidth; localX += 1) {
    const absoluteX = lineX + localX;
    const targetHue = absoluteX < splitX ? settings.leftHue : settings.rightHue;
    let hitCount = 0;
    let strength = 0;
    let darkCount = 0;
    for (let localY = 0; localY < lineHeight; localY += 1) {
      const index = (localY * lineWidth + localX) * 4;
      const red = linePixels[index];
      const green = linePixels[index + 1];
      const blue = linePixels[index + 2];
      const hsv = rgbToHsv(red, green, blue);
      if (
        hsv.s < minimumSaturation
        || hsv.v < minimumValue
        || hueDistance(hsv.h, targetHue) > hueWindow
      ) continue;
      hitCount += 1;
      const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      strength += hsv.s * 86 + hsv.v * 28 + Math.max(0, 120 - luma) * 0.08;
      if (luma < 118 || hsv.v < 0.46) darkCount += 1;
    }
    const score = hitCount / Math.max(1, lineHeight);
    if (score >= minimumRatio) {
      columns.push({
        x: absoluteX,
        score,
        strength: strength / Math.max(1, hitCount),
        darkRatio: darkCount / Math.max(1, hitCount),
      });
    }
  }
  return columns;
}

function unpackColumns(packed: Float64Array) {
  const columns: ColumnHit[] = [];
  for (let index = 0; index + 3 < packed.length; index += 4) {
    columns.push({
      x: packed[index],
      score: packed[index + 1],
      strength: packed[index + 2],
      darkRatio: packed[index + 3],
    });
  }
  return columns;
}

function closestWhiteKey(keys: PianoKey[], centerX: number) {
  let selected: PianoKey | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const key of keys) {
    if (key.isBlack) continue;
    const distance = Math.abs(key.x + key.w / 2 - centerX);
    if (distance < bestDistance) {
      selected = key;
      bestDistance = distance;
    }
  }
  return selected;
}

function mapRunToKey(
  keys: PianoKey[],
  centerX: number,
  width: number,
  strength: number,
  darkRatio: number,
) {
  const white = closestWhiteKey(keys, centerX);
  if (!white) return undefined;
  let closestBlack: PianoKey | undefined;
  let blackDistance = Number.POSITIVE_INFINITY;
  for (const key of keys) {
    if (!key.isBlack) continue;
    const distance = Math.abs(key.x + key.w / 2 - centerX);
    if (distance < blackDistance) {
      closestBlack = key;
      blackDistance = distance;
    }
  }
  if (!closestBlack) return white;
  const darkBoost = darkRatio > 0.36;
  const inside = centerX >= closestBlack.x - closestBlack.w * 0.24
    && centerX <= closestBlack.x + closestBlack.w * 1.24;
  const centered = blackDistance <= closestBlack.w * (darkBoost ? 0.78 : 0.62);
  const narrow = width <= closestBlack.w * (darkBoost ? 2.35 : 1.95);
  const strongEnough = strength >= 11 || (darkBoost && strength >= 7.5);
  return inside && centered && narrow && strongEnough ? closestBlack : white;
}

function suppressWeakBlackCandidates(
  keys: PianoKey[],
  candidates: Map<number, DetectionCandidate>,
  guard: number,
) {
  const guardRatio = clamp(guard / 100, 0, 1);
  for (const [midi, candidate] of [...candidates.entries()]) {
    const key = keys.find((item) => item.midi === midi);
    if (!key?.isBlack) continue;
    const center = key.x + key.w / 2;
    const darkBoost = candidate.darkRatio > 0.38;
    const centeredLimit = key.w * (darkBoost ? 0.82 : 0.67) * (1 - guardRatio * 0.16);
    const widthLimit = key.w * (darkBoost ? 2.5 : 2.05) * (1 - guardRatio * 0.12);
    const centered = Math.abs(candidate.centerX - center) <= centeredLimit;
    const narrow = candidate.width <= widthLimit;
    const neighboringWhiteStrength = Math.max(
      0,
      ...keys
        .filter((item) => !item.isBlack && Math.abs(item.x + item.w / 2 - center) < item.w * 0.95)
        .map((item) => candidates.get(item.midi)?.strength ?? 0),
    );
    const relativeRequirement = 1.16 + guardRatio * 0.62;
    const dominated = neighboringWhiteStrength > 0
      && candidate.strength < neighboringWhiteStrength * relativeRequirement
      && !darkBoost;
    if (!centered || !narrow || dominated) candidates.delete(midi);
  }
}

function buildCandidates(message: AnalyzeMessage, columns: ColumnHit[]) {
  const candidates = new Map<number, DetectionCandidate>();
  let index = 0;
  while (index < columns.length) {
    const run = [columns[index]];
    index += 1;
    while (index < columns.length && columns[index].x - run[run.length - 1].x <= 2) {
      run.push(columns[index]);
      index += 1;
    }
    const minimumRunWidth = Math.max(2, message.keyboardLogicalWidth / 52 * 0.16);
    if (run.length < minimumRunWidth) continue;
    const weight = run.reduce((sum, column) => sum + column.score, 0);
    const centerX = run.reduce((sum, column) => sum + column.x * column.score, 0)
      / Math.max(weight, 1e-6);
    const strength = run.reduce((sum, column) => sum + column.strength * column.score, 0)
      / Math.max(weight, 1e-6);
    const darkRatio = run.reduce((sum, column) => sum + column.darkRatio * column.score, 0)
      / Math.max(weight, 1e-6);
    const width = run[run.length - 1].x - run[0].x + 1;
    const key = mapRunToKey(message.keys, centerX, width, strength, darkRatio);
    if (!key) continue;
    const confidence = clamp(
      weight / Math.max(1, run.length) * 0.58
      + clamp(strength / 105, 0, 1) * 0.28
      + (key.isBlack ? clamp(darkRatio * 1.25, 0, 1) : 0.14),
      0,
      1,
    );
    const candidate: DetectionCandidate = {
      midi: key.midi,
      strength,
      confidence,
      centerX,
      width,
      darkRatio,
    };
    const previous = candidates.get(key.midi);
    if (!previous || candidate.confidence > previous.confidence) candidates.set(key.midi, candidate);
  }
  suppressWeakBlackCandidates(message.keys, candidates, message.settings.blackGuard);
  return candidates;
}

function packCandidates(candidates: Map<number, DetectionCandidate>) {
  const packed = new Float64Array(candidates.size * 6);
  let offset = 0;
  for (const candidate of candidates.values()) {
    packed[offset] = candidate.midi;
    packed[offset + 1] = candidate.strength;
    packed[offset + 2] = candidate.confidence;
    packed[offset + 3] = candidate.centerX;
    packed[offset + 4] = candidate.width;
    packed[offset + 5] = candidate.darkRatio;
    offset += 6;
  }
  return packed;
}

function keyRects(message: AnalyzeMessage) {
  const packed = new Float64Array(message.keys.length * 5);
  let offset = 0;
  for (const key of message.keys) {
    packed[offset] = key.midi;
    packed[offset + 1] = key.x - message.keyboardX;
    packed[offset + 2] = key.y - message.keyboardY;
    packed[offset + 3] = key.w;
    packed[offset + 4] = key.h;
    offset += 5;
  }
  return packed;
}

function glowTypeScript(message: AnalyzeMessage) {
  const rects = keyRects(message);
  const packed = new Float64Array(message.keys.length * 2);
  let output = 0;
  for (let index = 0; index < rects.length; index += 5) {
    const midi = rects[index];
    const x0 = clamp(Math.floor(rects[index + 1]), 0, message.keyboardWidth - 1);
    const y0 = clamp(Math.floor(rects[index + 2]), 0, message.keyboardHeight - 1);
    const x1 = clamp(
      Math.ceil(rects[index + 1] + rects[index + 3]),
      x0 + 1,
      message.keyboardWidth,
    );
    const y1 = clamp(
      Math.ceil(rects[index + 2] + rects[index + 4]),
      y0 + 1,
      message.keyboardHeight,
    );
    let sum = 0;
    let hot = 0;
    let count = 0;
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const pixel = (y * message.keyboardWidth + x) * 4;
        const luma = 0.2126 * message.keyboardPixels[pixel]
          + 0.7152 * message.keyboardPixels[pixel + 1]
          + 0.0722 * message.keyboardPixels[pixel + 2];
        sum += luma;
        if (luma > 148) hot += 1;
        count += 1;
      }
    }
    packed[output] = midi;
    packed[output + 1] = sum / Math.max(1, count) + hot / Math.max(1, count) * 72;
    output += 2;
  }
  return packed;
}

async function loadWasm(url: string) {
  if (!wasmModulePromise || wasmModuleUrl !== url) {
    wasmModuleUrl = url;
    wasmModulePromise = (async () => {
      const module = await import(/* @vite-ignore */ url) as unknown as WasmVisionModule;
      await module.default();
      return module;
    })();
  }
  return wasmModulePromise;
}

async function analyze(message: AnalyzeMessage) {
  let engine: "wasm" | "typescript" = "wasm";
  let columns: ColumnHit[];
  let packedGlow: Float64Array;
  try {
    const module = await loadWasm(message.wasmModuleUrl);
    const splitX = message.keyboardX
      + message.keyboardLogicalWidth * (message.settings.handSplit / 100);
    const packedColumns = module.analyze_color_columns(
      new Uint8Array(
        message.linePixels.buffer,
        message.linePixels.byteOffset,
        message.linePixels.byteLength,
      ),
      message.lineWidth,
      message.lineHeight,
      message.lineX,
      splitX,
      message.settings.threshold,
      message.settings.colorTolerance,
      message.settings.leftHue,
      message.settings.rightHue,
    );
    columns = unpackColumns(packedColumns);
    packedGlow = new Float64Array(module.measure_key_glow(
      new Uint8Array(
        message.keyboardPixels.buffer,
        message.keyboardPixels.byteOffset,
        message.keyboardPixels.byteLength,
      ),
      message.keyboardWidth,
      message.keyboardHeight,
      keyRects(message),
    ));
  } catch {
    engine = "typescript";
    wasmModulePromise = null;
    columns = analyzeColumnsTypeScript(message);
    packedGlow = glowTypeScript(message);
  }

  const packedCandidates = packCandidates(buildCandidates(message, columns));
  const response: WorkerResponse = {
    kind: "complete",
    id: message.id,
    packedCandidates,
    packedGlow,
    engine,
  };
  self.postMessage(response, { transfer: [packedCandidates.buffer, packedGlow.buffer] });
}

self.addEventListener("message", (event: MessageEvent<AnalyzeMessage>) => {
  if (event.data.kind !== "analyze") return;
  void analyze(event.data).catch((error: unknown) => {
    const response: WorkerResponse = {
      kind: "error",
      id: event.data.id,
      message: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  });
});
