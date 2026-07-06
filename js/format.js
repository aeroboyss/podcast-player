// 表示用の共通ユーティリティ（app.js / player.js で共用）

export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// エスケープ済みテキスト中のタイムスタンプ（3:12 / 1:02:33 形式）をリンク化する
export function linkifyTimestamps(escapedText) {
  return escapedText.replace(
    /(?<![\d:])(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(?![\d:])/g,
    (match, a, b, c) => {
      const sec = c !== undefined
        ? Number(a) * 3600 + Number(b) * 60 + Number(c)
        : Number(a) * 60 + Number(b);
      return `<button class="ts-link" data-sec="${sec}">${match}</button>`;
    }
  );
}
