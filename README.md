# 私人影视聚合播放器 · 可部署源码

静态前端 + Vercel Serverless Functions 同源代理。零第三方依赖、零服务器成本、不需要 AllOrigins。

## 一、这次到底改了什么

### 原版代码的确定性问题（静态审查结论）

| # | 问题 | 后果 |
|---|---|---|
| 1 | 浏览器直接 `fetch()` 第三方采集域名 | 同源策略下，上游不返回 `Access-Control-Allow-Origin` 就会被浏览器拦掉，请求根本到不了then，直接落进 catch，显示"接口响应失败"。**这是最表层也最致命的一层** |
| 2 | 需求里说用了 AllOrigins，但这份源码里**完全没有** AllOrigins | 等于裸跨域；即便补上公共代理，也只是把失败点从 CORS 换成代理限流/超时 |
| 3 | `ac=detail&wd=关键词` | 多数采集接口的搜索动作是 `ac=videolist`（`detail` 通常配合 `ids` 查单条），参数用错会返回空列表或错误 |
| 4 | `catch` 把所有异常压成一句"切换接口" | 403 / 超时 / 非 JSON / 空列表 / 网络不通 全部混在一起，无法定位真因 |
| 5 | 不检查 `data.code` / `data.msg` / `page` | 上游返回错误对象时也被当成"没数据" |
| 6 | 正则 `/https?:\/\/[^\s$#]+\.m3u8/` | 漏掉带 `?token=xxx` 的 M3U8、漏掉 MP4/FLV、只取第一条、不解析 `$$$` 多线路和 `#` 多集 |
| 7 | `<script src="cdn.jsdelivr.net/npm/hls.js@latest">` | `@latest` 会漂移到不兼容版本；CDN 挂了则 `Hls` 未定义，`Hls.isSupported()` 直接 ReferenceError |
| 8 | 无分类 / 分页 / 详情 / 播放记录 | 功能缺口 |

### 修复后的架构

```
浏览器 ──同源──> /api/vod (Vercel Serverless) ──服务端──> 你配置的数据源
                     │
                     ├─ 参数白名单 + 纠正 ac
                     ├─ 8s 超时，不拖死函数
                     ├─ 响应标准化（线路/剧集/分类/分页）
                     └─ 结构化错误码（stage + code + detail）
```

同源请求不再受浏览器 CORS 约束；上游地址只存在于服务端环境变量，前端拿不到。

### 关于实测边界（重要）

我从执行环境实测你给出的 5 个采集域名，全部返回同一份 `403 / No policy rule matched the request / policy_default_denied`，连你的 Vercel 站点也返回同款 403；而 `cdn.jsdelivr.net` 返回 200。这属于**当前出网环境的统一网关策略拦截**，因此这次**无法判定这些资源站在真实用户浏览器里是否可用**，也不把该 403 当作"资源站封禁"的结论。

所以本项目做了两件更靠得住的事：
1. 修掉上面 8 个确定性代码缺陷；
2. 把"为什么没数据"拆成可区分的错误码，你部署后在自己网络里打开 F12 就能一眼看到是 403、超时、非 JSON 还是真的空列表；
3. 附带 `scripts/smoke-test.js`，用本地 mock 上游端到端跑通新架构，不依赖任何外网资源站。

## 二、目录结构

```
.
├── index.html                 前端（搜索/分类/分页/详情/线路/选集/播放记录）
├── api/
│   ├── vod.js                 核心 Serverless 代理
│   └── sources.js             数据源下拉列表（不暴露上游地址）
├── lib/
│   ├── vod-format.js          播放地址与返回数据标准化
│   └── sources.js             数据源配置读取
├── vercel.json                Functions 超时配置
├── package.json
├── sources.example.json       多数据源配置示例
├── .env.example               环境变量示例
├── scripts/smoke-test.js      本地端到端测试
└── README.md
```

## 三、部署步骤（约 5 分钟）

1. **推到 GitHub**：把本目录整个作为仓库根目录（`index.html` 和 `api/` 必须在根目录，不要多套一层文件夹）。
2. **Vercel 导入**：Vercel → Add New → Project → 选该仓库 → Framework Preset 选 `Other` → Build Command 留空、Output Directory 留空 → Deploy。Vercel 会自动把 `api/*.js` 识别成 Serverless Functions。
3. **配置数据源**：Project Settings → Environment Variables，二选一：
   - `VOD_API_BASE` = `https://你的接口/api.php/provide/vod/`（单个，最简）
   - `VOD_SOURCES_JSON` = 把 `sources.example.json` 里 `enabled: true` 的条目压成一行 JSON（多个可切换）
   保存后**必须 Redeploy** 才生效。
4. **自定义域名**：Vercel → Domains 添加域名，按提示在 Cloudflare DNS 加一条 `CNAME → cname.vercel-dns.com`（或 Vercel 给出的 A 记录）。Cloudflare 代理状态建议先设 **DNS only**，确认可访问后再决定是否开启橙云代理。
5. **验收**：打开站点 → F12 → Network → 搜一次，应看到 `/api/vod?...` 返回 200 且 `Content-Type: application/json`；若返回 `ok:false`，按状态栏的 `[错误码]` 对照第五节处理。

本地调试：`npm run smoke`（纯本地，无需联网）、`npm run dev`（需 `npx vercel dev`，会读 `.env.local`）。

## 四、接口说明

`GET /api/vod`

| 参数 | 说明 |
|---|---|
| `source` | 数据源 id，来自 `/api/sources`；不传则用第一个 |
| `ac` | `videolist`（搜索/列表）/ `detail`（配合 `ids` 查单条）/ `class`（分类）；非法值回落到 `videolist`。为兼容原代码，`ac=detail&wd=` 且无 `ids` 时自动纠正为 `videolist` |
| `wd` | 搜索关键词 |
| `pg` | 页码，默认 1 |
| `t` | 分类 id |
| `ids` / `at` / `h` / `limit` | 透传给上游 |

成功返回：

```json
{
  "ok": true, "stage": "ok", "source": {"id":"...","name":"..."},
  "code": 1, "page": 1, "pagecount": 3, "total": 42,
  "classes": [{"id":"1","name":"电影"}],
  "list": [{
    "vod_id":"1001", "vod_name":"...", "vod_pic":"...",
    "vod_class":"...", "vod_year":"...", "vod_content":"...",
    "play_sources":[
      {"from":"线路A","episodes":[{"name":"第01集","url":"https://.../1.m3u8?token=..."}]}
    ]
  }]
}
```

失败返回 `{ "ok":false, "stage":"...", "code":"...", "message":"...", "detail":{...} }`，HTTP 状态统一 200，避免在浏览器里再叠一层 fetch 异常。成功结果带 `s-maxage=60` 边缘缓存，可减少免费额度和上游压力；失败结果一律 `no-store`。

## 五、错误码对照表

| code | stage | 含义 / 处理 |
|---|---|---|
| `NO_SOURCE` | config | 没配环境变量，去 Vercel 加 `VOD_API_BASE` 或 `VOD_SOURCES_JSON` 并重新部署 |
| `UNKNOWN_SOURCE` | config | 前端传了不存在的 id，刷新页面 |
| `INVALID_BASE` | config | base 不是合法 URL |
| `UPSTREAM_403` | upstream | 上游明确拒绝：接口停用 / 地区或 IP 风控 / 需要授权 / 不允许第三方调用。换用自有授权接口 |
| `UPSTREAM_404` | upstream | 接口路径不对，检查是否以 `/api.php/provide/vod/` 结尾 |
| `UPSTREAM_429` / `UPSTREAM_5xx` | upstream | 限流或上游故障，稍后重试 |
| `UPSTREAM_TIMEOUT` | network | 8 秒未响应 |
| `UPSTREAM_NETWORK` | network | DNS / TLS / 连接失败 |
| `INVALID_JSON` | parse | 上游返回 HTML 拦截页，`detail.excerpt` 里有响应片段 |
| `NOT_JSON` | 前端 | `/api/vod` 压根没返回 JSON，多半是 Functions 没部署成功（检查 `api/` 是否在仓库根目录） |
| `EMPTY` | 前端 | 接口连通但零结果，`code`/`msg` 会一并显示 |

## 六、免费额度与长期运行限制

- **Vercel Hobby**：永久免费，但限定**个人非商业用途**；每月约 100GB 带宽，超出后功能暂停而不是扣费。[citation:8] Serverless Functions 有单次执行时长上限（本项目 `maxDuration: 10` 秒，上游超时 8 秒），冷启动会带来首屏延迟；Vercel 近两年也在收紧闲置部署的存储保留策略，长期不更新的旧部署可能被清理。[citation:14] 具体数值以官方定价页为准。
- **Cloudflare Free**：权威 DNS、DNSSEC 免费，足够只做域名解析；若以后想把代理层挪到边缘，Workers 免费档有每日 10 万请求的额度。[citation:7][citation:16] 开启橙云代理时，注意它自己的缓存/防火墙规则可能再次影响 `/api/vod` 的响应头，排障阶段建议先保持 DNS only。
- **GitHub**：公开/私有仓库免费，作为源码与自动部署触发源没有持续成本。
- **真正的长期风险不在平台，在上游**：数据源随时可能改接口、加风控、下线；免费额度也禁不起高频搜索。本项目用边缘缓存（60 秒）+ 参数白名单 + 短超时把这种不确定性收敛住，但不承诺任何第三方源的可用性。若需要长期稳定，最可靠的做法是把数据放到自己掌控、有明确授权的服务里。

## 七、合规边界

请只接入**你拥有合法授权、或已获得权利人许可**的影视元数据和播放地址。`sources.example.json` 中列出的原项目自带地址仅作为「配置格式迁移示例」保留（默认 `enabled: false`），本项目不对其内容授权状况、服务条款或可用性作任何背书，也不提供绕过风控、防盗链或鉴权的手段。`api/vod.js` 只是一个通用的服务端转发 + 数据标准化层，接什么源由你决定并自行负责。
