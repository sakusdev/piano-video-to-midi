export type MidiNoteEvent = {
  midi: number;
  startMs: number;
  endMs: number;
  velocity: number;
};

export type DenoiseOptions = {
  minDurationMs: number;
  mergeGapMs: number;
  onsetSnapMs: number;
  orphanWindowMs: number;
  maxOrphanDurationMs: number;
};

const DEFAULT_OPTIONS: DenoiseOptions = {
  minDurationMs: 45,
  mergeGapMs: 35,
  onsetSnapMs: 28,
  orphanWindowMs: 55,
  maxOrphanDurationMs: 115,
};

function cloneSorted(events: MidiNoteEvent[]) {
  return [...events]
    .filter((e) => Number.isFinite(e.startMs) && Number.isFinite(e.endMs) && e.endMs > e.startMs)
    .map((e) => ({ ...e }))
    .sort((a, b) => a.startMs - b.startMs || a.midi - b.midi || a.endMs - b.endMs);
}

function snapOnsets(events: MidiNoteEvent[], windowMs: number) {
  const sorted = cloneSorted(events);
  let i = 0;
  while (i < sorted.length) {
    const group = [sorted[i]];
    let j = i + 1;
    while (j < sorted.length && sorted[j].startMs - group[0].startMs <= windowMs) {
      group.push(sorted[j]);
      j += 1;
    }

    if (group.length >= 2) {
      const strongest = group.reduce((best, e) => (e.velocity > best.velocity ? e : best), group[0]);
      const snappedStart = strongest.startMs;
      for (const e of group) {
        const duration = e.endMs - e.startMs;
        e.startMs = snappedStart;
        e.endMs = Math.max(e.startMs + 1, snappedStart + duration);
      }
    }
    i = j;
  }
  return sorted;
}

function mergeSamePitch(events: MidiNoteEvent[], gapMs: number) {
  const byPitch = new Map<number, MidiNoteEvent[]>();
  for (const e of cloneSorted(events)) {
    const list = byPitch.get(e.midi) ?? [];
    list.push(e);
    byPitch.set(e.midi, list);
  }

  const merged: MidiNoteEvent[] = [];
  for (const list of byPitch.values()) {
    list.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    for (const e of list) {
      const prev = merged.length > 0 ? merged[merged.length - 1] : undefined;
      if (prev && prev.midi === e.midi && e.startMs <= prev.endMs + gapMs) {
        prev.endMs = Math.max(prev.endMs, e.endMs);
        prev.velocity = Math.max(prev.velocity, e.velocity);
      } else {
        merged.push({ ...e });
      }
    }
  }
  return cloneSorted(merged);
}

function removeShortEvents(events: MidiNoteEvent[], minDurationMs: number) {
  return cloneSorted(events).filter((e) => e.endMs - e.startMs >= minDurationMs);
}

function removeOrphans(events: MidiNoteEvent[], windowMs: number, maxDurationMs: number) {
  const sorted = cloneSorted(events);
  return sorted.filter((e, idx) => {
    const duration = e.endMs - e.startMs;
    if (duration > maxDurationMs) return true;

    const hasNeighbor = sorted.some((other, j) => {
      if (j === idx) return false;
      if (Math.abs(other.startMs - e.startMs) > windowMs) return false;
      const interval = Math.abs(other.midi - e.midi);
      return interval <= 12;
    });

    return hasNeighbor;
  });
}

function trimOverlaps(events: MidiNoteEvent[]) {
  const sorted = cloneSorted(events);
  const byPitch = new Map<number, MidiNoteEvent[]>();
  for (const e of sorted) {
    const list = byPitch.get(e.midi) ?? [];
    list.push(e);
    byPitch.set(e.midi, list);
  }

  const out: MidiNoteEvent[] = [];
  for (const list of byPitch.values()) {
    list.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    for (let i = 0; i < list.length; i += 1) {
      const current = { ...list[i] };
      const next = list[i + 1];
      if (next && current.endMs > next.startMs) {
        current.endMs = Math.max(current.startMs + 1, next.startMs);
      }
      out.push(current);
    }
  }
  return cloneSorted(out);
}

export function denoiseMidiEvents(events: MidiNoteEvent[], options: Partial<DenoiseOptions> = {}) {
  const opt = { ...DEFAULT_OPTIONS, ...options };
  let result = cloneSorted(events);
  result = snapOnsets(result, opt.onsetSnapMs);
  result = mergeSamePitch(result, opt.mergeGapMs);
  result = removeShortEvents(result, opt.minDurationMs);
  result = removeOrphans(result, opt.orphanWindowMs, opt.maxOrphanDurationMs);
  result = trimOverlaps(result);
  result = mergeSamePitch(result, opt.mergeGapMs * 0.5);
  return cloneSorted(result);
}

export function normalizeMidiEvents(events: MidiNoteEvent[], leadMs = 0) {
  const sorted = cloneSorted(events);
  if (sorted.length === 0) return [];
  const first = Math.min(...sorted.map((e) => e.startMs));
  return sorted.map((e) => ({
    ...e,
    startMs: Math.max(0, e.startMs - first + leadMs),
    endMs: Math.max(1, e.endMs - first + leadMs),
  }));
}
