'use strict';

/**
 * GET /api/fragment?url=<分片 / 密钥地址>
 *
 * 让 HLS.js 取 .ts / .m4s / #EXT-X-KEY 时不再跨域：请求变成同源，
 * CORS 问题从根上消失。由 /api/playlist?proxyFrag=1 重写清单时自动引用。
 *
 * 平台限制（必须如实说明）：
 *   - Vercel Hobby 单次函数响应有体积上限，这里设 4MB 软上限，超了给明确错误码；
 *   - 免费额度约 100GB/月带宽，全代理分片会实打实消耗流量（1 小时 2Mbps ≈ 900MB）；
 *   - 函数执行 10 秒上限。
 * 因此这是「让 CORS 类故障能播起来」的诊断/过渡方案，不是长期流媒体分发方案。
 *
 * 边界：不伪造 Referer、不破 token、拒绝内网地址、可配域名白名单、不缓存到 CDN。
 */

const { isForbiddenHost } = require('./playlist');

const MAX_BYTES = 4 * 1024 * 1024;   // 4MB，避开 Hobby 函数响应上限
const TIMEOUT_MS = 8000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function contentTypeOf(pathname) {
  if (/\.m4s|\.mp4|\.cmfv/i.test(pathname)) return 'video/mp4';
  if (/\.ts|\.mts/i.test(pathname)) return 'video/mp2t';
  if (/\.aac/i.test(pathname)) return 'audio/aac';
  if (/\.mp3/i.test(pathname)) return 'audio/mpeg';
  if (/\.vtt|\.srt/i.test(pathname)) return 'text/vtt; charset=utf-8';
  return 'application/octet-stream';
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
  try { target = new URL(raw); }
  catch (e) { return sendJson(res, 400, { ok: false, code: 'INVALID_URL' }); }
  if (!/^https?:$/i.test(target.protocol)) {
    return sendJson(res, 400, { ok: false, code: 'BAD_SCHEME' });
  }
  if (isForbiddenHost(target.hostname)) {
    return sendJson(res, 400, { ok: false, code: 'FORBIDDEN_HOST', message: '不允许访问内网地址' });
  }
  // 不接 M3U8：那是 /api/playlist 的职责，避免两个函数互相套
  if (/\.m3u8(\?|$)/i.test(target.pathname + target.search)) {
    return sendJson(res, 400, { ok: false, code: 'USE_PLAYLIST', message: '清单请走 /api/playlist' });
  }

  const allow = String(process.env.PLAYLIST_HOST_ALLOWLIST || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const host = target.hostname.toLowerCase();
  if (allow.length && !allow.some((d) => host === d || host.endsWith('.' + d))) {
    return sendJson(res, 403, { ok: false, code: 'HOST_NOT_ALLOWED',
      message: '该域名不在 PLAYLIST_HOST_ALLOWLIST 中', detail: { host } });
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
        'Accept': '*/*',
        // 不设置 Referer：不伪造任何第三方站点身份，不破解防盗链。
      },
    });
    clearTimeout(timer);

    if (!upstream.ok) {
      return sendJson(res, 200, { ok: false, stage: 'upstream',
        code: `FRAGMENT_${upstream.status}`,
        message: `分片返回 HTTP ${upstream.status}`,
        detail: { httpStatus: upstream.status, host } });
    }

    const declared = Number(upstream.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) {
      return sendJson(res, 200, { ok: false, stage: 'limit',
        code: 'FRAGMENT_TOO_LARGE',
        message: `分片约 ${(declared / 1048576).toFixed(1)}MB，超过本方案 4MB 上限（Vercel Hobby 函数响应限制）`,
        detail: { host, bytes: declared, hint: '换更低清晰度线路、或改用原生直连模式' } });
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      return sendJson(res, 200, { ok: false, stage: 'limit',
        code: 'FRAGMENT_TOO_LARGE',
        message: `分片 ${(buf.length / 1048576).toFixed(1)}MB，超过 4MB 上限`,
        detail: { host, bytes: buf.length, hint: '换更低清晰度线路、或改用原生直连模式' } });
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', contentTypeOf(target.pathname));
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Access-Control-Allow-Origin', '*');
    // 分片带时效 token，绝不能进共享缓存
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.end(buf);

  } catch (e) {
    clearTimeout(timer);
    const aborted = e && e.name === 'AbortError';
    return sendJson(res, 200, { ok: false, stage: 'network',
      code: aborted ? 'FRAGMENT_TIMEOUT' : 'FRAGMENT_NETWORK',
      message: aborted ? '取分片超时（8 秒）' : '连接分片失败',
      detail: { host, reason: String((e && e.message) || e) } });
  }
}

module.exports = handler;
module.exports.handler = handler;
module.exports.contentTypeOf = contentTypeOf;
