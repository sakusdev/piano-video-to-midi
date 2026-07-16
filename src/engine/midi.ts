import { clamp } from "./geometry";
import type { NoteEvent } from "./types";

function writeVariableLength(value: number) {
  let buffer = value & 0x7f;
  const output: number[] = [];
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
  }
  while (true) {
    output.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return output;
}

const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0));
const u16 = (value: number) => [(value >>> 8) & 255, value & 255];
const u32 = (value: number) => [
  (value >>> 24) & 255,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255,
];

export function buildMidi(events: NoteEvent[], bpm = 120) {
  const ppq = 960;
  const ticksPerMs = ppq * bpm / 60000;
  type RawEvent = { tick: number; order: number; bytes: number[] };
  const rawEvents: RawEvent[] = [];
  const microsecondsPerQuarter = Math.round(60000000 / bpm);
  const trackName = ascii("Piano Video to MIDI");

  rawEvents.push({
    tick: 0,
    order: 0,
    bytes: [0xff, 0x03, trackName.length, ...trackName],
  });
  rawEvents.push({
    tick: 0,
    order: 1,
    bytes: [
      0xff,
      0x51,
      0x03,
      (microsecondsPerQuarter >>> 16) & 255,
      (microsecondsPerQuarter >>> 8) & 255,
      microsecondsPerQuarter & 255,
    ],
  });

  for (const event of events) {
    const startTick = Math.max(0, Math.round(event.startMs * ticksPerMs));
    const endTick = Math.max(startTick + 1, Math.round(event.endMs * ticksPerMs));
    const note = clamp(Math.round(event.midi), 0, 127);
    const velocity = clamp(Math.round(event.velocity), 1, 127);
    rawEvents.push({ tick: startTick, order: 3, bytes: [0x90, note, velocity] });
    rawEvents.push({ tick: endTick, order: 2, bytes: [0x80, note, 0] });
  }

  rawEvents.sort((a, b) => a.tick - b.tick || a.order - b.order || (a.bytes[1] ?? 0) - (b.bytes[1] ?? 0));
  const track: number[] = [];
  let currentTick = 0;
  for (const event of rawEvents) {
    track.push(...writeVariableLength(Math.max(0, event.tick - currentTick)), ...event.bytes);
    currentTick = event.tick;
  }
  track.push(0, 0xff, 0x2f, 0);

  return new Uint8Array([
    ...ascii("MThd"),
    ...u32(6),
    ...u16(0),
    ...u16(1),
    ...u16(ppq),
    ...ascii("MTrk"),
    ...u32(track.length),
    ...track,
  ]);
}
