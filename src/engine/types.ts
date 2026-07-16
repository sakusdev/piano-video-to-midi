export type Rect = { x: number; y: number; w: number; h: number };

export type PianoKey = Rect & {
  midi: number;
  name: string;
  isBlack: boolean;
  whiteIndex: number;
};

export type NoteEvent = {
  midi: number;
  startMs: number;
  endMs: number;
  velocity: number;
  confidence: number;
};

export type ActiveNote = {
  startMs: number;
  peakStrength: number;
  confidenceSum: number;
  samples: number;
};

export type DetectionCandidate = {
  midi: number;
  strength: number;
  confidence: number;
  centerX: number;
  width: number;
  darkRatio: number;
};

export type KeyboardGeometry = {
  rect: Rect;
  confidence: number;
  patternScore: number;
  whiteScore: number;
};

export type AudioOnset = {
  ms: number;
  strength: number;
};

export type DetectionMode = "balanced" | "visual" | "glow";
export type AnalysisQuality = "fast" | "balanced" | "accurate";
