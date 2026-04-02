const express = require('express');
const RSSParser = require('rss-parser');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
const parser = new RSSParser({ timeout: 35000 });
const slowParser = new RSSParser({ timeout: 60000 }); // For slow RSSHub sources like LatePost

// Sources that need longer timeout
const slowSources = ['晚点', 'LatePost', 'wallstreetcn'];
const PORT = process.env.PORT || 8080;

// Load source config
const sourcesConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/sources.json'), 'utf-8'));

// === TRANSLATION SYSTEM ===
const translationCachePath = path.join(__dirname, 'data/translations.json');
let translationCache = {};

function loadTranslationCache() {
  try {
    if (fs.existsSync(translationCachePath)) {
      translationCache = JSON.parse(fs.readFileSync(translationCachePath, 'utf-8'));
      console.log(`[Translation] Loaded ${Object.keys(translationCache).length} cached translations`);
    }
  } catch (err) {
    console.error(`[Translation] Cache load error: ${err.message}`);
    translationCache = {};
  }
}

function saveTranslationCache() {
  try {
    fs.writeFileSync(translationCachePath, JSON.stringify(translationCache, null, 2));
  } catch (err) {
    console.error(`[Translation] Cache save error: ${err.message}`);
  }
}

async function translateText(text) {
  if (!text || text.trim().length === 0) return text;
  // Skip if already mostly Chinese
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjk / text.length > 0.3) return text;

  // Check cache
  const cacheKey = text.substring(0, 100).trim();
  if (translationCache[cacheKey]) return translationCache[cacheKey];

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return text;
    const data = await resp.json();
    // Response format: [[["translated","original",...],...],...]
    const translated = data[0].map(seg => seg[0]).join('');
    if (translated && translated.length > 0) {
      translationCache[cacheKey] = translated;
      return translated;
    }
  } catch (err) {
    // Silent fail — return original
  }
  return text;
}

// Batch translate articles (only English titles that aren't cached yet)
async function translateArticles(articles) {
  const toTranslate = articles.filter(a => {
    const cjk = (a.title.match(/[\u4e00-\u9fff]/g) || []).length;
    const isChinese = cjk / a.title.length > 0.3;
    if (isChinese) {
      a.titleZh = a.title; // Already Chinese
      return false;
    }
    const cacheKey = a.title.substring(0, 100).trim();
    if (translationCache[cacheKey]) {
      a.titleZh = translationCache[cacheKey];
      return false;
    }
    return true;
  });

  if (toTranslate.length === 0) return;

  console.log(`[Translation] Translating ${toTranslate.length} article titles...`);

  // Translate in small batches to avoid rate limiting
  const batchSize = 5;
  for (let i = 0; i < toTranslate.length; i += batchSize) {
    const batch = toTranslate.slice(i, i + batchSize);
    await Promise.all(batch.map(async (article) => {
      article.titleZh = await translateText(article.title);
    }));
    // Small delay between batches
    if (i + batchSize < toTranslate.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  saveTranslationCache();
  console.log(`[Translation] Done. Cache size: ${Object.keys(translationCache).length}`);
}

// === TWO-STEP CONTENT CLASSIFIER ===

// Known Chinese source names (used for domestic detection)
const knownChineseSources = ['联商网', 'Linkshop', '亿邦动力', '机器之心', '量子位',
  'Qbitai', 'InfoQ 中文站', '钛媒体', '新华社', '商务部', 'CCFA', '艾媒', '财联社', '晚点', 'LatePost',
  '虎嗅', '华尔街见闻', '经济日报', '第一财经', '澎湃新闻', '新京报', '联合早报', '北京商报',
  '36氪 零售', '虎嗅 零售'];

// General-purpose sources whose articles should only be included if they match keywords
// These are broad media outlets that cover many topics beyond retail/AI
const generalSources = ['36氪', 'PYMNTS Retail', 'Hacker News', 'Techmeme', '第一财经',
  '新华社财经', '商务部', 'Ars Technica', 'MIT Technology Review', 'TechCrunch',
  'VentureBeat', 'Import AI', 'The Verge'];

// Step 1: Detect whether article is domestic (Chinese) or international
function detectLocale(article) {
  const title = article.title || '';
  const source = article.source || '';

  const nonPunct = title.replace(/[\s\p{P}\p{S}\d]/gu, '');
  const cjkChars = (nonPunct.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const totalChars = nonPunct.length;
  const cjkRatio = totalChars > 0 ? cjkChars / totalChars : 0;

  const sourceHasCJK = /[\u4e00-\u9fff]/.test(source);
  const sourceIsKnownChinese = knownChineseSources.some(s => source.includes(s));

  if (cjkRatio > 0.5) return 'domestic';
  if (cjkRatio < 0.2 && totalChars > 0) return 'intl';
  if (sourceHasCJK || sourceIsKnownChinese) return 'domestic';
  return 'intl';
}

// Step 2: Keywords for retail vs AI detection
// NOTE: Only include keywords with STRONG retail specificity.
// Generic terms like '品牌','消费','brand' are too broad and cause false positives.
const retailKeywords = [
  // Chinese retail — user-specified core keywords
  '即时零售', '前置仓', '小象超市', '盒马', '山姆', '胖东来', '社区团购',
  '生鲜电商', '仓储会员店', '折扣超市', '零售3.0',
  '产地直采', '高原农产品', '冷链物流', '源头溯源', '农业品牌化',
  '地标产品', '云南农产品', '品质分级', '产销对接',
  '促消费政策', '流通体系', '商务部零售', '消费复苏', '县域商业', '下沉市场', '绿色流通',
  // Chinese retail — additional high-specificity
  '零售', '超市', '门店', '电商', '购物', '供应链', '物流', '快消',
  '百货', '商超', '批发', '渠道', '便利店', '促消费',
  '以旧换新', '消费市场', '消费场景', '网上零售', '连锁经营',
  '消博会', '内需', '消费品', '折扣店', '会员店', '线下门店',
  '拼多多', '淘宝', '京东', '美团', '饿了么', '抖音电商',
  '社会消费品零售总额', '消费数据', '零售总额',
  // China outbound / cross-border
  '跨境电商', '出海', '全托管', '半托管', '独立站', 'DTC出海', '海外仓', '小包直邮',
  '跨境物流', '海外本地化', '品牌出海', '供应链出海', '外贸新业态',
  // China outbound brands
  'Temu', 'SHEIN', 'AliExpress', '全球速卖通', '1688海外', 'Miravia',
  '泡泡玛特', '名创优品', 'MINISO', 'Anker', 'PatPat', 'Cider',
  // Tea brands going global
  '茶饮出海', '蜜雪冰城', '喜茶', '霸王茶姬',
  // Southeast Asia retail
  'Shopee', 'Lazada', 'TikTok Shop', 'Grab', 'GoTo', 'Tokopedia', 'Sea Group',
  'social commerce', 'live commerce',
  // Europe retail
  'H&M', 'Zara', 'Inditex', 'Primark', 'Action', 'Pepco',
  // Japan/Korea retail
  'Uniqlo', 'MUJI', 'Daiso', 'Coupang',
  // Emerging market ecommerce (LATAM/MENA/Africa)
  'Mercado Libre', 'Noon', 'Jumia', 'Flipkart',
  'LATAM ecommerce', 'MENA retail',
  // English retail (high specificity)
  'grocery', 'retail', 'supermarket', 'ecommerce', 'e-commerce',
  'consumer spending', 'DTC', 'direct-to-consumer', 'omnichannel', 'CPG', 'FMCG',
  'checkout', 'merchandise', 'supply chain', 'fulfillment', 'last-mile',
  'Walmart', 'Amazon Fresh', 'Instacart', 'Kroger', 'Costco', 'Target', 'Whole Foods',
  'dark store', 'quick commerce', 'retail media', 'private label',
  'ALDI', 'Lidl', 'Tesco', 'Carrefour',
  'shopper', 'marketplace', 'seller', 'merchant'
];

const aiKeywords = [
  // Chinese AI — domestic
  '人工智能', '大模型', '机器学习', '深度学习', '神经网络',
  '百度文心', '通义千问', '讯飞星火', '智谱', '月之暗面', 'Kimi', 'DeepSeek',
  // International AI — companies & products
  'OpenAI', 'ChatGPT', 'Anthropic', 'Claude', 'Gemini', 'Google DeepMind',
  'Meta AI', 'Llama', 'Mistral', 'xAI', 'Grok', 'Copilot', 'Apple Intelligence',
  'Perplexity', 'Midjourney', 'Stability AI', 'Cohere', 'Inflection',
  // Technology & research frontier
  'GPT', 'LLM', 'transformer', 'foundation model', 'SOTA', 'benchmark',
  'RAG', 'multimodal', 'diffusion', 'fine-tuning', 'RLHF', 'generative AI',
  'AI agent', 'inference', 'training data', 'reasoning model', 'chain-of-thought',
  'scaling law', 'open source model', 'AI model', 'AI startup',
  'artificial intelligence', 'machine learning', 'deep learning', 'neural network',
  'computer vision', 'NLP', 'natural language', 'reinforcement learning',
  'chatbot', 'prompt', 'AGI',
  // AI infrastructure & chips
  'NVIDIA', 'GPU', 'AI chip', '算力', '数据中心', 'TPU', 'AI accelerator',
  'CUDA', 'H100', 'B200', 'Groq', 'Cerebras', 'AMD MI300', 'Intel Gaudi',
  'AI infrastructure',
  // AI safety & governance
  'AI safety', 'AI regulation', 'AI法案', 'alignment', 'AI ethics',
  'EU AI Act', 'responsible AI', 'AI governance', 'AI policy', 'AI bias',
  // AI + robotics / embodied intelligence
  'humanoid robot', '具身智能', 'embodied AI', 'autonomous driving', 'robotics',
  'Figure AI', 'Boston Dynamics', 'Tesla Optimus', '1X Technologies',
  '人形机器人', '自动驾驶',
  // AI coding & dev tools
  'GitHub Copilot', 'Cursor', 'Devin', 'AI coding', 'code generation',
  'Replit', 'Windsurf', 'AI IDE', 'vibe coding'
];

// === Step 2.5: International locale indicators ===
// Articles matching these keywords → force 'intl' locale regardless of language
const intlRetailIndicators = [
  // Outbound / cross-border (forces intl even for Chinese-language articles)
  '跨境电商', '出海', '全托管', '半托管', '独立站', 'DTC出海', '海外仓', '小包直邮',
  '跨境物流', '海外本地化', '品牌出海', '供应链出海', '外贸新业态',
  'Temu', 'SHEIN', 'AliExpress', '全球速卖通', '1688海外', 'Miravia',
  '泡泡玛特', '名创优品', 'MINISO', 'Anker', 'PatPat', 'Cider',
  '茶饮出海',
  // Southeast Asia
  'Shopee', 'Lazada', 'TikTok Shop', 'Grab', 'GoTo', 'Tokopedia', 'Sea Group',
  '东南亚', '东南亚电商',
  // Europe / Japan / Korea / Emerging
  'H&M', 'Zara', 'Inditex', 'Primark', 'Uniqlo', 'MUJI', 'Coupang',
  'Mercado Libre', 'Flipkart', 'Jumia',
  'Walmart', 'Amazon Fresh', 'Instacart', 'Kroger', 'Costco', 'Target',
  'ALDI', 'Lidl', 'Tesco', 'Carrefour',
];

const intlAIIndicators = [
  // International AI companies (forces intl even for Chinese-language articles)
  'OpenAI', 'ChatGPT', 'Anthropic', 'Claude', 'Gemini', 'Google DeepMind',
  'Meta AI', 'Llama', 'Mistral', 'xAI', 'Grok', 'Apple Intelligence',
  'Perplexity', 'Midjourney', 'Stability AI', 'Cohere', 'Inflection',
  'NVIDIA', 'GitHub Copilot', 'Cursor', 'Devin',
  'Figure AI', 'Boston Dynamics', 'Tesla Optimus', '1X Technologies',
  'Groq', 'Cerebras', 'EU AI Act',
];

// Domestic-only indicators: keep article in domestic even if intl keywords also match
const domesticRetailIndicators = [
  '即时零售', '前置仓', '小象超市', '盒马', '山姆', '胖东来', '社区团购',
  '生鲜电商', '仓储会员店', '折扣超市', '县域商业', '下沉市场',
  '消博会', '以旧换新', '社会消费品零售总额',
];
const domesticAIIndicators = [
  '百度文心', '通义千问', '讯飞星火', '智谱', '月之暗面', 'Kimi', 'DeepSeek',
];

// Brands that are both domestic and international — only force intl when combined with outbound context
const dualMarketBrands = ['蜜雪冰城', '霸王茶姬', '喜茶', '泡泡玛特', '名创优品'];
const outboundContextWords = ['出海', '海外', '美国', '欧洲', '东南亚', '日本', '韩国',
  '全球', '国际', '海外门店', '首店', '洛杉矶', '纽约', '好莱坞', '印尼', '越南',
  '马来西亚', '泰国', '英国', '法国', '德国'];

function detectLocaleOverride(article, topic) {
  const text = (article.title + ' ' + (article.snippet || '')).toLowerCase();
  const rawText = article.title + ' ' + (article.snippet || '');

  if (topic === 'retail') {
    // Check domestic-only first — if strongly domestic, no override
    const domesticHits = domesticRetailIndicators.filter(kw => text.includes(kw.toLowerCase())).length;
    let intlHits = intlRetailIndicators.filter(kw =>
      text.includes(kw.toLowerCase()) || rawText.includes(kw)
    ).length;

    // Context-aware: dual-market brands + outbound context → count as intl hit
    const hasDualBrand = dualMarketBrands.some(b => text.includes(b.toLowerCase()) || rawText.includes(b));
    const hasOutboundContext = outboundContextWords.some(w => text.includes(w.toLowerCase()));
    if (hasDualBrand && hasOutboundContext) intlHits += 2;

    if (intlHits > 0 && domesticHits === 0) return 'intl';
    // Mixed: if intl indicators dominate, force intl
    if (intlHits > domesticHits && intlHits >= 2) return 'intl';
  }

  if (topic === 'ai') {
    const domesticHits = domesticAIIndicators.filter(kw => text.includes(kw.toLowerCase())).length;
    const intlHits = intlAIIndicators.filter(kw =>
      text.includes(kw.toLowerCase()) || rawText.includes(kw)
    ).length;
    if (intlHits > 0 && domesticHits === 0) return 'intl';
    if (intlHits > domesticHits && intlHits >= 2) return 'intl';
  }

  return null; // no override
}

// Standalone 'AI' matching (avoid matching 'ALDI', 'MAIL', 'DETAIL', etc.)
const aiStandaloneRegex = /\bAI\b/;

// False-positive exclusions: terms that contain retail keywords as substrings
// but are NOT retail-related (e.g., 京东方 contains 京东, 淘宝贝 contains 淘宝)
const retailFalsePositives = ['京东方', '京东方科技'];

// Strong AI signals: if title contains these, heavily boost AI score
// These indicate the article is fundamentally about AI, not retail
const strongAISignals = [
  '大模型', '机器人', '算力', '芯片', 'GPU', 'LLM', 'GPT',
  '自动驾驶', '人形机器人', '具身智能', 'AI新浪潮', 'AI时代',
  'AI助手', 'AI Agent', 'AI大模型', 'AI芯片', 'AI算力',
  '壁仞', '寒武纪', '地平线', '昇腾', '摩尔线程',
];

function detectTopic(article) {
  const text = (article.title + ' ' + (article.snippet || '')).toLowerCase();
  const rawText = article.title + ' ' + (article.snippet || '');

  let retailScore = 0;
  for (const kw of retailKeywords) {
    if (text.includes(kw.toLowerCase())) retailScore++;
  }
  // Deduct score if false-positive terms are present
  for (const fp of retailFalsePositives) {
    if (rawText.includes(fp)) retailScore = Math.max(0, retailScore - 2);
  }

  let aiScore = 0;
  for (const kw of aiKeywords) {
    if (text.includes(kw.toLowerCase())) aiScore++;
  }
  // Check standalone "AI" separately to avoid false positives
  if (aiStandaloneRegex.test(rawText)) aiScore += 2;
  // Boost AI score for strong AI signals in the title
  for (const sig of strongAISignals) {
    if (rawText.includes(sig)) aiScore += 3;
  }

  if (retailScore > 0 && aiScore === 0) return { topic: 'retail', score: retailScore, retailScore, aiScore };
  if (aiScore > 0 && retailScore === 0) return { topic: 'ai', score: aiScore, retailScore, aiScore };
  if (retailScore > 0 && aiScore > 0) {
    const winner = retailScore >= aiScore ? 'retail' : 'ai';
    return { topic: winner, score: Math.max(retailScore, aiScore), retailScore, aiScore };
  }

  // Neither matched
  return { topic: null, score: 0, retailScore: 0, aiScore: 0 };
}

// === NOISE FILTER ===
// Filter out digest/summary roundups, stock market flash news, ads, recruitment
const noiseTitlePatterns = [
  // Digest / roundup / summary articles (总结类快讯)
  /新闻精选/, /要闻精选/, /每日精选/, /今日要闻/, /一周要闻/,
  /午间.*精选/, /早间.*精选/, /晚间.*精选/, /盘前必读/, /盘后必读/,
  /今日看点/, /本周看点/, /一文读懂/, /一图看懂/,
  /财经早餐/, /财经日历/, /财经早报/,
  /氪星晚报/, /氪星早报/, /电商早报/, /电商晚报/,
  /[早午晚]报[｜|：:]/, /午间快讯/, /快讯精选/, /日报精选/, /一周回顾/,
  // Stock market flash news (股市快讯)
  /[涨跌]停板?[汇总复盘]/, /龙虎榜/, /板块异动/, /个股异动/,
  /涨幅[居榜]/, /跌幅[居榜]/, /资金流[向入出]/,
  /A股[收开]盘/, /港股[收开]盘/, /美股[收开]盘/,
  /三大指数/, /两市[成交缩量放量]/, /大盘[收涨跌震]/, /股指[收涨跌]/,
  /主力资金/, /北向资金/, /融资融券/,
  /[早午晚]盘[播报综述点评]/, /盘面[综述分析]/,
  /涨停[股数家]/, /跌停[股数家]/,
  // Market data roundups
  /收盘[播报综述]/, /开盘[播报综述]/,
  /市场[日周]报/, /交易[日周]报/,
  // Stock price movement flash news
  /中概股.*盘前/, /中概股.*盘后/, /热门中概股/,
  /集体[走强走弱暴涨暴跌]/, /[股指期货].*[早午晚]盘/,
  // Ads, recruitment, promotions (广告、招聘、推广)
  /招人[!！]/, /招聘/, /校招/, /社招/, /应届/, /岗位/,
  /人才留言板/, /挑战赛.*报名/, /报名通道/, /开启报名/,
  /点击报名/, /峰会报名/, /早鸟票/, /限时优惠/, /免费领/,
  /推广活动/, /赞助/,
];

function isNoiseArticle(article) {
  const title = article.title || '';
  for (const pattern of noiseTitlePatterns) {
    if (pattern.test(title)) return true;
  }
  return false;
}

function classifyArticle(article) {
  // Global noise filter: remove digest roundups and stock market flash news
  if (isNoiseArticle(article)) return null;

  // Normalize legacy source names from cached data
  if (article.source === '36氪 AI') article.source = '36氪';

  // Blocked sources: removed from project but may linger in persistent cache
  const blockedSources = ['IT之家'];
  if (blockedSources.some(s => article.source.includes(s))) return null;

  let locale = detectLocale(article);
  const { topic, score, retailScore, aiScore } = detectTopic(article);
  const text = (article.title + ' ' + (article.snippet || '')).toLowerCase();
  const rawText = article.title + ' ' + (article.snippet || '');
  const isInfoQ = article.source.includes('InfoQ');

  // === InfoQ special rules ===
  if (isInfoQ) {
    // Rule 1: Filter noise — experience sharing, recruitment, conference promos, pure dev ops
    const noisePatterns = [
      '招聘', '招人', '校招', '社招', '应届', '岗位',
      '工程文化', '团队管理', '技术管理', '技术领导力',
      '面试', '简历', '薪资', '职场',
      'QCon', 'ArchSummit', 'GMTC', 'InfoQ大会', '大会', '峰会报名', '早鸟',
      '点击查看原文', '点击报名',
      'Spring Boot', 'Spring Security', 'Spring Integration', '.NET', 'Kubernetes',
      'Docker', 'PostgreSQL', 'MySQL', 'Redis', 'Kafka', 'gRPC', 'GraphQL',
      'OpenTelemetry', 'AMQP', 'DevOps', 'CI/CD', 'Terraform',
      '微服务', '容器化', '云原生', '可观测', '中间件',
    ];
    const isNoise = noisePatterns.some(p => text.includes(p.toLowerCase()));
    if (isNoise && topic !== 'ai') return null; // Pure noise without AI topic → filter
    if (isNoise && score < 3) return null;       // Noise with weak AI signal → filter

    // Rule 2: Must mention domestic AI indicators to enter domestic_ai, otherwise intl_ai
    const domesticAIRequired = [
      '百度', '文心', '通义', '千问', '阿里', '讯飞', '星火', '智谱', '月之暗面',
      'Kimi', 'DeepSeek', '字节', '豆包', '华为', '昇腾', '腾讯', '混元',
      '商汤', '旷视', '科大讯飞', '百川', '零一万物', 'Yi-', '阶跃星辰',
      '中国', '国内', '国产',
    ];
    const hasChineseAI = domesticAIRequired.some(k =>
      text.includes(k.toLowerCase()) || rawText.includes(k)
    );

    // Rule 3: Require score >= 3 for InfoQ to enter AI sections
    if (topic === 'ai' && score < 3) return null;

    // If topic is AI but no Chinese AI indicators → force intl locale
    if (topic === 'ai' && !hasChineseAI) {
      locale = 'intl';
    }
  }

  // === Source-locked topic constraints ===
  // Retail-dedicated sources: always classify as retail, never AI
  const retailLockedSources = ['Retail Dive', 'Modern Retail', 'Grocery Dive',
    'Supermarket News', 'Supply Chain Dive', 'Retail Gazette',
    'PYMNTS Retail', '联商网', 'Linkshop', '亿邦动力', 'CCFA', '艾媒',
    '36氪 零售', '虎嗅 零售'];
  // AI-dedicated sources: always classify as AI, never retail
  const aiLockedSources = ['机器之心', '量子位', 'Qbitai', 'Anthropic', 'The Decoder',
    'Import AI', 'Ars Technica', 'SCMP', 'OpenAI', 'DeepMind', 'Hugging Face'];

  // Sources that should respect their configured section's locale
  // (e.g., SCMP Tech is in domestic_ai — English but covers China)
  const domesticLockedSources = ['SCMP'];

  const isRetailLocked = retailLockedSources.some(s => article.source.includes(s));
  const isAILocked = aiLockedSources.some(s => article.source.includes(s));

  // Strict sources: require score >= 2 to avoid loose matches on single generic keyword
  const strictSources = ['36氪', 'PYMNTS Retail', 'Hacker News', 'Techmeme', '第一财经',
    '新华社财经', '商务部', 'Ars Technica', 'MIT Technology Review', 'TechCrunch',
    'VentureBeat', 'Import AI', 'The Verge', '钛媒体', 'NYT Tech', 'SCMP', 'Bloomberg',
    '经济日报', '澎湃新闻', '新京报', '联合早报', '华尔街见闻', '财联社'];
  // Semi-strict sources: require score >= 1 (dedicated topic feeds, less filtering needed)
  const semiStrictSources = ['Wired AI', '晚点', 'LatePost', '北京商报'];

  const isStrict = strictSources.some(gs => article.source.includes(gs));
  const isSemiStrict = semiStrictSources.some(gs => article.source.includes(gs));

  // If no topic detected at all
  if (!topic) {
    // Dedicated sources don't need keyword match — accept all their articles
    if (isRetailLocked) return `${locale}_retail`;
    if (isAILocked) return `${locale}_ai`;

    if (isStrict || isSemiStrict) return null; // General/strict sources always need keyword match

    const dedicatedRetailSources = ['联商网', 'Linkshop', '亿邦动力', 'Retail Dive', 'Modern Retail',
      'Grocery Dive', 'Supermarket News', 'Supply Chain Dive', 'Retail Gazette', 'CCFA', '艾媒',
      '36氪 零售', '虎嗅 零售'];
    const dedicatedAISources = ['机器之心', '量子位', 'Qbitai', 'Anthropic', 'The Decoder',
      'SCMP'];
    const isDedicatedRetail = dedicatedRetailSources.some(s => article.source.includes(s));
    const isDedicatedAI = dedicatedAISources.some(s => article.source.includes(s));

    if (isDedicatedRetail) return `${locale}_retail`;
    if (isDedicatedAI) return `${locale}_ai`;
    return null; // No match, filter out
  }

  // For strict sources, require score >= 2 to avoid single-keyword false positives
  // Skip for source-locked sources (dedicated feeds don't need keyword thresholds)
  if (isStrict && !isRetailLocked && !isAILocked && score < 2) return null;
  // Semi-strict: require score >= 1 (dedicated topic feeds, most articles relevant)
  if (isSemiStrict && !isRetailLocked && !isAILocked && score < 1) return null;

  // Force topic for source-locked sources, but allow override when signals are very strong
  let finalTopic = topic;
  if (isRetailLocked && topic === 'ai') {
    // Only force retail if the article has some retail relevance
    // Pure AI articles (retailScore === 0, strong AI signals) should go to AI section
    if (retailScore > 0 || aiScore < 3) {
      finalTopic = 'retail';
    }
  }
  if (isAILocked && topic === 'retail') finalTopic = 'ai';

  // Apply international locale override based on topic keywords
  // This ensures Chinese-language articles about international topics go to intl sections
  const localeOverride = detectLocaleOverride(article, finalTopic);
  if (localeOverride) locale = localeOverride;

  // Domestic-locked sources: respect their configured section's locale
  const isDomesticLocked = domesticLockedSources.some(s => article.source.includes(s));
  if (isDomesticLocked && article.originalSection && article.originalSection.startsWith('domestic')) {
    locale = 'domestic';
  }

  return `${locale}_${finalTopic}`;
}

// In-memory article cache
let articlesCache = {
  domestic_retail: [],
  intl_retail: [],
  domestic_ai: [],
  intl_ai: [],
  lastUpdated: null,
  trending: []
};

// --- RSS Fetching with retry + RSSHub fallback ---
async function fetchRSS(source, retries = 1) {
  const rssUrls = [source.rss, source.rsshub].filter(Boolean);

  for (const rssUrl of rssUrls) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const isSlow = slowSources.some(s => source.name.includes(s));
        const feed = await (isSlow ? slowParser : parser).parseURL(rssUrl);
      return (feed.items || []).slice(0, 20).map(item => {
        let title = item.title || '';
        let link = item.link || '';
        let articleSource = source.name;
        let articleSourceUrl = source.url;

        // Special handling for Google News RSS: strip " - Source" suffix and clean title
        if (source.rss && source.rss.includes('news.google.com/rss')) {
          title = title.replace(/\s*-\s*[^-]+$/, '').trim();
          title = title.replace(/^打印_/, '').trim();
        }

        // Special handling for Techmeme: extract original source & URL
        if (source.name === 'Techmeme' || source.name.includes('Techmeme')) {
          // Title format: "Headline (Author/Source)"
          const sourceMatch = title.match(/\(([^)]+)\)\s*$/);
          if (sourceMatch) {
            const parts = sourceMatch[1].split('/');
            articleSource = parts.length > 1 ? parts[parts.length - 1].trim() : parts[0].trim();
            title = title.replace(/\s*\([^)]+\)\s*$/, '').trim();
          }
          // Extract original article URL from HTML content
          const content = item.content || '';
          const urlMatch = content.match(/<A\s+HREF="(https?:\/\/(?!www\.techmeme\.com)[^"]+)"/i);
          if (urlMatch) {
            link = urlMatch[1];
            articleSourceUrl = link;
          }
        }

        // Clamp future dates to now (some feeds report feed-generation time, not article time)
        let pubDate = item.pubDate || item.isoDate || new Date().toISOString();
        const parsedDate = new Date(pubDate);
        if (isNaN(parsedDate.getTime()) || parsedDate.getTime() > Date.now() + 60000) {
          pubDate = new Date().toISOString();
        }

        return {
          title,
          link,
          pubDate,
          source: articleSource,
          sourceUrl: articleSourceUrl,
          priority: source.priority,
          tags: source.tags || [],
          snippet: (item.contentSnippet || item.content || '').substring(0, 200).replace(/<[^>]+>/g, ''),
          section: null
        };
      });
    } catch (err) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      console.error(`[RSS] Failed to fetch ${source.name} from ${rssUrl}: ${err.message}`);
      break; // try next rssUrl
    }
    }
  }
  return [];
}

// --- Firecrawl Scraping Fallback ---
async function fetchScrape(source) {
  try {
    const firecrawlKey = process.env.FIRECRAWL_API_KEY;
    if (!firecrawlKey) {
      return [];
    }
    const resp = await fetch(`https://api.firecrawl.dev/v1/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${firecrawlKey}` },
      body: JSON.stringify({ url: source.url, formats: ['markdown'], onlyMainContent: true })
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const lines = (data.data?.markdown || '').split('\n').filter(l => l.trim());
    const articles = [];
    for (const line of lines) {
      const linkMatch = line.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
      if (linkMatch) {
        articles.push({
          title: linkMatch[1], link: linkMatch[2],
          pubDate: new Date().toISOString(),
          source: source.name, sourceUrl: source.url,
          priority: source.priority, tags: source.tags || [],
          snippet: '', section: null
        });
      }
    }
    return articles.slice(0, 10);
  } catch (err) {
    console.error(`[Scrape] Error for ${source.name}: ${err.message}`);
    return [];
  }
}

// --- Load scraped cache (pre-fetched via Firecrawl MCP) ---
function loadScrapedCache() {
  try {
    const cachePath = path.join(__dirname, 'data/scraped_cache.json');
    if (fs.existsSync(cachePath)) {
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      console.log(`[Cache] Loaded ${cache.articles.length} pre-scraped articles`);
      return cache.articles || [];
    }
  } catch (err) {
    console.error(`[Cache] Error loading scraped cache: ${err.message}`);
  }
  return [];
}

// --- Fetch all sources (flat, then classify) ---
async function fetchAllSources() {
  const allSections = ['domestic_retail', 'intl_retail', 'domestic_ai', 'intl_ai'];
  const fetchPromises = [];

  for (const sectionKey of allSections) {
    const section = sourcesConfig[sectionKey];
    if (!section || !section.sources) continue;
    for (const src of section.sources) {
      const hasRssUrl = src.rss || src.rsshub;
      const promise = (src.type === 'rss' && hasRssUrl ? fetchRSS(src) : fetchScrape(src))
        .then(articles => articles.map(a => ({ ...a, originalSection: sectionKey })));
      fetchPromises.push(promise);
    }
  }

  const results = await Promise.allSettled(fetchPromises);
  const allArticles = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  // Merge in scraped cache articles (for sources that couldn't be fetched via RSS/HTTP)
  const cachedArticles = loadScrapedCache();
  // Map cached articles to determine their originalSection based on source name
  const sourceToSection = {};
  for (const sectionKey of allSections) {
    const section = sourcesConfig[sectionKey];
    if (!section || !section.sources) continue;
    for (const src of section.sources) {
      sourceToSection[src.name] = sectionKey;
    }
  }
  for (const ca of cachedArticles) {
    ca.originalSection = sourceToSection[ca.source] || 'intl_ai';
    allArticles.push(ca);
  }

  // Classify each article into the correct section
  for (const article of allArticles) {
    // Normalize legacy source names
    if (article.source === '36氪 AI') article.source = '36氪';
    article.section = classifyArticle({ ...article, section: article.originalSection });
  }

  // Filter out articles with no valid classification
  const classified = allArticles.filter(a => a.section !== null);

  // Sort by priority (high first), then date (newest first)
  // This ensures original/high-priority sources win deduplication over aggregators
  classified.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return new Date(b.pubDate) - new Date(a.pubDate);
  });

  // Exact title deduplication
  const seen = new Set();
  const exactDeduped = classified.filter(a => {
    const key = a.title.toLowerCase().substring(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Aggregator source suppression: remove aggregator articles when a primary source
  // already covers the same topic (fuzzy keyword overlap)
  const aggregatorSources = ['InfoQ', 'InfoQ 中文站'];
  const isAggregator = (source) => aggregatorSources.some(s => source.includes(s));

  function extractKeyTokens(title) {
    // Extract meaningful tokens (Chinese phrases 2+ chars, English words 3+ chars)
    const cn = (title.match(/[\u4e00-\u9fff]{2,}/g) || []);
    const en = (title.toLowerCase().match(/[a-z]{3,}/g) || [])
      .filter(w => !['the','and','for','with','from','that','this','how','are','was','has','its','not','but','will','can','new'].includes(w));
    return [...cn, ...en];
  }

  function hasSimilarCoverage(aggregatorArticle, primaryArticles) {
    const aggTokens = extractKeyTokens(aggregatorArticle.title + ' ' + (aggregatorArticle.snippet || ''));
    if (aggTokens.length === 0) return false;

    for (const primary of primaryArticles) {
      if (isAggregator(primary.source)) continue;
      if (primary.section !== aggregatorArticle.section) continue;

      const priTokens = extractKeyTokens(primary.title + ' ' + (primary.snippet || ''));
      // Count overlapping tokens
      const overlap = aggTokens.filter(t => priTokens.some(p => p.includes(t) || t.includes(p))).length;
      const ratio = overlap / aggTokens.length;
      // If 40%+ token overlap, consider it duplicate coverage
      if (ratio >= 0.4 && overlap >= 2) return true;
    }
    return false;
  }

  const primaryArticles = exactDeduped.filter(a => !isAggregator(a.source));
  const deduped = exactDeduped.filter(a => {
    if (!isAggregator(a.source)) return true;
    return !hasSimilarCoverage(a, primaryArticles);
  });

  return deduped;
}

// --- Compute trending topics ---
function computeTrending(allArticles) {
  // Collect all keywords: companies + product aliases
  const companies = sourcesConfig.trending_companies || [];
  const productMap = sourcesConfig.product_to_company || {};
  const allKeywords = [...companies, ...Object.keys(productMap)];

  // Count mentions per keyword
  const rawCounts = {};
  for (const kw of allKeywords) {
    const kwLower = kw.toLowerCase();
    let count = 0;
    for (const article of allArticles) {
      const text = (article.title + ' ' + article.snippet).toLowerCase();
      if (text.includes(kwLower)) count++;
    }
    if (count > 0) rawCounts[kw] = count;
  }

  // Consolidate product counts into parent company
  const consolidated = {};
  for (const [kw, count] of Object.entries(rawCounts)) {
    const parent = productMap[kw] || kw;
    consolidated[parent] = (consolidated[parent] || 0) + count;
  }

  // Only return companies from the trending_companies list
  const companySet = new Set(companies);
  return Object.entries(consolidated)
    .filter(([k]) => companySet.has(k))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([keyword, count]) => ({ keyword, count }));
}

// --- Persistent article cache (survives restarts) ---
const persistCachePath = path.join(__dirname, 'data/persistent_cache.json');

function loadPersistentCache() {
  try {
    if (fs.existsSync(persistCachePath)) {
      const data = JSON.parse(fs.readFileSync(persistCachePath, 'utf-8'));
      console.log(`[PersistCache] Loaded ${data.articles?.length || 0} persisted articles`);
      return data.articles || [];
    }
  } catch (err) {
    console.error(`[PersistCache] Error: ${err.message}`);
  }
  return [];
}

function savePersistentCache(articles) {
  try {
    // Only save articles from RSS feeds (not from scraped_cache to avoid duplication)
    const rssArticles = articles.filter(a => !a._fromScrapedCache);
    fs.writeFileSync(persistCachePath, JSON.stringify({
      articles: rssArticles,
      savedAt: new Date().toISOString()
    }, null, 2));
  } catch (err) {
    console.error(`[PersistCache] Save error: ${err.message}`);
  }
}

// --- Main refresh ---
async function refreshAll() {
  console.log(`[${new Date().toISOString()}] Refreshing all feeds...`);

  const allArticles = await fetchAllSources();

  // Merge with persistent cache from previous successful fetches
  const persistedArticles = loadPersistentCache();
  const persistedMap = new Map();
  for (const pa of persistedArticles) {
    persistedMap.set(pa.title.toLowerCase().substring(0, 50), pa);
  }

  // Preserve earliest known pubDate for re-fetched articles
  for (const article of allArticles) {
    const key = article.title.toLowerCase().substring(0, 50);
    const persisted = persistedMap.get(key);
    if (persisted && persisted.pubDate) {
      const pDate = new Date(persisted.pubDate);
      const aDate = new Date(article.pubDate);
      if (!isNaN(pDate.getTime()) && pDate < aDate) {
        article.pubDate = persisted.pubDate;
      }
    }
  }

  const existingKeys = new Set(allArticles.map(a => a.title.toLowerCase().substring(0, 50)));
  let mergedFromPersist = 0;
  for (const pa of persistedArticles) {
    const key = pa.title.toLowerCase().substring(0, 50);
    if (!existingKeys.has(key)) {
      // Normalize legacy source names
      if (pa.source === '36氪 AI') pa.source = '36氪';
      // Re-classify persisted articles
      pa.section = classifyArticle({ ...pa, originalSection: pa.originalSection || pa.section });
      if (pa.section) {
        allArticles.push(pa);
        existingKeys.add(key);
        mergedFromPersist++;
      }
    }
  }
  if (mergedFromPersist > 0) {
    console.log(`[PersistCache] Merged ${mergedFromPersist} articles from previous fetches`);
  }

  // Re-sort and deduplicate after merge
  allArticles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  const seen = new Set();
  const deduped = allArticles.filter(a => {
    const key = a.title.toLowerCase().substring(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Translate English article titles to Chinese
  await translateArticles(deduped);

  // Bucket into sections
  const sections = ['domestic_retail', 'intl_retail', 'domestic_ai', 'intl_ai'];
  for (const s of sections) {
    const sectionArticles = deduped.filter(a => a.section === s);
    if (sectionArticles.length > 0) {
      articlesCache[s] = sectionArticles;
    }
  }

  articlesCache.trending = computeTrending(deduped);
  articlesCache.lastUpdated = new Date().toISOString();

  // Save current articles to persistent cache for next restart
  savePersistentCache(deduped);

  const totalCount = sections.reduce((sum, s) => sum + articlesCache[s].length, 0);
  const breakdown = sections.map(s => `${s}:${articlesCache[s].length}`).join(', ');
  console.log(`[${new Date().toISOString()}] Refresh complete. ${totalCount} articles (${breakdown})`);
}

// --- API Routes ---
app.use(express.static(path.join(__dirname, 'docs')));

app.get('/api/articles', (req, res) => {
  const { section, search, tag } = req.query;
  let articles = [];

  if (section && articlesCache[section]) {
    articles = articlesCache[section];
  } else {
    articles = ['domestic_retail', 'intl_retail', 'domestic_ai', 'intl_ai']
      .flatMap(s => articlesCache[s]);
  }

  if (search) {
    const q = search.toLowerCase();
    articles = articles.filter(a =>
      a.title.toLowerCase().includes(q) ||
      a.snippet.toLowerCase().includes(q) ||
      a.source.toLowerCase().includes(q)
    );
  }

  if (tag) {
    const t = tag.toLowerCase();
    articles = articles.filter(a =>
      a.tags.some(at => at.toLowerCase().includes(t)) ||
      a.title.toLowerCase().includes(t) ||
      a.snippet.toLowerCase().includes(t)
    );
  }

  res.json({ articles, lastUpdated: articlesCache.lastUpdated, trending: articlesCache.trending });
});

app.get('/api/sources', (req, res) => {
  const { domestic_retail, intl_retail, domestic_ai, intl_ai, keywords } = sourcesConfig;
  res.json({ domestic_retail, intl_retail, domestic_ai, intl_ai, keywords });
});

app.get('/api/trending', (req, res) => {
  res.json({ trending: articlesCache.trending, lastUpdated: articlesCache.lastUpdated });
});

// Health check endpoint for Railway
app.get('/api/health', (req, res) => {
  const sections = ['domestic_retail', 'intl_retail', 'domestic_ai', 'intl_ai'];
  const totalArticles = sections.reduce((sum, s) => sum + articlesCache[s].length, 0);
  res.json({
    status: totalArticles > 0 ? 'healthy' : 'warming_up',
    articles: totalArticles,
    lastUpdated: articlesCache.lastUpdated,
    uptime: Math.floor(process.uptime()),
    pid: process.pid
  });
});

// --- Startup ---
// Write PID file so we can clean up old instances
const pidFile = path.join(__dirname, 'server.pid');
try {
  const oldPid = fs.readFileSync(pidFile, 'utf-8').trim();
  if (oldPid) {
    try { process.kill(parseInt(oldPid), 'SIGTERM'); } catch (e) { /* already dead */ }
    console.log(`[Startup] Killed old server process ${oldPid}`);
    const { execSync } = require('child_process');
    try { execSync('sleep 1'); } catch(e) {}
  }
} catch (e) { /* no pid file */ }
fs.writeFileSync(pidFile, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(pidFile); } catch(e) {} });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

app.listen(PORT, async () => {
  console.log(`RetailPulse server running on http://localhost:${PORT} (PID: ${process.pid})`);
  loadTranslationCache();

  // === INSTANT WARM START ===
  // Load persistent cache into articlesCache IMMEDIATELY so the API serves data
  // right away, before the slow RSS refresh (~60-90s) completes.
  try {
    const warmData = loadPersistentCache();
    if (warmData.length > 0) {
      const sections = ['domestic_retail', 'intl_retail', 'domestic_ai', 'intl_ai'];
      for (const s of sections) {
        articlesCache[s] = warmData.filter(a => a.section === s);
      }
      articlesCache.trending = computeTrending(warmData);
      articlesCache.lastUpdated = warmData[0]?.pubDate || new Date().toISOString();
      const total = sections.reduce((sum, s) => sum + articlesCache[s].length, 0);
      console.log(`[WarmStart] Serving ${total} cached articles immediately`);
    } else {
      // No persistent cache — try loading from data.json as secondary fallback
      try {
        const dataJsonPath = path.join(__dirname, 'docs/data.json');
        if (fs.existsSync(dataJsonPath)) {
          const djData = JSON.parse(fs.readFileSync(dataJsonPath, 'utf-8'));
          if (djData.articles && djData.articles.length > 0) {
            const sections = ['domestic_retail', 'intl_retail', 'domestic_ai', 'intl_ai'];
            for (const s of sections) {
              articlesCache[s] = djData.articles.filter(a => a.section === s);
            }
            articlesCache.trending = djData.trending || [];
            articlesCache.lastUpdated = djData.lastUpdated || new Date().toISOString();
            console.log(`[WarmStart] Loaded ${djData.articles.length} articles from data.json`);
          }
        }
      } catch (e) {
        console.error(`[WarmStart] data.json fallback error: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`[WarmStart] Error loading cache: ${e.message}`);
  }

  // Update data.json after each refresh for static fallback
  const updateStaticData = async () => {
    try {
      const allArticles = ['domestic_retail','intl_retail','domestic_ai','intl_ai'].flatMap(s => articlesCache[s]);
      const data = { articles: allArticles, trending: articlesCache.trending, lastUpdated: articlesCache.lastUpdated };
      fs.writeFileSync(path.join(__dirname, 'docs/data.json'), JSON.stringify(data));
    } catch(e) { console.error('[StaticData] Error writing data.json:', e.message); }
  };

  // Now do the full RSS refresh in the background (non-blocking)
  refreshAll().then(() => updateStaticData()).catch(e => {
    console.error(`[Refresh] Error: ${e.message}`);
  });

  cron.schedule('*/20 * * * *', async () => {
    await refreshAll();
    await updateStaticData();
  });

  // === KEEP-ALIVE SELF-PING ===
  // Prevent Railway from sleeping the service by pinging ourselves every 5 minutes.
  // Uses both localhost (keeps Node process active) AND public domain (keeps Railway ingress warm).
  const KEEP_ALIVE_INTERVAL = 5 * 60 * 1000; // 5 minutes
  setInterval(async () => {
    const now = new Date().toISOString();
    // Always ping localhost to keep the event loop active
    try {
      const localResp = await fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (localResp.ok) {
        const health = await localResp.json();
        console.log(`[KeepAlive] Local OK — ${health.articles} articles, updated ${health.lastUpdated}`);
      }
    } catch (e) {
      console.error(`[KeepAlive] Local ping failed: ${e.message}`);
    }
    // Also ping via public domain to keep Railway's ingress/proxy warm
    // This is critical — Railway decides "inactive" based on external traffic
    const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL;
    if (publicDomain) {
      try {
        const pubUrl = publicDomain.startsWith('http') ? publicDomain : `https://${publicDomain}`;
        const pubResp = await fetch(`${pubUrl}/api/health`, { signal: AbortSignal.timeout(10000) });
        if (pubResp.ok) {
          console.log(`[KeepAlive] Public OK at ${now}`);
        }
      } catch (e) {
        console.error(`[KeepAlive] Public ping failed: ${e.message}`);
      }
    }
  }, KEEP_ALIVE_INTERVAL);
});
