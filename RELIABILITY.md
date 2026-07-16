# Reliability model

このアプリは、動画・音声を外部サーバーへ送らず、ブラウザ内のWeb WorkerとRust/WebAssemblyで解析します。信頼性は「処理が成功すること」だけでなく、停止・破損・互換性不一致を検出し、安全に失敗できることを含みます。

## 守るべき不変条件

- UIスレッドではFFTや全鍵盤のピクセル走査を実行しない
- Workerの無応答を永久に待たない
- Workerから返る配列は、形・有限値・範囲・順序・MIDI鍵集合を検証する
- Rust/WASM ABIのバージョンがTypeScript側の期待値と一致しない場合は利用しない
- WASMが利用できない場合も、同じWorker内のTypeScript実装へフォールバックする
- 停止・動画変更・画面破棄時はWorkerを終了し、古い応答を採用しない
- 生成されたWASM、JavaScript loader、HTML参照、Worker bundleをCIで検査する
- Cloudflareは静的配信とヘルスチェックのみを担当し、ユーザーファイルを保存しない

## 障害時の動作

### 音声Worker

動画時間に応じた上限時間を設定します。Workerクラッシュ、転送失敗、不正応答、タイムアウトは分類されたエラーとして呼び出し側へ返します。エラーを空のonset配列として隠しません。

### 映像Worker

1フレームの処理が8秒を超えた場合はWorkerを終了します。Workerクラッシュ、不正応答、転送失敗、タイムアウトではWorkerを作り直し、同じフレームを1回だけ再取得して再試行します。2回失敗した場合は解析を停止し、途中までのノートを保持します。

### WASMフォールバック

WASMのロード、初期化、ABIバージョン、実行結果のいずれかが不正な場合、Worker内TypeScript実装へ切り替えます。フォールバック後もメインスレッドへ重い処理を戻しません。

## CIゲート

Pull Requestと`agent/**`ブランチでは以下を実行します。

1. 固定Rust toolchainのセットアップ
2. `cargo fmt --check`
3. `cargo clippy -- -D warnings`
4. Rust unit / integration tests
5. `wasm-pack`生成
6. TypeScript strict型検査
7. Vite production build
8. 生成物の完全性検査
9. Wrangler deployment dry-run

生成物検査では、WASM magic header、コンパイル可能性、必須export、loader API、HTML参照先、JavaScript/CSS/Worker bundle、source map非同梱を確認します。

## リリース前チェック

- GitHub Actionsがすべて成功している
- Cloudflare previewで`/api/health`が`ok: true`を返す
- 代表動画でWASMエンジンとTypeScriptフォールバックの両方を確認する
- 解析停止、動画差し替え、タブ非表示復帰、長時間動画でUIが操作可能である
- 出力MIDIを別ソフトで開き、ノート時刻が単調かつ範囲内である

## 今後の課題

- 正解MIDI付きfixtureによるprecision / recallと時刻誤差の継続測定
- 実ブラウザE2EでWorkerクラッシュ、WASM 404、遅延応答を注入するテスト
- Cloudflare preview deploymentに対する自動ヘルスチェック
- メモリ使用量とフレーム処理時間の長時間ベンチマーク
