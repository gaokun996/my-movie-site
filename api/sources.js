'use strict';

/** GET /api/sources —— 只返回 id + 名称，不暴露上游地址 */
const { publicSources } = require('../lib/sources');

module.exports = async function handler(req, res) {
  const list = publicSources();
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.end(JSON.stringify(list));
};
