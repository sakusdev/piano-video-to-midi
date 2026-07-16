import type { ChangeEvent } from "react";
import { clamp } from "../engine/geometry";
import type { AnalysisQuality, DetectionMode, Rect } from "../engine/types";
import type { AudioStatus, SampleTarget } from "./PreviewPanel";

export type AppStage = "empty" | "calibrate" | "ready" | "analyzing" | "complete";
export type QualitySettings = Record<AnalysisQuality, { playbackRate: number; label: string; hint: string }>;

type ControlPanelProps = {
  stage: AppStage;
  status: string;
  fileName: string;
  sourceUrl: string;
  keyboardRect: Rect | null;
  keyboardConfidence: number;
  canvasWidth: number;
  canvasHeight: number;
  isRunning: boolean;
  sampleTarget: SampleTarget;
  leftColor: string;
  rightColor: string;
  handSplit: number;
  quality: AnalysisQuality;
  qualitySettings: QualitySettings;
  audioStatus: AudioStatus;
  audioProgress: number;
  audioOnsetCount: number;
  progress: number;
  noteCount: number;
  activeCount: number;
  mode: DetectionMode;
  threshold: number;
  colorTolerance: number;
  blackGuard: number;
  lineOffset: number;
  lineHeight: number;
  confirmFrames: number;
  minimumNoteMs: number;
  leadMs: number;
  bpm: number;
  onAutoFit: () => void;
  onManualHint: () => void;
  onRect: (patch: Partial<Rect>) => void;
  onPreset: (name: "synthesia" | "neon") => void;
  onLeftColor: (value: string) => void;
  onRightColor: (value: string) => void;
  onSampleTarget: (target: SampleTarget) => void;
  onHandSplit: (value: number) => void;
  onQuality: (value: AnalysisQuality) => void;
  onStart: () => void;
  onStop: () => void;
  onExport: () => void;
  onMode: (value: DetectionMode) => void;
  onThreshold: (value: number) => void;
  onColorTolerance: (value: number) => void;
  onBlackGuard: (value: number) => void;
  onLineOffset: (value: number) => void;
  onLineHeight: (value: number) => void;
  onConfirmFrames: (value: number) => void;
  onMinimumNoteMs: (value: number) => void;
  onLeadMs: (value: number) => void;
  onBpm: (value: number) => void;
};

export function ControlPanel(props: ControlPanelProps) {
  const confidenceLabel = props.keyboardConfidence >= 0.72
    ? "高"
    : props.keyboardConfidence >= 0.45 ? "中" : "要確認";
  const canStart = Boolean(props.sourceUrl && props.keyboardRect && !props.isRunning);

  return (
    <aside className="control-column">
      <div className={`status-banner status-${props.stage}`}>
        <span className="status-dot" />
        <div><strong>{props.status}</strong>{props.fileName && <small>{props.fileName}</small>}</div>
      </div>

      <section className="control-card">
        <div className="section-heading">
          <div><span className="step-label">STEP 1</span><h2>鍵盤を合わせる</h2></div>
          <span className={`confidence confidence-${confidenceLabel === "要確認" ? "low" : confidenceLabel === "中" ? "mid" : "high"}`}>
            信頼度 {confidenceLabel} {Math.round(props.keyboardConfidence * 100)}%
          </span>
        </div>
        <p className="section-copy">青い枠が鍵盤全体を覆い、黄色線が落下ノーツの接触位置に重なるよう調整します。</p>
        <div className="two-buttons">
          <button type="button" className="secondary-button" onClick={props.onAutoFit} disabled={!props.sourceUrl || props.isRunning}>自動検出</button>
          <button type="button" className="secondary-button" onClick={props.onManualHint} disabled={!props.sourceUrl || props.isRunning}>手動で囲む</button>
        </div>
        {props.keyboardRect && (
          <div className="compact-sliders">
            <RangeControl label="X" value={Math.round(props.keyboardRect.x)} min={-Math.round(props.canvasWidth * 0.55)} max={Math.round(props.canvasWidth * 0.4)} onChange={(value) => props.onRect({ x: value })} disabled={props.isRunning} />
            <RangeControl label="Y" value={Math.round(props.keyboardRect.y)} min={0} max={props.canvasHeight} onChange={(value) => props.onRect({ y: value })} disabled={props.isRunning} />
            <RangeControl label="幅" value={Math.round(props.keyboardRect.w)} min={20} max={Math.round(props.canvasWidth * 1.9)} onChange={(value) => props.onRect({ w: value })} disabled={props.isRunning} />
            <RangeControl label="高さ" value={Math.round(props.keyboardRect.h)} min={20} max={props.canvasHeight} onChange={(value) => props.onRect({ h: value })} disabled={props.isRunning} />
          </div>
        )}
      </section>

      <section className="control-card">
        <div className="section-heading"><div><span className="step-label">STEP 2</span><h2>ノーツ色を指定</h2></div></div>
        <div className="preset-row">
          <button type="button" onClick={() => props.onPreset("synthesia")} disabled={props.isRunning}>青 / 緑</button>
          <button type="button" onClick={() => props.onPreset("neon")} disabled={props.isRunning}>青 / ピンク</button>
        </div>
        <div className="color-grid">
          <ColorControl label="左手" color={props.leftColor} onChange={props.onLeftColor} onSample={() => props.onSampleTarget(props.sampleTarget === "left" ? null : "left")} active={props.sampleTarget === "left"} disabled={props.isRunning} />
          <ColorControl label="右手" color={props.rightColor} onChange={props.onRightColor} onSample={() => props.onSampleTarget(props.sampleTarget === "right" ? null : "right")} active={props.sampleTarget === "right"} disabled={props.isRunning} />
        </div>
        <RangeControl label="左右の境界" value={props.handSplit} min={20} max={80} suffix="%" onChange={props.onHandSplit} disabled={props.isRunning} />
      </section>

      <section className="control-card">
        <div className="section-heading"><div><span className="step-label">STEP 3</span><h2>解析する</h2></div></div>
        <div className="segmented-control">
          {(Object.keys(props.qualitySettings) as AnalysisQuality[]).map((value) => (
            <button type="button" key={value} className={props.quality === value ? "selected" : ""} onClick={() => props.onQuality(value)} disabled={props.isRunning}>
              {props.qualitySettings[value].label}
            </button>
          ))}
        </div>
        <p className="quality-hint">{props.qualitySettings[props.quality].hint}</p>
        <div className="audio-state">
          <span className={`audio-icon audio-${props.audioStatus}`}>◉</span>
          <div>
            <strong>音声リズム補正</strong>
            <small>
              {props.audioStatus === "loading" && `解析中 ${Math.round(props.audioProgress * 100)}%`}
              {props.audioStatus === "ready" && `${props.audioOnsetCount}個のonsetを検出`}
              {props.audioStatus === "unavailable" && "音声なし、またはデコード非対応"}
              {props.audioStatus === "idle" && "動画を追加すると自動解析"}
            </small>
          </div>
        </div>

        {!props.isRunning ? (
          <button type="button" className="primary-action" onClick={props.onStart} disabled={!canStart}>解析開始</button>
        ) : (
          <button type="button" className="danger-action" onClick={props.onStop}>解析を停止</button>
        )}
        <div className="progress-track"><span style={{ width: `${props.progress * 100}%` }} /></div>
        <button type="button" className="export-action" onClick={props.onExport} disabled={!props.noteCount && !props.activeCount}>MIDIを書き出す</button>
      </section>

      <details className="advanced-card">
        <summary>詳細設定</summary>
        <div className="advanced-content">
          <label className="select-control">
            <span>検出方式</span>
            <select value={props.mode} onChange={(event: ChangeEvent<HTMLSelectElement>) => props.onMode(event.target.value as DetectionMode)} disabled={props.isRunning}>
              <option value="balanced">映像 + 発光 + 音声</option>
              <option value="visual">落下ノーツ色を優先</option>
              <option value="glow">鍵盤発光を優先</option>
            </select>
          </label>
          <RangeControl label="感度" value={props.threshold} min={5} max={60} onChange={props.onThreshold} disabled={props.isRunning} />
          <RangeControl label="色の許容幅" value={props.colorTolerance} min={0} max={40} onChange={props.onColorTolerance} disabled={props.isRunning} />
          <RangeControl label="黒鍵ガード" value={props.blackGuard} min={0} max={100} onChange={props.onBlackGuard} disabled={props.isRunning} />
          <RangeControl label="判定ライン" value={props.lineOffset} min={2} max={60} suffix="%" onChange={props.onLineOffset} disabled={props.isRunning} />
          <RangeControl label="ライン太さ" value={props.lineHeight} min={1} max={18} suffix="px" onChange={props.onLineHeight} disabled={props.isRunning} />
          <RangeControl label="確定フレーム" value={props.confirmFrames} min={1} max={5} onChange={props.onConfirmFrames} disabled={props.isRunning} />
          <RangeControl label="最短ノート" value={props.minimumNoteMs} min={10} max={180} suffix="ms" onChange={props.onMinimumNoteMs} disabled={props.isRunning} />
          <RangeControl label="先頭余白" value={props.leadMs} min={0} max={500} suffix="ms" onChange={props.onLeadMs} disabled={props.isRunning} />
          <RangeControl label="MIDIテンポ" value={props.bpm} min={40} max={240} suffix=" BPM" onChange={props.onBpm} disabled={props.isRunning} />
        </div>
      </details>
    </aside>
  );
}

type RangeControlProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (value: number) => void;
  disabled?: boolean;
};

function RangeControl({ label, value, min, max, suffix = "", onChange, disabled = false }: RangeControlProps) {
  return (
    <label className="range-control">
      <span>{label}<strong>{value}{suffix}</strong></span>
      <input type="range" min={min} max={max} value={clamp(value, min, max)} disabled={disabled} onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(Number(event.target.value))} />
    </label>
  );
}

type ColorControlProps = {
  label: string;
  color: string;
  active: boolean;
  onChange: (color: string) => void;
  onSample: () => void;
  disabled?: boolean;
};

function ColorControl({ label, color, active, onChange, onSample, disabled = false }: ColorControlProps) {
  return (
    <div className="color-control">
      <span>{label}</span>
      <div>
        <input type="color" value={color} disabled={disabled} onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)} />
        <code>{color.toUpperCase()}</code>
        <button type="button" className={active ? "active" : ""} onClick={onSample} disabled={disabled} title="動画から色を取得">⊕</button>
      </div>
    </div>
  );
}
