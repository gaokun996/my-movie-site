'use strict';

/**
 * 苹果 CMS / 通用采集接口的数据标准化。
 * 不依赖任何第三方库，可同时被 Serverless Function 与本地测试脚本复用。
 */

function cleanUrl(u) {
  if (!u) return '';
  return String(u)
    .trim()
    .split('\\/').join('/')
    .replace(/^&nbsp;/i, '')
    .replace(/&amp;/g, '&')
    .replace(/[,，;；]+$/, '');
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);
}

/**
 * 解析 vod_play_url。
 *
 * 兼容格式：
 *   多线路： "线路A内容$$$线路B内容"  （线路名来自 vod_play_from）
 *   多集：   "第01集$https://a/1.m3u8#第02集$https://a/2.m3u8"
 *   带鉴权： "https://a/1.m3u8?token=xxx&exp=yyy"（原正则会漏掉）
 *   裸地址： "https://a/1.mp4"
 *
 * 注意：不再只认 .m3u8，mp4 / flv 等同样保留，交给前端按扩展名选择播放器。
 */
function parsePlayUrl(raw, playFrom) {
  const text = String(raw || '').trim();
  if (!text) return [];

  const fromNames = String(playFrom || '')
    .split('$$$')
    .map((s) => s.trim())
    .filter(Boolean);

  return text
    .split('$$$')
    .map((block, i) => {
      let from = fromNames[i] || `线路 ${i + 1}`;
      const episodes = [];

      String(block)
        .split('#')
        .forEach((part, idx) => {
          const p = String(part).trim();
          if (!p) return;
          const sep = p.indexOf('$');
          let name;
          let url;
          if (sep > -1) {
            name = p.slice(0, sep).trim();
            url = cleanUrl(p.slice(sep + 1));
          } else {
            name = `第${String(idx + 1).padStart(2, '0')}集`;
            url = cleanUrl(p);
          }
          if (!url) return;
          // 丢弃明显不是播放地址的脏数据
          const looksLikeMedia = /^(https?:|\/\/|\/|\.\/)/i.test(url) ||
            /\.(m3u8|mp4|flv|mkv|ts|avi|mov)(\?|$)/i.test(url);
          if (!looksLikeMedia) return;
          episodes.push({ name: name || `第${idx + 1}集`, url });
        });

      // 有些源把线路名塞在首段（"正片$https://..."），此时只有一集
      if (!fromNames[i] && episodes.length === 1 &&
          !/第?\d+\s*(集|期|话)/.test(episodes[0].name)) {
        from = episodes[0].name;
        episodes[0].name = '正片';
      }

      return { from, episodes };
    })
    .filter((s) => s.episodes.length > 0);
}

function normalizeItem(it) {
  const raw = it && typeof it === 'object' ? it : {};
  const pic = String(raw.vod_pic || raw.pic || raw.vod_pic_thumb || '')
    .split(',')[0]
    .trim();
  const playFrom = String(raw.vod_play_from || raw.play_from || '');
  const playUrl = raw.vod_play_url || raw.play_url || '';

  return {
    vod_id: String(raw.vod_id ?? raw.id ?? ''),
    vod_name: String(raw.vod_name || raw.name || '未命名').trim(),
    vod_pic: pic,
    vod_class: String(raw.vod_class || raw.type_name || '').trim(),
    vod_year: String(raw.vod_year || raw.year || '').trim(),
    vod_area: String(raw.vod_area || raw.area || '').trim(),
    vod_remarks: String(raw.vod_remarks || raw.remarks || raw.vod_version || '').trim(),
    vod_content: stripHtml(raw.vod_content || raw.content || raw.vod_blurb || ''),
    vod_play_from: playFrom,
    play_sources: parsePlayUrl(playUrl, playFrom),
  };
}

/** 把各种上游返回统一成前端可直接渲染的结构 */
function normalizeResponse(payload) {
  if (Array.isArray(payload)) {
    return {
      code: payload.length ? 1 : 0,
      msg: '',
      page: 1,
      pagecount: 1,
      total: payload.length,
      classes: [],
      list: payload.map(normalizeItem),
    };
  }

  const p = payload && typeof payload === 'object' ? payload : {};
  const rawList = p.list || p.data || p.vod || [];
  const list = (Array.isArray(rawList) ? rawList : []).map(normalizeItem);
  const rawClasses = Array.isArray(p.class) ? p.class : [];

  return {
    code: Number(p.code ?? (list.length ? 1 : 0)),
    msg: String(p.msg || ''),
    page: Number(p.page || 1) || 1,
    pagecount: Number(p.pagecount || p.page_count || 1) || 1,
    total: Number(p.total || list.length) || 0,
    classes: rawClasses.map((c) => ({
      id: String(c.type_id ?? c.id ?? ''),
      name: String(c.type_name ?? c.name ?? ''),
    })).filter((c) => c.id && c.name),
    list,
  };
}

module.exports = { parsePlayUrl, normalizeItem, normalizeResponse, stripHtml, cleanUrl };
