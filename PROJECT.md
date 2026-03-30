# RetailPulse 零售脉搏

> 零售与 AI 行业新闻聚合平台

---

## 1. 项目概述

### 背景

零售行业和 AI 技术是当下变化最快的两个领域。从业者每天需要跟踪大量信息源——国内有联商网、亿邦动力、机器之心、36氪，海外有 Retail Dive、TechCrunch、MIT Technology Review 等。这些信息分散在几十个网站和 RSS 源中，手动浏览效率低下，且容易遗漏关键动态。

### 产品定位

RetailPulse（零售脉搏）是一个**零售 + AI 行业新闻聚合平台**，自动从 30+ 个信息源抓取、分类、整合新闻，提供统一的阅读界面。

核心价值：
- **一站式信息聚合**：将零售和 AI 两个领域的国内外信息源整合到一个页面
- **智能分类**：通过两步分类器（语言检测 + 关键词匹配）自动将文章归入四大板块
- **公司动态追踪**：Trending Bar 实时统计 30 家重点公司的新闻提及量
- **零维护运行**：定时自动刷新，无需人工干预

### 目标用户

- 零售行业从业者（运营、采购、战略岗位）
- 关注 AI 技术动态的产品经理和技术人员
- 关注中国消费品牌出海的投资和研究人员
- 需要同时了解国内外行业动态的决策者

## 2. 功能特性

### 四大内容板块

| 板块 | 说明 | 信息源数量 |
|------|------|-----------|
| 国内零售 China Retail | 实体零售、电商、即时零售、政策、出海 | 6 个 |
| 国际零售 Global Retail | 欧美零售、东南亚电商、供应链、支付 | 7 个 |
| 国内 AI China AI | 大模型、AI 产业、技术实践、AI 商业化 | 6 个 |
| 国际 AI Global AI | AI 研究、AI 公司动态、AI 安全、前沿论文 | 15 个 |

### Trending Bar（公司动态追踪）

固定追踪 30 家重点公司，按文章提及次数动态排序。产品名自动归并到母公司（例：ChatGPT → OpenAI，抖音/豆包 → 字节跳动，Claude → Anthropic）。

覆盖范围：
- **AI 巨头**：OpenAI、Anthropic、Google、Meta、Microsoft、Apple、NVIDIA、xAI
- **AI 新锐**：Cursor
- **中国科技**：百度、阿里巴巴、腾讯、华为、京东、拼多多、美团、字节跳动
- **中国零售**：盒马、山姆、胖东来、小象超市
- **跨境/出海**：Temu、SHEIN、TikTok Shop、Shopee、Lazada、Grab
- **国际零售**：Amazon、Instacart、Coupang、Mercado Libre

### 信息层级设计

每个板块采用**卡片 + 列表**混合布局：
- **Top 3 卡片**：24 小时内优先级最高的文章，展示标题、来源、摘要、标签
- **时间线列表**：其余文章按时间倒序排列，按日期分组（今天 / 昨天 / 更早）

### 搜索与筛选

- 全局搜索：按标题、摘要、来源关键词过滤
- 标签筛选：点击文章标签按主题过滤
- 公司筛选：点击 Trending Bar 公司名过滤相关文章

### 来源优先级标识

每个信息源配有 1-3 星优先级：
- ★★★（红色）：核心信息源，如 Retail Dive、MIT Technology Review
- ★★（橙色）：重要信息源，如 Modern Retail、TechCrunch
- ★（灰色）：补充信息源

## 3. 技术架构

### 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 后端 | Node.js + Express | 轻量级 HTTP 服务器 |
| RSS 解析 | rss-parser | 解析 RSS/Atom 订阅源 |
| 定时任务 | node-cron | 每 20 分钟自动刷新 |
| 前端 | 纯 HTML/CSS/JS | 无框架依赖，单文件 SPA |
| 字体 | Noto Serif SC (Google Fonts) | 中文衬线字体，编辑感 |
| 部署 | Railway | 支持 Node.js 后端持续运行 |

### 系统架构

```
┌─────────────────────────────────────────────────────┐
│                    前端 (index.html)                  │
│  ┌───────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ Trending   │  │ Tab 导航  │  │ 卡片 + 列表渲染   │  │
│  │ Bar        │  │ 搜索/筛选 │  │                   │  │
│  └─────┬─────┘  └─────┬────┘  └────────┬─────────┘  │
│        └───────────────┼────────────────┘            │
│                        │ fetch()                     │
│                        ▼                             │
│              ┌─────────────────┐                     │
│              │ API 优先        │                     │
│              │ → data.json     │  三级降级策略        │
│              │ → EMBEDDED_DATA │                     │
│              └─────────────────┘                     │
└─────────────────────────────────────────────────────┘
                         │
                    /api/articles
                    /api/trending
                         │
┌─────────────────────────────────────────────────────┐
│                  后端 (server.js)                     │
│                                                      │
│  ┌──────────┐    ┌──────────────┐    ┌───────────┐  │
│  │ RSS 抓取  │───▶│ 两步分类器    │───▶│ 文章缓存   │  │
│  │ + RSSHub  │    │ 1. 语言检测   │    │ (内存)     │  │
│  │ 降级      │    │ 2. 主题匹配   │    └─────┬─────┘  │
│  └──────────┘    └──────────────┘          │         │
│                                            ▼         │
│  ┌──────────┐    ┌──────────────┐    ┌───────────┐  │
│  │ 持久化    │◀──▶│ Trending     │◀───│ data.json  │  │
│  │ 缓存      │    │ 公司统计      │    │ 静态降级    │  │
│  └──────────┘    └──────────────┘    └───────────┘  │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │ node-cron: 每 20 分钟刷新                      │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### 数据流

1. **RSS 抓取**：对每个配置了 RSS 地址的信息源调用 `rss-parser` 解析。若主 RSS 地址失败，自动降级到 RSSHub 备用地址
2. **两步分类器**：
   - **Step 1 - 语言检测**：统计标题中 CJK 字符占比，判断国内（domestic）还是国际（intl）
   - **Step 2 - 主题匹配**：用关键词列表匹配零售（retail）或 AI 主题，结合来源锁定和严格过滤规则
3. **文章去重**：基于标题前 50 字符去重
4. **pubDate 矫正**：未来时间戳自动钳位到当前时间；持久化缓存中保留最早已知发布时间
5. **Trending 统计**：遍历所有文章，统计 30 家公司及其产品别名的提及次数
6. **静态数据更新**：每次刷新后将完整数据写入 `public/data.json`，并内联到 `index.html` 的 `EMBEDDED_DATA` 变量中

### 三级降级策略

前端获取数据时按优先级尝试：

```
API (/api/articles)  →  data.json (静态文件)  →  EMBEDDED_DATA (内联 JSON)
```

- **API 可用**：直接使用服务端实时数据
- **API 不可用**：加载静态 `data.json`，客户端执行筛选
- **data.json 不可用**：使用 HTML 内联的 `EMBEDDED_DATA`，确保纯静态托管也能显示内容

### 持久化缓存机制

服务重启后，之前抓取的文章不会丢失：

- `data/persistent_cache.json`：保存最近一次完整文章列表
- 新一轮抓取完成后，与缓存合并，保留未重新出现的旧文章
- 确保服务重启或 RSS 源临时不可用时，用户仍能看到历史内容

### 文章分类器详解

分类器采用两步法将无结构的 RSS 文章归入四个板块：

```
原始文章 → detectLocale() → domestic / intl
         → detectTopic()  → retail / ai / null
         → 组合结果       → domestic_retail / intl_ai / ...
```

特殊处理规则：
- **来源锁定**（aiLockedSources）：机器之心、量子位、Anthropic 等 AI 专业源的文章默认归为 AI 板块
- **严格过滤**（strictSources）：Bloomberg 等综合媒体的文章必须同时匹配关键词才会收录
- **通用来源过滤**（generalSources）：36氪、Hacker News 等广覆盖媒体需要关键词匹配才收录
- **国际特征检测**：包含外国品牌名、英文地区关键词的文章会被标记为国际

## 4. 数据源详情

### 国内零售 China Retail（6 个源）

| 信息源 | 类型 | 优先级 | 覆盖领域 |
|--------|------|--------|----------|
| 联商网 Linkshop | scrape | ★★★ | 实体零售、连锁、便利店、生鲜 |
| 亿邦动力 | scrape | ★★ | 电商、即时零售、新零售 |
| 新华社财经 | scrape | ★★★ | 消费、经济、政策 |
| 商务部 | scrape | ★★ | 政策、消费、外贸 |
| 中国连锁经营协会 CCFA | scrape | ★★ | 连锁、便利店、行业协会 |
| 艾媒咨询 | scrape | ★★ | 消费数据、市场研究、新零售 |

### 国际零售 Global Retail（7 个源）

| 信息源 | 类型 | 优先级 | 覆盖领域 |
|--------|------|--------|----------|
| Retail Dive | RSS | ★★★ | US retail、DTC、omnichannel |
| Modern Retail | RSS | ★★ | DTC、omnichannel、ecommerce |
| Grocery Dive | RSS | ★★ | grocery、dark store、delivery |
| PYMNTS Retail | RSS | ★ | payments、retail media、fintech |
| Supermarket News | RSS | ★★ | grocery、supermarket、food retail |
| Supply Chain Dive | RSS | ★★ | supply chain、logistics、fulfillment |
| Retail Gazette | RSS | ★★ | UK retail、Europe、fashion |

### 国内 AI China AI（6 个源）

| 信息源 | 类型 | 优先级 | 覆盖领域 |
|--------|------|--------|----------|
| 机器之心 | scrape | ★★★ | 大模型、AI 产业、学术 |
| 量子位 Qbitai | scrape | ★★★ | AI 产品、AI 动态 |
| 36氪 AI | RSS | ★★ | AI 创投、AI 应用 |
| InfoQ 中文站 | RSS | ★★ | AI 工程、技术实践 |
| 钛媒体 | scrape | ★★ | AI 商业化、产业融合 |
| SCMP Tech | RSS | ★★ | China AI、tech policy |

### 国际 AI Global AI（15 个源）

| 信息源 | 类型 | 优先级 | RSSHub 备用 | 覆盖领域 |
|--------|------|--------|-------------|----------|
| MIT Technology Review | RSS | ★★★ | — | AI research、deep tech |
| TechCrunch AI | RSS | ★★ | — | AI startups、funding |
| VentureBeat AI | RSS | ★★ | — | enterprise AI、B2B |
| Wired AI | RSS | ★★★ | ✓ | AI、tech policy、consumer AI |
| NYT Tech | RSS | ★★ | — | tech、AI、regulation |
| Anthropic Blog | RSS | ★★★ | ✓ | LLM、AI safety |
| OpenAI Blog | scrape | ★★★ | ✓ | LLM、ChatGPT、AI research |
| DeepMind Blog | RSS | ★★★ | ✓ | AI research、Gemini、AGI |
| Import AI | RSS | ★★ | — | AI research、weekly |
| Techmeme | RSS | ★★★ | — | tech、AI、startups |
| Hacker News | RSS | ★★ | ✓ | tech、startups |
| Ars Technica | RSS | ★★ | — | tech、AI |
| The Decoder | RSS | ★★ | — | AI、LLM |
| Hugging Face Papers | RSS | ★★ | ✓ | AI research、papers、open source |
| Bloomberg Tech | RSS | ★★★ | ✓ | tech、AI、markets |

### RSSHub 集成

部分信息源的官方 RSS 不可用或限制访问，通过 [RSSHub](https://github.com/DIYgod/RSSHub) 公共实例（`hub.slarker.me`）获取替代 RSS 源。

抓取逻辑自动执行降级：
```
主 RSS 地址 → 失败 → RSSHub 备用地址 → 失败 → 跳过
```

### 关键词配置

`data/sources.json` 中的 `keywords` 字段定义了各主题的监控关键词，用于分类器匹配和内容过滤：

- **即时零售**：即时零售、前置仓、小象超市、盒马、山姆、胖东来...
- **供应链**：产地直采、冷链物流、源头溯源...
- **跨境出海**：跨境电商、出海、全托管、Temu、SHEIN...
- **AI 前沿**：大模型、多模态、AI Agent、LLM、RAG...
- **AI 公司**：OpenAI、ChatGPT、Anthropic、Claude、Gemini...
- **AI 基础设施**：NVIDIA、GPU、AI chip、算力、H100...

## 5. 部署指南

### 项目结构

```
retailpulse/
├── server.js                  # 后端主程序（Express + RSS 抓取 + 分类器）
├── package.json               # 依赖配置
├── data/
│   ├── sources.json           # 信息源、关键词、Trending 公司配置
│   ├── persistent_cache.json  # 持久化文章缓存（自动生成）
│   ├── scraped_cache.json     # 预抓取缓存（Scrape 类型源）
│   └── translations.json      # 翻译缓存
├── public/
│   ├── index.html             # 前端单页应用（含内联 EMBEDDED_DATA）
│   └── data.json              # 静态数据降级文件（自动生成）
└── .gitignore
```

### 本地开发

```bash
# 环境要求：Node.js >= 18
git clone https://github.com/feihe7301-hash/retailpulse.git
cd retailpulse
npm install
npm start
# 访问 http://localhost:8080
```

服务启动后会立即执行一次全量 RSS 抓取（约 60-90 秒），之后每 20 分钟自动刷新。

### Railway 部署

1. 在 [Railway](https://railway.app) 创建新项目，连接 GitHub 仓库
2. Railway 自动检测 `package.json`，使用 `npm start` 启动
3. 环境变量：`PORT` 由 Railway 自动注入，无需手动配置
4. 推送到 `main` 分支自动触发重新部署

### 注意事项

- `scrape` 类型的信息源（国内站点）需要在有网络访问权限的环境下运行
- `data/persistent_cache.json` 会在每次刷新后自动更新，确保服务重启后数据不丢失
- 静态托管（如 GitHub Pages）也可使用，但只能展示 `EMBEDDED_DATA` 中的快照数据，不会自动更新

## 6. 未来规划

### 数据层

- [ ] 接入更多国内信息源（第一财经、界面新闻、晚点 LatePost）
- [ ] 添加东南亚本地零售信息源（The Ken、KrASIA、Tech in Asia）
- [ ] 支持 Scrape 类型源的可靠抓取（Firecrawl / Playwright 集成）
- [ ] 文章全文抓取与存储，不仅限于 RSS 摘要

### 智能化

- [ ] AI 摘要生成：用大模型为每篇文章生成中文摘要
- [ ] 智能分类改进：用 embedding 模型替代关键词匹配
- [ ] 每日简报自动生成：按板块汇总当日重要新闻
- [ ] 相关文章推荐：基于内容相似度关联相关报道

### 用户体验

- [ ] 完善双语界面和翻译系统
- [ ] 用户订阅与推送（邮件 / 微信 / Slack）
- [ ] 个性化关注列表：自定义追踪公司和关键词
- [ ] 文章收藏与标注功能
- [ ] 暗色模式优化

### 基础设施

- [ ] 添加监控和告警（RSS 抓取失败率、服务健康检查）
- [ ] 数据库存储替代 JSON 文件（SQLite 或 PostgreSQL）
- [ ] API 认证与速率限制
- [ ] CDN 加速静态资源
