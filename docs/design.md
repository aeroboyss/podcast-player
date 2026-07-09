# ポッドキャスト再生アプリ 設計書

日付: 2026-07-05

## 目的

iPhone の Safari から使う自分用ポッドキャストプレイヤー。番組の検索・お気に入り登録・再生に加え、
Gemini API でエピソードの要約と理解度確認クイズ（4択×5問）を生成する。

## 要件

- iPhone のブラウザで使用（モバイルファースト、ホーム画面追加対応）
- 番組名で検索してお気に入り登録（iTunes Search API）
- 再生・停止、15秒スキップ（早送り）、30秒巻き戻し
- 番組・エピソード概要の表示
- 文字起こしデータ（RSS の Podcasting 2.0 `<podcast:transcript>`）を優先取得し、
  なければエピソード音声を Gemini に渡して、要約と4択クイズ5問を生成

## アーキテクチャ

**ビルド不要の静的 SPA（vanilla JS / ES modules）を GitHub Pages でホスティング。**
サーバーは持たない。外部 API はすべてブラウザから直接呼ぶ。

- 番組検索: iTunes Search API（キー不要・CORS 対応で直接呼べる）
- エピソード一覧: **iTunes Lookup API を主経路**とする（CORS 対応・安定、最新200件）。
  RSS はベストエフォートの補強として非同期に取得し、transcript タグ・番組説明・
  長いエピソード説明をマージする（`js/episodes.js`）
  - 実装時の検証で公開 CORS プロキシ（allorigins / corsproxy.io）は不安定
    （5xx や大きいフィードで 413）と判明したため、プロキシ依存を主経路から外した
- RSS 取得: ブラウザ直接 fetch → CORS で失敗したら公開 CORS プロキシ
  （allorigins → corsproxy.io の順にフォールバック）
- AI 生成: Gemini API（`gemini-2.5-flash`）
  - transcript あり → テキストを直接プロンプトに渡す
  - transcript なし → 音声を Gemini Files API に resumable upload し、file_uri で参照
  - 出力は responseSchema による構造化 JSON（summary + quiz[5]）
- 保存: すべて localStorage（お気に入り / API キー / 生成済み要約・クイズ / 再生位置）
- 端末間同期: GitHub の非公開 Gist を同期ストレージに使用（`js/sync.js`）。
  gist スコープのトークンを各端末に設定すると、起動時・変更時・フォアグラウンド復帰時・
  一時停止時に自動同期。競合はお気に入り・設定がセクション単位の LWW
  （同時刻なら中身のある方を優先＝旧データ救済）、要約/クイズ・再生位置はキー単位マージ

## モジュール構成

| ファイル | 責務 |
|---|---|
| `index.html` | シェル。ホーム画面・各パネル・プレイヤーバー（2026-07 に下部タブバーを廃止し、ホーム画面＋歯車/虫眼鏡アイコンのナビゲーションに変更） |
| `js/app.js` | ビューの描画・イベント配線・ルーティング |
| `js/storage.js` | localStorage ラッパー（お気に入り・キー・キャッシュ・再生位置） |
| `js/itunes.js` | 番組検索・エピソード一覧取得（iTunes Search / Lookup API） |
| `js/episodes.js` | エピソード一覧のロード戦略（Lookup 主経路＋RSS 補強のマージ） |
| `js/rss.js` | フィード取得・XML パース・transcript 処理 |
| `js/net.js` | CORS プロキシフォールバック付き fetch |
| `js/gemini.js` | 要約＋クイズ生成（transcript / 音声アップロードの両経路） |
| `js/player.js` | `<audio>` 制御、Media Session、再生位置の保存・復元 |

## 画面

1. **お気に入り** — 登録番組のグリッド。タップで番組詳細へ
2. **検索** — 番組名検索、結果から登録/解除
3. **番組詳細** — アートワーク・番組概要・エピソード一覧
4. **エピソードシート** — エピソード概要、再生ボタン、AI 要約・クイズ
5. **設定** — Gemini API キーの入力・保存
6. **プレイヤーバー**（画面下部固定） — 再生/停止、-30秒、+15秒、シークバー

## エラー処理

- CORS プロキシは順にリトライし、全滅したらユーザーにメッセージ表示
- Gemini 呼び出しは進捗表示（音声取得→アップロード→処理中→生成中）付き。
  失敗時はエラー内容を表示して再試行可能
- API キー未設定で AI 機能を使うと設定画面へ誘導

## 制約・割り切り（自分用のため）

- 公開 CORS プロキシは不安定（実測: allorigins は 5xx 頻発、corsproxy.io は
  サイズ制限で 403/413）。また Spotify/Anchor 系や robotstart など多くの音声ホストは
  CORS 非対応のため、音声からの AI 生成には `cf-proxy/` の自前 Cloudflare Worker の
  設置を推奨。設定画面で登録した自前プロキシ URL がすべての取得で最優先される
- API キーは localStorage 保存（リポジトリには含めない）
- GitHub Pages は無料プランのため public リポジトリ
- オフライン再生・ダウンロード機能はなし
