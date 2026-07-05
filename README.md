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
js/sync.js            端末間同期（GitHub Gist・LWWマージ）
js/storage.js         localStorage ラッパー・同期用の状態エクスポート/適用
manifest.webmanifest  PWA マニフェスト
icons/                アプリアイコン
docs/design.md        設計書
```

## 複数端末での同期（Mac / iPhone）

お気に入り・設定（Gemini キー、プロキシ URL）・生成済み要約/クイズ・再生位置を、
自分の GitHub アカウントの**非公開 Gist** 経由で端末間同期できる。

1. [gist スコープのトークンを作成](https://github.com/settings/tokens/new?scopes=gist&description=podcast-player-sync)
   （スコープは gist のみでよい）
2. 各端末の「設定」タブ →「端末間の同期（GitHub）」に同じトークンを貼って「保存して同期」

同期は起動時・変更時（数秒後にまとめて）・アプリのフォアグラウンド復帰時・
再生の一時停止時に自動実行される。「今すぐ同期」で手動実行も可能。
競合時はセクション単位で新しい方が優先され、要約/クイズと再生位置はキー単位でマージされる。

注意: Gemini API キーも Gist（非公開）に含まれる。Gist の URL を知る人は閲覧できるため、
気になる場合はキーの同期をやめて各端末で個別に設定し直すこと。

## 自前 CORS プロキシの設置（音声取得が 403 で失敗する場合）

Spotify/Anchor 系など多くの音声ホストはブラウザからの直接取得（CORS）を許可しておらず、
公開プロキシも大きい音声ファイルを拒否するため、「音声の取得に失敗しました (HTTP 403)」に
なることがある。その場合は Cloudflare Workers（無料枠で十分）に `cf-proxy/` の
プロキシを設置する。

```sh
cd cf-proxy
npx wrangler login    # 初回のみ。ブラウザで Cloudflare にログイン（アカウントは無料で作成可）
npx wrangler deploy
```

表示された URL（例 `https://podcast-proxy.xxx.workers.dev`）を使い、アプリの
「設定」タブの「自前 CORS プロキシ URL」に次の形式で登録する：

```
https://podcast-proxy.xxx.workers.dev/?url=
```

第三者による無断利用を防ぎたい場合はトークン認証を有効にする：

```sh
npx wrangler secret put AUTH_TOKEN   # 任意の文字列を設定
```

その場合の登録 URL は `https://podcast-proxy.xxx.workers.dev/?token=<設定した値>&url=`。

登録すると RSS・文字起こし・音声のすべての取得がこのプロキシを最優先で使うようになる。

## 制約

- エピソード一覧は iTunes Lookup API（CORS 対応）から直接取得するため安定して動くが、
  RSS 由来の情報（文字起こしタグ・番組説明）と音声からの AI 生成は公開 CORS プロキシ
  （allorigins / corsproxy.io）に依存する。不安定な場合は `js/net.js` の `PROXIES` を
  自前のプロキシ（Cloudflare Workers 等）に差し替える
- Gemini API キーはブラウザの localStorage に保存される。共用端末では使わないこと
- 音声からの生成はファイルサイズ・長さに応じて時間と API コストがかかる
