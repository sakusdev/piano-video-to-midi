# Piano Video to MIDI

Synthesia / Ember風のピアノ動画から、鍵盤発光と落下ノーツ判定ラインを使ってMIDIを生成するWebアプリです。

## 起動

```bash
npm install
npm run dev
```

ブラウザで表示されたURLを開いてください。

## 使い方

1. 動画ファイルを選ぶ
2. 動画を鍵盤が見える場所で一時停止
3. Canvas上で鍵盤全体をドラッグ指定
4. 黄色の判定ラインをノーツが通る位置に調整
5. start
6. export MIDI

## 調整

- 反応しない: thresholdを下げる / color strictを下げる
- 誤検知する: thresholdを上げる / color strictを上げる / confirm framesを2〜3
- 速い曲: confirm framesを1〜2
- 判定位置がズレる: line offsetを調整
