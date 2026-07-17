import assert from "node:assert/strict";
import {
  glowSampleRect,
  mapRunToPianoKey,
} from "../src/engine/key-mapping.ts";

const keys = [
  { midi: 60, isBlack: false, x: 0, y: 57, w: 10, h: 39 },
  { midi: 61, isBlack: true, x: 7.3, y: 3.5, w: 5.4, h: 50 },
  { midi: 62, isBlack: false, x: 10, y: 57, w: 10, h: 39 },
  { midi: 63, isBlack: true, x: 17.3, y: 3.5, w: 5.4, h: 50 },
  { midi: 64, isBlack: false, x: 20, y: 57, w: 10, h: 39 },
  { midi: 65, isBlack: false, x: 30, y: 57, w: 10, h: 39 },
];

const whiteCenter = mapRunToPianoKey(keys, 5, 7, 50);
assert.equal(whiteCenter?.key.midi, 60, "A centered white-key run must remain white");

const darkLookingWhite = mapRunToPianoKey(keys, 6.8, 7.2, 50);
assert.equal(
  darkLookingWhite?.key.midi,
  60,
  "A wide or shadowed white-key run near a black key must default to white",
);

const blackCenter = mapRunToPianoKey(keys, 10, 4.4, 50);
assert.equal(blackCenter?.key.midi, 61, "A narrow run centered in a black lane must map to black");

const ambiguousWideRun = mapRunToPianoKey(keys, 9.2, 9, 50);
assert.equal(
  ambiguousWideRun?.key.isBlack,
  false,
  "An ambiguous run spanning both lanes must fail safe to white",
);

const efGap = mapRunToPianoKey(keys, 25, 7, 50);
assert.equal(efGap?.key.isBlack, false, "The E-F gap must never synthesize a black key");

for (const key of keys) {
  const sample = glowSampleRect(key);
  assert.ok(sample.x > key.x && sample.y > key.y, "Glow ROI must be inset from borders");
  assert.ok(sample.x + sample.w < key.x + key.w, "Glow ROI must not cross horizontal borders");
  assert.ok(sample.y + sample.h < key.y + key.h, "Glow ROI must not cross vertical borders");
}

const whiteSample = glowSampleRect(keys[0]);
const blackSample = glowSampleRect(keys[1]);
assert.ok(whiteSample.y > blackSample.y, "White glow must be sampled below black-key shadows");

console.log("Key mapping regression tests passed.");
