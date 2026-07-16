import { clamp } from "./geometry";
import type { VisionFrameAnalysis } from "./vision-worker";
import type {
  ActiveNote,
  AudioOnset,
  DetectionMode,
  NoteEvent,
  PianoKey,
} from "./types";

type SignalState = { visualEma: number; glowEma: number };

export type FrameAnalyzerSettings = {
  mode: DetectionMode;
  threshold: number;
  colorTolerance: number;
  blackGuard: number;
  handSplit: number;
  leftHue: number;
  rightHue: number;
  lineOffset: number;
  lineHeight: number;
  confirmFrames: number;
  minimumNoteMs: number;
};

export type FrameProcessResult = {
  added: NoteEvent[];
  activeCount: number;
};

export class FrameAnalyzer {
  private baseline = new Map<number, number>();
  private signals = new Map<number, SignalState>();
  private active = new Map<number, ActiveNote>();
  private pendingOn = new Map<number, number>();
  private pendingOff = new Map<number, number>();
  private rawEvents: NoteEvent[] = [];
  private lastAudioSplitMs = -Infinity;
  private frameDurationMs = 16.7;
  private lastFrameMs = -1;

  reset() {
    this.baseline.clear();
    this.signals.clear();
    this.active.clear();
    this.pendingOn.clear();
    this.pendingOff.clear();
    this.rawEvents = [];
    this.lastAudioSplitMs = -Infinity;
    this.frameDurationMs = 16.7;
    this.lastFrameMs = -1;
  }

  get events() {
    return this.rawEvents;
  }

  get activeMidis() {
    return new Set(this.active.keys());
  }

  get activeCount() {
    return this.active.size;
  }

  private closeNote(midi: number, active: ActiveNote, endMs: number, minimumNoteMs: number) {
    const durationMs = endMs - active.startMs;
    if (durationMs < Math.max(10, minimumNoteMs * 0.5)) return undefined;
    const confidence = clamp(active.confidenceSum / Math.max(1, active.samples), 0, 1);
    const velocity = clamp(Math.round(42 + active.peakStrength * 0.84 + confidence * 24), 28, 127);
    const event: NoteEvent = {
      midi,
      startMs: active.startMs,
      endMs: Math.max(active.startMs + 1, endMs),
      velocity,
      confidence,
    };
    this.rawEvents.push(event);
    return event;
  }

  finish(nowMs: number, minimumNoteMs: number) {
    const added: NoteEvent[] = [];
    for (const [midi, active] of this.active) {
      const event = this.closeNote(
        midi,
        active,
        Math.max(nowMs, active.startMs + minimumNoteMs),
        minimumNoteMs,
      );
      if (event) added.push(event);
    }
    this.active.clear();
    return added;
  }

  process(
    nowMs: number,
    keys: PianoKey[],
    settings: FrameAnalyzerSettings,
    vision: VisionFrameAnalysis,
    audioOnset?: AudioOnset,
  ): FrameProcessResult {
    if (this.lastFrameMs >= 0) {
      const delta = nowMs - this.lastFrameMs;
      if (delta > 0 && delta < 150) {
        this.frameDurationMs = this.frameDurationMs * 0.82 + delta * 0.18;
      }
    }
    this.lastFrameMs = nowMs;

    const candidates = vision.candidates;
    const glowScores = vision.glowScores;
    const audioHit = Boolean(audioOnset && audioOnset.strength >= 0.07);
    const frameCorrection = (settings.confirmFrames - 1) * this.frameDurationMs;
    const added: NoteEvent[] = [];

    for (const key of keys) {
      const candidate = candidates.get(key.midi);
      const glow = glowScores.get(key.midi) ?? 0;
      const baseline = this.baseline.get(key.midi) ?? glow;
      const glowDifference = Math.max(0, glow - baseline);
      const signal = this.signals.get(key.midi) ?? { visualEma: 0, glowEma: 0 };
      const visualValue = candidate?.confidence ?? 0;
      signal.visualEma = signal.visualEma * 0.48 + visualValue * 0.52;
      signal.glowEma = signal.glowEma * 0.72 + glowDifference * 0.28;
      this.signals.set(key.midi, signal);

      const active = this.active.get(key.midi);
      const visualStrong = signal.visualEma >= 0.34 + settings.threshold / 300;
      const visualWeak = signal.visualEma >= 0.2 + settings.threshold / 520;
      const glowStrong = signal.glowEma >= settings.threshold * (key.isBlack ? 0.72 : 0.86);
      const shouldStart = settings.mode === "visual"
        ? visualStrong
        : settings.mode === "glow"
          ? glowStrong
          : visualStrong || (visualWeak && (audioHit || glowStrong)) || (glowStrong && candidate !== undefined);
      const shouldEnd = settings.mode === "visual"
        ? signal.visualEma < 0.13
        : settings.mode === "glow"
          ? signal.glowEma < settings.threshold * 0.26
          : signal.visualEma < 0.12 && signal.glowEma < settings.threshold * 0.32;
      const strength = Math.max(candidate?.strength ?? 0, glowDifference * 1.15);
      const frameConfidence = clamp(
        signal.visualEma * 0.72
        + clamp(signal.glowEma / Math.max(1, settings.threshold * 1.6), 0, 1) * 0.18
        + (audioHit ? (audioOnset?.strength ?? 0) * 0.1 : 0),
        0,
        1,
      );

      if (!active && !candidate && glowDifference < settings.threshold * 0.55) {
        this.baseline.set(key.midi, baseline * 0.975 + glow * 0.025);
      }

      if (
        active
        && audioHit
        && candidate
        && nowMs - active.startMs > Math.max(78, settings.minimumNoteMs * 0.9)
        && nowMs - this.lastAudioSplitMs > 48
      ) {
        const event = this.closeNote(
          key.midi,
          active,
          Math.max(active.startMs + 1, nowMs - frameCorrection),
          settings.minimumNoteMs,
        );
        if (event) added.push(event);
        const startMs = Math.max(0, nowMs - frameCorrection);
        this.active.set(key.midi, {
          startMs,
          peakStrength: strength,
          confidenceSum: frameConfidence,
          samples: 1,
        });
        this.pendingOn.set(key.midi, 0);
        this.pendingOff.set(key.midi, 0);
        this.lastAudioSplitMs = nowMs;
        continue;
      }

      if (!active) {
        if (shouldStart) {
          const increment = audioHit && visualWeak ? settings.confirmFrames : 1;
          const pending = (this.pendingOn.get(key.midi) ?? 0) + increment;
          this.pendingOn.set(key.midi, pending);
          this.pendingOff.set(key.midi, 0);
          if (pending >= settings.confirmFrames) {
            const startMs = Math.max(0, nowMs - frameCorrection);
            this.active.set(key.midi, {
              startMs,
              peakStrength: strength,
              confidenceSum: frameConfidence,
              samples: 1,
            });
            this.pendingOn.set(key.midi, 0);
          }
        } else {
          this.pendingOn.set(key.midi, 0);
        }
        continue;
      }

      active.peakStrength = Math.max(active.peakStrength, strength);
      active.confidenceSum += frameConfidence;
      active.samples += 1;
      if (shouldEnd) {
        const pending = (this.pendingOff.get(key.midi) ?? 0) + 1;
        this.pendingOff.set(key.midi, pending);
        if (pending >= settings.confirmFrames) {
          const event = this.closeNote(
            key.midi,
            active,
            Math.max(active.startMs + 1, nowMs - frameCorrection),
            settings.minimumNoteMs,
          );
          if (event) added.push(event);
          this.active.delete(key.midi);
          this.pendingOff.set(key.midi, 0);
        }
      } else {
        this.pendingOff.set(key.midi, 0);
      }
    }

    return { added, activeCount: this.active.size };
  }
}
