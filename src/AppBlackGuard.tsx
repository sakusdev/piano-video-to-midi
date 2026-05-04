import { useEffect, useMemo, useRef, useState } from "react";

type Rect = { x: number; y: number; w: number; h: number };
type Key = Rect & { midi: number; isBlack: boolean };
type Ev = { midi: number; startMs: number; endMs: number; velocity: number };
type Active = { startMs: number; strength: number };
type Mode = "blob" | "hybrid" | "glow";
type Cand = { midi: number; strength: number; center: number; width: number };

const BLACK = new Set([1, 3, 6, 8, 10]);
const NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const isBlack = (m: number) => BLACK.has(m % 12);

function whiteIndexToMidi(idx: number) {
  let c = -1;
  for (let m = 21; m <= 108; m++) {
    if (!isBlack(m)) {
      c += 1;
      if (c === idx) return m;
    }
  }
  return 108;
}

function buildKeys(r: Rect) {
  const out: Key[] = [];
  const whiteW = r.w / 52;
  let wi = 0;
  for (let m = 21; m <= 108; m++) {
    if (!isBlack(m)) {
      out.push({ midi: m, isBlack: false, x: r.x + wi * whiteW, y: r.y + r.h * 0.6, w: whiteW, h: r.h * 0.36 });
      wi += 1;
    }
  }
  const blackAfter = new Set(["A", "C", "D", "F", "G"]);
  for (let i = 0; i < 51; i++) {
    const left = whiteIndexToMidi(i);
    if (!blackAfter.has(NOTE[left % 12])) continue;
    const midi = left + 1;
    if (midi < 21 || midi > 108) continue;
    out.push({ midi, isBlack: true, x: r.x + (i + 1) * whiteW - whiteW * 0.24, y: r.y + r.h * 0.04, w: whiteW * 0.48, h: r.h * 0.48 });
  }
  return out.sort((a, b) => Number(a.isBlack) - Number(b.isBlack));
}

function hsv(r: number, g: number, b: number) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hue(hex: string) {
  const s = hex.replace("#", "");
  const n = parseInt(s.length === 3 ? s.split("").map((c) => c + c).join("") : s, 16);
  return hsv((n >> 16) & 255, (n >> 8) & 255, n & 255).h;
}

function hueDist(a: number, b: number) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function image(ctx: CanvasRenderingContext2D, r: Rect) {
  const x0 = clamp(Math.floor(r.x), 0, ctx.canvas.width - 1);
  const y0 = clamp(Math.floor(r.y), 0, ctx.canvas.height - 1);
  const x1 = clamp(Math.ceil(r.x + r.w), 0, ctx.canvas.width);
  const y1 = clamp(Math.ceil(r.y + r.h), 0, ctx.canvas.height);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, data: ctx.getImageData(x0, y0, x1 - x0, y1 - y0) };
}

function whitePixel(r: number, g: number, b: number) {
  const p = hsv(r, g, b);
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return l > 145 && p.s < 0.28 && p.v > 0.55;
}

function glowScore(ctx: CanvasRenderingContext2D, r: Rect) {
  const im = image(ctx, r);
  if (!im) return 0;
  const img = im.data, d = img.data;
  let sum = 0, hot = 0, count = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const i = (y * img.width + x) * 4;
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += l;
      if (l > 145) hot += 1;
      count += 1;
    }
  }
  return sum / Math.max(1, count) + (hot / Math.max(1, count)) * 80;
}

function nearestKey(keys: Key[], x: number, includeBlack = true) {
  const pool = includeBlack ? keys : keys.filter((k) => !k.isBlack);
  let best = pool[0] ?? keys[0];
  let dist = Infinity;
  for (const k of pool) {
    const d = Math.abs(k.x + k.w / 2 - x);
    if (d < dist) { dist = d; best = k; }
  }
  return best;
}

function assignBlobToKey(keys: Key[], center: number, width: number, strength: number, existing: Map<number, Cand>) {
  let key = nearestKey(keys, center, true);
  if (key.isBlack) {
    const keyCenter = key.x + key.w / 2;
    const centerError = Math.abs(center - keyCenter);
    const centeredEnough = centerError <= key.w * 0.34;
    const narrowEnough = width <= key.w * 1.35;
    const strongEnough = strength >= 18;

    if (!centeredEnough || !narrowEnough || !strongEnough) {
      key = nearestKey(keys, center, false);
    }
  }

  const old = existing.get(key.midi);
  if (!old || strength > old.strength) existing.set(key.midi, { midi: key.midi, center, width, strength });
}

function suppressBlackKeys(keys: Key[], candidates: Map<number, Cand>, guard: number) {
  const factor = 1.1 + guard / 100;
  for (const [midi, cand] of [...candidates]) {
    const key = keys.find((k) => k.midi === midi);
    if (!key?.isBlack) continue;

    const keyCenter = key.x + key.w / 2;
    const centered = Math.abs(cand.center - keyCenter) <= key.w * (0.42 - guard / 420);
    const narrow = cand.width <= key.w * (1.55 - guard / 160);
    const nearWhites = keys.filter((k) => !k.isBlack && Math.abs((k.x + k.w / 2) - keyCenter) < k.w * 0.95);
    const strongestWhite = Math.max(0, ...nearWhites.map((k) => candidates.get(k.midi)?.strength ?? 0));
    const strongerThanWhite = strongestWhite <= 0 || cand.strength >= strongestWhite * factor;

    if (!centered || !narrow || !strongerThanWhite) candidates.delete(midi);
  }
}

function detectBlobs(ctx: CanvasRenderingContext2D, rect: Rect, keys: Key[], y: number, h: number, leftHue: number, rightHue: number, split: number, threshold: number, strict: number, blackGuard: number) {
  const im = image(ctx, { x: rect.x, y, w: rect.w, h });
  if (!im) return new Map<number, Cand>();
  const img = im.data, d = img.data;
  const splitX = rect.x + rect.w * (split / 100);
  const minS = 0.2 + strict * 0.007;
  const minV = 0.3;
  const win = Math.max(10, 30 - strict * 0.25);
  const minRatio = threshold / 100;
  const columns: { x: number; score: number; strength: number }[] = [];

  for (let x = 0; x < img.width; x++) {
    let hit = 0, strength = 0;
    const canvasX = im.x + x;
    const target = canvasX < splitX ? leftHue : rightHue;
    for (let yy = 0; yy < img.height; yy++) {
      const i = (yy * img.width + x) * 4;
      const p = hsv(d[i], d[i + 1], d[i + 2]);
      if (p.s >= minS && p.v >= minV && hueDist(p.h, target) <= win) {
        hit += 1;
        strength += p.s * 110 + p.v * 35;
      }
    }
    const score = hit / Math.max(1, img.height);
    if (score >= minRatio) columns.push({ x: canvasX, score, strength: strength / Math.max(1, hit || 1) });
  }

  const candidates = new Map<number, Cand>();
  let i = 0;
  while (i < columns.length) {
    const run = [columns[i++]];
    while (i < columns.length && columns[i].x - run[run.length - 1].x <= 3) run.push(columns[i++]);
    if (run.length < 3) continue;
    const weight = run.reduce((s, c) => s + c.score, 0);
    const center = run.reduce((s, c) => s + c.x * c.score, 0) / Math.max(1e-6, weight);
    const strength = run.reduce((s, c) => s + c.strength * c.score, 0) / Math.max(1e-6, weight);
    const width = run[run.length - 1].x - run[0].x + 1;
    assignBlobToKey(keys, center, width, strength, candidates);
  }

  suppressBlackKeys(keys, candidates, blackGuard);
  return candidates;
}

function writeVarLen(v: number) {
  let b = v & 0x7f;
  const out: number[] = [];
  while ((v >>= 7)) { b <<= 8; b |= (v & 0x7f) | 0x80; }
  while (true) { out.push(b & 255); if (b & 0x80) b >>= 8; else break; }
  return out;
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function makeMidi(events: Ev[], bpm = 120) {
  const ppq = 480, ticksPerMs = ppq * bpm / 60000;
  type Raw = { tick: number; order: number; bytes: number[] };
  const raw: Raw[] = [];
  const tempo = Math.round(60000000 / bpm);
  raw.push({ tick: 0, order: 0, bytes: [255, 81, 3, (tempo >>> 16) & 255, (tempo >>> 8) & 255, tempo & 255] });
  for (const e of events) {
    const start = Math.max(0, Math.round(e.startMs * ticksPerMs));
    const end = Math.max(start + 1, Math.round(e.endMs * ticksPerMs));
    raw.push({ tick: start, order: 2, bytes: [144, clamp(e.midi, 0, 127), clamp(e.velocity, 1, 127)] });
    raw.push({ tick: end, order: 1, bytes: [128, clamp(e.midi, 0, 127), 0] });
  }
  raw.sort((a, b) => a.tick - b.tick || a.order - b.order || a.bytes[1] - b.bytes[1]);
  const track: number[] = [];
  let cursor = 0;
  for (const e of raw) { track.push(...writeVarLen(Math.max(0, e.tick - cursor)), ...e.bytes); cursor = e.tick; }
  track.push(0, 255, 47, 0);
  return new Uint8Array([...ascii("MThd"), ...u32(6), ...u16(0), ...u16(1), ...u16(ppq), ...ascii("MTrk"), ...u32(track.length), ...track]);
}

function merge(events: Ev[], minMs: number, gap = 22) {
  const sorted = [...events].filter((e) => e.endMs - e.startMs >= minMs).sort((a, b) => a.midi - b.midi || a.startMs - b.startMs);
  const out: Ev[] = [];
  for (const e of sorted) {
    const last = out[out.length - 1];
    if (last && last.midi === e.midi && e.startMs - last.endMs <= gap) {
      last.endMs = Math.max(last.endMs, e.endMs);
      last.velocity = Math.max(last.velocity, e.velocity);
    } else out.push({ ...e });
  }
  return out.sort((a, b) => a.startMs - b.startMs || a.midi - b.midi);
}

function estimateRect(ctx: CanvasRenderingContext2D): Rect {
  const { width, height } = ctx.canvas;
  const row: number[] = [];
  for (let y = 0; y < height; y++) {
    const data = ctx.getImageData(0, y, width, 1).data;
    let hits = 0;
    for (let x = 0; x < width; x++) {
      const i = x * 4;
      if (whitePixel(data[i], data[i + 1], data[i + 2])) hits += 1;
    }
    row[y] = hits / width;
  }

  let bestS = Math.round(height * 0.65), bestE = Math.round(height * 0.92), bestScore = -1, start = -1;
  for (let y = Math.round(height * 0.45); y < height; y++) {
    const on = row[y] > 0.32;
    if (on && start < 0) start = y;
    if ((!on || y === height - 1) && start >= 0) {
      const end = on ? y : y - 1;
      const len = end - start + 1;
      const avg = row.slice(start, end + 1).reduce((a, b) => a + b, 0) / len;
      const score = len * avg;
      if (score > bestScore) { bestScore = score; bestS = start; bestE = end; }
      start = -1;
    }
  }

  const y = bestS;
  const h = Math.max(40, bestE - bestS + 1);
  const y0 = clamp(Math.round(y + h * 0.62), 0, height - 1);
  const y1 = clamp(Math.round(y + h * 0.94), y0 + 1, height);
  const col: number[] = [];
  for (let x = 0; x < width; x++) {
    const data = ctx.getImageData(x, y0, 1, y1 - y0).data;
    let hits = 0;
    for (let yy = 0; yy < y1 - y0; yy++) {
      const i = yy * 4;
      if (whitePixel(data[i], data[i + 1], data[i + 2])) hits += 1;
    }
    col[x] = hits / Math.max(1, y1 - y0);
  }

  let xs = 0, xe = width - 1;
  while (xs < width && col[xs] < 0.18) xs += 1;
  while (xe > xs && col[xe] < 0.18) xe -= 1;
  const margin = Math.max(2, Math.round(width * 0.006));
  return { x: clamp(xs - margin, -Math.round(width * 0.55), width), y, w: clamp(xe - xs + 1 + margin * 2, 10, Math.round(width * 1.9)), h };
}

export default function AppBlackGuard() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const analyzing = useRef(false);
  const urlRef = useRef("");
  const last = useRef(-1);
  const base = useRef(new Map<number, number>());
  const active = useRef(new Map<number, Active>());
  const pendingOn = useRef(new Map<number, number>());
  const pendingOff = useRef(new Map<number, number>());
  const events = useRef<Ev[]>([]);

  const [url, setUrl] = useState("");
  const [rect, setRect] = useState<Rect | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [dragRect, setDragRect] = useState<Rect | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("動画を読み込んで自動セット");
  const [count, setCount] = useState(0);
  const [mode, setMode] = useState<Mode>("blob");
  const [threshold, setThreshold] = useState(18);
  const [lineOffset, setLineOffset] = useState(14);
  const [lineHeight, setLineHeight] = useState(6);
  const [strict, setStrict] = useState(14);
  const [blackGuard, setBlackGuard] = useState(65);
  const [frames, setFrames] = useState(2);
  const [minMs, setMinMs] = useState(35);
  const [left, setLeft] = useState("#6fb8ff");
  const [right, setRight] = useState("#9bdc4b");
  const [split, setSplit] = useState(50);

  const keys = useMemo(() => rect ? buildKeys(rect) : [], [rect]);
  const leftHue = useMemo(() => hue(left), [left]);
  const rightHue = useMemo(() => hue(right), [right]);
  const cw = canvasRef.current?.width ?? 960;
  const ch = canvasRef.current?.height ?? 540;
  const xMin = -Math.round(cw * 0.55), xMax = Math.round(cw * 0.35), wMax = Math.round(cw * 1.9);

  function estimate() {
    const ctx = canvasRef.current?.getContext("2d");
    return ctx ? estimateRect(ctx) : { x: 0, y: 300, w: 960, h: 160 };
  }

  function update(patch: Partial<Rect>) {
    const c = canvasRef.current;
    if (!c) return;
    const n = { ...(rect ?? estimate()), ...patch };
    n.x = clamp(Math.round(n.x), -Math.round(c.width * 0.55), Math.round(c.width * 0.35));
    n.y = clamp(Math.round(n.y), 0, Math.max(0, c.height - 10));
    n.w = clamp(Math.round(n.w), 10, Math.round(c.width * 1.9));
    n.h = clamp(Math.round(n.h), 10, c.height - n.y);
    setRect(n);
  }

  function reset() {
    base.current.clear(); active.current.clear(); pendingOn.current.clear(); pendingOff.current.clear(); events.current = [];
    last.current = -1; setCount(0);
  }

  function close(midi: number, a: Active, end: number) {
    if (end - a.startMs < minMs) return;
    events.current.push({ midi, startMs: a.startMs, endMs: end, velocity: clamp(Math.round(44 + a.strength * 1.15), 35, 120) });
    setCount(events.current.length);
  }

  function draw() {
    const v = videoRef.current, c = canvasRef.current, ctx = c?.getContext("2d");
    if (!v || !c || !ctx || !c.width || !c.height) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(v, 0, 0, c.width, c.height);
    if (rect) {
      ctx.save();
      ctx.strokeStyle = "#22d3ee"; ctx.lineWidth = 2; ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      const hitY = rect.y - rect.h * (lineOffset / 100);
      ctx.strokeStyle = "#facc15"; ctx.beginPath(); ctx.moveTo(rect.x, hitY); ctx.lineTo(rect.x + rect.w, hitY); ctx.stroke();
      for (const k of keys) {
        ctx.globalAlpha = active.current.has(k.midi) ? 1 : k.isBlack ? 0.9 : 0.45;
        ctx.strokeStyle = active.current.has(k.midi) ? "#a3e635" : k.isBlack ? "#ef4444" : "#06b6d4";
        ctx.lineWidth = active.current.has(k.midi) ? 3 : 1;
        ctx.strokeRect(k.x, k.y, k.w, k.h);
      }
      ctx.restore();
    }
    if (dragRect) { ctx.save(); ctx.strokeStyle = "#facc15"; ctx.lineWidth = 2; ctx.strokeRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h); ctx.restore(); }
  }

  function resume() {
    const v = videoRef.current;
    if (!v || !analyzing.current || v.ended || timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (!analyzing.current || !videoRef.current || videoRef.current.ended) return;
      videoRef.current.play().catch(() => setStatus("スマホ側で停止。再生で継続"));
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(loop);
    }, 180);
  }

  function loop() {
    rafRef.current = null;
    const v = videoRef.current, c = canvasRef.current, ctx = c?.getContext("2d");
    if (!v || !c || !ctx || !rect || !analyzing.current) return;
    if (v.paused && !v.ended) { resume(); rafRef.current = requestAnimationFrame(loop); return; }
    if (v.currentTime === last.current) { rafRef.current = requestAnimationFrame(loop); return; }
    last.current = v.currentTime;
    ctx.drawImage(v, 0, 0, c.width, c.height);

    const now = v.currentTime * 1000;
    const hitY = rect.y - rect.h * (lineOffset / 100);
    const candidates = detectBlobs(ctx, rect, keys, hitY, lineHeight, leftHue, rightHue, split, threshold, strict, blackGuard);

    for (const k of keys) {
      const gs = glowScore(ctx, k);
      const b = base.current.get(k.midi) ?? gs;
      const gd = gs - b;
      const cand = candidates.get(k.midi);
      const a = active.current.get(k.midi);
      const on = mode === "glow" ? gd > threshold : Boolean(cand);
      const off = mode === "glow" ? gd < threshold * 0.38 : mode === "hybrid" ? !cand && gd < threshold * 0.38 : !cand;
      const strength = Math.max(mode === "blob" ? 0 : Math.max(0, gd), cand?.strength ?? 0);

      if (!a && gd < threshold * 0.65) base.current.set(k.midi, b * 0.97 + gs * 0.03);
      if (!a) {
        if (on) {
          const n = (pendingOn.current.get(k.midi) ?? 0) + 1;
          pendingOn.current.set(k.midi, n); pendingOff.current.set(k.midi, 0);
          if (n >= frames) {
            active.current.set(k.midi, { startMs: Math.max(0, now - (frames - 1) * 16.7), strength });
            pendingOn.current.set(k.midi, 0);
          }
        } else pendingOn.current.set(k.midi, 0);
      } else {
        a.strength = Math.max(a.strength, strength);
        if (off) {
          const n = (pendingOff.current.get(k.midi) ?? 0) + 1;
          pendingOff.current.set(k.midi, n);
          if (n >= frames) {
            close(k.midi, a, Math.max(a.startMs + 1, now - (frames - 1) * 16.7));
            active.current.delete(k.midi); pendingOff.current.set(k.midi, 0);
          }
        } else pendingOff.current.set(k.midi, 0);
      }
    }
    draw();
    if (!v.ended) rafRef.current = requestAnimationFrame(loop);
    else { analyzing.current = false; setRunning(false); setStatus("解析完了"); }
  }

  async function start() {
    const v = videoRef.current;
    if (!v || !rect) { setStatus("先に動画と鍵盤範囲"); return; }
    reset(); analyzing.current = true; setRunning(true); setStatus("解析中 / 黒鍵Guard ON");
    try { v.setAttribute("playsinline", "true"); await v.play(); } catch { setStatus("再生ボタンを押してからstart"); }
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(loop);
  }

  function stop() {
    analyzing.current = false;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null; videoRef.current?.pause(); setRunning(false); setStatus("停止");
  }

  function exportMidi() {
    const now = (videoRef.current?.currentTime ?? 0) * 1000;
    for (const [m, a] of active.current) close(m, a, Math.max(now, a.startMs + minMs));
    active.current.clear();
    const output = merge(events.current, minMs);
    if (!output.length) { setStatus("ノートなし"); return; }
    const u = URL.createObjectURL(new Blob([makeMidi(output)], { type: "audio/midi" }));
    const a = document.createElement("a"); a.href = u; a.download = "piano-video.mid"; a.click(); URL.revokeObjectURL(u);
    setCount(output.length); setStatus(`MIDI出力完了: ${output.length} notes`);
  }

  function sync() {
    const v = videoRef.current, c = canvasRef.current;
    if (!v || !c) return;
    const scale = Math.min(1, 960 / (v.videoWidth || 1280));
    c.width = Math.floor((v.videoWidth || 1280) * scale);
    c.height = Math.floor((v.videoHeight || 720) * scale);
    const ctx = c.getContext("2d");
    if (ctx) { ctx.drawImage(v, 0, 0, c.width, c.height); setRect(estimateRect(ctx)); }
    draw();
  }

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = canvasRef.current!, r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  }

  useEffect(() => { draw(); }, [rect, lineOffset, lineHeight, split, keys.length]);
  useEffect(() => () => {
    analyzing.current = false;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  return <div className="app-shell"><div className="app-container">
    <div><h1 className="app-title">Perfect Piano Video → MIDI</h1><p className="app-subtitle">黒鍵Guard: 中心/幅/隣接白鍵で巻き込み抑制</p></div>
    <div className="layout-grid"><div className="video-panel">
      <input className="file-input" type="file" accept="video/*" onChange={e => { const f = e.target.files?.[0]; if (!f) return; if (urlRef.current) URL.revokeObjectURL(urlRef.current); const u = URL.createObjectURL(f); urlRef.current = u; setUrl(u); setRect(null); setDragRect(null); reset(); setStatus("動画読み込み完了。自動セット後に微調整"); }} />
      <video ref={videoRef} src={url} controls playsInline preload="auto" className="video-preview" onLoadedMetadata={sync} onSeeked={draw} onPause={() => analyzing.current ? resume() : draw()} onPlay={() => { if (analyzing.current && rafRef.current === null) rafRef.current = requestAnimationFrame(loop); }} />
      <canvas ref={canvasRef} className="canvas-preview" onPointerDown={e => { const p = point(e); setDrag(p); setDragRect({ x: p.x, y: p.y, w: 1, h: 1 }); }} onPointerMove={e => { if (!drag) return; const p = point(e); setDragRect({ x: Math.min(p.x, drag.x), y: Math.min(p.y, drag.y), w: Math.abs(p.x - drag.x), h: Math.abs(p.y - drag.y) }); }} onPointerUp={() => { if (dragRect && dragRect.w > 50 && dragRect.h > 10) { setRect(dragRect); setStatus("鍵盤範囲設定完了"); } setDrag(null); }} />
      <div className="button-grid"><button className="btn" onClick={() => { const ctx = canvasRef.current?.getContext("2d"); if (ctx) { setRect(estimateRect(ctx)); setStatus("白鍵本体から自動セット完了。必要ならX/Wを微調整"); } }}>鍵盤範囲を自動セット</button><button className="btn" onClick={draw}>プレビュー更新</button></div>
    </div><div className="control-panel">
      <div className="status-box">{status}</div>
      <label className="control-group">検出モード<select className="control-input" value={mode} onChange={e => setMode(e.target.value as Mode)}><option value="blob">Blob 推奨</option><option value="hybrid">Hybrid 終端補助</option><option value="glow">Glow 非推奨</option></select></label>
      <div className="status-box">鍵盤範囲 微調整</div>
      <label className="control-group">X {rect?.x ?? 0}<input className="control-input" type="range" min={xMin} max={xMax} value={rect?.x ?? 0} onChange={e => update({ x: Number(e.target.value) })} /></label>
      <label className="control-group">Y {rect?.y ?? 0}<input className="control-input" type="range" min={0} max={ch} value={rect?.y ?? 0} onChange={e => update({ y: Number(e.target.value) })} /></label>
      <label className="control-group">W {rect?.w ?? 0}<input className="control-input" type="range" min={10} max={wMax} value={rect?.w ?? 10} onChange={e => update({ w: Number(e.target.value) })} /></label>
      <label className="control-group">H {rect?.h ?? 0}<input className="control-input" type="range" min={10} max={ch} value={rect?.h ?? 10} onChange={e => update({ h: Number(e.target.value) })} /></label>
      <label className="control-group">左手色<input className="control-input" type="color" value={left} onChange={e => setLeft(e.target.value)} /></label>
      <label className="control-group">右手色<input className="control-input" type="color" value={right} onChange={e => setRight(e.target.value)} /></label>
      <label className="control-group">threshold {threshold}<input className="control-input" type="range" min={5} max={60} value={threshold} onChange={e => setThreshold(Number(e.target.value))} /></label>
      <label className="control-group">line offset {lineOffset}%<input className="control-input" type="range" min={2} max={60} value={lineOffset} onChange={e => setLineOffset(Number(e.target.value))} /></label>
      <label className="control-group">line height {lineHeight}px<input className="control-input" type="range" min={1} max={16} value={lineHeight} onChange={e => setLineHeight(Number(e.target.value))} /></label>
      <label className="control-group">color strict {strict}<input className="control-input" type="range" min={0} max={40} value={strict} onChange={e => setStrict(Number(e.target.value))} /></label>
      <label className="control-group">black guard {blackGuard}<input className="control-input" type="range" min={0} max={100} value={blackGuard} onChange={e => setBlackGuard(Number(e.target.value))} /></label>
      <label className="control-group">confirm frames {frames}<input className="control-input" type="range" min={1} max={5} value={frames} onChange={e => setFrames(Number(e.target.value))} /></label>
      <label className="control-group">min note {minMs}ms<input className="control-input" type="range" min={10} max={160} value={minMs} onChange={e => setMinMs(Number(e.target.value))} /></label>
      <label className="control-group">左右分割 {split}%<input className="control-input" type="range" min={20} max={80} value={split} onChange={e => setSplit(Number(e.target.value))} /></label>
      <div className="button-grid"><button className="btn btn-primary" onClick={start} disabled={running}>start</button><button className="btn" onClick={stop} disabled={!running}>stop</button><button className="btn btn-success button-wide" onClick={exportMidi}>export MIDI</button></div>
      <div className="notes-count">notes: {count}</div><p className="help-text">黒鍵を巻き込むならblack guardを上げる。黒鍵が消えすぎるなら下げる。</p>
    </div></div>
  </div></div>;
}
