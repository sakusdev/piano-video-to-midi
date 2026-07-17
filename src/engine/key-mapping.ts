export type KeyLane = {
  midi: number;
  isBlack: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type KeyMapping = {
  key: KeyLane;
  laneConfidence: number;
};

export type SampleRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

function closestKey(keys: KeyLane[], centerX: number, isBlack: boolean) {
  let selected: KeyLane | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const key of keys) {
    if (key.isBlack !== isBlack) continue;
    const distance = Math.abs(key.x + key.w / 2 - centerX);
    if (distance < bestDistance) {
      selected = key;
      bestDistance = distance;
    }
  }
  return selected ? { key: selected, distance: bestDistance } : undefined;
}

function overlapWidth(leftA: number, rightA: number, leftB: number, rightB: number) {
  return Math.max(0, Math.min(rightA, rightB) - Math.max(leftA, leftB));
}

/**
 * Assigns a falling-note run to the fixed piano layout.
 *
 * Darkness is deliberately not used here. A white-key note can be dark because
 * of shadows, outlines or blending effects, but its horizontal lane does not
 * change. Ambiguous runs therefore fall back to the nearest white key.
 */
export function mapRunToPianoKey(
  keys: KeyLane[],
  centerX: number,
  runWidth: number,
  blackGuard: number,
): KeyMapping | undefined {
  if (!Number.isFinite(centerX) || !Number.isFinite(runWidth) || runWidth <= 0) return undefined;

  const nearestWhite = closestKey(keys, centerX, false);
  if (!nearestWhite) return undefined;
  const whiteHalfWidth = Math.max(0.5, nearestWhite.key.w / 2);
  const whiteDistance = nearestWhite.distance / whiteHalfWidth;

  const nearestBlack = closestKey(keys, centerX, true);
  if (!nearestBlack) {
    return {
      key: nearestWhite.key,
      laneConfidence: clamp(1 - whiteDistance * 0.45, 0.35, 1),
    };
  }

  const guard = clamp(blackGuard / 100, 0, 1);
  const black = nearestBlack.key;
  const blackHalfWidth = Math.max(0.5, black.w / 2);
  const blackDistance = nearestBlack.distance / blackHalfWidth;
  const runLeft = centerX - runWidth / 2;
  const runRight = centerX + runWidth / 2;
  const overlap = overlapWidth(runLeft, runRight, black.x, black.x + black.w);
  const runInsideBlackRatio = overlap / Math.max(1, runWidth);

  const centerLimit = 0.68 - guard * 0.12;
  const widthLimit = black.w * (1.48 - guard * 0.2);
  const overlapRequirement = 0.62 + guard * 0.08;
  const blackMustBeatWhiteBy = 0.16 + guard * 0.14;

  const structurallyBlack = blackDistance <= centerLimit
    && runWidth <= widthLimit
    && runInsideBlackRatio >= overlapRequirement
    && blackDistance + blackMustBeatWhiteBy < whiteDistance;

  if (!structurallyBlack) {
    return {
      key: nearestWhite.key,
      laneConfidence: clamp(1 - whiteDistance * 0.45, 0.35, 1),
    };
  }

  const laneConfidence = clamp(
    1
      - blackDistance * 0.42
      - Math.max(0, 1 - runInsideBlackRatio) * 0.34
      - Math.max(0, runWidth / Math.max(1, widthLimit) - 0.8) * 0.24,
    0.36,
    1,
  );
  return { key: black, laneConfidence };
}

/**
 * Returns an inset glow-sampling region. White keys are sampled only in their
 * lower body; black keys are sampled in their upper-middle body. This avoids
 * borders, shadows and neighboring-key spill.
 */
export function glowSampleRect(key: KeyLane): SampleRect {
  if (key.isBlack) {
    return {
      x: key.x + key.w * 0.16,
      y: key.y + key.h * 0.14,
      w: key.w * 0.68,
      h: key.h * 0.68,
    };
  }
  return {
    x: key.x + key.w * 0.18,
    y: key.y + key.h * 0.22,
    w: key.w * 0.64,
    h: key.h * 0.66,
  };
}
