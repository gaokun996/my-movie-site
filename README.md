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
│   ├── vod.js                 核心 Serverless 代理（元数据 JSON）
│   ├── sources.js             数据源下拉列表（不暴露上游地址）
│   └── playlist.js            M3U8 播放清单同源代理（只几 KB 文本）
├── lib/
│   ├── vod-format.js          播放地址与返回数据标准化
│   ├── sources.js             数据源配置读取
│   └── demo-data.js           内置演示数据（CC0 / 公开测试流）
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
3. **先不配任何环境变量，直接验收**：零配置会自动进入「演示模式」，页面下拉里出现「演示数据 · CC0 公开测试流」，可以立刻验证搜索 / 分类 / 分页 / 播放 / 播放记录全链路。详见第三节后面的「演示模式」。
4. **换成自有授权接口（之后再做）**：Project Settings → Environment Variables，二选一：
   - `VOD_API_BASE` = `https://你的接口/api.php/provide/vod/`（**单个完整 URL**，不是一串地址，也不要带 `?ac=` 参数）
   - `VOD_SOURCES_JSON` = 一个**单行 JSON 数组**，例如：
     `[{"id":"mine","name":"我的影视库","base":"https://你的接口/api.php/provide/vod/","enabled":true}]`
   保存后**必须 Redeploy** 才生效；一旦配好，演示源自动让位。
5. **自定义域名**：Vercel → Domains 添加域名，按提示在 Cloudflare DNS 加一条 `CNAME → cname.vercel-dns.com`（或 Vercel 给出的 A 记录）。Cloudflare 代理状态建议先设 **DNS only**，确认可访问后再决定是否开启橙云代理。
6. **验收**：打开站点 → F12 → Network → 搜一次，应看到 `/api/vod?...` 返回 200 且 `Content-Type: application/json`；若返回 `ok:false`，按状态栏的 `[错误码]` 对照第五节处理。

### 演示模式

不配 `VOD_API_BASE` / `VOD_SOURCES_JSON`，或配置写错时，`/api/sources` 会返回一个 `演示数据` 源，`/api/vod` 完全不出网、直接返回内置数据。播放地址用的是 MDN 的 CC0 公共领域视频、Google 公开示例视频，以及 Mux / Apple 面向开发者的公开 HLS 测试流——它们只是**播放器验证素材，不是影视内容库**。

这个模式解决的是「部署完只看到一个报错框」的问题：你可以先确认整套架构确实跑通了，再把手里的授权接口填进环境变量。配置非法时下拉名称会带上原因（例如「演示数据（VOD_SOURCES_JSON 不是合法 JSON）」），不会静默失败。

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
| `NO_SOURCE` | config | 理论上不会出现（零配置会回退演示数据）。若出现，说明 `lib/sources.js` / `lib/demo-data.js` 没上传完整 |
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

请只接入**你拥有合法授权、或已获得权利人许可**的影视元数据和播放地址。内置演示模式使用 CC0 公共领域视频与开发者公开测试流，仅用于验证播放器，不代表任何影视内容授权；`sources.example.json` 中列出的原项目自带地址仅作为「配置格式迁移示例」保留（默认 `enabled: false`），本项目不对其内容授权状况、服务条款或可用性作任何背书，也不提供绕过风控、防盗链或鉴权的手段。`api/vod.js` 只是一个通用的服务端转发 + 数据标准化层，接什么源由你决定并自行负责。

**关于 `VOD_API_BASE` 的 value**：它只接受**一个**以 `https://` 开头的完整接口地址。把十几个地址一起粘进去会被判定为非法 URL，自动回退到演示模式并在下拉名称里提示原因；需要多接口切换请用 `VOD_SOURCES_JSON` 的单行 JSON 数组。

## 八、外观版（v3）说明

`index.html` 按常见的「影院海报墙」样式重做，覆盖以下交互：

| 界面元素 | 实现 |
|---|---|
| 顶栏：品牌 / 胶囊搜索框 / 资源下拉 / 接口设置 | 资源下拉数据来自 `/api/sources`，切换即重新拉数据 |
| 统计行「共 N 部 · 第 X/Y 页 · 当前接口」 | 直接取 `total / page / pagecount / source.name`，不是写死的文案 |
| 分类下拉 + 默认排序 / 最新 / 片名 | 分类来自 `ac=class`；排序**只作用于当前页**（上游没给排序参数，不假造全库热度） |
| 满屏海报网格 + 右上角角标 + 底部片名 | 角标取 `vod_remarks`（如「HD中字」），海报加载失败自动回退占位图 |
| 资源接口设置弹窗 | 每行：名称 / 地址列 / 测速按钮；测速真实调用 `/api/vod?source=…&ac=class` 并显示耗时或错误码 |
| 底部「接口名称 / 接口地址 / 添加」 | 点击生成一行 `VOD_SOURCES_JSON` 供复制到 Vercel，附「复制」按钮 |
| 点击海报 | 播放弹层：线路切换、选集、HLS.js 双 CDN 兜底、播放记录 |

### 三处与常见聚合站刻意不同

1. **地址列不显示真实上游 URL**，显示「服务端托管 · 地址不下发到浏览器」。`/api/sources` 只返回 `{id, name}`——这正是本项目能绕开 CORS 的前提：浏览器不直接请求第三方域名。
2. **没有「请求走 Cloudflare 公共代理」开关**，改成只读勾选「同源 Serverless 转发（已启用）」。前端直连 + 公共代理就是原版故障的成因，退回那套等于白修。
3. **「添加」不做即时直连**：数据源由 Vercel 环境变量统一管理，保存后必须 Redeploy 才生效。弹窗帮你把格式拼好，避免在页面里存地址、也避免改一次就要改代码。

零配置时下拉显示「演示数据 · CC0 公开测试流」，共 6 条 / 2 页——**排版和字段与真实库一致，只是数量不同**；配上自有授权接口后统计数字、分类、海报会自然换成真实数据。参考截图里的「共 4587 部 / 77 页」属于对方的数据规模，本项目不内置任何第三方采集站地址。

## 九、影片详情弹框（v4）

点海报弹出的浮层按「影片详情」样式重做，字段与真实采集接口一一对应：

| 截图元素 | 数据来源 |
|---|---|
| 标题「影片详情」、720px 窄弹框、左侧 158px 竖版海报 | 静态布局 + `vod_pic` |
| 片名 | `vod_name` |
| 四个圆角标签 `HD国语 / 动作片 / 2026 / 大陆` | `vod_remarks`、`vod_class`、`vod_year`、`vod_area`（自动去重、空值跳过） |
| 「导演:xxx」行 | `vod_director`、`vod_actor`（v4 新增标准化字段，兼容 `director` / `actor` 别名） |
| 「简介：…」 | `vod_content` |
| 「播放源」下 `teifan` / `ffm3u8` | `vod_play_from` 拆出的线路名，选中态蓝色描边 |
| 「选集」下 `HD国语` | 该线路 `episodes[].name` |
| 底部「已跳过片头 26 秒」浮层 | 真实功能：播放前 26 秒浮出「跳过片头 26 秒」，点击 `seek` 到 26 秒并显示「已跳过」 |

### 三处处理说明

1. **`&nbsp;` 不复刻**：参考截图里「简介:&nbsp;《山竹刀》」把 HTML 实体当字面文本渲染了，属于对方的小 bug。`stripHtml()` 会把它转成正常空格，显示更干净。
2. **播放器默认收起**：截图里弹框没有视频区，所以点海报只展示「详情 + 播放源 + 选集」，与图一致；点任意选集后弹框内展开 16:9 播放器并开始播放。从「最近观看」进入时会自动恢复到当时那一集。把 `index.html` 顶部的 `AUTO_PLAY_ON_OPEN` 改成 `true`，即可变成一点开就播。
3. **片头秒数可配**：`SKIP_INTRO_SECONDS = 26` 只是按截图的数字设的默认值，按片源实际改这一个常量即可；纯直播流没有可跳转时长时该浮层不会出现。

演示数据里播放源显示为「MP4 直连」「Mux 测试流」等，接上真实授权接口后会自动变成接口返回的线路名（如 `teifan` / `ffm3u8`），前端不用改。

### v4 覆盖清单

若你已在 GitHub 部署过 v3，本次只需覆盖以下文件（`api/` 与 `lib/sources.js` 未改动）：

```
index.html                  ← 详情弹框 + 海报墙
lib/vod-format.js           ← 新增 vod_director / vod_actor
lib/demo-data.js            ← 演示条目补演职员字段
scripts/smoke-test.js       ← 新增字段断言（现共 14 项）
README.md
```

`node scripts/smoke-test.js` 本地 14 项全通过；前端脚本引用的 41 个 DOM id 与定义完全一一对应。

## 十、v5：列表出来了，但点播放一直缓冲

### 先分清两层

`/api/vod` 转发的只是**元数据 JSON**（片名、海报、`vod_play_url`）。列表和详情能出来，说明第一层已经完全打通。播放地址里的 M3U8 是由浏览器里的 HLS.js **另外发请求**去取的，跟 `/api/vod` 不是同一条链路 —— 所以「有海报、有选集、点播放永远转圈」是典型的第二层问题。

播放链路实际有三段，任意一段被挡都会表现为「一直缓冲」：

| 段 | 谁在请求 | 常见故障 |
|---|---|---|
| ① M3U8 清单 | HLS.js 用 XHR/fetch | **缺 CORS 头**（最常见）、403、返回 HTML 拦截页、地址其实不是 M3U8 |
| ② 解密密钥 `#EXT-X-KEY` | HLS.js | 加密流鉴权，密钥 URL 被拒 |
| ③ `.ts` / `.m4s` 分片 | HLS.js | Referer 白名单、IP 绑定、token 时效（防盗链） |

### v5 做了什么

**`api/playlist.js`：只代理 M3U8 清单文本**（通常几 KB），不代理视频分片。清单走同源后，HLS.js 不再受浏览器 CORS 约束；服务端同时把清单里的**相对分片地址重写成绝对 URL**，避免基准地址变成本站后分片 404。

刻意不做、也不建议做的事：

- **不伪造 Referer**：请求里不设置任何第三方站点身份。CORS 是浏览器同源策略，同源转发是标准解法；防盗链是授权校验，绕过它既不稳定也不合规。
- **不代理视频分片**：Vercel Function 单次执行 10 秒、免费 100GB 带宽，一集剧就能吃光；这条路从架构上就不成立。
- **不当开放代理**：只接受 `.m3u8`、拒绝内网/环回地址、响应体上限 512KB、必须含 `#EXTM3U`。可选 `PLAYLIST_HOST_ALLOWLIST`（逗号分隔域名）进一步收紧到实际分片域名。

**播放器下方新增诊断条**：

- 显示当前完整播放地址，可「复制地址」「新标签打开」「重试播放」
- 「取清单方式」可切 **同源代理（默认）** / **浏览器直连**，用于对比
- 状态分阶段显示：`① 正在取播放清单` → `② 清单就绪（N 个清晰度），正在取视频分片` → `③ 分片已加载，播放中`
- 失败时按层给出原因，并带上 HTTP 状态码；若 `/api/playlist` 有结构化错误，会自动读回 `[错误码] + 响应片段`

### 怎么读诊断结果

| 卡在 | 含义 | 还能做什么 |
|---|---|---|
| `① 播放清单层` + 直连模式 | 上游 M3U8 没给 `Access-Control-Allow-Origin` | 切「同源代理」，v5 默认已开 |
| `① 播放清单层` + 代理模式仍 `PLAYLIST_403` / `PLAYLIST_INVALID_M3U8` | 清单域名有 Referer / 地区 / 时效校验 | 需要接口方按接入文档给你的域名授权；配置层面救不了 |
| `③ 视频分片层` + `HTTP 403` | 清单拿到了，分片被防盗链拒绝 | **这一层在纯前端零成本架构里无稳定解**。示例站能播，通常是因为它有授权、有合作身份，或自建了流代理 |
| `② 解密密钥层` | 加密流需要密钥鉴权 | 同上，需要合法凭证 |

把诊断条那行文字和「新标签打开」看到的结果一起发来，就能确定是「CORS（已修）」还是「防盗链（需要授权）」，不用再反复猜。

### 为什么示例网站能看、这里不行

复制 URL 只复制了入口，复制不走**调用身份**：域名白名单、`Referer`、IP 段、签名参数、时效 token，以及示例站自己的播放/解析服务。更关键的是我们的请求从 **Vercel 的出网 IP** 发出，对资源站是一个全新来源。「在别人站上能看」也不等于「有权把同一批内容放到自己站上分发」—— 本项目提供诊断与合规的转发，不提供绕过风控的手段。

### 真要长期可播的两条路

1. 向接口方申请**允许你的域名调用**的白名单或正规接入凭证，按对方文档配置；
2. 换成**你拥有授权或公有领域**的片源（见第七节），元数据与播放地址都在你掌控之内，三层链路才同时成立。

### v5 覆盖清单

```
api/playlist.js        ← 新增（必须传，否则 /api/playlist 404）
index.html             ← 播放诊断条 + 分层错误 + 代理/直连切换
scripts/smoke-test.js  ← 新增 5 项清单代理断言（现共 19 项）
README.md
```

`lib/` 与 `api/vod.js`、`api/sources.js` 未改动。上传后 Vercel 会自动把 `api/playlist.js` 识别成新 Function，**不需要改环境变量、不需要 Redeploy 之外额外操作**。本地 `node scripts/smoke-test.js` 19 项全通过，前端 45 个 DOM id 与引用一一对应。
