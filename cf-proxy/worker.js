// ポッドキャスト用の個人 CORS プロキシ（Cloudflare Workers）。
// GET /?url=<encodeURIComponent した対象URL> で対象を取得し、CORS ヘッダー付きで中継する。
// 環境変数 AUTH_TOKEN を設定した場合は &token=<値> が一致するリクエストのみ許可。

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') {
      return new Response('method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('url');

    if (env.AUTH_TOKEN && reqUrl.searchParams.get('token') !== env.AUTH_TOKEN) {
      return new Response('forbidden', { status: 403, headers: CORS_HEADERS });
    }
    if (!target || !/^https?:\/\//i.test(target)) {
      return new Response('missing or invalid ?url=', { status: 400, headers: CORS_HEADERS });
    }

    let upstream;
    try {
      upstream = await fetch(target, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (podcast-player personal proxy)',
          // Range を透過してシークや部分取得を可能にする
          ...(request.headers.get('Range') ? { Range: request.headers.get('Range') } : {}),
        },
      });
    } catch (e) {
      return new Response('upstream fetch failed: ' + e.message, { status: 502, headers: CORS_HEADERS });
    }

    const headers = new Headers();
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const v = upstream.headers.get(name);
      if (v) headers.set(name, v);
    }
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);

    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
