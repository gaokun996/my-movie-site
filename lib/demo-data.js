'use strict';

/**
 * 内置演示数据源（不发起任何服务端出网请求）。
 *
 * 用途：没有任何自有授权接口时，也能完整验证
 *   搜索 / 分类 / 分页 / 详情 / 多线路 / 选集 / HLS.js 播放 / 播放记录
 * 这一整条链路，避免"部署完了却只有一个报错框"。
 *
 * 播放地址均为公开、明确可自由使用的测试素材：
 *   - MDN interactive-examples 的 CC0 公共领域视频（flower.mp4 / flower.webm）
 *   - Google gtv-videos-bucket 的公开示例视频（Big Buck Bunny）
 *   - Mux 与 Apple 面向开发者公开的 HLS 测试流
 * 它们只是播放器验证素材，不是影视内容库；请自行确认目标网络可达性。
 *
 * 一旦配置了 VOD_API_BASE 或 VOD_SOURCES_JSON，本模块自动让位。
 */

const DEMO_BASE = 'demo://local';
const PAGE_SIZE = 3;

const DEMO_CLASSES = [
  { type_id: '1', type_name: '演示·直连播放' },
  { type_id: '2', type_name: '演示·HLS 播放' },
  { type_id: '3', type_name: '演示·分页验证' },
];

const MDN_CC0_MP4 = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
const MDN_CC0_WEBM = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm';
const GOOGLE_SAMPLE_MP4 = 'https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
const MUX_HLS = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const APPLE_HLS_4X3 = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3_variant.m3u8';
const APPLE_HLS_16X9 = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8';

const DEMO_ITEMS = [
  {
    vod_id: 'demo-1', vod_name: '演示 · 花（CC0 公共领域）',
    type_id: '1', vod_class: '演示·直连播放', vod_year: '2024', vod_area: 'MDN',
    vod_remarks: 'MP4 直连', vod_pic: '',
    vod_content: 'MDN 用于 <video> 标签教学的 CC0 公共领域示例视频。第一条线路走浏览器原生直连，不受 CORS 约束，用来确认播放器与页面链路完全打通。',
    vod_play_from: 'MP4 直连$$$备用格式',
    vod_play_url: `正片$${MDN_CC0_MP4}#正片（WebM）$${MDN_CC0_WEBM}$$$正片$${MDN_CC0_MP4}`,
  },
  {
    vod_id: 'demo-2', vod_name: '演示 · Big Buck Bunny（公开示例）',
    type_id: '1', vod_class: '演示·直连播放', vod_year: '2008', vod_area: 'Blender',
    vod_remarks: '多线路', vod_pic: '',
    vod_content: '公开的示例视频，用于验证「一条资源里有多条播放线路」时前端线路切换是否正常。',
    vod_play_from: '直连线路$$$HLS 线路',
    vod_play_url: `正片$${GOOGLE_SAMPLE_MP4}$$$正片$${MUX_HLS}`,
  },
  {
    vod_id: 'demo-3', vod_name: '演示 · HLS 多码率测试流',
    type_id: '2', vod_class: '演示·HLS 播放', vod_year: '2024', vod_area: 'Mux / Apple',
    vod_remarks: 'M3U8 多集', vod_pic: '',
    vod_content: 'Mux 与 Apple 面向开发者公开的 HLS 测试流，用来验证 HLS.js 加载 M3U8、多集切换、以及 MANIFEST_PARSED 后的自动播放。若某条流在你的网络里不可达，换另一集即可，不影响架构验证。',
    vod_play_from: 'Mux 测试流$$$Apple BipBop',
    vod_play_url: `正片$${MUX_HLS}$$$第01集$${APPLE_HLS_4X3}#第02集$${APPLE_HLS_16X9}`,
  },
  {
    vod_id: 'demo-4', vod_name: '演示 · 分页条目 A',
    type_id: '3', vod_class: '演示·分页验证', vod_year: '2024', vod_area: '本地生成',
    vod_remarks: '第 2 页', vod_pic: '',
    vod_content: '用于确认「下一页」确实换了数据，而不是重复渲染同一页。',
    vod_play_from: 'MP4 直连',
    vod_play_url: `正片$${MDN_CC0_MP4}`,
  },
  {
    vod_id: 'demo-5', vod_name: '演示 · 分页条目 B',
    type_id: '3', vod_class: '演示·分页验证', vod_year: '2024', vod_area: '本地生成',
    vod_remarks: '第 2 页', vod_pic: '',
    vod_content: '用于确认分类筛选与搜索过滤作用在服务端返回的数据上。',
    vod_play_from: 'HLS 线路',
    vod_play_url: `正片$${MUX_HLS}`,
  },
  {
    vod_id: 'demo-6', vod_name: '演示 · 分页条目 C',
    type_id: '3', vod_class: '演示·分页验证', vod_year: '2024', vod_area: '本地生成',
    vod_remarks: '第 2 页', vod_pic: '',
    vod_content: '用于确认播放记录（localStorage）在多条目之间互不串数据。',
    vod_play_from: 'MP4 直连',
    vod_play_url: `正片$${GOOGLE_SAMPLE_MP4}`,
  },
];

/* 补齐详情弹框要展示的演职员字段，走与真实源完全相同的 normalizeItem 路径 */
const DEMO_CREDITS = {
  'demo-1': { director: 'MDN Web Docs', actor: 'CC0 公共领域素材' },
  'demo-2': { director: 'Blender Foundation', actor: 'Big Buck Bunny 剧组' },
  'demo-3': { director: 'Mux / Apple Developer', actor: '公开测试流' },
  'demo-4': { director: '本地生成', actor: '演示条目' },
  'demo-5': { director: '本地生成', actor: '演示条目' },
  'demo-6': { director: '本地生成', actor: '演示条目' },
};
DEMO_ITEMS.forEach((it) => {
  const c = DEMO_CREDITS[it.vod_id] || {};
  it.vod_director = c.director || '';
  it.vod_actor = c.actor || '';
});

/** 构造一个与苹果 CMS 采集接口同形状的 payload，交给 normalizeResponse 复用全部解析逻辑 */
function buildDemoPayload(params) {
  const ac = params.ac || 'videolist';
  const wd = String(params.wd || '').trim().toLowerCase();
  const cls = String(params.t || '').trim();
  const ids = String(params.ids || '').trim();
  const pg = Math.max(1, Number(params.pg || 1) || 1);

  let matched = DEMO_ITEMS.slice();
  if (ids) matched = matched.filter((it) => it.vod_id === ids);
  if (cls) matched = matched.filter((it) => it.type_id === cls);
  if (wd) {
    matched = matched.filter((it) =>
      (it.vod_name + ' ' + it.vod_content).toLowerCase().includes(wd));
  }

  const pagecount = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
  const safePg = Math.min(pg, pagecount);
  const slice = ac === 'class' ? [] : matched.slice((safePg - 1) * PAGE_SIZE, safePg * PAGE_SIZE);

  return {
    code: 1,
    msg: '内置演示数据（CC0 / 公开测试流，非影视内容库）',
    page: safePg,
    pagecount,
    total: matched.length,
    class: DEMO_CLASSES,
    list: slice,
  };
}

module.exports = { DEMO_BASE, DEMO_CLASSES, DEMO_ITEMS, buildDemoPayload };
