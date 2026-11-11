'use strict';

/**
 * 数据源只在服务端读取，前端永远拿不到上游地址。
 *
 * 优先级：
 *   1. VOD_SOURCES_JSON  —— JSON 数组，支持多接口切换
 *   2. VOD_API_BASE      —— 单接口，最简配置
 *   3. 未配置 / 配置无效  —— 自动回退到内置演示数据（CC0 公开测试流）
 *
 * 回退演示数据的意义：部署完立刻能看到完整功能跑通，而不是只看到一个
 * "尚未配置数据源"的报错框。一旦配上自有授权接口，演示源自动让位。
 *
 * 每次调用都重新读环境变量，方便本地测试与 Vercel 运行时热更新。
 */

const { DEMO_BASE } = require('./demo-data');

function normalizeEntry(s, i) {
  if (typeof s === 'string') {
    return { id: `src${i + 1}`, name: `接口 ${i + 1}`, base: s, referer: '', enabled: true };
  }
  const o = s && typeof s === 'object' ? s : {};
  return {
    id: String(o.id || `src${i + 1}`),
    name: String(o.name || `接口 ${i + 1}`),
    base: String(o.base || o.url || ''),
    referer: String(o.referer || ''),
    enabled: o.enabled !== false,
  };
}

function demoSource(reason) {
  return [{
    id: 'demo',
    name: reason ? `演示数据（${reason}）` : '演示数据 · CC0 公开测试流',
    base: DEMO_BASE,
    referer: '',
    enabled: true,
  }];
}

function loadSources() {
  let raw = [];
  let reason = '';

  if (process.env.VOD_SOURCES_JSON) {
    try {
      const parsed = JSON.parse(process.env.VOD_SOURCES_JSON);
      raw = Array.isArray(parsed) ? parsed : (parsed.sources || []);
    } catch (e) {
      reason = 'VOD_SOURCES_JSON 不是合法 JSON';
      raw = [];
    }
  } else if (process.env.VOD_API_BASE) {
    raw = [{
      id: 'default',
      name: process.env.VOD_API_NAME || '默认接口',
      base: process.env.VOD_API_BASE,
    }];
  } else {
    return demoSource('');
  }

  const list = raw
    .map(normalizeEntry)
    .filter((s) => s.enabled && /^https?:\/\//i.test(s.base));

  if (!list.length) return demoSource(reason || '配置里没有可用的 https 接口地址');
  return list;
}

function getSource(id) {
  if (!id) return null;
  return loadSources().find((s) => s.id === id) || null;
}

/** 给前端下拉用：刻意不暴露 base / referer */
function publicSources() {
  return loadSources().map((s) => ({ id: s.id, name: s.name }));
}

module.exports = { loadSources, getSource, publicSources, DEMO_BASE };
