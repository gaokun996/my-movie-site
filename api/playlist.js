'use strict';

/**
 * GET /api/playlist?url=<M3U8 地址>
 *
 * 只代理「播放清单文本」（通常几 KB），不代理视频分片。
 * 目的：HLS.js 用 XHR/fetch 取 M3U8，必须拿到 CORS 头；很多采集站
 * 给 M3U8 的响应没有 Access-Control-Allow-Origin，浏览器会直接拦掉，
 * 表现就是"一直缓冲、没有画面"。让清单走同源即可消除这一层。
 *
 * 同时把清单里的相对分片地址重写成绝对 URL，避免代理后基准地址变成本站
 * 导致分片 404。
 *
 * 边界（刻意不做）：
 *   - 不伪造任何第三方域名的 Referer，不破解 token / 防盗链；
 *   - 不代理 .ts / .mp4 等视频分片（Vercel 10s 上限 + 免费 100GB 带宽扛不住）；
 *   - 拒绝内网 / 环回地址，避免变成开放代理。
 */

const MAX_BYTES = 512 * 1024;      // 清单文本上限
const TIMEOUT_MS = 8000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function sendText(res, status, text, cacheable) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', cacheable
    ? 'public, s-maxage=30, stale-while-revalidate=60'
    : 'no-store');
  res.end(text);
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** SSRF 基本防护：拒绝私有 / 环回 / 保留地址 */
function isForbiddenHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127 || a === 169 && b === 254 ||
        a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 ||
        a >= 224) return true;
  }
  return false;
}

/**
 * 把清单中的相对 URI 重写成绝对 URL。
 * 只处理非注释行，保留 #EXT 指令、属性列表与加密 KEY URI 原样结构。
 */
function absolutize(text, baseUrl) {
  const base = new URL(baseUrl);
  return String(text).split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      // #EXT-X-KEY 里的 URI="..." 也可能是相对路径
      if (/^#EXT-X-(KEY|MAP|SESSION-KEY)/i.test(trimmed)) {
        return line.replace(/URI="([^"]+)"/gi, (full, uri) => {
          if (/^(https?:|data:|skd:)/i.test(uri)) return full;
          try { return `URI="${new URL(uri, base).toString()}"`; }
          catch (e) { return full; }
        });
      }
      return line;
    }
    if (/^(https?:|\/\/|data:)/i.test(trimmed)) return line;
    try { return new URL(trimmed, base).toString(); }
    catch (e) { return line; }
  }).join('\n');
}

async function handler(req, res) {
  let q;
  try {
    q = new URL(req.url || '/', 'http://localhost').searchParams;
  } catch (e) {
    return sendJson(res, 400, { ok: false, code: 'BAD_REQUEST' });
  }

  const raw = q.get('url');
  if (!raw) return sendJson(res, 400, { ok: false, code: 'NO_URL', message: '缺少 url 参数' });

  let target;
  try {
    target = new URL(raw);
  } catch (e) {
    return sendJson(res, 400, { ok: false, code: 'INVALID_URL', message: '播放地址不是合法 URL' });
  }
  if (!/^https?:$/i.test(target.protocol)) {
    return sendJson(res, 400, { ok: false, code: 'BAD_SCHEME', message: '只支持 http/https' });
  }
  if (isForbiddenHost(target.hostname)) {
    return sendJson(res, 400, { ok: false, code: 'FORBIDDEN_HOST', message: '不允许访问内网地址' });
  }
  // 只接受 M3U8 清单，挡住把它当通用文本代理的滥用
  if (!/\.m3u8(\?|$)/i.test(target.pathname + target.search)) {
    return sendJson(res, 400, { ok: false, code: 'NOT_PLAYLIST', message: '只代理 .m3u8 播放清单' });
  }

  // 可选严格白名单：PLAYLIST_HOST_ALLOWLIST=cdn.a.com,cdn.b.com
  // 不填时允许任意公网 https，方便试跑；生产建议按实际分片域名填。
  const allow = String(process.env.PLAYLIST_HOST_ALLOWLIST || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.some((d) => target.hostname.toLowerCase() === d ||
      target.hostname.toLowerCase().endsWith('.' + d))) {
    return sendJson(res, 403, { ok: false, code: 'HOST_NOT_ALLOWED',
      message: '该域名不在 PLAYLIST_HOST_ALLOWLIST 中', detail: { host: target.hostname } });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(target.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
        // 不设置 Referer：不伪造任何第三方站点身份。
        // 若对方接入文档明确要求「清单域名自身的 Referer」，可在下面按需开启，
        // 但绝不会伪造成示例站或其他未授权域名。
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    clearTimeout(timer);

    if (!upstream.ok) {
      return sendJson(res, 200, { ok: false, stage: 'upstream',
        code: `PLAYLIST_${upstream.status}`,
        message: `播放清单返回 HTTP ${upstream.status}`,
        detail: { httpStatus: upstream.status, host: target.hostname } });
    }

    const text = await upstream.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
      return sendJson(res, 200, { ok: false, stage: 'parse',
        code: 'PLAYLIST_TOO_LARGE', message: '清单超过 512KB，疑似不是 M3U8' });
    }
    // 明显不是 HLS 清单（返回了 HTML 拦截页）时给出可诊断的错误
    if (!/#EXTM3U/i.test(text)) {
      return sendJson(res, 200, { ok: false, stage: 'parse',
        code: 'PLAYLIST_INVALID_M3U8', message: '上游返回的不是 M3U8 清单（可能是拦截页）',
        detail: { excerpt: text.replace(/\s+/g, ' ').slice(0, 180), host: target.hostname } });
    }

    const finalUrl = upstream.url || target.toString();
    return sendText(res, 200, absolutize(text, finalUrl), true);

  } catch (e) {
    clearTimeout(timer);
    const aborted = e && e.name === 'AbortError';
    return sendJson(res, 200, { ok: false, stage: 'network',
      code: aborted ? 'PLAYLIST_TIMEOUT' : 'PLAYLIST_NETWORK',
      message: aborted ? '取播放清单超时（8 秒）' : '连接播放清单失败',
      detail: { host: target.hostname, reason: String((e && e.message) || e) } });
  }
};

// 默认导出必须是函数，Vercel 才会把它识别成 Serverless Function；
// 额外挂属性仅供本地测试调用纯函数，不影响运行时。
module.exports = handler;
module.exports.handler = handler;
module.exports.absolutize = absolutize;
module.exports.isForbiddenHost = isForbiddenHost;
