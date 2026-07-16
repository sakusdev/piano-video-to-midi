import type {
  ChangeEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import { midiName } from "../engine/geometry";
import type { NoteEvent } from "../engine/types";

export type AudioStatus = "idle" | "loading" | "ready" | "unavailable";
export type SampleTarget = "left" | "right" | null;

type PreviewPanelProps = {
  sourceUrl: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  sampleTarget: SampleTarget;
  isRunning: boolean;
  currentTime: number;
  duration: number;
  progress: number;
  noteCount: number;
  activeCount: number;
  audioStatus: AudioStatus;
  audioProgress: number;
  audioOnsetCount: number;
  recentEvents: NoteEvent[];
  onFile: (file: File) => void;
  onLoadedMetadata: () => void;
  onSeeked: () => void;
  onTimeUpdate: () => void;
  onEnded: () => void;
  onPointerDown: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  onTogglePreview: () => void;
  onSeek: (seconds: number) => void;
  onAutoFit: () => void;
  onRefresh: () => void;
};

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remaining}`;
}

function FilePicker({ onFile, replace = false }: { onFile: (file: File) => void; replace?: boolean }) {
  if (replace) {
    return (
      <label className="secondary-button file-replace">
        動画を変更
        <input
          type="file"
          accept="video/*"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];
            if (file) onFile(file);
          }}
        />
      </label>
    );
  }
  return (
    <label className="drop-zone">
      <input
        type="file"
        accept="video/*"
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
        }}
      />
      <div className="drop-icon">♪</div>
      <strong>ピアノ動画を追加</strong>
      <span>Synthesia / SeeMusic / Piano VFX 系の動画に最適化</span>
      <span className="drop-action">動画を選択</span>
    </label>
  );
}

export function PreviewPanel(props: PreviewPanelProps) {
  const {
    sourceUrl,
    videoRef,
    canvasRef,
    sampleTarget,
    isRunning,
    currentTime,
    duration,
    progress,
    noteCount,
    activeCount,
    audioStatus,
    audioProgress,
    audioOnsetCount,
    recentEvents,
    onFile,
    onLoadedMetadata,
    onSeeked,
    onTimeUpdate,
    onEnded,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onTogglePreview,
    onSeek,
    onAutoFit,
    onRefresh,
  } = props;

  return (
    <div className="preview-column">
      {!sourceUrl ? (
        <FilePicker onFile={onFile} />
      ) : (
        <div className="preview-card">
          <video
            ref={videoRef}
            src={sourceUrl}
            className="source-video"
            playsInline
            preload="auto"
            onLoadedMetadata={onLoadedMetadata}
            onSeeked={onSeeked}
            onTimeUpdate={onTimeUpdate}
            onEnded={onEnded}
          />
          <div className={`canvas-wrap ${sampleTarget ? "sampling" : ""}`}>
            <canvas
              ref={canvasRef}
              className="analysis-canvas"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            />
            {sampleTarget && (
              <div className="sampling-hint">
                {sampleTarget === "left" ? "左手" : "右手"}ノーツの中央をタップ
              </div>
            )}
            {isRunning && <div className="live-badge"><span />解析中</div>}
          </div>

          <div className="transport">
            <button
              type="button"
              className="icon-button"
              onClick={onTogglePreview}
              disabled={isRunning}
              aria-label="プレビューを再生または一時停止"
            >▶</button>
            <span>{formatTime(currentTime)}</span>
            <input
              type="range"
              min={0}
              max={Math.max(0.01, duration)}
              step={0.01}
              value={currentTime}
              disabled={isRunning}
              onChange={(event: ChangeEvent<HTMLInputElement>) => onSeek(Number(event.target.value))}
              aria-label="動画位置"
            />
            <span>{formatTime(duration)}</span>
          </div>

          <div className="preview-actions">
            <FilePicker onFile={onFile} replace />
            <button type="button" className="secondary-button" onClick={onAutoFit} disabled={isRunning}>
              鍵盤を再検出
            </button>
            <button type="button" className="secondary-button" onClick={onRefresh}>表示を更新</button>
          </div>
        </div>
      )}

      {sourceUrl && (
        <div className="analysis-summary">
          <div><span>進捗</span><strong>{Math.round(progress * 100)}%</strong></div>
          <div><span>検出ノート</span><strong>{noteCount}</strong></div>
          <div><span>発音中</span><strong>{activeCount}</strong></div>
          <div>
            <span>音声onset</span>
            <strong>{audioStatus === "loading" ? `${Math.round(audioProgress * 100)}%` : audioOnsetCount}</strong>
          </div>
        </div>
      )}

      {recentEvents.length > 0 && (
        <div className="recent-card">
          <div className="section-heading">
            <div><span className="step-label">LIVE RESULT</span><h2>直近の検出</h2></div>
          </div>
          <div className="event-list">
            {[...recentEvents].reverse().map((event, index) => (
              <div className="event-row" key={`${event.midi}-${event.startMs}-${index}`}>
                <strong>{midiName(event.midi)}</strong>
                <span>{(event.startMs / 1000).toFixed(2)}s</span>
                <span>{Math.round(event.endMs - event.startMs)}ms</span>
                <span>{Math.round(event.confidence * 100)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
