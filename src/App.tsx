import { useEffect, useMemo, useRef, useState } from "react";
// 自前MIDI + ハイブリッド検出（発光 + 落下ノーツ判定ライン）

type Rect = { x: number; y: number; w: number; h: number };

type KeyRegion = Rect & { midi: number; name: string; isBlack: boolean };

type NoteEvent = { midi: number; startMs: number; endMs: number; velocity: number };

type ActiveNote = { startMs: number; maxStrength: number; frames: number };

type DetectionMode = "hybrid" | "falling" | "glow";
type ColorMode = "key" | "hand" | "both";

const BLACK_NOTE_INDEXES = new Set([1, 3, 6, 8, 10]);
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

const isBlackMidi = (m: number) => BLACK_NOTE_INDEXES.has(m % 12);
const midiToName = (m: number) => `${NOTE_NAMES[m % 12]}${Math.floor(m/12)-1}`;

function whiteIndexToMidi(index: number) {
  let c = -1;
  for (let m=21;m<=108;m++){
    if(!isBlackMidi(m)){c++; if(c===index) return m;}
  }
  return 108;
}

function buildPianoRegions(rect: Rect): KeyRegion[] {
  const out: KeyRegion[] = [];
  const w = rect.w/52;
  let wi=0;
  for(let m=21;m<=108;m++){
    if(!isBlackMidi(m)){
      out.push({midi:m,name:midiToName(m),isBlack:false,
        x:rect.x+wi*w, y:rect.y+rect.h*0.58, w, h:rect.h*0.38});
      wi++;
    }
  }
  const blackAfter=new Set(["A","C","D","F","G"]);
  for(let i=0;i<51;i++){
    const lm=whiteIndexToMidi(i);
    if(!blackAfter.has(NOTE_NAMES[lm%12])) continue;
    const bm=lm+1; if(bm<21||bm>108) continue;
    out.push({midi:bm,name:midiToName(bm),isBlack:true,
      x:rect.x+(i+1)*w-w*0.3, y:rect.y+rect.h*0.04, w:w*0.6, h:rect.h*0.48});
  }
  return out.sort((a,b)=>Number(a.isBlack)-Number(b.isBlack));
}

function getLumaScore(ctx: CanvasRenderingContext2D, r: Rect){
  const x=Math.max(0,Math.floor(r.x));
  const y=Math.max(0,Math.floor(r.y));
  const maxW = Math.max(1, ctx.canvas.width - x);
  const maxH = Math.max(1, ctx.canvas.height - y);
  const w=Math.max(1,Math.min(Math.floor(r.w), maxW));
  const h=Math.max(1,Math.min(Math.floor(r.h), maxH));
  const d=ctx.getImageData(x,y,w,h).data;
  let sum=0, hot=0, c=0;
  for(let yy=0;yy<h;yy+=2){
    for(let xx=0;xx<w;xx+=2){
      const i=(yy*w+xx)*4;
      const l=0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2];
      sum+=l; if(l>145) hot++; c++;
    }
  }
  return (sum/Math.max(1,c)) + (hot/Math.max(1,c))*80;
}

function rgbToHsv(r:number,g:number,b:number){
  r/=255; g/=255; b/=255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
  let h=0;
  if(d!==0){
    if(max===r) h=((g-b)/d)%6;
    else if(max===g) h=(b-r)/d+2;
    else h=(r-g)/d+4;
    h*=60;
    if(h<0) h+=360;
  }
  const s=max===0?0:d/max;
  const v=max;
  return {h,s,v};
}
const hexToRgb = (hex: string) => {
  const n = hex.replace("#", "");
  const full = n.length === 3 ? n.split("").map((c) => c + c).join("") : n;
  const v = parseInt(full, 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
};
const hueDistance = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

function scanLine(
  ctx:CanvasRenderingContext2D,
  key:KeyRegion,
  y:number,
  h:number,
  strict:number,
  targetHue:number
){
  const x=Math.max(0,Math.floor(key.x+key.w*0.1));
  const yy=Math.max(0,Math.floor(y));
  const maxW = Math.max(1, ctx.canvas.width - x);
  const maxH = Math.max(1, ctx.canvas.height - yy);
  const w=Math.max(1,Math.min(Math.floor(key.w*0.8), maxW));
  const hh=Math.max(1,Math.min(Math.floor(h), maxH));
  const data=ctx.getImageData(x, yy, w, hh).data;
  let col=0, bri=0, str=0, cnt=0;
  for(let i=0;i<data.length;i+=4){
    const r=data[i], g=data[i+1], b=data[i+2];
    const hsv=rgbToHsv(r,g,b);
    const {s,v}=hsv;
    const l=0.2126*r+0.7152*g+0.0722*b;
    const hueHit = hueDistance(hsv.h, targetHue) < 30 + strict * 0.6;
    const ch = s>0.16+strict*0.006 && v>0.25 && hueHit;
    const bh = l>125+strict*1.5;
    if(ch) col++;
    if(bh) bri++;
    str += Math.max(ch ? s*100+v*35 : 0, bh ? (l-110)*0.75 : 0);
    cnt++;
  }
  const cr=col/Math.max(1,cnt), br=bri/Math.max(1,cnt);
  return { ratio: Math.max(cr, br*0.85), strength: str/Math.max(1,cnt) };
}

function denoiseAndMerge(events: NoteEvent[], minNoteMs: number, gapMs = 22): NoteEvent[] {
  const sorted = [...events]
    .filter((e) => e.endMs - e.startMs >= minNoteMs)
    .sort((a, b) => a.midi - b.midi || a.startMs - b.startMs);
  const merged: NoteEvent[] = [];
  for (const e of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.midi === e.midi && e.startMs - last.endMs <= gapMs) {
      last.endMs = Math.max(last.endMs, e.endMs);
      last.velocity = Math.max(last.velocity, e.velocity);
      continue;
    }
    merged.push({ ...e });
  }
  return merged.sort((a, b) => a.startMs - b.startMs || a.midi - b.midi);
}

const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));

function writeVarLen(v:number){
  let b=v&0x7f;
  const out:number[]=[];
  while((v>>=7)){
    b<<=8;
    b|=(v&0x7f)|0x80;
  }
  while(true){
    out.push(b&0xff);
    if(b&0x80) b>>=8;
    else break;
  }
  return out;
}
const textBytes=(t:string)=>[...t].map(c=>c.charCodeAt(0));
const u32=(n:number)=>[(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255];
const u16=(n:number)=>[(n>>>8)&255,n&255];

function buildExactMidi(events: NoteEvent[], bpm=120){
  const ppq=480, tpm=(ppq*bpm)/60000;
  type E={tick:number, order:number, bytes:number[]};
  const raw:E[]=[];
  const mpq=Math.round(60000000/bpm);
  raw.push({tick:0,order:0,bytes:[0xff,0x51,0x03,(mpq>>>16)&255,(mpq>>>8)&255,mpq&255]});
  for(const e of events){
    const st=Math.max(0,Math.round(e.startMs*tpm));
    const et=Math.max(st+1,Math.round(e.endMs*tpm));
    const note=clamp(e.midi,0,127), vel=clamp(e.velocity,1,127);
    raw.push({tick:st,order:2,bytes:[0x90,note,vel]});
    raw.push({tick:et,order:1,bytes:[0x80,note,0]});
  }
  raw.sort((a,b)=>a.tick-b.tick||a.order-b.order||a.bytes[1]-b.bytes[1]);
  let last=0;
  const track:number[]=[];
  for(const e of raw){
    const d=Math.max(0,e.tick-last);
    track.push(...writeVarLen(d),...e.bytes);
    last=e.tick;
  }
  track.push(0x00,0xff,0x2f,0x00);
  const header=[...textBytes("MThd"),...u32(6),...u16(0),...u16(1),...u16(ppq)];
  const trk=[...textBytes("MTrk"),...u32(track.length),...track];
  return new Uint8Array([...header,...trk]);
}

export default function App(){
  const videoRef=useRef<HTMLVideoElement|null>(null);
  const canvasRef=useRef<HTMLCanvasElement|null>(null);

  const [videoUrl,setVideoUrl]=useState("");
  const [keyboardRect,setKeyboardRect]=useState<Rect|null>(null);
  const [dragStart,setDragStart]=useState<{x:number;y:number}|null>(null);
  const [dragRect,setDragRect]=useState<Rect|null>(null);
  const [isAnalyzing,setIsAnalyzing]=useState(false);

  const [mode,setMode]=useState<DetectionMode>("hybrid");
  const [threshold,setThreshold]=useState(18);
  const [minNoteMs,setMinNoteMs]=useState(35);
  const [hitLineOffset,setHitLineOffset]=useState(14);
  const [lineHeight,setLineHeight]=useState(4);
  const [colorStrictness,setColorStrictness]=useState(10);
  const [whiteNoteColor, setWhiteNoteColor] = useState("#49b8ff");
  const [blackNoteColor, setBlackNoteColor] = useState("#ff5cc8");
  const [leftHandColor, setLeftHandColor] = useState("#4aa3ff");
  const [rightHandColor, setRightHandColor] = useState("#ffb347");
  const [colorMode, setColorMode] = useState<ColorMode>("both");
  const [handSplit, setHandSplit] = useState(50);
  const [confirmFrames,setConfirmFrames]=useState(2);

  const [status,setStatus]=useState("動画を読み込んで、Canvasで鍵盤範囲をドラッグ指定");
  const [eventCount,setEventCount]=useState(0);

  const regions=useMemo(()=>keyboardRect?buildPianoRegions(keyboardRect):[],[keyboardRect]);

  const rafRef=useRef<number|null>(null);
  const autoResumeRef=useRef(0);
  const baselineRef=useRef<Map<number,number>>(new Map());
  const activeRef=useRef<Map<number,ActiveNote>>(new Map());
  const pendingOnRef=useRef<Map<number,number>>(new Map());
  const pendingOffRef=useRef<Map<number,number>>(new Map());
  const eventsRef=useRef<NoteEvent[]>([]);
  const videoUrlRef=useRef<string>("");

  function syncCanvasSize(){
    const v=videoRef.current, c=canvasRef.current;
    if(!v||!c) return;
    const vw=v.videoWidth||1280, vh=v.videoHeight||720;
    const scale=Math.min(1,960/vw);
    c.width=Math.floor(vw*scale);
    c.height=Math.floor(vh*scale);
    if (!keyboardRect) {
      const autoH = c.height * 0.34;
      setKeyboardRect({
        x: Math.round(c.width * 0.06),
        y: Math.round(c.height - autoH - c.height * 0.03),
        w: Math.round(c.width * 0.88),
        h: Math.round(autoH),
      });
    }
    drawFrame();
  }

  function drawFrame(){
    const v=videoRef.current, c=canvasRef.current;
    if(!v||!c) return;
    const ctx=c.getContext("2d");
    if(!ctx) return;
    ctx.clearRect(0,0,c.width,c.height);
    ctx.drawImage(v,0,0,c.width,c.height);

    if(keyboardRect){
      ctx.save();
      ctx.strokeStyle="#22d3ee";
      ctx.lineWidth=2;
      ctx.strokeRect(keyboardRect.x,keyboardRect.y,keyboardRect.w,keyboardRect.h);

      for(const r of regions){
        ctx.globalAlpha=r.isBlack?0.9:0.65;
        ctx.strokeStyle=r.isBlack?"#ef4444":"#06b6d4";
        ctx.strokeRect(r.x,r.y,r.w,r.h);
      }

      const hitY=keyboardRect.y-keyboardRect.h*(hitLineOffset/100);
      ctx.globalAlpha=1;
      ctx.strokeStyle="#facc15";
      ctx.lineWidth=2;
      ctx.beginPath();
      ctx.moveTo(keyboardRect.x,hitY);
      ctx.lineTo(keyboardRect.x+keyboardRect.w,hitY);
      ctx.stroke();
      ctx.restore();
    }

    if(dragRect){
      ctx.save();
      ctx.strokeStyle="#facc15";
      ctx.lineWidth=2;
      ctx.strokeRect(dragRect.x,dragRect.y,dragRect.w,dragRect.h);
      ctx.restore();
    }
  }

  function reset(){
    baselineRef.current.clear();
    activeRef.current.clear();
    pendingOnRef.current.clear();
    pendingOffRef.current.clear();
    eventsRef.current=[];
    setEventCount(0);
  }

  function loop(){
    const v=videoRef.current, c=canvasRef.current;
    if(!v||!c) return;
    const ctx=c.getContext("2d");
    if(!ctx) return;

    ctx.drawImage(v,0,0,c.width,c.height);
    const now=v.currentTime*1000;
    const hitY=keyboardRect ? keyboardRect.y-keyboardRect.h*(hitLineOffset/100) : 0;

    for(const key of regions){
      const glow=getLumaScore(ctx,key);
      const base=baselineRef.current.get(key.midi) ?? glow;
      const gdiff=glow-base;
      const wc = hexToRgb(whiteNoteColor);
      const bc = hexToRgb(blackNoteColor);
      const lc = hexToRgb(leftHandColor);
      const rc = hexToRgb(rightHandColor);
      const whiteHue = rgbToHsv(wc.r, wc.g, wc.b).h;
      const blackHue = rgbToHsv(bc.r, bc.g, bc.b).h;
      const leftHue = rgbToHsv(lc.r, lc.g, lc.b).h;
      const rightHue = rgbToHsv(rc.r, rc.g, rc.b).h;
      const keyHue = key.isBlack ? blackHue : whiteHue;
      const splitX = keyboardRect ? keyboardRect.x + keyboardRect.w * (handSplit / 100) : c.width * 0.5;
      const handHue = (key.x + key.w * 0.5) < splitX ? leftHue : rightHue;
      const targetHue = colorMode === "key" ? keyHue : colorMode === "hand" ? handHue : (keyHue + handHue) * 0.5;
      const fall= keyboardRect ? scanLine(ctx,key,hitY,lineHeight,colorStrictness,targetHue) : {ratio:0,strength:0};

      const fallOn=fall.ratio>threshold/100;
      const fallOff=fall.ratio<threshold/220;
      const glowOn=gdiff>threshold;
      const glowOff=gdiff<threshold*0.45;

      const hybridOnScore = (fall.ratio * 100) + Math.max(0, gdiff) * 0.9;
      const hybridOffScore = (fall.ratio * 100) + Math.max(0, gdiff) * 0.6;
      const shouldOn = mode==="hybrid"
        ? (hybridOnScore > threshold * 1.5 || (fallOn && glowOn))
        : mode==="falling" ? fallOn : glowOn;
      const shouldOff= mode==="hybrid"
        ? (hybridOffScore < threshold * 0.95 && (fallOff || glowOff))
        : mode==="falling" ? fallOff : glowOff;

      const strength=Math.max(gdiff,fall.strength);
      const active=activeRef.current.get(key.midi);

      if(!active && gdiff<threshold*0.7){
        baselineRef.current.set(key.midi, base*0.97+glow*0.03);
      }

      if(!active){
        if(shouldOn){
          const n=(pendingOnRef.current.get(key.midi)??0)+1;
          pendingOnRef.current.set(key.midi,n);
          pendingOffRef.current.set(key.midi,0);

          if(n>=confirmFrames){
            const corr=(confirmFrames-1)*16.7;
            activeRef.current.set(key.midi,{
              startMs:Math.max(0,now-corr),
              maxStrength:strength,
              frames:1
            });
            pendingOnRef.current.set(key.midi,0);
          }
        } else {
          pendingOnRef.current.set(key.midi,0);
        }
      } else {
        active.frames++;
        active.maxStrength=Math.max(active.maxStrength,strength);

        if(shouldOff){
          const n=(pendingOffRef.current.get(key.midi)??0)+1;
          pendingOffRef.current.set(key.midi,n);

          if(n>=confirmFrames){
            const corr=(confirmFrames-1)*16.7;
            const endMs=Math.max(active.startMs+1, now-corr);
            const dur=endMs-active.startMs;

            if(dur>=minNoteMs){
              const vel=clamp(Math.round(45+active.maxStrength*1.15),35,120);
              eventsRef.current.push({midi:key.midi,startMs:active.startMs,endMs,velocity:vel});
              setEventCount(eventsRef.current.length);
            }

            activeRef.current.delete(key.midi);
            pendingOffRef.current.set(key.midi,0);
          }
        } else {
          pendingOffRef.current.set(key.midi,0);
        }
      }
    }

    if(keyboardRect){
      const hitY=keyboardRect.y-keyboardRect.h*(hitLineOffset/100);
      ctx.strokeStyle="#facc15";
      ctx.lineWidth=2;
      ctx.beginPath();
      ctx.moveTo(keyboardRect.x,hitY);
      ctx.lineTo(keyboardRect.x+keyboardRect.w,hitY);
      ctx.stroke();
    }

    for(const r of regions){
      ctx.strokeStyle=activeRef.current.has(r.midi) ? "#a3e635" : r.isBlack ? "#ef4444" : "#06b6d4";
      ctx.lineWidth=activeRef.current.has(r.midi) ? 3 : 1;
      ctx.strokeRect(r.x,r.y,r.w,r.h);
    }

    if(!v.paused && !v.ended){
      autoResumeRef.current = 0;
      rafRef.current=requestAnimationFrame(loop);
    } else {
      if (!v.ended && autoResumeRef.current < 10) {
        autoResumeRef.current += 1;
        v.play().catch(()=>{});
        rafRef.current=requestAnimationFrame(loop);
      } else {
        setIsAnalyzing(false);
        setStatus(v.ended ? "解析完了（動画末尾）" : "解析停止");
      }
    }
  }

  function start(){
    const v=videoRef.current;
    if(!v||!keyboardRect){
      setStatus("先に動画読み込みと鍵盤範囲指定をしてください");
      return;
    }
    reset();
    setIsAnalyzing(true);
    setStatus("解析中");
    autoResumeRef.current = 0;
    v.play();
    rafRef.current=requestAnimationFrame(loop);
  }

  function stop(){
    if(rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current=null;
    setIsAnalyzing(false);
    videoRef.current?.pause();
    setStatus("停止");
  }

  function fitKeyboardDefault() {
    const c = canvasRef.current;
    if (!c) return;
    const autoH = c.height * 0.34;
    setKeyboardRect({
      x: Math.round(c.width * 0.06),
      y: Math.round(c.height - autoH - c.height * 0.03),
      w: Math.round(c.width * 0.88),
      h: Math.round(autoH),
    });
    setStatus("鍵盤範囲を自動配置しました。必要なら下のスライダーで微調整してください。");
  }

  function updateKeyboardRect(patch: Partial<Rect>) {
    const c = canvasRef.current;
    if (!c) return;
    const base = keyboardRect ?? { x: 0, y: Math.round(c.height * 0.62), w: c.width, h: Math.round(c.height * 0.34) };
    const next = { ...base, ...patch };
    next.x = clamp(Math.round(next.x), -Math.round(c.width), Math.max(0, c.width - 10));
    next.y = clamp(Math.round(next.y), 0, Math.max(0, c.height - 10));
    next.w = clamp(Math.round(next.w), 10, Math.round(c.width * 1.5));
    next.h = clamp(Math.round(next.h), 10, c.height - next.y);
    setKeyboardRect(next);
  }

  function exportMidi(){
    const v=videoRef.current;
    const now=v ? v.currentTime*1000 : 0;

    for(const [m,a] of activeRef.current){
      eventsRef.current.push({
        midi:m,
        startMs:a.startMs,
        endMs:Math.max(now,a.startMs+minNoteMs),
        velocity:clamp(Math.round(45+a.maxStrength*1.4),35,115)
      });
    }
    activeRef.current.clear();

    const sorted = denoiseAndMerge(eventsRef.current, minNoteMs);

    if(!sorted.length){
      setStatus("ノートなし。thresholdを下げるかline offsetを調整");
      return;
    }

    const bytes=buildExactMidi(sorted,120);
    const url=URL.createObjectURL(new Blob([bytes],{type:"audio/midi"}));
    const a=document.createElement("a");
    a.href=url;
    a.download="perfect.mid";
    a.click();
    URL.revokeObjectURL(url);
    setEventCount(sorted.length);
    setStatus(`MIDI出力完了: ${sorted.length} notes`);
  }

  function canvasPoint(e:React.PointerEvent<HTMLCanvasElement>){
    const c=canvasRef.current!;
    const r=c.getBoundingClientRect();
    return {
      x:((e.clientX-r.left)/r.width)*c.width,
      y:((e.clientY-r.top)/r.height)*c.height
    };
  }

  useEffect(() => {
    return () => {
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    };
  }, []);

  return (
    <div className="app-shell">
      <div className="app-container">
        <div>
          <h1 className="app-title">Perfect Piano Video → MIDI</h1>
          <p className="app-subtitle">Synthesia / Ember風動画からMIDIを生成</p>
        </div>

        <div className="layout-grid">
          <div className="video-panel">
            <input
              className="file-input"
              type="file"
              accept="video/*"
              onChange={e=>{
                const f=e.target.files?.[0];
                if(!f) return;
                if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
                videoUrlRef.current = URL.createObjectURL(f);
                setVideoUrl(videoUrlRef.current);
                setKeyboardRect(null);
                setDragRect(null);
                reset();
                setStatus("動画読み込み完了。Canvas上で鍵盤全体をドラッグ");
              }}
            />

            <video
              ref={videoRef}
              src={videoUrl}
              onLoadedMetadata={syncCanvasSize}
              onSeeked={drawFrame}
              onPause={drawFrame}
              onTimeUpdate={() => { if (!isAnalyzing) drawFrame(); }}
              controls
              playsInline
              className="video-preview"
            />

            <canvas
              ref={canvasRef}
              className="canvas-preview"
              onPointerDown={e=>{
                const p=canvasPoint(e);
                setDragStart(p);
                setDragRect({x:p.x,y:p.y,w:1,h:1});
              }}
              onPointerMove={e=>{
                if(!dragStart) return;
                const p=canvasPoint(e);
                setDragRect({
                  x:Math.min(p.x,dragStart.x),
                  y:Math.min(p.y,dragStart.y),
                  w:Math.abs(p.x-dragStart.x),
                  h:Math.abs(p.y-dragStart.y)
                });
              }}
              onPointerUp={()=>{
                if(dragRect && dragRect.w>50 && dragRect.h>10){
                  setKeyboardRect(dragRect);
                  setStatus("鍵盤範囲設定完了。黄色線が判定ライン");
                }
                setDragStart(null);
              }}
            />
            <div className="status-box">
              範囲指定が難しい場合: 「鍵盤範囲を自動配置」→ 下の X/Y/W/H スライダーで微調整
            </div>
          </div>

          <div className="control-panel">
            <div className="status-box">{status}</div>

            <label className="control-group">
              検出モード
              <select className="control-input" value={mode} onChange={e=>setMode(e.target.value as DetectionMode)}>
                <option value="hybrid">Hybrid: 落下ノーツ + 発光</option>
                <option value="falling">Falling: 落下ノーツのみ</option>
                <option value="glow">Glow: 発光のみ</option>
              </select>
            </label>

            <label className="control-group">threshold {threshold}
              <input className="control-input" type="range" min={5} max={60} value={threshold} onChange={e=>setThreshold(+e.target.value)}/>
            </label>

            <label className="control-group">line offset {hitLineOffset}%
              <input className="control-input" type="range" min={2} max={60} value={hitLineOffset} onChange={e=>setHitLineOffset(+e.target.value)}/>
            </label>

            <label className="control-group">line height {lineHeight}px
              <input className="control-input" type="range" min={1} max={16} value={lineHeight} onChange={e=>setLineHeight(+e.target.value)}/>
            </label>

            <label className="control-group">color strict {colorStrictness}
              <input className="control-input" type="range" min={0} max={40} value={colorStrictness} onChange={e=>setColorStrictness(+e.target.value)}/>
            </label>
            <label className="control-group">
              色モード
              <select className="control-input" value={colorMode} onChange={e=>setColorMode(e.target.value as ColorMode)}>
                <option value="both">鍵盤色 + 手色（Synthesia推奨）</option>
                <option value="key">鍵盤色のみ</option>
                <option value="hand">手色のみ</option>
              </select>
            </label>
            <label className="control-group">白鍵ノーツ色
              <input className="control-input" type="color" value={whiteNoteColor} onChange={e=>setWhiteNoteColor(e.target.value)} />
            </label>
            <label className="control-group">黒鍵ノーツ色
              <input className="control-input" type="color" value={blackNoteColor} onChange={e=>setBlackNoteColor(e.target.value)} />
            </label>
            <label className="control-group">左手ノーツ色
              <input className="control-input" type="color" value={leftHandColor} onChange={e=>setLeftHandColor(e.target.value)} />
            </label>
            <label className="control-group">右手ノーツ色
              <input className="control-input" type="color" value={rightHandColor} onChange={e=>setRightHandColor(e.target.value)} />
            </label>
            <label className="control-group">左右分割位置 {handSplit}%
              <input className="control-input" type="range" min={20} max={80} value={handSplit} onChange={e=>setHandSplit(+e.target.value)} />
            </label>

            <label className="control-group">confirm frames {confirmFrames}
              <input className="control-input" type="range" min={1} max={5} value={confirmFrames} onChange={e=>setConfirmFrames(+e.target.value)}/>
            </label>

            <label className="control-group">min note {minNoteMs}ms
              <input className="control-input" type="range" min={10} max={160} value={minNoteMs} onChange={e=>setMinNoteMs(+e.target.value)}/>
            </label>

            <div className="button-grid">
              <button className="btn btn-primary" onClick={start} disabled={isAnalyzing}>start</button>
              <button className="btn" onClick={stop} disabled={!isAnalyzing}>stop</button>
              <button className="btn btn-success button-wide" onClick={exportMidi}>export MIDI</button>
            </div>
            <div className="button-grid">
              <button className="btn button-wide" onClick={fitKeyboardDefault}>鍵盤範囲を自動配置</button>
            </div>
            {keyboardRect && (
              <div>
                <label className="control-group">keyboard X {Math.round(keyboardRect.x)}
                  <input className="control-input" type="range" min={-Math.round(canvasRef.current?.width ?? 1)} max={canvasRef.current?.width ?? 1} value={keyboardRect.x} onChange={e=>updateKeyboardRect({x:+e.target.value})}/>
                </label>
                <label className="control-group">keyboard Y {Math.round(keyboardRect.y)}
                  <input className="control-input" type="range" min={0} max={canvasRef.current?.height ?? 1} value={keyboardRect.y} onChange={e=>updateKeyboardRect({y:+e.target.value})}/>
                </label>
                <label className="control-group">keyboard W {Math.round(keyboardRect.w)}
                  <input className="control-input" type="range" min={50} max={Math.round((canvasRef.current?.width ?? 100) * 1.5)} value={keyboardRect.w} onChange={e=>updateKeyboardRect({w:+e.target.value})}/>
                </label>
                <label className="control-group">keyboard H {Math.round(keyboardRect.h)}
                  <input className="control-input" type="range" min={30} max={canvasRef.current?.height ?? 30} value={keyboardRect.h} onChange={e=>updateKeyboardRect({h:+e.target.value})}/>
                </label>
              </div>
            )}
            <p className="help-text">Tip: Hybrid + confirm frames 2-3 + min note 40-70ms がSynthesiaで安定しやすいです。</p>

            <div className="notes-count">notes: {eventCount}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
