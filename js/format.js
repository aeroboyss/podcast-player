// 表示用の共通ユーティリティ（app.js / player.js で共用）

export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// エスケープ済みテキスト中の URL とタイムスタンプ（3:12 / 1:02:33 形式）をリンク化する。
// URL の中に "t=1:23" のような数字列が含まれていてもタイムスタンプ側と誤って
// 二重に置換されないよう、1回の正規表現パスで両方をまとめて処理する。
// 日本語のショーノートでは URL の直後にスペースなしで日本語が続くことが多いため、
// CJK文字（ひらがな・カタカナ・漢字・全角記号）が現れた時点で URL を打ち切る。
const URL_RE = /https?:\/\/[^\s<>"　-〿぀-ヿ㐀-鿿＀-￯]+/;
const TIMESTAMP_RE = /(?<![\d:])(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(?![\d:])/;
const LINKIFY_RE = new RegExp(`(${URL_RE.source})|${TIMESTAMP_RE.source}`, 'g');

export function linkifyText(escapedText) {
  return escapedText.replace(LINKIFY_RE, (match, url, h, m, s) => {
    if (url) {
      // 末尾の句読点はリンクに含めない（例: "…参照してください。"の句点）
      const trail = url.match(/[)\].,、。」』]+$/)?.[0] || '';
      const href = url.slice(0, url.length - trail.length);
      return `<a href="${href}" target="_blank" rel="noopener">${href}</a>${trail}`;
    }
    const sec = s !== undefined ? Number(h) * 3600 + Number(m) * 60 + Number(s) : Number(h) * 60 + Number(m);
    return `<button class="ts-link" data-sec="${sec}">${match}</button>`;
  });
}
