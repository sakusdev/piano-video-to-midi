# Piano Video to MIDI

ピアノ演奏・Synthesia / SeeMusic / Piano VFX系の動画から、端末内だけでMIDIを生成するWebアプリです。

落下ノーツの色、鍵盤発光、音声のspectral-flux onsetを組み合わせ、単一の検出方法では抜けやすい連打・和音・黒鍵・ロールを補完します。選択した動画は外部サーバーへアップロードされません。

## 現在の目標

このプロジェクトは、単なる「動画の色をMIDIへ置換するツール」ではなく、動画と音声から編集可能なピアノMIDIの下書きを高精度に復元することを目標にしています。

- 映像から鍵盤位置、落下ノーツ、押鍵発光を推定
- 音声から発音タイミングを推定し、連打や分離しにくいノーツを補正
- 和音の同時性を整えつつ、アルペジオやロールの時間差は保持
- ブラウザ、Electron、Androidでローカル処理
- 誤検出を隠すのではなく、鍵盤範囲・色・判定ラインを視覚的に調整可能にする

## 主な改善点

- 1フレームにつき判定ラインと鍵盤領域をまとめて取得
- 色列検出と鍵盤発光のピクセル走査をRust/WebAssembly + 専用Web Workerへ分離
- `requestVideoFrameCallback`と非同期Worker応答を使った動画フレーム基準の解析
- 高精度モードでは動画を低速再生し、処理落ちによるフレーム欠落を抑制
- 複数フレームの中央値を使った鍵盤範囲の自動推定
- 左右のノーツ色を動画から直接スポイト可能
- 音声FFTとonset検出も別のRust/WebAssembly Workerへ分離
- ピクセル配列と音声バッファはTransferableとして渡し、巨大コピーを削減
- 停止・動画変更・解析完了時には処理中のWorkerを終了し、古い結果を破棄
- WASMが使えない環境でも、各Worker内のTypeScript実装へ自動フォールバック
- 局所中央値/MADによる適応型onset閾値
- 音声onsetがある同音連打は結合せず、映像上の短い途切れだけを統合
- 和音を整列しながら、方向性のあるロール/アルペジオは保持
- ステップ型UI、解析進捗、検出ノート一覧、モバイル対応

## 精度が出やすい動画

- Synthesia / SeeMusic / Piano VFX系の落下ノーツ動画
- 鍵盤全体が画面内に入り、途中でカメラが動かない動画
- 左右のノーツ色が背景と十分に異なる動画
- 音声が含まれている動画

実写のみで落下ノーツや明確な鍵盤発光がない動画は、現時点では音高推定機能が不足しているため対象外に近いです。

## 使い方

```bash
npm install
npm run dev
```

1. 動画を追加
2. 自動検出された鍵盤の青い枠を確認
3. 黄色い判定ラインがノーツの接触位置に来るよう調整
4. 左右のノーツ色をプリセットまたはスポイトで設定
5. 解析品質を選び「解析開始」
6. 結果を確認してMIDIを書き出し

### 解析品質

- **高速**: 短い確認向け
- **標準**: 通常利用向け
- **高精度**: 動画を低速再生し、フレーム欠落を抑える

## 調整の目安

ノートが抜ける場合は、感度を下げ、ライン太さを少し増やし、確定フレームを1にします。誤検出が多い場合は、感度・色の許容幅・黒鍵ガードを上げます。

色の許容幅は、値を上げるほど指定色に厳しくなります。黒鍵が白鍵として検出される場合は黒鍵ガードを下げるのではなく、まずノーツ色と鍵盤範囲を確認してください。

## Rust / WebAssembly engine

音声FFT・onset検出・色列検出・鍵盤発光計測は、Rustから生成したWebAssemblyを専用Web Worker内で実行します。Reactと動画プレビューのメインスレッドは、動画フレームの描画と必要範囲の取得、結果表示を担当します。

Rust/WASMを生成するにはRust toolchain、`wasm32-unknown-unknown` target、`wasm-pack`を用意します。

```bash
npm run build:wasm
npm run test:wasm
npm run build
```

Rust環境がないローカル端末でもWebアプリ自体のビルドは継続し、同じWorker内のTypeScript実装へフォールバックします。GitHub Actions、Electron配布、Android APKではRust環境をセットアップしてWASMを必ず生成します。WASMの読み込みや実行に失敗した場合も、重いFFTやピクセル走査がUIスレッドへ戻ることはありません。

## Cloudflare Workers

Web版はCloudflare Workers Static Assetsへデプロイできます。Cloudflareはアプリの配信と`/api/health`だけを担当し、動画・音声・MIDI・解析結果はアップロードも保存もしません。R2、D1、KVは使用しません。

```bash
npm run dev:cf
npm run deploy:cf
```

`wrangler.jsonc`のcustom buildが`npm run build:cf`を実行します。Cloudflareのビルド環境にRustがなければminimal toolchainを、`wasm-pack`がなければ公式installerを導入し、RustソースからWASMを生成してからTypeScript型検査とViteビルドを実行します。

Static Assetsでは`dist/`を配信し、SPA fallbackを有効化しています。`run_worker_first: true`により、Workerが`/api/health`を処理し、HTML・JavaScript・Worker・WASMへセキュリティヘッダーとキャッシュ方針を付与します。

CloudflareのGit連携を使う場合はリポジトリを接続し、デプロイコマンドを`npx wrangler@4 deploy`に設定します。ビルドはWrangler設定のcustom buildから実行されるため、Cloudflare側の別のビルドコマンドは不要です。

## Build

```bash
npm run build
npm run preview
```

Pull Requestと`agent/**`ブランチではGitHub ActionsがRustテスト、WASM生成、TypeScriptの型検査、Viteビルド、Wrangler dry-runを実行します。

## Electron

```bash
npm run electron:preview
npm run build:electron
```

配布物は`release/`へ生成されます。GitHub Actionsの各OS向け配布ビルドにはRust/WASMが含まれます。

## Android APK

```bash
npm run sync:android
npm run build:android
```

ローカルビルドにはAndroid SDKが必要です。GitHub Actionsから生成するdebug APKにはRust/WASMが含まれます。

## Privacy

動画と音声は端末内で処理されます。ファイル本体は外部サーバーへ送信されません。

## Limitations

結果は元動画の解像度、フレームレート、圧縮、色、エフェクト、鍵盤角度に左右されます。現時点では完全自動採譜ではなく、編集可能なMIDI下書きを高速に作るためのツールです。
