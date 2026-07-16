import { clamp } from "./geometry";
import type { AudioOnset, NoteEvent } from "./types";

function nearestOnset(onsets: AudioOnset[], ms: number, windowMs: number) {
  let selected: AudioOnset | undefined;
  let bestDistance = windowMs + 1;
  for (const onset of onsets) {
    if (onset.ms < ms - windowMs) continue;
    if (onset.ms > ms + windowMs) break;
    const distance = Math.abs(onset.ms - ms);
    if (distance < bestDistance) {
      selected = onset;
      bestDistance = distance;
    }
  }
  return selected;
}

function hasOnsetBetween(onsets: AudioOnset[], startMs: number, endMs: number) {
  return onsets.some((onset) => onset.strength >= 0.12 && onset.ms >= startMs && onset.ms <= endMs);
}

function mergeFragments(events: NoteEvent[], minimumNoteMs: number, onsets: AudioOnset[]) {
  const sorted = [...events]
    .filter((event) => event.endMs - event.startMs >= Math.max(8, minimumNoteMs * 0.45))
    .sort((a, b) => a.midi - b.midi || a.startMs - b.startMs);
  const merged: NoteEvent[] = [];

  for (const event of sorted) {
    const previous = merged[merged.length - 1];
    const gap = previous && previous.midi === event.midi ? event.startMs - previous.endMs : Infinity;
    const repeatEvidence = previous
      ? hasOnsetBetween(onsets, Math.max(previous.endMs - 12, previous.startMs), event.startMs + 20)
      : false;

    if (previous && previous.midi === event.midi && gap <= 20 && !repeatEvidence) {
      previous.endMs = Math.max(previous.endMs, event.endMs);
      previous.velocity = Math.max(previous.velocity, event.velocity);
      previous.confidence = Math.max(previous.confidence, event.confidence);
      continue;
    }

    merged.push({ ...event });
  }

  return merged.sort((a, b) => a.startMs - b.startMs || a.midi - b.midi);
}

function isRolledGroup(group: NoteEvent[]) {
  if (group.length < 3) return false;
  const ordered = [...group].sort((a, b) => a.startMs - b.startMs || a.midi - b.midi);
  const direction = Math.sign(ordered[ordered.length - 1].midi - ordered[0].midi);
  if (direction === 0) return false;
  let directionalSteps = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    if ((ordered[index].midi - ordered[index - 1].midi) * direction > 0) directionalSteps += 1;
  }
  const pitchSpan = Math.max(...ordered.map((event) => event.midi)) - Math.min(...ordered.map((event) => event.midi));
  const timeSpan = ordered[ordered.length - 1].startMs - ordered[0].startMs;
  return pitchSpan >= 4 && timeSpan >= 18 && directionalSteps >= ordered.length - 2;
}

function alignChords(events: NoteEvent[]) {
  const sorted = [...events].sort((a, b) => a.startMs - b.startMs || a.midi - b.midi);
  let index = 0;

  while (index < sorted.length) {
    const group = [sorted[index]];
    let next = index + 1;
    while (next < sorted.length && sorted[next].startMs - group[0].startMs <= 24) {
      group.push(sorted[next]);
      next += 1;
    }

    if (group.length > 1 && !isRolledGroup(group)) {
      const totalWeight = group.reduce(
        (sum, event) => sum + Math.max(0.2, event.confidence) * Math.max(24, event.velocity),
        0,
      );
      const alignedStart = Math.round(group.reduce(
        (sum, event) => sum + event.startMs * Math.max(0.2, event.confidence) * Math.max(24, event.velocity),
        0,
      ) / Math.max(1, totalWeight));
      for (const event of group) {
        const duration = event.endMs - event.startMs;
        event.startMs = alignedStart;
        event.endMs = Math.max(alignedStart + 1, alignedStart + duration);
      }
    }

    index = next;
  }

  return sorted.sort((a, b) => a.startMs - b.startMs || a.midi - b.midi);
}

function snapToAudio(events: NoteEvent[], onsets: AudioOnset[]) {
  if (!onsets.length) return events;
  return events.map((event) => {
    const onset = nearestOnset(onsets, event.startMs, 26);
    if (!onset || onset.strength < 0.08) return { ...event };
    const maximumShift = event.confidence >= 0.72 ? 14 : 24;
    const shift = clamp(onset.ms - event.startMs, -maximumShift, maximumShift);
    return {
      ...event,
      startMs: event.startMs + shift,
      endMs: Math.max(event.startMs + shift + 1, event.endMs + shift),
      confidence: clamp(event.confidence + onset.strength * 0.08, 0, 1),
    };
  });
}

export function finalizeNoteEvents(
  input: NoteEvent[],
  minimumNoteMs: number,
  onsets: AudioOnset[],
  leadMs: number,
) {
  const audioSorted = [...onsets].sort((a, b) => a.ms - b.ms);
  const merged = mergeFragments(input, minimumNoteMs, audioSorted);
  const snapped = snapToAudio(merged, audioSorted);
  const aligned = alignChords(snapped)
    .filter((event) => event.endMs - event.startMs >= minimumNoteMs)
    .filter((event) => event.confidence >= 0.16);

  if (!aligned.length) return [];
  const firstStart = Math.min(...aligned.map((event) => event.startMs));
  return aligned.map((event) => ({
    ...event,
    startMs: Math.max(0, event.startMs - firstStart + leadMs),
    endMs: Math.max(1, event.endMs - firstStart + leadMs),
  }));
}
