'use strict';

/**
 * 纯本地端到端验证，不需要外网、不需要 Vercel CLI。
 * 运行： node scripts/smoke-test.js
 *
 * 会起一个 mock 上游，直接调用真实的 api/vod.js handler，
 * 覆盖：参数纠正、多线路解析、带鉴权参数的 M3U8、403 / 非 JSON / 未配置 等分支。
 */

const http = require('http');
const assert = require('assert');
const { parsePlayUrl, normalizeItem, normalizeResponse } = require('../lib/vod-format');
const vodHandler = require('../api/vod');
const sourcesHandler = require('../api/sources');

const SAMPLE = {
  code: 1, msg: '数据列表', page: 1, pagecount: 3, total: 42,
  class: [{ type_id: '1', type_name: '电影' }, { type_id: '2', type_name: '电视剧' }],
  list: [{
    vod_id: 1001, vod_name: '测试影片', vod_pic: 'https://img.example/a.jpg',
    vod_class: '动作', vod_year: '2024', vod_area: '中国大陆',
    vod_remarks: 'HD', vod_content: '<p>简介&nbsp;内容</p>',
    vod_play_from: '线路A$$$线路B',
    vod_play_url: '第01集$https://cdn.example/1.m3u8?token=abc&exp=9#第02集$https://cdn.example/2.m3u8$$$正片$https://cdn.example/movie.mp4'
  }]
};

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failures.push(name + ' → ' + e.message); console.log('  FAIL  ' + name + ' → ' + e.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failures.push(name + ' → ' + e.message); console.log('  FAIL  ' + name + ' → ' + e.message); }
}

function mockRes() {
  return {
    statusCode: 0, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v; },
    end(s) { this.body = String(s); }
  };
}
async function call(handler, url) {
  const res = mockRes();
  await handler({ url, method: 'GET' }, res);
  return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers };
}

let lastUpstreamUrl = '';
const server = http.createServer((req, res) => {
  lastUpstreamUrl = req.url;
  const send = (code, type, text) => {
    res.writeHead(code, { 'Content-Type': type });
    res.end(text);
  };
  if (req.url.indexOf('/deny/') === 0) return send(403, 'application/json', '{"title":"Request denied"}');
  if (req.url.indexOf('/html/') === 0) return send(200, 'text/html', '<html><h1>Access Denied</h1></html>');
  return send(200, 'application/json; charset=utf-8', JSON.stringify(SAMPLE));
});

function setBase(path) {
  process.env.VOD_API_BASE = `http://127.0.0.1:${server.address().port}${path}`;
  delete process.env.VOD_SOURCES_JSON;
}

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const basePort = server.address().port;
  console.log(`\n本地 mock 上游： http://127.0.0.1:${basePort}\n`);

  console.log('[1] 播放地址解析');
  check('多线路 / 多集 / 带 query 的 M3U8 / MP4 全部保留', () => {
    const s = parsePlayUrl(SAMPLE.list[0].vod_play_url, SAMPLE.list[0].vod_play_from);
    assert.strictEqual(s.length, 2, '应有 2 条线路');
    assert.strictEqual(s[0].from, '线路A');
    assert.strictEqual(s[0].episodes.length, 2, '线路A 应有 2 集');
    assert.ok(s[0].episodes[0].url.includes('token=abc&exp=9'), 'M3U8 的鉴权参数不能丢');
    assert.strictEqual(s[1].from, '线路B');
    assert.ok(s[1].episodes[0].url.endsWith('.mp4'), 'MP4 直链不能丢');
  });
  check('裸地址也能解析', () => {
    const s = parsePlayUrl('https://cdn.example/a.m3u8', '');
    assert.strictEqual(s.length, 1);
    assert.strictEqual(s[0].episodes[0].url, 'https://cdn.example/a.m3u8');
  });
  check('空地址返回空数组', () => assert.deepStrictEqual(parsePlayUrl('', ''), []));

  console.log('\n[2] 返回数据标准化');
  check('分页 / 分类 / 字段映射', () => {
    const n = normalizeResponse(SAMPLE);
    assert.strictEqual(n.pagecount, 3);
    assert.strictEqual(n.total, 42);
    assert.strictEqual(n.classes.length, 2);
    assert.strictEqual(n.list[0].vod_name, '测试影片');
    assert.ok(!n.list[0].vod_content.includes('<p>'), 'HTML 标签应被清除');
    assert.strictEqual(n.list[0].play_sources.length, 2);
  });
  check('兼容纯数组返回', () => {
    const n = normalizeResponse([{ vod_name: 'X' }]);
    assert.strictEqual(n.list.length, 1);
  });
  check('详情弹框字段：导演 / 主演 / 标签来源', () => {
    const n = normalizeItem({
      vod_name: 'X', vod_director: '张三', vod_actor: '李四',
      vod_remarks: 'HD国语', vod_class: '动作片', vod_year: '2026', vod_area: '大陆',
    });
    assert.strictEqual(n.vod_director, '张三');
    assert.strictEqual(n.vod_actor, '李四');
    assert.deepStrictEqual(
      [n.vod_remarks, n.vod_class, n.vod_year, n.vod_area],
      ['HD国语', '动作片', '2026', '大陆'], '应能拼出参考截图里的 4 个标签');
  });

  console.log('\n[3] 零配置演示模式');
  const clearEnv = () => { delete process.env.VOD_API_BASE; delete process.env.VOD_SOURCES_JSON; };
  await checkAsync('未配置任何环境变量 → 自动回退演示数据（不再是 NO_SOURCE）', async () => {
    clearEnv();
    const r = await call(vodHandler, '/api/vod?ac=videolist');
    assert.strictEqual(r.body.ok, true, '零配置也必须能跑通');
    assert.strictEqual(r.body.demo, true);
    assert.strictEqual(r.body.list.length, 3, '每页 3 条');
    assert.ok(r.body.pagecount >= 2, '至少 2 页');
    assert.ok(r.body.list[0].play_sources.length >= 1, '要有可播放线路');
    assert.ok(r.body.list[0].play_sources[0].episodes[0].url.startsWith('https://'));
    assert.ok(r.body.list[0].vod_director, '演示条目也要有导演，详情弹框才能显示演职员行');
  });
  await checkAsync('演示模式：分类 / 搜索 / 分页 / 多线路 / HLS 多集', async () => {
    clearEnv();
    const cls = await call(vodHandler, '/api/vod?ac=class');
    assert.strictEqual(cls.body.classes.length, 3);

    const p2 = await call(vodHandler, '/api/vod?ac=videolist&pg=2');
    assert.strictEqual(p2.body.page, 2);
    assert.notStrictEqual(p2.body.list[0].vod_id, 'demo-1', '第 2 页不能和第 1 页重复');

    const kw = await call(vodHandler, '/api/vod?ac=videolist&wd=' + encodeURIComponent('多码率'));
    assert.ok(kw.body.list.length >= 1, '关键词应命中');
    const hlsItem = kw.body.list[0];
    assert.strictEqual(hlsItem.play_sources.length, 2, '应有 2 条线路');
    assert.ok(hlsItem.play_sources[1].episodes[1].url.includes('bipbop_16x9'), 'HLS 多集应被解析');

    const filtered = await call(vodHandler, '/api/vod?ac=videolist&t=3');
    assert.ok(filtered.body.list.every((i) => i.vod_id.startsWith('demo-')), '分类筛选应生效');
  });
  await checkAsync('配置写错时回退演示数据，并在名称里给出警告', async () => {
    clearEnv();
    process.env.VOD_SOURCES_JSON = '{ this is not json';
    const r = await call(sourcesHandler, '/api/sources');
    assert.strictEqual(r.body.length, 1);
    assert.ok(r.body[0].name.includes('不是合法 JSON'), '用户要能看见配置写错了');
    clearEnv();
  });
  await checkAsync('/api/sources 不暴露上游地址', async () => {
    setBase('/ok/api.php/provide/vod/');
    const r = await call(sourcesHandler, '/api/sources');
    assert.strictEqual(r.body.length, 1);
    assert.strictEqual(r.body[0].name, '默认接口');
    assert.strictEqual(r.body[0].base, undefined, 'base 不能下发给前端');
  });

  console.log('\n[4] 正常链路（真实调用 api/vod.js）');
  await checkAsync('ac=detail&wd= 被纠正为 ac=videolist，且数据完整返回', async () => {
    setBase('/ok/api.php/provide/vod/');
    const r = await call(vodHandler, '/api/vod?ac=detail&wd=%E6%B5%8B%E8%AF%95&pg=2');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.list.length, 1);
    assert.ok(lastUpstreamUrl.includes('ac=videolist'), '上游应收到 ac=videolist');
    assert.ok(lastUpstreamUrl.includes('wd='), '关键词应透传');
    assert.ok(lastUpstreamUrl.includes('pg=2'), '分页应透传');
    assert.ok(r.body.list[0].play_sources[0].episodes[0].url.includes('token=abc'));
    assert.ok(r.headers['Cache-Control'].includes('s-maxage'), '成功结果应可边缘缓存');
  });
  await checkAsync('未知数据源 → UNKNOWN_SOURCE', async () => {
    setBase('/ok/api.php/provide/vod/');
    const r = await call(vodHandler, '/api/vod?source=nope');
    assert.strictEqual(r.body.code, 'UNKNOWN_SOURCE');
  });

  console.log('\n[5] 故障分层');
  await checkAsync('上游 403 → UPSTREAM_403，且不缓存', async () => {
    setBase('/deny/api.php/provide/vod/');
    const r = await call(vodHandler, '/api/vod?ac=videolist&wd=test');
    assert.strictEqual(r.body.ok, false);
    assert.strictEqual(r.body.stage, 'upstream');
    assert.strictEqual(r.body.code, 'UPSTREAM_403');
    assert.strictEqual(r.body.detail.httpStatus, 403);
    assert.ok(r.headers['Cache-Control'].includes('no-store'));
  });
  await checkAsync('上游返回 HTML → INVALID_JSON 并带响应片段', async () => {
    setBase('/html/api.php/provide/vod/');
    const r = await call(vodHandler, '/api/vod?ac=videolist');
    assert.strictEqual(r.body.stage, 'parse');
    assert.strictEqual(r.body.code, 'INVALID_JSON');
    assert.ok(r.body.detail.excerpt.includes('Access Denied'));
  });

  server.close();
  console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
  if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  console.log('全部通过：新架构在本地端到端可跑通，且失败原因可被准确定位。\n');
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
