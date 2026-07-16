import { clamp } from "./geometry";
import type { DetectionCandidate, PianoKey, Rect } from "./types";

export type VisionSettings = {
  threshold: number;
  colorTolerance: number;
  blackGuard: number;
  handSplit: number;
  leftHue: number;
  rightHue: number;
};

type PixelBuffer = {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

type ColumnHit = {
  x: number;
  score: number;
  strength: number;
  darkRatio: number;
};

function readRect(ctx: CanvasRenderingContext2D, rect: Rect): PixelBuffer | null {
  const x0 = clamp(Math.floor(rect.x), 0, ctx.canvas.width - 1);
  const y0 = clamp(Math.floor(rect.y), 0, ctx.canvas.height - 1);
  const x1 = clamp(Math.ceil(rect.x + rect.w), 0, ctx.canvas.width);
  const y1 = clamp(Math.ceil(rect.y + rect.h), 0, ctx.canvas.height);
  if (x1 <= x0 || y1 <= y0) return null;
  const image = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
  return { x: x0, y: y0, width: image.width, height: image.height, data: image.data };
}

function rgbToHsv(r: number, g: number, b: number) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let hue = 0;

  if (delta !== 0) {
    if (max === rn) hue = ((gn - bn) / delta) % 6;
    else if (max === gn) hue = (bn - rn) / delta + 2;
    else hue = (rn - gn) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }

  return { h: hue, s: max === 0 ? 0 : delta / max, v: max };
}

export function hueFromHex(hex: string) {
  const stripped = hex.replace("#", "");
  const normalized = stripped.length === 3
    ? stripped.split("").map((character) => character + character).join("")
    : stripped;
  const value = Number.parseInt(normalized, 16);
  return rgbToHsv((value >> 16) & 255, (value >> 8) & 255, value & 255).h;
}

function hueDistance(a: number, b: number) {
  const distance = Math.abs(a - b) % 360;
  return distance > 180 ? 360 - distance : distance;
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

export function detectColoredNotes(
  ctx: CanvasRenderingContext2D,
  keyboardRect: Rect,
  keys: PianoKey[],
  hitLineY: number,
  lineHeight: number,
  settings: VisionSettings,
) {
  const image = readRect(ctx, {
    x: keyboardRect.x,
    y: hitLineY,
    w: keyboardRect.w,
    h: Math.max(1, lineHeight),
  });
  if (!image) return new Map<number, DetectionCandidate>();

  const splitX = keyboardRect.x + keyboardRect.w * (settings.handSplit / 100);
  const minimumSaturation = 0.15 + settings.colorTolerance * 0.006;
  const minimumValue = 0.22 + settings.colorTolerance * 0.002;
  const hueWindow = Math.max(7, 34 - settings.colorTolerance * 0.55);
  const minimumRatio = clamp(settings.threshold / 115, 0.025, 0.7);
  const columns: ColumnHit[] = [];

  for (let localX = 0; localX < image.width; localX += 1) {
    const absoluteX = image.x + localX;
    const targetHue = absoluteX < splitX ? settings.leftHue : settings.rightHue;
    let hitCount = 0;
    let strength = 0;
    let darkCount = 0;

    for (let localY = 0; localY < image.height; localY += 1) {
      const index = (localY * image.width + localX) * 4;
      const red = image.data[index];
      const green = image.data[index + 1];
      const blue = image.data[index + 2];
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

    const score = hitCount / Math.max(1, image.height);
    if (score >= minimumRatio) {
      columns.push({
        x: absoluteX,
        score,
        strength: strength / Math.max(1, hitCount),
        darkRatio: darkCount / Math.max(1, hitCount),
      });
    }
  }

  const candidates = new Map<number, DetectionCandidate>();
  let index = 0;
  while (index < columns.length) {
    const run = [columns[index]];
    index += 1;
    while (index < columns.length && columns[index].x - run[run.length - 1].x <= 2) {
      run.push(columns[index]);
      index += 1;
    }

    const minimumRunWidth = Math.max(2, keyboardRect.w / 52 * 0.16);
    if (run.length < minimumRunWidth) continue;
    const weight = run.reduce((sum, column) => sum + column.score, 0);
    const centerX = run.reduce((sum, column) => sum + column.x * column.score, 0) / Math.max(weight, 1e-6);
    const strength = run.reduce((sum, column) => sum + column.strength * column.score, 0) / Math.max(weight, 1e-6);
    const darkRatio = run.reduce((sum, column) => sum + column.darkRatio * column.score, 0) / Math.max(weight, 1e-6);
    const width = run[run.length - 1].x - run[0].x + 1;
    const key = mapRunToKey(keys, centerX, width, strength, darkRatio);
    if (!key) continue;

    const confidence = clamp(
      (weight / Math.max(1, run.length)) * 0.58
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

  suppressWeakBlackCandidates(keys, candidates, settings.blackGuard);
  return candidates;
}

function averageLumaInRect(buffer: PixelBuffer, rect: Rect) {
  const x0 = clamp(Math.floor(rect.x) - buffer.x, 0, buffer.width - 1);
  const y0 = clamp(Math.floor(rect.y) - buffer.y, 0, buffer.height - 1);
  const x1 = clamp(Math.ceil(rect.x + rect.w) - buffer.x, x0 + 1, buffer.width);
  const y1 = clamp(Math.ceil(rect.y + rect.h) - buffer.y, y0 + 1, buffer.height);
  let sum = 0;
  let hot = 0;
  let count = 0;

  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const index = (y * buffer.width + x) * 4;
      const luma = 0.2126 * buffer.data[index]
        + 0.7152 * buffer.data[index + 1]
        + 0.0722 * buffer.data[index + 2];
      sum += luma;
      if (luma > 148) hot += 1;
      count += 1;
    }
  }

  return sum / Math.max(1, count) + (hot / Math.max(1, count)) * 72;
}

export function measureKeyGlow(
  ctx: CanvasRenderingContext2D,
  keyboardRect: Rect,
  keys: PianoKey[],
) {
  const buffer = readRect(ctx, keyboardRect);
  const scores = new Map<number, number>();
  if (!buffer) return scores;
  for (const key of keys) scores.set(key.midi, averageLumaInRect(buffer, key));
  return scores;
}
