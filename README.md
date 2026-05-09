# Piano Video to MIDI

ピアノ演奏・Synthesia風動画から、ブラウザ上でMIDIファイルを生成するWebアプリです。

落下ノーツ、鍵盤発光、音声の立ち上がりを組み合わせて、動画内の発音タイミングと鍵盤位置を推定します。動画ファイルはブラウザ内で処理され、サーバーにはアップロードされません。

## Features

- 動画ファイルからMIDIを書き出し
- 鍵盤範囲の自動推定
- 白鍵・黒鍵の配置パターンを使った鍵盤補正
- 落下ノーツの色検出
- 鍵盤発光による補助検出
- 音声onsetによる連打・リズム補正
- Electron版では音声FFTのspectral fluxも併用し、連打・和音・映像上で溶けるノーツの分割精度を補強
- ロール/アルペジオのタイミング保持
- 黒鍵誤検出を抑える `black guard`
- 手動ドラッグとスライダーによる微調整

## Good Input Videos

精度が出やすい動画:

- Synthesia / Piano VFX / SeeMusic 系の落下ノーツ動画
- 鍵盤全体が画面内に見えている動画
- ノーツ色が背景や鍵盤と十分に違う動画
- 音声が含まれている動画

苦手な動画:

- 鍵盤が大きく斜め、または途中で動く動画
- 手やエフェクトで鍵盤が頻繁に隠れる動画
- ノーツ色と背景色が近い動画
- 低画質・強いブラー・フレーム落ちがある動画
- 実写のみで落下ノーツや明確な発光がない動画

## Usage

```bash
npm install
npm run dev
```

表示されたURLをブラウザで開きます。

1. 動画ファイルを選択
2. `鍵盤範囲を高精度自動セット` を押す
3. 必要ならCanvas上で鍵盤範囲をドラッグ指定
4. 黄色い判定ラインがノーツの到達位置に来るように `line offset` を調整
5. `start` で解析
6. `export MIDI` でMIDIを書き出し

## Controls

- `検出モード`
  - `Blob`: 落下ノーツ検出。基本はこれがおすすめ
  - `Hybrid`: 落下ノーツ + 鍵盤発光の終端補助
  - `Glow`: 鍵盤発光のみ。特殊な動画向け
- `threshold`: 検出感度。低いほど拾いやすく、高いほど誤検出しにくい
- `line offset`: 判定ラインの位置
- `line height`: 判定ラインの太さ
- `color strict`: ノーツ色の厳しさ
- `black guard`: 黒鍵の誤検出抑制
- `confirm frames`: 何フレーム連続で検出したら発音扱いにするか
- `min note`: 短すぎるノートを捨てる最小長
- `lead`: 書き出しMIDIの先頭余白
- `左右分割`: 左右でノーツ色が違う動画向けの分割位置

## Tuning Tips

反応しない:

- `threshold` を下げる
- `color strict` を下げる
- `confirm frames` を 1 にする
- `line height` を少し上げる

誤検出が多い:

- `threshold` を上げる
- `color strict` を上げる
- `confirm frames` を 2 から 3 にする
- `black guard` を上げる

黒鍵が抜ける:

- `black guard` を下げる
- `line offset` を少し調整する
- `threshold` を少し下げる

連打やグリッサンドが抜ける:

- 音声付き動画を使う
- Electron版を使うと音声FFTも併用され、見た目で連続ノーツがつながる動画でも発音タイミングを拾いやすくなります
- `confirm frames` を 1 にする
- `line height` を少し上げる
- `threshold` を少し下げる

## Build

```bash
npm run build
npm run preview
```

## Electron

ローカルでElectron版を確認する場合:

```bash
npm run electron:preview
```

Electron版では動画解析に加えて音声FFTを使ったspectral flux onsetを併用します。通常の音量変化だけでは拾いにくい連打、和音、黒鍵を含む発音の切れ目を補助的に検出します。

配布用パッケージを作る場合:

```bash
npm run build:electron
```

生成物は `release/` に出力されます。GitHub Actionsの `Build Electron app` workflow は、`master` へのpushまたは手動実行で Windows / macOS / Linux 版をビルドし、zipやインストーラなどの配布用ファイルだけをartifactとしてアップロードします。

`v0.1.0` のような `v*` タグをpushすると、同じworkflowがGitHub Releaseを作成し、各OSのElectronパッケージをrelease assetsとして添付します。

## Android APK

Android版はCapacitorで `dist/` をWebViewアプリとして包みます。

```bash
npm run sync:android
npm run build:android
```

ローカルでAPKを作るにはAndroid SDKが必要です。GitHub Actionsの `Build Android APK` workflow は、`master` へのpushまたは手動実行で debug APK をビルドしてartifactとしてアップロードします。`v*` タグをpushした場合は、同じAPKをGitHub Releaseにも添付します。

## Privacy

動画解析はブラウザ内で行われます。選択した動画ファイルは外部サーバーへアップロードされません。

## Notes

このアプリは動画と音声からMIDIを推定するツールです。元動画の画質、色、角度、音声、エフェクトによって結果は変わります。完璧な採譜ではなく、MIDI化の下書きを高速に作るためのツールとして使うのがおすすめです。
