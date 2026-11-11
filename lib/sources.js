'use strict';

/**
 * 数据源只在服务端读取，前端永远拿不到上游地址。
 *
 * 优先级：
 *   1. VOD_SOURCES_JSON  —— JSON 数组，支持多接口切换
 *   2. VOD_API_BASE      —— 单接口，最简配置
 *   3. 未配置            —— 返回空数组，前端给出明确的引导提示
 *
 * 每次调用都重新读环境变量，方便本地测试与 Vercel 运行时热更新。
 */

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

function loadSources() {
  let raw = [];

  if (process.env.VOD_SOURCES_JSON) {
    try {
      const parsed = JSON.parse(process.env.VOD_SOURCES_JSON);
      raw = Array.isArray(parsed) ? parsed : (parsed.sources || []);
    } catch (e) {
      // 配置写错时不要让整个函数崩掉，交给前端提示 NO_SOURCE
      return [];
    }
  } else if (process.env.VOD_API_BASE) {
    raw = [{
      id: 'default',
      name: process.env.VOD_API_NAME || '默认接口',
      base: process.env.VOD_API_BASE,
    }];
  }

  return raw
    .map(normalizeEntry)
    .filter((s) => s.enabled && /^https?:\/\//i.test(s.base));
}

function getSource(id) {
  if (!id) return null;
  return loadSources().find((s) => s.id === id) || null;
}

/** 给前端下拉用：刻意不暴露 base / referer */
function publicSources() {
  return loadSources().map((s) => ({ id: s.id, name: s.name }));
}

module.exports = { loadSources, getSource, publicSources };
