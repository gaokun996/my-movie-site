'use strict';

/**
 * GET /api/vod?source=xxx&ac=videolist&wd=关键词&pg=1&t=分类ID
 *
 * 浏览器只请求同源的 /api/vod，由本函数在服务端取上游数据 —— 同源策略不再生效，
 * 因此彻底不需要 AllOrigins 之类的公共代理。
 *
 * 关键设计：失败时返回带 stage / code 的结构化错误，而不是笼统地"切换接口重试"。
 */

const { loadSources, getSource, DEMO_BASE } = require('../lib/sources');
const { normalizeResponse } = require('../lib/vod-format');
const { buildDemoPayload } = require('../lib/demo-data');

const ALLOWED_AC = new Set(['videolist', 'detail', 'class', 'list']);
const PASS_THROUGH = ['wd', 'pg', 't', 'ids', 'at', 'h', 'limit'];
const UPSTREAM_TIMEOUT_MS = 8000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function send(res, status, body, cacheable) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', cacheable
    ? 'public, s-maxage=60, stale-while-revalidate=300'
    : 'no-store');
  res.end(JSON.stringify(body));
}

function error(res, stage, code, message, detail) {
  return send(res, 200, { ok: false, stage, code, message, detail: detail || {} }, false);
}

module.exports = async function handler(req, res) {
  let q;
  try {
    q = new URL(req.url || '/', 'http://localhost').searchParams;
  } catch (e) {
    return error(res, 'config', 'BAD_REQUEST', '请求地址解析失败');
  }

  const sources = loadSources();
  if (!sources.length) {
    return error(res, 'config', 'NO_SOURCE',
      '数据源列表为空。正常情况下会自动回退到内置演示数据；若出现此提示，请检查 lib/sources.js 是否完整上传。',
      { hint: '参见随项目附带的 sources.example.json 与 README.md' });
  }

  const requested = getSource(q.get('source'));
  if (q.get('source') && !requested) {
    return error(res, 'config', 'UNKNOWN_SOURCE', `不存在的数据源：${q.get('source')}`,
      { available: sources.map((s) => s.id) });
  }
  const src = requested || sources[0];

  // 原项目用 ac=detail&wd= 做搜索，多数采集站要求 ac=videolist，这里兼容纠正；
  // ac=detail&ids= 仍保留为按 id 查单条。
  let ac = ALLOWED_AC.has(q.get('ac')) ? q.get('ac') : 'videolist';
  if (ac === 'detail' && q.get('wd') && !q.get('ids')) ac = 'videolist';

  // 零配置演示模式：完全不出网，直接返回内置数据，复用同一套标准化逻辑。
  // 配置自有授权接口后本分支不会命中。
  if (src.base === DEMO_BASE) {
    const payload = buildDemoPayload({
      ac,
      wd: q.get('wd'),
      pg: q.get('pg'),
      t: q.get('t'),
      ids: q.get('ids'),
    });
    return send(res, 200, {
      ok: true,
      stage: 'ok',
      demo: true,
      source: { id: src.id, name: src.name },
      ac,
      ...normalizeResponse(payload),
    }, true);
  }

  let target;
  try {
    target = new URL(src.base);
  } catch (e) {
    return error(res, 'config', 'INVALID_BASE', `数据源 ${src.name} 的地址不是合法 URL`,
      { source: src.id });
  }
  target.searchParams.set('ac', ac);
  PASS_THROUGH.forEach((k) => {
    const v = q.get(k);
    if (v !== null && v !== '') target.searchParams.set(k, v);
  });
  if (ac === 'videolist' && !target.searchParams.has('pg')) {
    target.searchParams.set('pg', '1');
  }

  const headers = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  // 部分采集站校验 Referer 必须来自自身域名；可在 sources 配置里覆盖
  headers.Referer = src.referer || new URL(src.base).origin + '/';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(target.toString(), {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!upstream.ok) {
      return error(res, 'upstream', `UPSTREAM_${upstream.status}`,
        `上游接口返回 HTTP ${upstream.status}`,
        { source: src.name, ac, httpStatus: upstream.status, keyword: q.get('wd') || '' });
    }

    const text = await upstream.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (e) {
      return error(res, 'parse', 'INVALID_JSON',
        '上游返回的不是 JSON（通常是拦截页 / HTML 错误页 / 空响应）',
        { source: src.name, ac, excerpt: text.replace(/\s+/g, ' ').slice(0, 200) });
    }

    const norm = normalizeResponse(payload);
    return send(res, 200, {
      ok: true,
      stage: 'ok',
      source: { id: src.id, name: src.name },
      ac,
      ...norm,
    }, true);

  } catch (e) {
    clearTimeout(timer);
    const aborted = e && e.name === 'AbortError';
    return error(res, 'network',
      aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_NETWORK',
      aborted ? `上游接口 ${UPSTREAM_TIMEOUT_MS / 1000} 秒内未响应` : '连接上游接口失败',
      { source: src.name, ac, reason: String((e && e.message) || e) });
  }
};
