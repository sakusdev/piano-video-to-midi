import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { analyzeAudioOnsets, type AudioAnalysisProgress } from "./engine/audio";
import {
  buildPianoKeys,
  clamp,
  estimateKeyboardGeometry,
  medianKeyboardGeometry,
  midiName,
} from "./engine/geometry";
import { buildMidi } from "./engine/midi";
import { finalizeNoteEvents } from "./engine/postprocess";
import { hueFromHex } from "./engine/vision";
import { VisionWorkerClient } from "./engine/vision-worker";
import { FrameAnalyzer, type FrameAnalyzerSettings } from "./engine/frame-analyzer";
import type {
  AnalysisQuality,
  AudioOnset,
  DetectionMode,
  KeyboardGeometry,
  NoteEvent,
  Rect,
} from "./engine/types";
import { PreviewPanel, type AudioStatus, type SampleTarget } from "./components/PreviewPanel";
import { ControlPanel, type AppStage } from "./components/ControlPanel";

const QUALITY_SETTINGS: Record<AnalysisQuality, { playbackRate: number; label: string; hint: string }> = {
  fast: { playbackRate: 1.2, label: "高速", hint: "短い確認用。処理の軽さを優先します。" },
  balanced: { playbackRate: 0.72, label: "標準", hint: "精度と速度のバランスを取ります。" },
  accurate: { playbackRate: 0.38, label: "高精度", hint: "低速再生でフレーム欠落を抑えます。" },
};

const PRESETS = {
  synthesia: {
    left: "#6fb8ff",
    right: "#9bdc4b",
    threshold: 18,
    colorTolerance: 14,
    blackGuard: 58,
    lineHeight: 7,
  },
  neon: {
    left: "#27d7ff",
    right: "#ff4dc4",
    threshold: 15,
    colorTolerance: 10,
    blackGuard: 52,
    lineHeight: 8,
  },
};

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remaining}`;
}

function rgbToHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue]
    .map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AppRhythm() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceUrlRef = useRef("");
  const frameCallbackRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const audioAbortRef = useRef<AbortController | null>(null);
  const audioOnsetsRef = useRef<AudioOnset[]>([]);
  const audioIndexRef = useRef(0);
  const analyzerRef = useRef(new FrameAnalyzer());
  const visionWorkerRef = useRef(new VisionWorkerClient());
  const analysisGenerationRef = useRef(0);

  const [sourceUrl, setSourceUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [keyboardRect, setKeyboardRect] = useState<Rect | null>(null);
  const [keyboardConfidence, setKeyboardConfidence] = useState(0);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragRect, setDragRect] = useState<Rect | null>(null);
  const [sampleTarget, setSampleTarget] = useState<SampleTarget>(null);
  const [stage, setStage] = useState<AppStage>("empty");
  const [status, setStatus] = useState("動画を追加してください");
  const [isRunning, setIsRunning] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [progress, setProgress] = useState(0);
  const [noteCount, setNoteCount] = useState(0);
  const [recentEvents, setRecentEvents] = useState<NoteEvent[]>([]);
  const [activeCount, setActiveCount] = useState(0);

  const [audioStatus, setAudioStatus] = useState<AudioStatus>("idle");
  const [audioProgress, setAudioProgress] = useState(0);
  const [audioOnsetCount, setAudioOnsetCount] = useState(0);

  const [mode, setMode] = useState<DetectionMode>("balanced");
  const [quality, setQuality] = useState<AnalysisQuality>("balanced");
  const [leftColor, setLeftColor] = useState(PRESETS.synthesia.left);
  const [rightColor, setRightColor] = useState(PRESETS.synthesia.right);
  const [handSplit, setHandSplit] = useState(50);
  const [threshold, setThreshold] = useState(PRESETS.synthesia.threshold);
  const [colorTolerance, setColorTolerance] = useState(PRESETS.synthesia.colorTolerance);
  const [blackGuard, setBlackGuard] = useState(PRESETS.synthesia.blackGuard);
  const [lineOffset, setLineOffset] = useState(14);
  const [lineHeight, setLineHeight] = useState(PRESETS.synthesia.lineHeight);
  const [confirmFrames, setConfirmFrames] = useState(2);
  const [minimumNoteMs, setMinimumNoteMs] = useState(38);
  const [leadMs, setLeadMs] = useState(0);
  const [bpm, setBpm] = useState(120);

  const keys = useMemo(
    () => keyboardRect ? buildPianoKeys(keyboardRect) : [],
    [keyboardRect],
  );
  const leftHue = useMemo(() => hueFromHex(leftColor), [leftColor]);
  const rightHue = useMemo(() => hueFromHex(rightColor), [rightColor]);

  const cancelScheduledFrame = () => {
    const video = videoRef.current as (HTMLVideoElement & {
      cancelVideoFrameCallback?: (handle: number) => void;
    }) | null;
    if (frameCallbackRef.current !== null && video?.cancelVideoFrameCallback) {
      video.cancelVideoFrameCallback(frameCallbackRef.current);
    }
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    frameCallbackRef.current = null;
    animationFrameRef.current = null;
  };

  const resetAnalysis = () => {
    analysisGenerationRef.current += 1;
    visionWorkerRef.current.reset();
    analyzerRef.current.reset();
    audioIndexRef.current = 0;
    setNoteCount(0);
    setRecentEvents([]);
    setActiveCount(0);
    setProgress(0);
  };

  const drawFrame = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!video || !canvas || !context || !canvas.width || !canvas.height) return;

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    if (keyboardRect) {
      const hitLineY = keyboardRect.y - keyboardRect.h * (lineOffset / 100);
      context.save();
      context.strokeStyle = "#58d7ff";
      context.lineWidth = 2;
      context.strokeRect(keyboardRect.x, keyboardRect.y, keyboardRect.w, keyboardRect.h);
      context.fillStyle = "rgba(88, 215, 255, 0.08)";
      context.fillRect(keyboardRect.x, keyboardRect.y, keyboardRect.w, keyboardRect.h);

      for (const key of keys) {
        const active = analyzerRef.current.activeMidis.has(key.midi);
        context.globalAlpha = active ? 1 : key.isBlack ? 0.72 : 0.38;
        context.strokeStyle = active ? "#b8ff5c" : key.isBlack ? "#ff6e7a" : "#65ddeb";
        context.lineWidth = active ? 3 : 1;
        context.strokeRect(key.x, key.y, key.w, key.h);
        if (active && key.w >= 12) {
          context.fillStyle = "rgba(184, 255, 92, 0.2)";
          context.fillRect(key.x, key.y, key.w, key.h);
        }
      }

      context.globalAlpha = 1;
      context.strokeStyle = "#ffd75a";
      context.lineWidth = 2;
      context.setLineDash([8, 5]);
      context.beginPath();
      context.moveTo(keyboardRect.x, hitLineY);
      context.lineTo(keyboardRect.x + keyboardRect.w, hitLineY);
      context.stroke();
      context.setLineDash([]);

      const splitX = keyboardRect.x + keyboardRect.w * (handSplit / 100);
      context.strokeStyle = "rgba(255, 255, 255, 0.45)";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(splitX, hitLineY - 16);
      context.lineTo(splitX, keyboardRect.y + keyboardRect.h);
      context.stroke();
      context.restore();
    }

    if (dragRect) {
      context.save();
      context.strokeStyle = "#ffd75a";
      context.fillStyle = "rgba(255, 215, 90, 0.12)";
      context.lineWidth = 2;
      context.fillRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
      context.strokeRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
      context.restore();
    }
  };

  const scheduleFrame = () => {
    if (!runningRef.current || frameCallbackRef.current !== null || animationFrameRef.current !== null) return;
    const video = videoRef.current as (HTMLVideoElement & {
      requestVideoFrameCallback?: (
        callback: (now: number, metadata: { mediaTime: number }) => void,
      ) => number;
    }) | null;
    if (!video) return;

    if (video.requestVideoFrameCallback) {
      frameCallbackRef.current = video.requestVideoFrameCallback((_now, metadata) => {
        frameCallbackRef.current = null;
        void processFrame(metadata.mediaTime * 1000);
      });
    } else {
      animationFrameRef.current = requestAnimationFrame(() => {
        animationFrameRef.current = null;
        void processFrame((videoRef.current?.currentTime ?? 0) * 1000);
      });
    }
  };

  const findAudioOnset = (nowMs: number) => {
    const onsets = audioOnsetsRef.current;
    while (
      audioIndexRef.current < onsets.length
      && onsets[audioIndexRef.current].ms < nowMs - 58
    ) audioIndexRef.current += 1;
    const onset = onsets[audioIndexRef.current];
    if (!onset || Math.abs(onset.ms - nowMs) > 46) return undefined;
    return onset;
  };

  const appendEvents = (events: NoteEvent[]) => {
    if (!events.length) return;
    setNoteCount(analyzerRef.current.events.length);
    setRecentEvents((previous) => [...previous, ...events].slice(-8));
  };

  const finishAnalysis = (message = "解析が完了しました") => {
    const nowMs = (videoRef.current?.currentTime ?? 0) * 1000;
    appendEvents(analyzerRef.current.finish(nowMs, minimumNoteMs));
    runningRef.current = false;
    analysisGenerationRef.current += 1;
    visionWorkerRef.current.reset();
    cancelScheduledFrame();
    setIsRunning(false);
    setActiveCount(0);
    setProgress(1);
    setStage("complete");
    setStatus(message);
  };

  const processFrame = async (nowMs: number) => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!video || !canvas || !context || !keyboardRect || !runningRef.current) return;

    if (video.ended || nowMs >= video.duration * 1000 - 8) {
      finishAnalysis();
      return;
    }
    if (video.paused) {
      scheduleFrame();
      return;
    }

    const generation = analysisGenerationRef.current;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const settings: FrameAnalyzerSettings = {
      mode,
      threshold,
      colorTolerance,
      blackGuard,
      handSplit,
      leftHue,
      rightHue,
      lineOffset,
      lineHeight,
      confirmFrames,
      minimumNoteMs,
    };
    const hitLineY = keyboardRect.y - keyboardRect.h * (lineOffset / 100);

    try {
      const vision = await visionWorkerRef.current.analyze(
        context,
        keyboardRect,
        keys,
        hitLineY,
        lineHeight,
        {
          threshold: threshold * 0.72,
          colorTolerance,
          blackGuard,
          handSplit,
          leftHue,
          rightHue,
        },
      );
      if (generation !== analysisGenerationRef.current || !runningRef.current) return;
      const result = analyzerRef.current.process(
        nowMs,
        keys,
        settings,
        vision,
        findAudioOnset(nowMs),
      );
      appendEvents(result.added);
      setActiveCount(result.activeCount);
      const seconds = nowMs / 1000;
      setCurrentTime(seconds);
      setProgress(duration > 0 ? clamp(seconds / duration, 0, 1) : 0);
      drawFrame();
      scheduleFrame();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (generation !== analysisGenerationRef.current || !runningRef.current) return;
      runningRef.current = false;
      cancelScheduledFrame();
      video.pause();
      setIsRunning(false);
      setStage(analyzerRef.current.events.length ? "complete" : "ready");
      setStatus("映像解析Workerでエラーが発生しました。設定を確認して再実行してください");
    }
  };

  const seekTo = async (seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    const target = clamp(seconds, 0, Math.max(0, video.duration || seconds));
    if (Math.abs(video.currentTime - target) < 0.015) {
      video.currentTime = target;
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      video.addEventListener("seeked", done, { once: true });
      video.currentTime = target;
    });
  };

  const syncCanvas = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const sourceWidth = video.videoWidth || 1280;
    const sourceHeight = video.videoHeight || 720;
    const scale = Math.min(1, 1280 / sourceWidth);
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    const context = canvas.getContext("2d");
    if (context) {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const geometry = estimateKeyboardGeometry(context);
      setKeyboardRect(geometry.rect);
      setKeyboardConfidence(geometry.confidence);
      setStage("calibrate");
      setStatus("鍵盤範囲とノーツ色を確認してください");
    }
    drawFrame();
  };

  const autoFitKeyboard = async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!video || !canvas || !context) return;

    const wasPaused = video.paused;
    const origin = video.currentTime;
    const sampleTimes = duration > 1
      ? [0.04, 0.12, 0.24, 0.39, 0.56, 0.73, 0.88]
        .map((ratio) => clamp(duration * ratio, 0, Math.max(0.01, duration - 0.05)))
      : [origin];
    const geometries: KeyboardGeometry[] = [];
    setStatus("複数フレームから鍵盤を推定しています…");

    for (const sampleTime of sampleTimes) {
      await seekTo(sampleTime);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      geometries.push(estimateKeyboardGeometry(context));
    }

    const fallback = keyboardRect ?? {
      x: 0,
      y: Math.round(canvas.height * 0.62),
      w: canvas.width,
      h: Math.round(canvas.height * 0.32),
    };
    const result = medianKeyboardGeometry(geometries, fallback);
    setKeyboardRect(result.rect);
    setKeyboardConfidence(result.confidence);
    await seekTo(origin);
    if (!wasPaused) void video.play();
    setStage("ready");
    setStatus(`鍵盤を自動設定しました（信頼度 ${Math.round(result.confidence * 100)}%）`);
    drawFrame();
  };

  const updateKeyboardRect = (patch: Partial<Rect>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const base = keyboardRect ?? {
      x: 0,
      y: Math.round(canvas.height * 0.62),
      w: canvas.width,
      h: Math.round(canvas.height * 0.32),
    };
    const next = { ...base, ...patch };
    next.x = clamp(Math.round(next.x), -Math.round(canvas.width * 0.55), Math.round(canvas.width * 0.4));
    next.y = clamp(Math.round(next.y), 0, canvas.height - 10);
    next.w = clamp(Math.round(next.w), 20, Math.round(canvas.width * 1.9));
    next.h = clamp(Math.round(next.h), 20, canvas.height - next.y);
    setKeyboardRect(next);
    setKeyboardConfidence(1);
    setStage("ready");
  };

  const canvasPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) / bounds.width * canvas.width,
      y: (event.clientY - bounds.top) / bounds.height * canvas.height,
    };
  };

  const sampleCanvasColor = (point: { x: number; y: number }) => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!video || !canvas || !context || !sampleTarget) return false;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const x = clamp(Math.round(point.x), 0, canvas.width - 1);
    const y = clamp(Math.round(point.y), 0, canvas.height - 1);
    const pixel = context.getImageData(x, y, 1, 1).data;
    const color = rgbToHex(pixel[0], pixel[1], pixel[2]);
    if (sampleTarget === "left") setLeftColor(color);
    else setRightColor(color);
    setSampleTarget(null);
    setStage("ready");
    setStatus(`${sampleTarget === "left" ? "左手" : "右手"}ノーツ色を ${color} に設定しました`);
    drawFrame();
    return true;
  };

  const loadAudio = async (file: File) => {
    audioAbortRef.current?.abort();
    const controller = new AbortController();
    audioAbortRef.current = controller;
    audioOnsetsRef.current = [];
    setAudioStatus("loading");
    setAudioProgress(0);
    setAudioOnsetCount(0);

    try {
      const onsets = await analyzeAudioOnsets(
        file,
        (value: AudioAnalysisProgress) => setAudioProgress(value.progress),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      audioOnsetsRef.current = onsets;
      setAudioOnsetCount(onsets.length);
      setAudioStatus(onsets.length ? "ready" : "unavailable");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setAudioStatus("unavailable");
    }
  };

  const handleFile = (file: File) => {
    runningRef.current = false;
    cancelScheduledFrame();
    audioAbortRef.current?.abort();
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    const url = URL.createObjectURL(file);
    sourceUrlRef.current = url;
    setSourceUrl(url);
    setFileName(file.name);
    setKeyboardRect(null);
    setKeyboardConfidence(0);
    setDragRect(null);
    setCurrentTime(0);
    setDuration(0);
    setStage("calibrate");
    setStatus("動画を読み込み中…");
    resetAnalysis();
    void loadAudio(file);
  };

  const startAnalysis = async () => {
    const video = videoRef.current;
    if (!video || !keyboardRect) {
      setStatus("先に動画と鍵盤範囲を設定してください");
      return;
    }

    cancelScheduledFrame();
    resetAnalysis();
    await seekTo(0);
    video.playbackRate = QUALITY_SETTINGS[quality].playbackRate;
    runningRef.current = true;
    setIsRunning(true);
    setStage("analyzing");
    setStatus(`解析中 — ${QUALITY_SETTINGS[quality].label}モード`);
    try {
      await video.play();
      scheduleFrame();
    } catch {
      runningRef.current = false;
      setIsRunning(false);
      setStatus("再生がブロックされました。もう一度「解析開始」を押してください");
    }
  };

  const stopAnalysis = () => {
    runningRef.current = false;
    analysisGenerationRef.current += 1;
    visionWorkerRef.current.reset();
    cancelScheduledFrame();
    videoRef.current?.pause();
    setIsRunning(false);
    setStage(analyzerRef.current.events.length ? "complete" : "ready");
    setStatus("解析を停止しました。途中結果をMIDIに書き出せます");
  };

  const exportMidi = () => {
    const nowMs = (videoRef.current?.currentTime ?? 0) * 1000;
    appendEvents(analyzerRef.current.finish(nowMs, minimumNoteMs));
    const events = finalizeNoteEvents(
      analyzerRef.current.events,
      minimumNoteMs,
      audioOnsetsRef.current,
      leadMs,
    );
    if (!events.length) {
      setStatus("書き出せるノートがありません。色・判定ライン・感度を確認してください");
      return;
    }
    const safeName = fileName.replace(/\.[^.]+$/, "") || "piano-video";
    downloadBlob(new Blob([buildMidi(events, bpm)], { type: "audio/midi" }), `${safeName}.mid`);
    setNoteCount(events.length);
    setRecentEvents(events.slice(-8));
    setStatus(`MIDIを書き出しました（${events.length}ノート）`);
  };

  const applyPreset = (name: keyof typeof PRESETS) => {
    const preset = PRESETS[name];
    setLeftColor(preset.left);
    setRightColor(preset.right);
    setThreshold(preset.threshold);
    setColorTolerance(preset.colorTolerance);
    setBlackGuard(preset.blackGuard);
    setLineHeight(preset.lineHeight);
    setMode("balanced");
    setStage(keyboardRect ? "ready" : stage);
    setStatus(`${name === "synthesia" ? "Synthesia 青/緑" : "ネオン 青/ピンク"}プリセットを適用しました`);
  };

  useEffect(() => {
    drawFrame();
  }, [keyboardRect, dragRect, lineOffset, handSplit, keys.length]);

  useEffect(() => {
    return () => {
      runningRef.current = false;
      analysisGenerationRef.current += 1;
      cancelScheduledFrame();
      visionWorkerRef.current.dispose();
      audioAbortRef.current?.abort();
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    };
  }, []);

  const canvasWidth = canvasRef.current?.width ?? 960;
  const canvasHeight = canvasRef.current?.height ?? 540;
  const canStart = Boolean(sourceUrl && keyboardRect && !isRunning);
  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">LOCAL • PRIVATE • VIDEO TO MIDI</div>
          <h1>Piano Video to MIDI</h1>
          <p>映像のノーツ追跡と音声onsetを統合して、編集可能なMIDIへ変換します。</p>
        </div>
        <div className="privacy-badge"><span />ファイルは端末外へ送信されません</div>
      </header>

      <section className="workspace">
        <PreviewPanel
          sourceUrl={sourceUrl}
          videoRef={videoRef}
          canvasRef={canvasRef}
          sampleTarget={sampleTarget}
          isRunning={isRunning}
          currentTime={currentTime}
          duration={duration}
          progress={progress}
          noteCount={noteCount}
          activeCount={activeCount}
          audioStatus={audioStatus}
          audioProgress={audioProgress}
          audioOnsetCount={audioOnsetCount}
          recentEvents={recentEvents}
          onFile={handleFile}
          onLoadedMetadata={syncCanvas}
          onSeeked={() => {
            setCurrentTime(videoRef.current?.currentTime ?? 0);
            drawFrame();
          }}
          onTimeUpdate={() => {
            if (!runningRef.current) {
              setCurrentTime(videoRef.current?.currentTime ?? 0);
              drawFrame();
            }
          }}
          onEnded={() => { if (runningRef.current) finishAnalysis(); }}
          onPointerDown={(event) => {
            if (isRunning) return;
            const point = canvasPoint(event);
            if (sampleCanvasColor(point)) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragStart(point);
            setDragRect({ x: point.x, y: point.y, w: 1, h: 1 });
          }}
          onPointerMove={(event) => {
            if (!dragStart || isRunning || sampleTarget) return;
            const point = canvasPoint(event);
            setDragRect({
              x: Math.min(point.x, dragStart.x),
              y: Math.min(point.y, dragStart.y),
              w: Math.abs(point.x - dragStart.x),
              h: Math.abs(point.y - dragStart.y),
            });
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            if (dragRect && dragRect.w > 60 && dragRect.h > 20) {
              setKeyboardRect(dragRect);
              setKeyboardConfidence(1);
              setStage("ready");
              setStatus("鍵盤範囲を手動設定しました");
            }
            setDragStart(null);
            setDragRect(null);
          }}
          onTogglePreview={() => {
            const video = videoRef.current;
            if (!video || isRunning) return;
            if (video.paused) void video.play();
            else video.pause();
          }}
          onSeek={(seconds) => {
            setCurrentTime(seconds);
            if (videoRef.current) videoRef.current.currentTime = seconds;
          }}
          onAutoFit={autoFitKeyboard}
          onRefresh={drawFrame}
        />

        <ControlPanel
          stage={stage}
          status={status}
          fileName={fileName}
          sourceUrl={sourceUrl}
          keyboardRect={keyboardRect}
          keyboardConfidence={keyboardConfidence}
          canvasWidth={canvasWidth}
          canvasHeight={canvasHeight}
          isRunning={isRunning}
          sampleTarget={sampleTarget}
          leftColor={leftColor}
          rightColor={rightColor}
          handSplit={handSplit}
          quality={quality}
          qualitySettings={QUALITY_SETTINGS}
          audioStatus={audioStatus}
          audioProgress={audioProgress}
          audioOnsetCount={audioOnsetCount}
          progress={progress}
          noteCount={noteCount}
          activeCount={activeCount}
          mode={mode}
          threshold={threshold}
          colorTolerance={colorTolerance}
          blackGuard={blackGuard}
          lineOffset={lineOffset}
          lineHeight={lineHeight}
          confirmFrames={confirmFrames}
          minimumNoteMs={minimumNoteMs}
          leadMs={leadMs}
          bpm={bpm}
          onAutoFit={autoFitKeyboard}
          onManualHint={() => setStatus("プレビュー上で鍵盤全体をドラッグしてください")}
          onRect={updateKeyboardRect}
          onPreset={applyPreset}
          onLeftColor={setLeftColor}
          onRightColor={setRightColor}
          onSampleTarget={setSampleTarget}
          onHandSplit={setHandSplit}
          onQuality={setQuality}
          onStart={startAnalysis}
          onStop={stopAnalysis}
          onExport={exportMidi}
          onMode={setMode}
          onThreshold={setThreshold}
          onColorTolerance={setColorTolerance}
          onBlackGuard={setBlackGuard}
          onLineOffset={setLineOffset}
          onLineHeight={setLineHeight}
          onConfirmFrames={setConfirmFrames}
          onMinimumNoteMs={setMinimumNoteMs}
          onLeadMs={setLeadMs}
          onBpm={setBpm}
        />
      </section>
    </main>
  );
}
