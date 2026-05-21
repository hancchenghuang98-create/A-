const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const ROOT = __dirname;
const CACHE_DIR = path.join(ROOT, "cache");
const CONFIG_PATH = path.join(ROOT, "config.local.json");
const PORT = Number(process.env.PORT || 3030);
const TUSHARE_URL = "http://api.tushare.pro";
const QUERY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const STATIC_MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};
const BLOCKED_STATIC = new Set(["server.js", "config.local.json", "config.example.json"]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function file(res, status, content, ext) {
  res.writeHead(status, {
    "Content-Type": STATIC_MIME[ext] || "text/plain; charset=utf-8"
  });
  res.end(content);
}

function parseMaybeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function round(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return Number(Number(value).toFixed(digits));
}

function toIsoDate(text) {
  if (!text || String(text).length !== 8) return text || null;
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}${m}${day}`;
}

async function readLocalConfig() {
  try {
    const raw = await fsp.readFile(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function getToken() {
  if (process.env.TUSHARE_TOKEN) return process.env.TUSHARE_TOKEN.trim();
  const local = await readLocalConfig();
  if (local.tushareToken && typeof local.tushareToken === "string") {
    return local.tushareToken.trim();
  }
  return "";
}

function normalizeTsCode(input) {
  const raw = String(input || "").trim().toUpperCase();
  if (!raw) return "";
  if (raw.endsWith(".SH") || raw.endsWith(".SZ") || raw.endsWith(".BJ")) return raw;
  if (/^(6|5|9|688)\d{5}$/.test(raw)) return `${raw}.SH`;
  if (/^(0|1|2|3)\d{5}$/.test(raw)) return `${raw}.SZ`;
  if (/^(4|8)\d{5}$/.test(raw)) return `${raw}.BJ`;
  return raw;
}

async function tushareQuery(apiName, params = {}, fields = "") {
  const token = await getToken();
  if (!token) {
    throw new HttpError(503, "未配置 Tushare Token。请在项目目录创建 config.local.json。");
  }

  const response = await fetch(TUSHARE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_name: apiName,
      token,
      params,
      fields
    })
  });

  if (!response.ok) {
    throw new HttpError(502, `Tushare 请求失败：HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload.code !== 0) {
    if (payload.code === 2002) {
      throw new HttpError(403, `${apiName} 接口无权限，请检查 Tushare 积分或单独权限。`);
    }
    throw new HttpError(502, `${apiName} 接口返回错误：${payload.msg || payload.code}`);
  }

  const fieldsList = payload.data?.fields || [];
  const items = payload.data?.items || [];
  return items.map(row => Object.fromEntries(fieldsList.map((field, index) => [field, row[index]])));
}

async function optionalTushareQuery(apiName, params = {}, fields = "") {
  try {
    const rows = await tushareQuery(apiName, params, fields);
    return { rows, warning: null };
  } catch (error) {
    if (error instanceof HttpError && (error.status === 403 || error.status === 503)) {
      return { rows: [], warning: error.message };
    }
    throw error;
  }
}

function makeCacheFile(apiName, params, fields) {
  const digest = crypto
    .createHash("sha1")
    .update(JSON.stringify({ apiName, params, fields }))
    .digest("hex");
  return path.join(CACHE_DIR, `${apiName}-${digest}.json`);
}

async function cachedTushareQuery(apiName, params = {}, fields = "", ttlMs = QUERY_CACHE_TTL_MS) {
  await ensureDir(CACHE_DIR);
  const cachePath = makeCacheFile(apiName, params, fields);

  try {
    const raw = JSON.parse(await fsp.readFile(cachePath, "utf8"));
    if (Date.now() - raw.fetchedAt < ttlMs && Array.isArray(raw.rows)) {
      return raw.rows;
    }
  } catch {}

  const rows = await tushareQuery(apiName, params, fields);
  await fsp.writeFile(cachePath, JSON.stringify({ fetchedAt: Date.now(), rows }), "utf8");
  return rows;
}

async function optionalCachedTushareQuery(apiName, params = {}, fields = "", ttlMs = QUERY_CACHE_TTL_MS) {
  try {
    const rows = await cachedTushareQuery(apiName, params, fields, ttlMs);
    return { rows, warning: null };
  } catch (error) {
    if (error instanceof HttpError && (error.status === 403 || error.status === 503)) {
      return { rows: [], warning: error.message };
    }
    throw error;
  }
}

async function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    await fsp.mkdir(dir, { recursive: true });
  }
}

async function getStockBasics() {
  await ensureDir(CACHE_DIR);
  const cachePath = path.join(CACHE_DIR, "stock_basic.json");

  try {
    const raw = JSON.parse(await fsp.readFile(cachePath, "utf8"));
    const fresh = Date.now() - raw.fetchedAt < 7 * 24 * 60 * 60 * 1000;
    if (fresh && Array.isArray(raw.items)) return raw.items;
  } catch {}

  const items = await tushareQuery(
    "stock_basic",
    { list_status: "L" },
    "ts_code,symbol,name,area,industry,market,list_date,exchange,is_hs,act_name"
  );
  await fsp.writeFile(cachePath, JSON.stringify({ fetchedAt: Date.now(), items }, null, 2), "utf8");
  return items;
}

async function searchStocks(query) {
  const basics = await getStockBasics();
  const q = String(query || "").trim().toUpperCase();
  if (!q) return [];
  return basics
    .filter(item => {
      const haystack = [
        item.ts_code,
        item.symbol,
        item.name,
        item.industry,
        item.market
      ].join(" ").toUpperCase();
      return haystack.includes(q);
    })
    .slice(0, 12);
}

function sortAscByDate(rows) {
  return [...rows].sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));
}

function movingAverage(values, window) {
  return values.map((_, index) => {
    if (index + 1 < window) return null;
    const slice = values.slice(index + 1 - window, index + 1);
    const sum = slice.reduce((acc, value) => acc + value, 0);
    return round(sum / window, 2);
  });
}

function ema(values, period) {
  const alpha = 2 / (period + 1);
  const result = [];
  let prev = values[0] || 0;
  values.forEach((value, index) => {
    if (index === 0) {
      result.push(value);
      prev = value;
      return;
    }
    const next = alpha * value + (1 - alpha) * prev;
    result.push(next);
    prev = next;
  });
  return result;
}

function calcMacd(values) {
  const ema12 = ema(values, 12);
  const ema26 = ema(values, 26);
  const difSeries = values.map((_, index) => ema12[index] - ema26[index]);
  const deaSeries = ema(difSeries, 9);
  const histSeries = difSeries.map((value, index) => (value - deaSeries[index]) * 2);
  const last = values.length - 1;
  return {
    dif: round(difSeries[last], 3),
    dea: round(deaSeries[last], 3),
    hist: round(histSeries[last], 3)
  };
}

function calcRsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return round(100 - 100 / (1 + rs), 2);
}

function adjustCandles(dailyRows, adjRows, mode) {
  const factorByDate = new Map(adjRows.map(item => [item.trade_date, parseMaybeNumber(item.adj_factor) || 1]));
  const lastFactor = factorByDate.get(dailyRows[dailyRows.length - 1]?.trade_date) || 1;

  return dailyRows.map(row => {
    const factor = factorByDate.get(row.trade_date) || 1;
    const ratio = mode === "qfq" ? factor / lastFactor : 1;
    return {
      tradeDate: row.trade_date,
      open: round((parseMaybeNumber(row.open) || 0) * ratio, 3),
      high: round((parseMaybeNumber(row.high) || 0) * ratio, 3),
      low: round((parseMaybeNumber(row.low) || 0) * ratio, 3),
      close: round((parseMaybeNumber(row.close) || 0) * ratio, 3),
      vol: parseMaybeNumber(row.vol) || 0,
      amount: parseMaybeNumber(row.amount) || 0
    };
  });
}

function safeIndustryThemes(industry = "", market = "", name = "") {
  const themes = new Set();
  const text = `${industry} ${market} ${name}`;

  if (/半导体|电子|通信|软件|计算机|云|光模块|AI|人工智能/.test(text)) themes.add("数字经济");
  if (/电池|新能源|储能|光伏|汽车/.test(text)) themes.add("先进制造");
  if (/银行|运营商|石油|煤炭|电力|公用事业/.test(text)) themes.add("高股息防守");
  if (/医药|生物|中药|医疗/.test(text)) themes.add("医药创新");
  if (/有色|黄金|铜|资源/.test(text)) themes.add("资源安全");
  if (/消费|食品|家电|白酒/.test(text)) themes.add("内需消费");
  if (/科创板/.test(market)) themes.add("硬科技");
  if (/创业板/.test(market)) themes.add("成长弹性");
  if (themes.size === 0) themes.add("常规行业观察");

  return [...themes];
}

function mapBoardRule(market) {
  if (market === "创业板" || market === "科创板") return "20%涨跌幅";
  return "主板常规涨跌幅";
}

function scoreFundamentalBlock(data) {
  const { pe, pb, roe, grossMargin, debtToAssets, yoySales, yoyDeduNp, ocfps, dvRatio } = data.fundamental;
  let score = 50;
  if (roe !== null) score += Math.min(roe, 25) * 1.1;
  if (grossMargin !== null) score += Math.min(grossMargin, 50) * 0.25;
  if (yoySales !== null) score += Math.max(Math.min(yoySales, 30), -20) * 0.4;
  if (yoyDeduNp !== null) score += Math.max(Math.min(yoyDeduNp, 35), -25) * 0.45;
  if (ocfps !== null) score += Math.max(Math.min(ocfps, 6), -2) * 3;
  if (debtToAssets !== null) score -= Math.max(debtToAssets - 45, 0) * 0.35;
  if (pe !== null) score += pe < 25 ? 6 : pe < 45 ? 2 : -6;
  if (pb !== null) score += pb < 4 ? 4 : pb < 8 ? 0 : -4;
  if (dvRatio !== null) score += Math.min(dvRatio, 6) * 1.2;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreTechnicalBlock(data) {
  const { close } = data.quote;
  const { ma5, ma10, ma20, ma60, rsi14, macd } = data.technical;
  let score = 45;
  if (close > ma20) score += 10;
  if (close > ma60) score += 10;
  if (ma5 > ma10 && ma10 > ma20) score += 14;
  if (ma20 > ma60) score += 8;
  if (rsi14 !== null) score += rsi14 >= 45 && rsi14 <= 70 ? 8 : rsi14 > 80 ? -6 : -2;
  if (macd.hist !== null) score += macd.hist > 0 ? 8 : -4;
  if (data.fundamental.volumeRatio !== null) score += data.fundamental.volumeRatio >= 1 ? 4 : -2;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function scorePolicyBlock(data) {
  let score = 48;
  if (data.meta.market === "主板" && (data.fundamental.dvRatio || 0) >= 3) score += 18;
  if (data.meta.market === "科创板") score += 15;
  if (data.meta.market === "创业板") score += 12;
  score += Math.min(data.policy.tags.length * 7, 24);
  if (data.meta.isHs === "H" || data.meta.isHs === "S") score += 5;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreRiskBlock(data) {
  let score = 90;
  if (data.risk.isSt) score -= 50;
  if (data.risk.pledgeRatio !== null) score -= Math.min(data.risk.pledgeRatio * 1.5, 35);
  if (data.fundamental.debtToAssets !== null && data.fundamental.debtToAssets > 70) score -= 14;
  if (data.technical.rsi14 !== null && data.technical.rsi14 > 82) score -= 8;
  if (data.meta.market === "创业板" || data.meta.market === "科创板") score -= 6;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function summarizeTrend(close, ma20, ma60, macdHist) {
  if (close > ma20 && ma20 > ma60 && macdHist > 0) return "趋势上行";
  if (close > ma60 && macdHist >= 0) return "中期偏强";
  if (close < ma20 && macdHist < 0) return "偏弱整理";
  return "震荡观察";
}

function buildAnalysis(meta, dailyRows, adjustedRows, dailyBasic, fina, pledge, moneyflow) {
  const closes = adjustedRows.map(item => item.close);
  const ma5 = movingAverage(closes, 5);
  const ma10 = movingAverage(closes, 10);
  const ma20 = movingAverage(closes, 20);
  const ma60 = movingAverage(closes, 60);
  const macd = calcMacd(closes);
  const rsi14 = calcRsi(closes, 14);
  const lastIndex = adjustedRows.length - 1;
  const lastDaily = dailyRows[lastIndex];
  const lastAdj = adjustedRows[lastIndex];
  const latestBasic = dailyBasic || {};
  const latestFina = fina || {};
  const latestPledge = pledge || {};
  const latestMoneyflow = moneyflow || {};
  const policyTags = safeIndustryThemes(meta.industry, meta.market, meta.name);

  const result = {
    meta: {
      name: meta.name,
      tsCode: meta.ts_code,
      market: meta.market || "--",
      industry: meta.industry || "--",
      exchange: meta.exchange || "--",
      listDate: toIsoDate(meta.list_date),
      isHs: meta.is_hs || "N"
    },
    quote: {
      close: parseMaybeNumber(lastAdj.close),
      pctChg: parseMaybeNumber(lastDaily.pct_chg),
      amount: parseMaybeNumber(lastDaily.amount),
      tradeDate: toIsoDate(lastDaily.trade_date)
    },
    fundamental: {
      pe: parseMaybeNumber(latestBasic.pe),
      pb: parseMaybeNumber(latestBasic.pb),
      psTtm: parseMaybeNumber(latestBasic.ps_ttm),
      turnoverRate: parseMaybeNumber(latestBasic.turnover_rate),
      volumeRatio: parseMaybeNumber(latestBasic.volume_ratio),
      totalMv: parseMaybeNumber(latestBasic.total_mv),
      circMv: parseMaybeNumber(latestBasic.circ_mv),
      dvRatio: parseMaybeNumber(latestBasic.dv_ratio),
      roe: parseMaybeNumber(latestFina.roe),
      roa: parseMaybeNumber(latestFina.roa),
      grossMargin: parseMaybeNumber(latestFina.gross_margin),
      debtToAssets: parseMaybeNumber(latestFina.debt_to_assets),
      yoySales: parseMaybeNumber(latestFina.yoy_sales),
      yoyDeduNp: parseMaybeNumber(latestFina.yoy_dedu_np),
      ocfps: parseMaybeNumber(latestFina.ocfps)
    },
    technical: {
      ma5: ma5[lastIndex],
      ma10: ma10[lastIndex],
      ma20: ma20[lastIndex],
      ma60: ma60[lastIndex],
      rsi14,
      macd,
      trendLabel: summarizeTrend(lastAdj.close, ma20[lastIndex] || 0, ma60[lastIndex] || 0, macd.hist || 0),
      commentary: [
        `当前价格相对 MA20 ${lastAdj.close > (ma20[lastIndex] || 0) ? "在上方" : "在下方"}`,
        `MACD ${macd.hist >= 0 ? "翻红或维持多头" : "仍处空头区域"}`,
        latestBasic.volume_ratio ? `量比 ${round(latestBasic.volume_ratio, 2)}` : "量比数据待补充"
      ].join("，")
    },
    policy: {
      tags: policyTags,
      notes: [
        `板块归属：${meta.market || "未分类"}，A 股交易制度与波动特征会直接影响持仓节奏。`,
        `行业归属：${meta.industry || "未分类"}，政策打分当前按行业主题映射，不等同于正式投顾结论。`,
        `如果后面接入公告、新闻和政策数据库，这一栏还能继续升级成事件驱动评分。`
      ]
    },
    risk: {
      isSt: /ST/.test(meta.name || ""),
      pledgeRatio: parseMaybeNumber(latestPledge.pledge_ratio),
      boardRule: mapBoardRule(meta.market),
      level: "中"
    },
    warnings: [],
    chart: {
      labels: adjustedRows.map(item => item.tradeDate),
      candles: adjustedRows.map(item => [item.open, item.close, item.low, item.high]),
      volume: adjustedRows.map(item => round(item.vol, 0)),
      ma5,
      ma10,
      ma20,
      ma60
    }
  };

  result.scores = {
    fundamental: scoreFundamentalBlock(result),
    technical: scoreTechnicalBlock(result),
    policy: scorePolicyBlock(result),
    risk: scoreRiskBlock(result)
  };
  result.scores.total = Math.round(
    result.scores.fundamental * 0.4 +
    result.scores.technical * 0.25 +
    result.scores.policy * 0.2 +
    result.scores.risk * 0.15
  );

  result.risk.level = result.scores.risk >= 80 ? "低" : result.scores.risk >= 65 ? "中" : "高";

  result.positives = [];
  result.risks = [];

  if ((result.fundamental.roe || 0) >= 12) result.positives.push(`ROE 为 ${round(result.fundamental.roe)}%，盈利效率不错。`);
  if ((result.fundamental.yoyDeduNp || 0) > 0) result.positives.push(`扣非净利同比 ${round(result.fundamental.yoyDeduNp)}%，基本面没有只靠非经常损益。`);
  if ((result.technical.ma5 || 0) > (result.technical.ma20 || 0)) result.positives.push("短中期均线结构偏多，技术面有承接。");
  if ((latestMoneyflow.net_mf_amount || 0) > 0) result.positives.push(`最近一期主力净流入约 ${round(latestMoneyflow.net_mf_amount)} 万元。`);
  if ((result.fundamental.dvRatio || 0) >= 3) result.positives.push("股息率具备一定防守属性，适合 A 股红利思路。");

  if (result.risk.isSt) result.risks.push("名称含 ST，风险偏高。");
  if ((result.risk.pledgeRatio || 0) >= 15) result.risks.push(`股权质押比例 ${round(result.risk.pledgeRatio)}%，需要重点盯住。`);
  if ((result.fundamental.debtToAssets || 0) > 70) result.risks.push(`资产负债率 ${round(result.fundamental.debtToAssets)}%，杠杆压力偏高。`);
  if ((result.technical.rsi14 || 0) > 78) result.risks.push(`RSI14 已到 ${round(result.technical.rsi14)}，短线有过热迹象。`);
  if (result.meta.market === "创业板" || result.meta.market === "科创板") result.risks.push("板块波动更大，仓位不宜重。");
  if ((result.fundamental.pe || 0) > 45) result.risks.push(`PE 约 ${round(result.fundamental.pe)}，估值消化压力较大。`);
  if (!result.risks.length) result.risks.push("当前没有突出的硬伤，但仍要结合仓位和止损执行。");

  result.summary = [
    `${result.meta.name} 当前综合评分 ${result.scores.total} 分。`,
    `基本面 ${result.scores.fundamental}、技术面 ${result.scores.technical}、政策/风格 ${result.scores.policy}、风险 ${result.scores.risk}。`,
    `更适合作为 ${result.policy.tags[0]} 方向下的 ${result.risk.level === "低" ? "稳健观察对象" : "需要纪律管理的波段观察对象"}。`
  ].join("");

  return result;
}

function buildCompanyProfile(meta, company = {}) {
  return {
    fullName: company.com_name || meta.name || "--",
    chairman: company.chairman || "--",
    manager: company.manager || "--",
    secretary: company.secretary || "--",
    employees: parseMaybeNumber(company.employees),
    regCapital: parseMaybeNumber(company.reg_capital),
    province: company.province || "--",
    city: company.city || "--",
    website: company.website || "",
    email: company.email || "",
    mainBusiness: company.main_business || "",
    introduction: company.introduction || ""
  };
}

function buildAnnouncements(rows = []) {
  return rows.slice(0, 10).map(item => ({
    annDate: toIsoDate(item.ann_date),
    title: item.title || "",
    url: item.url || "",
    recTime: item.rec_time || ""
  }));
}

async function getStockDetail(tsCode, range, adjMode) {
  const basics = await getStockBasics();
  const normalized = normalizeTsCode(tsCode);
  const basic = basics.find(item => item.ts_code === normalized);
  if (!basic) {
    throw new HttpError(404, `找不到股票代码：${normalized}`);
  }

  const dayMap = { "6m": 220, "1y": 420, "3y": 1200, "5y": 2000 };
  const startDate = dateOffset(dayMap[range] || 420);

  const [daily, adjFactor, dailyBasicPack, finaPack, pledgePack, moneyflowPack, companyPack, annsPack] = await Promise.all([
    cachedTushareQuery("daily", { ts_code: normalized, start_date: startDate }, "ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount", 30 * 60 * 1000),
    adjMode === "qfq"
      ? cachedTushareQuery("adj_factor", { ts_code: normalized, start_date: startDate }, "ts_code,trade_date,adj_factor", 30 * 60 * 1000)
      : Promise.resolve([]),
    optionalCachedTushareQuery("daily_basic", { ts_code: normalized, start_date: startDate }, "ts_code,trade_date,close,turnover_rate,volume_ratio,pe,pb,ps_ttm,dv_ratio,total_mv,circ_mv", 30 * 60 * 1000),
    optionalCachedTushareQuery("fina_indicator", { ts_code: normalized }, "", QUERY_CACHE_TTL_MS),
    optionalCachedTushareQuery("pledge_stat", { ts_code: normalized }, "ts_code,end_date,pledge_ratio", QUERY_CACHE_TTL_MS),
    optionalCachedTushareQuery("moneyflow", { ts_code: normalized, start_date: startDate }, "ts_code,trade_date,net_mf_amount", 30 * 60 * 1000),
    optionalCachedTushareQuery("stock_company", { ts_code: normalized }, "ts_code,com_name,chairman,manager,secretary,reg_capital,setup_date,province,city,introduction,website,email,employees,main_business", QUERY_CACHE_TTL_MS),
    optionalCachedTushareQuery("anns_d", { ts_code: normalized, start_date: dateOffset(120) }, "ann_date,ts_code,name,title,url,rec_time", 60 * 60 * 1000)
  ]);

  if (!daily.length) {
    throw new HttpError(404, `${normalized} 没有可用的日线数据。`);
  }

  const dailyAsc = sortAscByDate(daily);
  const adjAsc = sortAscByDate(adjFactor);
  const adjusted = adjustCandles(dailyAsc, adjAsc, adjMode);

  const detail = buildAnalysis(
    basic,
    dailyAsc,
    adjusted,
    dailyBasicPack.rows[0],
    finaPack.rows[0],
    pledgePack.rows[0],
    moneyflowPack.rows[0]
  );
  detail.warnings = [dailyBasicPack.warning, finaPack.warning, pledgePack.warning, moneyflowPack.warning].filter(Boolean);
  if (detail.warnings.length) {
    detail.risks.unshift(`当前有 ${detail.warnings.length} 类高阶数据未取到，页面已自动降级显示。`);
  }
  detail.company = buildCompanyProfile(basic, companyPack.rows[0]);
  detail.announcements = buildAnnouncements(
    [...annsPack.rows].sort((a, b) => String(b.ann_date).localeCompare(String(a.ann_date)))
  );
  if (companyPack.warning) detail.warnings.push(companyPack.warning);
  if (annsPack.warning) detail.warnings.push(annsPack.warning);
  return detail;
}

async function getWatchlistDetails(codes) {
  const uniqueCodes = [...new Set(codes.map(normalizeTsCode).filter(Boolean))].slice(0, 12);
  const items = await Promise.all(uniqueCodes.map(code => getStockDetail(code, "1y", "qfq")));
  return items.map(item => ({
    tsCode: item.meta.tsCode,
    name: item.meta.name,
    market: item.meta.market,
    industry: item.meta.industry,
    close: item.quote.close,
    pctChg: item.quote.pctChg,
    pe: item.fundamental.pe,
    pb: item.fundamental.pb,
    roe: item.fundamental.roe,
    dvRatio: item.fundamental.dvRatio,
    trendLabel: item.technical.trendLabel,
    score: item.scores.total,
    riskLevel: item.risk.level
  })).sort((a, b) => b.score - a.score);
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (BLOCKED_STATIC.has(relative)) {
    throw new HttpError(403, "禁止访问该文件。");
  }
  const filePath = path.join(ROOT, relative);
  if (!filePath.startsWith(ROOT)) {
    throw new HttpError(403, "非法路径。");
  }
  const content = await fsp.readFile(filePath);
  file(res, 200, content, path.extname(filePath));
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname === "/api/health") {
      const token = await getToken();
      return json(res, 200, {
        ok: true,
        tokenConfigured: Boolean(token),
        provider: "Tushare",
        serverTime: new Date().toISOString()
      });
    }

    if (pathname === "/api/search") {
      const items = await searchStocks(url.searchParams.get("q"));
      return json(res, 200, { items });
    }

    if (pathname === "/api/watchlist") {
      const codes = String(url.searchParams.get("codes") || "")
        .split(",")
        .map(item => item.trim())
        .filter(Boolean);
      if (!codes.length) {
        throw new HttpError(400, "请通过 codes 参数传入股票列表。");
      }
      const items = await getWatchlistDetails(codes);
      return json(res, 200, { items });
    }

    if (pathname.startsWith("/api/stock/")) {
      const tsCode = pathname.replace("/api/stock/", "");
      const range = url.searchParams.get("range") || "1y";
      const adj = url.searchParams.get("adj") || "qfq";
      const detail = await getStockDetail(tsCode, range, adj);
      return json(res, 200, detail);
    }

    return serveStatic(req, res, pathname);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    return json(res, status, {
      ok: false,
      error: error.message || "服务器内部错误"
    });
  }
}

const HOST = process.env.HOST || "0.0.0.0";

http.createServer((req, res) => {
  handler(req, res);
}).listen(PORT, HOST, () => {
  console.log(`A-share analyzer is running at http://${HOST}:${PORT}`);
});
