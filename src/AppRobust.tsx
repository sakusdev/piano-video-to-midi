import { useEffect, useMemo, useRef, useState } from "react";

type Rect = { x: number; y: number; w: number; h: number };
type Key = Rect & { midi: number; isBlack: boolean };
type Ev = { midi: number; startMs: number; endMs: number; velocity: number };
type Active = { startMs: number; strength: number };
type Mode = "falling" | "hybrid" | "glow";
type Scan = { ratio: number; strength: number; rawOn: boolean; rawOff: boolean };

const BLACK = new Set([1, 3, 6, 8, 10]);
const NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const isBlack = (m: number) => BLACK.has(m % 12);

function whiteIndexToMidi(idx: number) {
  let c = -1;
  for (let m = 21; m <= 108; m++) {
    if (!isBlack(m)) {
      c++;
      if (c === idx) return m;
    }
  }
  return 108;
}

function buildKeys(r: Rect) {
  const out: Key[] = [];
  const ww = r.w / 52;
  let wi = 0;
  for (let m = 21; m <= 108; m++) {
    if (!isBlack(m)) {
      out.push({ midi: m, isBlack: false, x: r.x + wi * ww, y: r.y + r.h * 0.6, w: ww, h: r.h * 0.36 });
      wi++;
    }
  }
  const blackAfter = new Set(["A", "C", "D", "F", "G"]);
  for (let i = 0; i < 51; i++) {
    const left = whiteIndexToMidi(i);
    if (!blackAfter.has(NOTE[left % 12])) continue;
    const m = left + 1;
    if (m < 21 || m > 108) continue;
    out.push({ midi: m, isBlack: true, x: r.x + (i + 1) * ww - ww * 0.24, y: r.y + r.h * 0.04, w: ww * 0.48, h: r.h * 0.48 });
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
  return ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
}

function glowScore(ctx: CanvasRenderingContext2D, r: Rect) {
  const im = image(ctx, r);
  if (!im) return 0;
  const d = im.data;
  let sum = 0, hot = 0, count = 0;
  for (let y = 0; y < im.height; y += 2) {
    for (let x = 0; x < im.width; x += 2) {
      const i = (y * im.width + x) * 4;
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += l;
      if (l > 145) hot++;
      count++;
    }
  }
  return sum / Math.max(1, count) + (hot / Math.max(1, count)) * 80;
}

function colorLine(ctx: CanvasRenderingContext2D, k: Key, y: number, h: number, hues: number[], strict: number) {
  const im = image(ctx, { x: k.x + k.w * 0.18, y, w: k.w * 0.64, h });
  if (!im) return { ratio: 0, strength: 0 };
  const d = im.data;
  let hit = 0, strength = 0, count = 0;
  const minS = 0.2 + strict * 0.007;
  const win = Math.max(10, 30 - strict * 0.25);
  for (let i = 0; i < d.length; i += 4) {
    const p = hsv(d[i], d[i + 1], d[i + 2]);
    const ok = p.s >= minS && p.v >= 0.3 && hues.some((hueValue) => hueDist(p.h, hueValue) <= win);
    if (ok) {
      hit++;
      strength += p.s * 110 + p.v * 35;
    }
    count++;
  }
  return { ratio: hit / Math.max(1, count), strength: strength / Math.max(1, count) };
}

function resolveCandidates(keys: Key[], scans: Map<number, Scan>) {
  const allowed = new Map<number, boolean>();
  for (const k of keys) allowed.set(k.midi, scans.get(k.midi)?.rawOn ?? false);

  for (const k of keys) {
    if (!k.isBlack) continue;
    const s = scans.get(k.midi);
    if (!s?.rawOn) continue;
    const center = k.x + k.w / 2;
    const nearbyWhites = keys.filter((w) => !w.isBlack && Math.abs((w.x + w.w / 2) - center) < w.w * 0.95);
    const strongestWhite = Math.max(0, ...nearbyWhites.map((w) => scans.get(w.midi)?.rawOn ? (scans.get(w.midi)?.strength ?? 0) : 0));
    const strongestWhiteRatio = Math.max(0, ...nearbyWhites.map((w) => scans.get(w.midi)?.rawOn ? (scans.get(w.midi)?.ratio ?? 0) : 0));

    const blackIsClearlyStronger = s.strength > strongestWhite * 1.35 && s.ratio > strongestWhiteRatio * 1.2;
    const blackStrongEnough = s.ratio > 0.34 && s.strength > 18;
    if (!blackStrongEnough || (strongestWhite > 0 && !blackIsClearlyStronger)) allowed.set(k.midi, false);
  }
  return allowed;
}

function writeVarLen(v: number) {
  let b = v & 0x7f;
  const out: number[] = [];
  while ((v >>= 7)) { b <<= 8; b |= (v & 0x7f) | 0x80; }
  while (true) { out.push(b & 0xff); if (b & 0x80) b >>= 8; else break; }
  return out;
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function midi(events: Ev[], bpm = 120) {
  const ppq = 480, tpm = ppq * bpm / 60000;
  type R = { tick: number; order: number; bytes: number[] };
  const raw: R[] = [];
  const tempo = Math.round(60000000 / bpm);
  raw.push({ tick: 0, order: 0, bytes: [255, 81, 3, (tempo >>> 16) & 255, (tempo >>> 8) & 255, tempo & 255] });
  for (const e of events) {
    const st = Math.max(0, Math.round(e.startMs * tpm)), et = Math.max(st + 1, Math.round(e.endMs * tpm));
    raw.push({ tick: st, order: 2, bytes: [144, clamp(e.midi, 0, 127), clamp(e.velocity, 1, 127)] });
    raw.push({ tick: et, order: 1, bytes: [128, clamp(e.midi, 0, 127), 0] });
  }
  raw.sort((a, b) => a.tick - b.tick || a.order - b.order || a.bytes[1] - b.bytes[1]);
  const tr: number[] = [];
  let cur = 0;
  for (const e of raw) { tr.push(...writeVarLen(Math.max(0, e.tick - cur)), ...e.bytes); cur = e.tick; }
  tr.push(0, 255, 47, 0);
  return new Uint8Array([...ascii("MThd"), ...u32(6), ...u16(0), ...u16(1), ...u16(ppq), ...ascii("MTrk"), ...u32(tr.length), ...tr]);
}

function merge(events: Ev[], minMs: number, gap = 22) {
  const s = [...events].filter((e) => e.endMs - e.startMs >= minMs).sort((a, b) => a.midi - b.midi || a.startMs - b.startMs);
  const out: Ev[] = [];
  for (const e of s) {
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
  let bestY = Math.round(height * 0.66), best = -Infinity;
  for (let y = Math.round(height * 0.5); y < Math.round(height * 0.94); y += 2) {
    const d = ctx.getImageData(0, y, width, 1).data;
    let bright = 0, trans = 0, prev = false;
    for (let x = 0; x < width; x++) {
      const i = x * 4;
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const on = l > 135;
      if (on) bright++;
      if (x > 0 && on !== prev) trans++;
      prev = on;
    }
    const br = bright / width;
    const score = trans * 0.9 + br * 90 - Math.abs(br - 0.45) * 110;
    if (score > best) { best = score; bestY = y; }
  }
  const h = clamp(Math.round(height * 0.30), 40, Math.round(height * 0.46));
  return { x: -Math.round(width * 0.06), y: clamp(Math.round(bestY - h * 0.52), 0, height - h), w: Math.round(width * 1.12), h };
}

export default function AppRobust() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const analyzing = useRef(false);
  const urlRef = useRef("");
  const lastTime = useRef(-1);
  const base = useRef(new Map<number, number>());
  const active = useRef(new Map<number, Active>());
  const pon = useRef(new Map<number, number>());
  const poff = useRef(new Map<number, number>());
  const events = useRef<Ev[]>([]);

  const [url, setUrl] = useState("");
  const [rect, setRect] = useState<Rect | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [dragRect, setDragRect] = useState<Rect | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("動画を読み込んで鍵盤範囲を調整");
  const [count, setCount] = useState(0);
  const [mode, setMode] = useState<Mode>("falling");
  const [threshold, setThreshold] = useState(18);
  const [lineOffset, setLineOffset] = useState(14);
  const [lineHeight, setLineHeight] = useState(5);
  const [strict, setStrict] = useState(14);
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
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    return ctx ? estimateRect(ctx) : { x: -50, y: 300, w: 1060, h: 180 };
  }

  function update(patch: Partial<Rect>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const next = { ...(rect ?? estimate()), ...patch };
    next.x = clamp(Math.round(next.x), -Math.round(canvas.width * 0.55), Math.round(canvas.width * 0.35));
    next.y = clamp(Math.round(next.y), 0, Math.max(0, canvas.height - 10));
    next.w = clamp(Math.round(next.w), 10, Math.round(canvas.width * 1.9));
    next.h = clamp(Math.round(next.h), 10, canvas.height - next.y);
    setRect(next);
  }

  function reset() {
    base.current.clear(); active.current.clear(); pon.current.clear(); poff.current.clear(); events.current = [];
    lastTime.current = -1; setCount(0);
  }

  function close(midiValue: number, a: Active, endMs: number) {
    if (endMs - a.startMs < minMs) return;
    events.current.push({ midi: midiValue, startMs: a.startMs, endMs, velocity: clamp(Math.round(44 + a.strength * 1.15), 35, 120) });
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
      videoRef.current.play().catch(() => setStatus("スマホ側で停止。再生ボタンで継続"));
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(loop);
    }, 180);
  }

  function loop() {
    rafRef.current = null;
    const v = videoRef.current, c = canvasRef.current, ctx = c?.getContext("2d");
    if (!v || !c || !ctx || !rect || !analyzing.current) return;
    if (v.paused && !v.ended) { resume(); rafRef.current = requestAnimationFrame(loop); return; }
    if (v.currentTime === lastTime.current) { rafRef.current = requestAnimationFrame(loop); return; }
    lastTime.current = v.currentTime;

    ctx.drawImage(v, 0, 0, c.width, c.height);
    const now = v.currentTime * 1000;
    const hitY = rect.y - rect.h * (lineOffset / 100);
    const splitX = rect.x + rect.w * (split / 100);

    const scans = new Map<number, Scan>();
    for (const k of keys) {
      const ls = colorLine(ctx, k, hitY, lineHeight, [k.x + k.w * 0.5 < splitX ? leftHue : rightHue], strict);
      const blackBoost = k.isBlack ? 1.45 : 1;
      const rawOn = ls.ratio > (threshold / 100) * blackBoost && ls.strength > (k.isBlack ? 14 : 7);
      const rawOff = ls.ratio < threshold / 260;
      scans.set(k.midi, { ...ls, rawOn, rawOff });
    }
    const allowed = resolveCandidates(keys, scans);

    for (const k of keys) {
      const gs = glowScore(ctx, k);
      const b = base.current.get(k.midi) ?? gs;
      const gd = gs - b;
      const sc = scans.get(k.midi) ?? { ratio: 0, strength: 0, rawOn: false, rawOff: true };
      const a = active.current.get(k.midi);
      const fallOn = allowed.get(k.midi) ?? false;
      const fallOff = sc.rawOff;
      const glowOn = gd > threshold;
      const glowOff = gd < threshold * 0.38;
      const on = mode === "glow" ? glowOn : fallOn;
      const off = mode === "glow" ? glowOff : mode === "hybrid" ? fallOff && glowOff : fallOff;
      const strength = Math.max(mode === "falling" ? 0 : Math.max(0, gd), sc.strength);

      if (!a && gd < threshold * 0.65) base.current.set(k.midi, b * 0.97 + gs * 0.03);
      if (!a) {
        if (on) {
          const n = (pon.current.get(k.midi) ?? 0) + 1;
          pon.current.set(k.midi, n); poff.current.set(k.midi, 0);
          if (n >= frames) {
            active.current.set(k.midi, { startMs: Math.max(0, now - (frames - 1) * 16.7), strength });
            pon.current.set(k.midi, 0);
          }
        } else pon.current.set(k.midi, 0);
      } else {
        a.strength = Math.max(a.strength, strength);
        if (off) {
          const n = (poff.current.get(k.midi) ?? 0) + 1;
          poff.current.set(k.midi, n);
          if (n >= frames) {
            close(k.midi, a, Math.max(a.startMs + 1, now - (frames - 1) * 16.7));
            active.current.delete(k.midi); poff.current.set(k.midi, 0);
          }
        } else poff.current.set(k.midi, 0);
      }
    }
    draw();
    if (!v.ended) rafRef.current = requestAnimationFrame(loop);
    else { analyzing.current = false; setRunning(false); setStatus("解析完了"); }
  }

  async function start() {
    const v = videoRef.current;
    if (!v || !rect) { setStatus("先に動画と鍵盤範囲を設定"); return; }
    reset(); analyzing.current = true; setRunning(true); setStatus("解析中 / 黒鍵巻き込み抑制ON");
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
    const es = merge(events.current, minMs);
    if (!es.length) { setStatus("ノートなし"); return; }
    const u = URL.createObjectURL(new Blob([midi(es)], { type: "audio/midi" }));
    const a = document.createElement("a"); a.href = u; a.download = "piano-video.mid"; a.click(); URL.revokeObjectURL(u);
    setCount(es.length); setStatus(`MIDI出力完了: ${es.length} notes`);
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
    <div><h1 className="app-title">Perfect Piano Video → MIDI</h1><p className="app-subtitle">Robust: 黒鍵巻き込み抑制 + 自動セット改善</p></div>
    <div className="layout-grid"><div className="video-panel">
      <input className="file-input" type="file" accept="video/*" onChange={e => { const f = e.target.files?.[0]; if (!f) return; if (urlRef.current) URL.revokeObjectURL(urlRef.current); const u = URL.createObjectURL(f); urlRef.current = u; setUrl(u); setRect(null); setDragRect(null); reset(); setStatus("動画読み込み完了。仮配置後にX/Wとline offsetを調整"); }} />
      <video ref={videoRef} src={url} controls playsInline preload="auto" className="video-preview" onLoadedMetadata={sync} onSeeked={draw} onPause={() => analyzing.current ? resume() : draw()} onPlay={() => { if (analyzing.current && rafRef.current === null) rafRef.current = requestAnimationFrame(loop); }} />
      <canvas ref={canvasRef} className="canvas-preview" onPointerDown={e => { const p = point(e); setDrag(p); setDragRect({ x: p.x, y: p.y, w: 1, h: 1 }); }} onPointerMove={e => { if (!drag) return; const p = point(e); setDragRect({ x: Math.min(p.x, drag.x), y: Math.min(p.y, drag.y), w: Math.abs(p.x - drag.x), h: Math.abs(p.y - drag.y) }); }} onPointerUp={() => { if (dragRect && dragRect.w > 50 && dragRect.h > 10) { setRect(dragRect); setStatus("鍵盤範囲設定完了"); } setDrag(null); }} />
      <div className="button-grid"><button className="btn" onClick={() => { const c = canvasRef.current, ctx = c?.getContext("2d"); if (ctx) { setRect(estimateRect(ctx)); setStatus("自動セット完了。端が見切れる場合はXをマイナス、Wを大きく"); } }}>鍵盤範囲を自動セット</button><button className="btn" onClick={draw}>プレビュー更新</button></div>
    </div><div className="control-panel">
      <div className="status-box">{status}</div>
      <label className="control-group">検出モード<select className="control-input" value={mode} onChange={e => setMode(e.target.value as Mode)}><option value="falling">Falling 推奨</option><option value="hybrid">Hybrid 終端補助</option><option value="glow">Glow 非推奨</option></select></label>
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
      <label className="control-group">confirm frames {frames}<input className="control-input" type="range" min={1} max={5} value={frames} onChange={e => setFrames(Number(e.target.value))} /></label>
      <label className="control-group">min note {minMs}ms<input className="control-input" type="range" min={10} max={160} value={minMs} onChange={e => setMinMs(Number(e.target.value))} /></label>
      <label className="control-group">左右分割 {split}%<input className="control-input" type="range" min={20} max={80} value={split} onChange={e => setSplit(Number(e.target.value))} /></label>
      <div className="button-grid"><button className="btn btn-primary" onClick={start} disabled={running}>start</button><button className="btn" onClick={stop} disabled={!running}>stop</button><button className="btn btn-success button-wide" onClick={exportMidi}>export MIDI</button></div>
      <div className="notes-count">notes: {count}</div><p className="help-text">黒鍵が巻き込まれる場合: color strictを上げる / line offsetを少し上げる / Falling推奨。</p>
    </div></div>
  </div></div>;
}
