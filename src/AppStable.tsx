import { useEffect, useMemo, useRef, useState } from "react";

type Rect = { x: number; y: number; w: number; h: number };
type KeyRegion = Rect & { midi: number; name: string; isBlack: boolean };
type NoteEvent = { midi: number; startMs: number; endMs: number; velocity: number };
type ActiveNote = { startMs: number; strength: number; onFrames: number; offFrames: number };
type DetectionMode = "hybrid" | "falling" | "glow";

type Hsv = { h: number; s: number; v: number };

const BLACK_NOTES = new Set([1, 3, 6, 8, 10]);
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const isBlackMidi = (midi: number) => BLACK_NOTES.has(midi % 12);
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function midiToName(midi: number) {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

function whiteIndexToMidi(index: number) {
  let count = -1;
  for (let midi = 21; midi <= 108; midi += 1) {
    if (!isBlackMidi(midi)) {
      count += 1;
      if (count === index) return midi;
    }
  }
  return 108;
}

function buildPianoRegions(rect: Rect): KeyRegion[] {
  const regions: KeyRegion[] = [];
  const whiteW = rect.w / 52;
  let whiteIndex = 0;

  for (let midi = 21; midi <= 108; midi += 1) {
    if (!isBlackMidi(midi)) {
      regions.push({
        midi,
        name: midiToName(midi),
        isBlack: false,
        x: rect.x + whiteIndex * whiteW,
        y: rect.y + rect.h * 0.58,
        w: whiteW,
        h: rect.h * 0.38,
      });
      whiteIndex += 1;
    }
  }

  const blackAfter = new Set(["A", "C", "D", "F", "G"]);
  for (let i = 0; i < 51; i += 1) {
    const leftMidi = whiteIndexToMidi(i);
    if (!blackAfter.has(NOTE_NAMES[leftMidi % 12])) continue;
    const midi = leftMidi + 1;
    if (midi < 21 || midi > 108) continue;
    regions.push({
      midi,
      name: midiToName(midi),
      isBlack: true,
      x: rect.x + (i + 1) * whiteW - whiteW * 0.3,
      y: rect.y + rect.h * 0.04,
      w: whiteW * 0.6,
      h: rect.h * 0.48,
    });
  }

  return regions.sort((a, b) => Number(a.isBlack) - Number(b.isBlack));
}

function rgbToHsv(r: number, g: number, b: number): Hsv {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;

  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

function hexToHue(hex: string) {
  const cleaned = hex.replace("#", "");
  const full = cleaned.length === 3 ? cleaned.split("").map((c) => c + c).join("") : cleaned;
  const value = Number.parseInt(full, 16);
  return rgbToHsv((value >> 16) & 255, (value >> 8) & 255, value & 255).h;
}

function hueDistance(a: number, b: number) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function safeImageData(ctx: CanvasRenderingContext2D, rect: Rect) {
  const x = clamp(Math.floor(rect.x), 0, ctx.canvas.width - 1);
  const y = clamp(Math.floor(rect.y), 0, ctx.canvas.height - 1);
  const w = clamp(Math.floor(rect.w), 1, ctx.canvas.width - x);
  const h = clamp(Math.floor(rect.h), 1, ctx.canvas.height - y);
  return ctx.getImageData(x, y, w, h);
}

function glowScore(ctx: CanvasRenderingContext2D, rect: Rect) {
  const image = safeImageData(ctx, rect);
  const data = image.data;
  let sum = 0;
  let hot = 0;
  let count = 0;

  for (let y = 0; y < image.height; y += 2) {
    for (let x = 0; x < image.width; x += 2) {
      const i = (y * image.width + x) * 4;
      const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += luma;
      if (luma > 145) hot += 1;
      count += 1;
    }
  }

  return sum / Math.max(1, count) + (hot / Math.max(1, count)) * 80;
}

function scanFallingLine(
  ctx: CanvasRenderingContext2D,
  key: KeyRegion,
  y: number,
  height: number,
  targetHues: number[],
  strictness: number,
) {
  const image = safeImageData(ctx, {
    x: key.x + key.w * 0.12,
    y,
    w: key.w * 0.76,
    h: height,
  });
  const data = image.data;
  let colorHits = 0;
  let strength = 0;
  let count = 0;

  const minSaturation = 0.18 + strictness * 0.006;
  const minValue = 0.28;
  const hueWindow = Math.max(12, 34 - strictness * 0.25);

  for (let i = 0; i < data.length; i += 4) {
    const hsv = rgbToHsv(data[i], data[i + 1], data[i + 2]);
    const hueHit = targetHues.some((hue) => hueDistance(hsv.h, hue) <= hueWindow);
    const hit = hueHit && hsv.s >= minSaturation && hsv.v >= minValue;
    if (hit) {
      colorHits += 1;
      strength += hsv.s * 105 + hsv.v * 35;
    }
    count += 1;
  }

  return {
    ratio: colorHits / Math.max(1, count),
    strength: strength / Math.max(1, count),
  };
}

function writeVarLen(value: number) {
  let buffer = value & 0x7f;
  const bytes: number[] = [];
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
  }
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return bytes;
}

function ascii(text: string) {
  return [...text].map((c) => c.charCodeAt(0));
}

function u16(n: number) {
  return [(n >>> 8) & 255, n & 255];
}

function u32(n: number) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function mergeEvents(events: NoteEvent[], minMs: number, gapMs = 22) {
  const sorted = [...events]
    .filter((e) => e.endMs - e.startMs >= minMs)
    .sort((a, b) => a.midi - b.midi || a.startMs - b.startMs);
  const merged: NoteEvent[] = [];

  for (const event of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && prev.midi === event.midi && event.startMs - prev.endMs <= gapMs) {
      prev.endMs = Math.max(prev.endMs, event.endMs);
      prev.velocity = Math.max(prev.velocity, event.velocity);
    } else {
      merged.push({ ...event });
    }
  }

  return merged.sort((a, b) => a.startMs - b.startMs || a.midi - b.midi);
}

function buildMidi(events: NoteEvent[], bpm = 120) {
  const ppq = 480;
  const ticksPerMs = (ppq * bpm) / 60000;
  type Raw = { tick: number; order: number; bytes: number[] };
  const raw: Raw[] = [];
  const tempo = Math.round(60000000 / bpm);

  raw.push({
    tick: 0,
    order: 0,
    bytes: [0xff, 0x51, 0x03, (tempo >>> 16) & 255, (tempo >>> 8) & 255, tempo & 255],
  });

  for (const event of events) {
    const start = Math.max(0, Math.round(event.startMs * ticksPerMs));
    const end = Math.max(start + 1, Math.round(event.endMs * ticksPerMs));
    const note = clamp(event.midi, 0, 127);
    raw.push({ tick: start, order: 2, bytes: [0x90, note, clamp(event.velocity, 1, 127)] });
    raw.push({ tick: end, order: 1, bytes: [0x80, note, 0] });
  }

  raw.sort((a, b) => a.tick - b.tick || a.order - b.order || a.bytes[1] - b.bytes[1]);

  const track: number[] = [];
  let cursor = 0;
  for (const event of raw) {
    track.push(...writeVarLen(Math.max(0, event.tick - cursor)), ...event.bytes);
    cursor = event.tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00);

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

function estimateKeyboardRect(ctx: CanvasRenderingContext2D): Rect {
  const { width, height } = ctx.canvas;
  return {
    x: Math.round(width * 0.02),
    y: Math.round(height * 0.68),
    w: Math.round(width * 0.96),
    h: Math.round(height * 0.27),
  };
}

export default function AppStable() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const videoUrlRef = useRef("");
  const lastFrameTimeRef = useRef(-1);

  const baselineRef = useRef<Map<number, number>>(new Map());
  const activeRef = useRef<Map<number, ActiveNote>>(new Map());
  const pendingOnRef = useRef<Map<number, number>>(new Map());
  const pendingOffRef = useRef<Map<number, number>>(new Map());
  const eventsRef = useRef<NoteEvent[]>([]);

  const [videoUrl, setVideoUrl] = useState("");
  const [keyboardRect, setKeyboardRect] = useState<Rect | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragRect, setDragRect] = useState<Rect | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [status, setStatus] = useState("動画を読み込み、Canvas上で鍵盤全体をドラッグ指定してください。");
  const [eventCount, setEventCount] = useState(0);

  const [mode, setMode] = useState<DetectionMode>("hybrid");
  const [threshold, setThreshold] = useState(18);
  const [lineOffset, setLineOffset] = useState(14);
  const [lineHeight, setLineHeight] = useState(4);
  const [colorStrictness, setColorStrictness] = useState(10);
  const [confirmFrames, setConfirmFrames] = useState(2);
  const [minNoteMs, setMinNoteMs] = useState(35);
  const [leftColor, setLeftColor] = useState("#6fb8ff");
  const [rightColor, setRightColor] = useState("#9bdc4b");
  const [handSplit, setHandSplit] = useState(50);

  const regions = useMemo(() => (keyboardRect ? buildPianoRegions(keyboardRect) : []), [keyboardRect]);
  const leftHue = useMemo(() => hexToHue(leftColor), [leftColor]);
  const rightHue = useMemo(() => hexToHue(rightColor), [rightColor]);

  function resetAnalysis() {
    baselineRef.current.clear();
    activeRef.current.clear();
    pendingOnRef.current.clear();
    pendingOffRef.current.clear();
    eventsRef.current = [];
    lastFrameTimeRef.current = -1;
    setEventCount(0);
  }

  function syncCanvasSize() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const scale = Math.min(1, 960 / (video.videoWidth || 1280));
    canvas.width = Math.max(1, Math.floor((video.videoWidth || 1280) * scale));
    canvas.height = Math.max(1, Math.floor((video.videoHeight || 720) * scale));

    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (!keyboardRect) setKeyboardRect(estimateKeyboardRect(ctx));
    }
    drawFrame();
  }

  function drawFrame() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!video || !canvas || !ctx || canvas.width === 0 || canvas.height === 0) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    if (keyboardRect) {
      ctx.save();
      ctx.strokeStyle = "#22d3ee";
      ctx.lineWidth = 2;
      ctx.strokeRect(keyboardRect.x, keyboardRect.y, keyboardRect.w, keyboardRect.h);

      const hitY = keyboardRect.y - keyboardRect.h * (lineOffset / 100);
      ctx.strokeStyle = "#facc15";
      ctx.beginPath();
      ctx.moveTo(keyboardRect.x, hitY);
      ctx.lineTo(keyboardRect.x + keyboardRect.w, hitY);
      ctx.stroke();

      for (const key of regions) {
        ctx.globalAlpha = activeRef.current.has(key.midi) ? 1 : key.isBlack ? 0.9 : 0.55;
        ctx.strokeStyle = activeRef.current.has(key.midi) ? "#a3e635" : key.isBlack ? "#ef4444" : "#06b6d4";
        ctx.lineWidth = activeRef.current.has(key.midi) ? 3 : 1;
        ctx.strokeRect(key.x, key.y, key.w, key.h);
      }
      ctx.restore();
    }

    if (dragRect) {
      ctx.save();
      ctx.strokeStyle = "#facc15";
      ctx.lineWidth = 2;
      ctx.strokeRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
      ctx.restore();
    }
  }

  function closeNote(midi: number, active: ActiveNote, endMs: number) {
    const duration = endMs - active.startMs;
    if (duration < minNoteMs) return;
    eventsRef.current.push({
      midi,
      startMs: active.startMs,
      endMs,
      velocity: clamp(Math.round(44 + active.strength * 1.15), 35, 120),
    });
    setEventCount(eventsRef.current.length);
  }

  function analyzeFrame() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!video || !canvas || !ctx || !keyboardRect) return;

    if (video.currentTime === lastFrameTimeRef.current) {
      rafRef.current = requestAnimationFrame(analyzeFrame);
      return;
    }
    lastFrameTimeRef.current = video.currentTime;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const nowMs = video.currentTime * 1000;
    const hitY = keyboardRect.y - keyboardRect.h * (lineOffset / 100);
    const splitX = keyboardRect.x + keyboardRect.w * (handSplit / 100);

    for (const key of regions) {
      const score = glowScore(ctx, key);
      const base = baselineRef.current.get(key.midi) ?? score;
      const glowDiff = score - base;
      const targetHues = key.x + key.w * 0.5 < splitX ? [leftHue] : [rightHue];
      const fall = scanFallingLine(ctx, key, hitY, lineHeight, targetHues, colorStrictness);

      const fallOn = fall.ratio > threshold / 100;
      const fallOff = fall.ratio < threshold / 260;
      const glowOn = glowDiff > threshold;
      const glowOff = glowDiff < threshold * 0.38;
      const shouldOn = mode === "hybrid" ? fallOn || glowOn : mode === "falling" ? fallOn : glowOn;
      const shouldOff = mode === "hybrid" ? fallOff && glowOff : mode === "falling" ? fallOff : glowOff;
      const strength = Math.max(Math.max(0, glowDiff), fall.strength);
      const active = activeRef.current.get(key.midi);

      if (!active && glowDiff < threshold * 0.65) {
        baselineRef.current.set(key.midi, base * 0.97 + score * 0.03);
      }

      if (!active) {
        if (shouldOn) {
          const count = (pendingOnRef.current.get(key.midi) ?? 0) + 1;
          pendingOnRef.current.set(key.midi, count);
          pendingOffRef.current.set(key.midi, 0);
          if (count >= confirmFrames) {
            activeRef.current.set(key.midi, {
              startMs: Math.max(0, nowMs - (confirmFrames - 1) * 16.7),
              strength,
              onFrames: count,
              offFrames: 0,
            });
            pendingOnRef.current.set(key.midi, 0);
          }
        } else {
          pendingOnRef.current.set(key.midi, 0);
        }
      } else {
        active.strength = Math.max(active.strength, strength);
        active.onFrames += 1;
        if (shouldOff) {
          const count = (pendingOffRef.current.get(key.midi) ?? 0) + 1;
          pendingOffRef.current.set(key.midi, count);
          active.offFrames = count;
          if (count >= confirmFrames) {
            closeNote(key.midi, active, Math.max(active.startMs + 1, nowMs - (confirmFrames - 1) * 16.7));
            activeRef.current.delete(key.midi);
            pendingOffRef.current.set(key.midi, 0);
          }
        } else {
          pendingOffRef.current.set(key.midi, 0);
          active.offFrames = 0;
        }
      }
    }

    drawFrame();
    if (!video.paused && !video.ended) rafRef.current = requestAnimationFrame(analyzeFrame);
    else {
      setIsAnalyzing(false);
      setStatus(video.ended ? "解析完了。MIDI出力できます。" : "解析停止。MIDI出力できます。");
    }
  }

  async function start() {
    const video = videoRef.current;
    if (!video || !keyboardRect) {
      setStatus("先に動画読み込みと鍵盤範囲指定をしてください。");
      return;
    }
    resetAnalysis();
    setIsAnalyzing(true);
    setStatus("解析中。緑枠が検出中のノートです。");
    try {
      await video.play();
      rafRef.current = requestAnimationFrame(analyzeFrame);
    } catch {
      setIsAnalyzing(false);
      setStatus("ブラウザが自動再生を止めました。動画の再生ボタンを押してからstartしてください。");
    }
  }

  function stop() {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    videoRef.current?.pause();
    setIsAnalyzing(false);
    setStatus("停止しました。");
  }

  function exportMidi() {
    const nowMs = (videoRef.current?.currentTime ?? 0) * 1000;
    for (const [midi, active] of activeRef.current.entries()) {
      closeNote(midi, active, Math.max(nowMs, active.startMs + minNoteMs));
    }
    activeRef.current.clear();

    const events = mergeEvents(eventsRef.current, minNoteMs);
    if (events.length === 0) {
      setStatus("ノートがありません。thresholdを下げるか、判定ライン位置を調整してください。");
      return;
    }

    const blob = new Blob([buildMidi(events)], { type: "audio/midi" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "piano-video.mid";
    a.click();
    URL.revokeObjectURL(url);
    setEventCount(events.length);
    setStatus(`MIDI出力完了: ${events.length} notes`);
  }

  function autoFitKeyboard() {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !video || !ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    setKeyboardRect(estimateKeyboardRect(ctx));
    setStatus("鍵盤範囲を仮配置しました。必要ならCanvasをドラッグし直してください。");
  }

  function canvasPoint(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    };
  }, []);

  return (
    <div className="app-shell">
      <div className="app-container">
        <div>
          <h1 className="app-title">Perfect Piano Video → MIDI</h1>
          <p className="app-subtitle">信頼性重視版: 落下ノーツ色検出 + 鍵盤発光検出</p>
        </div>

        <div className="layout-grid">
          <div className="video-panel">
            <input
              className="file-input"
              type="file"
              accept="video/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
                const url = URL.createObjectURL(file);
                videoUrlRef.current = url;
                setVideoUrl(url);
                setKeyboardRect(null);
                setDragRect(null);
                resetAnalysis();
                setStatus("動画を読み込みました。Canvas上で鍵盤全体をドラッグ指定してください。");
              }}
            />

            <video
              ref={videoRef}
              src={videoUrl}
              controls
              playsInline
              className="video-preview"
              onLoadedMetadata={syncCanvasSize}
              onSeeked={drawFrame}
              onPause={drawFrame}
            />

            <canvas
              ref={canvasRef}
              className="canvas-preview"
              onPointerDown={(e) => {
                const p = canvasPoint(e);
                setDragStart(p);
                setDragRect({ x: p.x, y: p.y, w: 1, h: 1 });
              }}
              onPointerMove={(e) => {
                if (!dragStart) return;
                const p = canvasPoint(e);
                setDragRect({
                  x: Math.min(p.x, dragStart.x),
                  y: Math.min(p.y, dragStart.y),
                  w: Math.abs(p.x - dragStart.x),
                  h: Math.abs(p.y - dragStart.y),
                });
              }}
              onPointerUp={() => {
                if (dragRect && dragRect.w > 50 && dragRect.h > 10) {
                  setKeyboardRect(dragRect);
                  setStatus("鍵盤範囲を設定しました。黄色線が落下ノーツ判定ラインです。");
                }
                setDragStart(null);
              }}
            />

            <div className="button-grid">
              <button className="btn" onClick={autoFitKeyboard}>鍵盤範囲を仮配置</button>
              <button className="btn" onClick={drawFrame}>プレビュー更新</button>
            </div>
          </div>

          <div className="control-panel">
            <div className="status-box">{status}</div>

            <label className="control-group">検出モード
              <select className="control-input" value={mode} onChange={(e) => setMode(e.target.value as DetectionMode)}>
                <option value="hybrid">Hybrid: 落下ノーツ + 発光</option>
                <option value="falling">Falling: 落下ノーツのみ</option>
                <option value="glow">Glow: 鍵盤発光のみ</option>
              </select>
            </label>

            <label className="control-group">左手色 <input className="control-input" type="color" value={leftColor} onChange={(e) => setLeftColor(e.target.value)} /></label>
            <label className="control-group">右手色 <input className="control-input" type="color" value={rightColor} onChange={(e) => setRightColor(e.target.value)} /></label>

            <label className="control-group">threshold {threshold}<input className="control-input" type="range" min={5} max={60} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} /></label>
            <label className="control-group">line offset {lineOffset}%<input className="control-input" type="range" min={2} max={60} value={lineOffset} onChange={(e) => setLineOffset(Number(e.target.value))} /></label>
            <label className="control-group">line height {lineHeight}px<input className="control-input" type="range" min={1} max={16} value={lineHeight} onChange={(e) => setLineHeight(Number(e.target.value))} /></label>
            <label className="control-group">color strict {colorStrictness}<input className="control-input" type="range" min={0} max={40} value={colorStrictness} onChange={(e) => setColorStrictness(Number(e.target.value))} /></label>
            <label className="control-group">confirm frames {confirmFrames}<input className="control-input" type="range" min={1} max={5} value={confirmFrames} onChange={(e) => setConfirmFrames(Number(e.target.value))} /></label>
            <label className="control-group">min note {minNoteMs}ms<input className="control-input" type="range" min={10} max={160} value={minNoteMs} onChange={(e) => setMinNoteMs(Number(e.target.value))} /></label>
            <label className="control-group">左右分割 {handSplit}%<input className="control-input" type="range" min={20} max={80} value={handSplit} onChange={(e) => setHandSplit(Number(e.target.value))} /></label>

            <div className="button-grid">
              <button className="btn btn-primary" onClick={start} disabled={isAnalyzing}>start</button>
              <button className="btn" onClick={stop} disabled={!isAnalyzing}>stop</button>
              <button className="btn btn-success button-wide" onClick={exportMidi}>export MIDI</button>
            </div>

            <div className="notes-count">notes: {eventCount}</div>
            <p className="help-text">誤検知する: threshold/color strict/confirm framesを上げる。反応しない: threshold/color strictを下げる。</p>
          </div>
        </div>
      </div>
    </div>
  );
}
