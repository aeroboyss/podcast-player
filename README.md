# Podcast Player

iPhone の Safari から使う自分用ポッドキャストプレイヤー。
ビルド不要の静的 Web アプリ（vanilla JS）で、GitHub Pages でホスティングする。

## 機能

- **番組検索・お気に入り登録** — iTunes Search API で番組名検索し、タップで登録。
  エピソード一覧も iTunes Lookup API から取得（最新200件）し、RSS から文字起こし情報等を補完
- **再生** — 再生/停止、15秒スキップ、30秒巻き戻し、シークバー、再生位置の自動保存・復元
- **概要表示** — 番組の説明とエピソードごとの概要を表示
- **AI 要約・クイズ** — Gemini API（gemini-2.5-flash）でエピソードの要約＋重要ポイント＋
  理解度確認の4択クイズ5問を生成
  - RSS に文字起こし（Podcasting 2.0 `<podcast:transcript>`）があればテキストから生成
  - なければエピソード音声を Gemini Files API にアップロードして音声から直接生成
- **iPhone 対応** — ホーム画面追加（PWA manifest）、ロック画面の再生操作（Media Session API）

## 使い方

1. デプロイした URL を iPhone の Safari で開く（ホーム画面に追加推奨）
2. 「設定」タブで Gemini API キーを保存（[Google AI Studio](https://aistudio.google.com/apikey) で取得）
3. 「検索」タブで番組名を検索して登録
4. 番組 → エピソードを開いて再生、「要約とクイズを生成」で AI 機能を使用

データ（お気に入り・API キー・生成結果・再生位置）はすべて端末の localStorage に保存される。
サーバーには何も送信されない（外部 API との通信のみ）。

## ローカルで動かす

```sh
npx serve .        # または python3 -m http.server 8000
```

## GitHub Pages へのデプロイ

初回のみ（`gh` CLI 認証済みであること）:

```sh
./deploy.sh
```

以降の更新は `git push` するだけで反映される。

## ファイル構成

```
index.html            シェル（タブ・パネル・プレイヤーバー）
css/style.css         スタイル（モバイルファースト・ダークテーマ）
js/app.js             画面描画・イベント配線
js/player.js          <audio> 制御・Media Session・再生位置保存
js/rss.js             RSS 取得・パース・transcript 処理
js/itunes.js          番組検索・エピソード一覧（iTunes Search / Lookup API）
js/episodes.js        エピソード読み込み戦略（Lookup 主経路＋RSS 補強）
js/gemini.js          要約・クイズ生成（transcript / 音声の両経路）
js/net.js             CORS プロキシ付き fetch
js/storage.js         localStorage ラッパー
manifest.webmanifest  PWA マニフェスト
icons/                アプリアイコン
docs/design.md        設計書
```

## 制約

- エピソード一覧は iTunes Lookup API（CORS 対応）から直接取得するため安定して動くが、
  RSS 由来の情報（文字起こしタグ・番組説明）と音声からの AI 生成は公開 CORS プロキシ
  （allorigins / corsproxy.io）に依存する。不安定な場合は `js/net.js` の `PROXIES` を
  自前のプロキシ（Cloudflare Workers 等）に差し替える
- Gemini API キーはブラウザの localStorage に保存される。共用端末では使わないこと
- 音声からの生成はファイルサイズ・長さに応じて時間と API コストがかかる
