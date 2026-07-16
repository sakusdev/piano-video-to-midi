import type { KeyboardGeometry, PianoKey, Rect } from "./types";

const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK_AFTER_WHITE = new Set(["A", "C", "D", "F", "G"]);

export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export const isBlackMidi = (midi: number) => BLACK_PITCH_CLASSES.has(midi % 12);

export const midiName = (midi: number) =>
  `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

function whiteIndexToMidi(index: number) {
  let whiteIndex = -1;
  for (let midi = 21; midi <= 108; midi += 1) {
    if (isBlackMidi(midi)) continue;
    whiteIndex += 1;
    if (whiteIndex === index) return midi;
  }
  return 108;
}

export function buildPianoKeys(rect: Rect): PianoKey[] {
  const keys: PianoKey[] = [];
  const whiteWidth = rect.w / 52;
  let whiteIndex = 0;

  for (let midi = 21; midi <= 108; midi += 1) {
    if (isBlackMidi(midi)) continue;
    keys.push({
      midi,
      name: midiName(midi),
      isBlack: false,
      whiteIndex,
      x: rect.x + whiteIndex * whiteWidth,
      y: rect.y + rect.h * 0.57,
      w: whiteWidth,
      h: rect.h * 0.39,
    });
    whiteIndex += 1;
  }

  for (let index = 0; index < 51; index += 1) {
    const leftMidi = whiteIndexToMidi(index);
    if (!BLACK_AFTER_WHITE.has(NOTE_NAMES[leftMidi % 12])) continue;
    const midi = leftMidi + 1;
    if (midi < 21 || midi > 108) continue;
    keys.push({
      midi,
      name: midiName(midi),
      isBlack: true,
      whiteIndex: index,
      x: rect.x + (index + 1) * whiteWidth - whiteWidth * 0.27,
      y: rect.y + rect.h * 0.035,
      w: whiteWidth * 0.54,
      h: rect.h * 0.5,
    });
  }

  return keys.sort((a, b) => Number(a.isBlack) - Number(b.isBlack) || a.midi - b.midi);
}

function rgbToHsv(r: number, g: number, b: number) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;

  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

function isWhitePixel(r: number, g: number, b: number) {
  const hsv = rgbToHsv(r, g, b);
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luma > 142 && hsv.s < 0.32 && hsv.v > 0.52;
}

function scoreBlackPattern(ctx: CanvasRenderingContext2D, rect: Rect) {
  const whiteWidth = rect.w / 52;
  const top = clamp(Math.round(rect.y + rect.h * 0.04), 0, ctx.canvas.height - 1);
  const bottom = clamp(Math.round(rect.y + rect.h * 0.52), top + 1, ctx.canvas.height);
  let blackHits = 0;
  let whiteGapHits = 0;

  for (let index = 0; index < 51; index += 1) {
    const leftMidi = whiteIndexToMidi(index);
    const shouldHaveBlack = BLACK_AFTER_WHITE.has(NOTE_NAMES[leftMidi % 12]);
    const center = Math.round(rect.x + (index + 1) * whiteWidth);
    const x0 = clamp(Math.round(center - whiteWidth * 0.2), 0, ctx.canvas.width - 1);
    const x1 = clamp(Math.round(center + whiteWidth * 0.2), x0 + 1, ctx.canvas.width);
    const data = ctx.getImageData(x0, top, x1 - x0, bottom - top).data;
    let dark = 0;
    let count = 0;

    for (let i = 0; i < data.length; i += 4) {
      const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (luma < 88) dark += 1;
      count += 1;
    }

    const ratio = dark / Math.max(1, count);
    if (shouldHaveBlack && ratio > 0.2) blackHits += 1;
    if (!shouldHaveBlack && ratio < 0.2) whiteGapHits += 1;
  }

  return clamp((blackHits / 36) * 0.72 + (whiteGapHits / 15) * 0.28, 0, 1);
}

export function estimateKeyboardGeometry(ctx: CanvasRenderingContext2D): KeyboardGeometry {
  const { width, height } = ctx.canvas;
  const rowScores = new Float32Array(height);
  const startY = Math.round(height * 0.38);
  const endY = Math.round(height * 0.99);

  for (let y = startY; y < endY; y += 1) {
    const data = ctx.getImageData(0, y, width, 1).data;
    let white = 0;
    let transitions = 0;
    let previous = false;
    for (let x = 0; x < width; x += 1) {
      const i = x * 4;
      const current = isWhitePixel(data[i], data[i + 1], data[i + 2]);
      if (current) white += 1;
      if (x > 0 && current !== previous) transitions += 1;
      previous = current;
    }
    rowScores[y] = (white / Math.max(1, width)) * 0.72 + clamp(transitions / 130, 0, 1) * 0.28;
  }

  let bestStart = Math.round(height * 0.64);
  let bestEnd = Math.round(height * 0.92);
  let bestScore = -Infinity;
  let runStart = -1;

  for (let y = startY; y < endY; y += 1) {
    const active = rowScores[y] > 0.235;
    if (active && runStart < 0) runStart = y;
    if ((!active || y === endY - 1) && runStart >= 0) {
      const runEnd = active ? y : y - 1;
      const length = runEnd - runStart + 1;
      let sum = 0;
      for (let row = runStart; row <= runEnd; row += 1) sum += rowScores[row];
      const average = sum / Math.max(1, length);
      const expected = height * 0.28;
      const score = average * Math.sqrt(length) - (Math.abs(length - expected) / height) * 0.42;
      if (score > bestScore) {
        bestScore = score;
        bestStart = runStart;
        bestEnd = runEnd;
      }
      runStart = -1;
    }
  }

  const y = clamp(bestStart, 0, height - 20);
  const h = clamp(bestEnd - bestStart + 1, 40, Math.round(height * 0.52));
  const sampleY0 = clamp(Math.round(y + h * 0.58), 0, height - 1);
  const sampleY1 = clamp(Math.round(y + h * 0.95), sampleY0 + 1, height);
  const columnScores = new Float32Array(width);

  for (let x = 0; x < width; x += 1) {
    const data = ctx.getImageData(x, sampleY0, 1, sampleY1 - sampleY0).data;
    let white = 0;
    for (let row = 0; row < sampleY1 - sampleY0; row += 1) {
      const i = row * 4;
      if (isWhitePixel(data[i], data[i + 1], data[i + 2])) white += 1;
    }
    columnScores[x] = white / Math.max(1, sampleY1 - sampleY0);
  }

  let x0 = 0;
  let x1 = width - 1;
  while (x0 < width && columnScores[x0] < 0.14) x0 += 1;
  while (x1 > x0 && columnScores[x1] < 0.14) x1 -= 1;

  const margin = Math.max(2, Math.round(width * 0.006));
  const rect: Rect = {
    x: clamp(x0 - margin, -Math.round(width * 0.55), width),
    y,
    w: clamp(x1 - x0 + 1 + margin * 2, 20, Math.round(width * 1.9)),
    h,
  };
  const whiteScore = clamp(bestScore * 0.54, 0, 1);
  const patternScore = scoreBlackPattern(ctx, rect);
  return {
    rect,
    whiteScore,
    patternScore,
    confidence: clamp(whiteScore * 0.44 + patternScore * 0.56, 0, 1),
  };
}

export function medianKeyboardGeometry(
  geometries: KeyboardGeometry[],
  fallback: Rect,
): KeyboardGeometry {
  const confident = geometries.filter((geometry) => geometry.confidence >= 0.32);
  const source = confident.length ? confident : geometries;
  if (!source.length) {
    return { rect: fallback, confidence: 0, patternScore: 0, whiteScore: 0 };
  }

  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  return {
    rect: {
      x: Math.round(median(source.map((geometry) => geometry.rect.x))),
      y: Math.round(median(source.map((geometry) => geometry.rect.y))),
      w: Math.round(median(source.map((geometry) => geometry.rect.w))),
      h: Math.round(median(source.map((geometry) => geometry.rect.h))),
    },
    confidence: source.reduce((sum, geometry) => sum + geometry.confidence, 0) / source.length,
    patternScore: source.reduce((sum, geometry) => sum + geometry.patternScore, 0) / source.length,
    whiteScore: source.reduce((sum, geometry) => sum + geometry.whiteScore, 0) / source.length,
  };
}
