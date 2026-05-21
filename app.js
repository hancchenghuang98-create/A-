const state = {
  adjustment: "qfq",
  range: "1y",
  selectedCode: "600519.SH",
  searchTimer: null,
  chart: null
};

const els = {
  statusBanner: document.getElementById("statusBanner"),
  searchInput: document.getElementById("searchInput"),
  searchButton: document.getElementById("searchButton"),
  searchResults: document.getElementById("searchResults"),
  watchlistInput: document.getElementById("watchlistInput"),
  watchlistButton: document.getElementById("watchlistButton"),
  watchlistTable: document.getElementById("watchlistTable"),
  adjustment: document.getElementById("adjustment"),
  range: document.getElementById("range"),
  quoteCards: document.getElementById("quoteCards"),
  scoreCards: document.getElementById("scoreCards"),
  diagnostics: document.getElementById("diagnostics"),
  metaPanel: document.getElementById("metaPanel"),
  companyPanel: document.getElementById("companyPanel"),
  metricsPanel: document.getElementById("metricsPanel"),
  technicalPanel: document.getElementById("technicalPanel"),
  policyPanel: document.getElementById("policyPanel"),
  announcementsPanel: document.getElementById("announcementsPanel"),
  chartContainer: document.getElementById("klineChart"),
  loading: document.getElementById("loadingState"),
  quickLinks: document.querySelectorAll("[data-ts-code]")
};

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "--";
  }
  return Number(value).toFixed(digits);
}

function formatPct(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "--";
  }
  const num = Number(value);
  return `${num > 0 ? "+" : ""}${num.toFixed(digits)}%`;
}

function formatLargeMarketCap(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "--";
  const yi = num / 10000;
  if (yi >= 10000) return `${(yi / 10000).toFixed(2)}万亿`;
  return `${yi.toFixed(0)}亿`;
}

function scoreTone(score) {
  if (score >= 80) return "strong";
  if (score >= 65) return "mid";
  return "weak";
}

function setLoading(isLoading, text = "正在拉取真实 A 股数据...") {
  els.loading.hidden = !isLoading;
  els.loading.textContent = text;
}

async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "请求失败");
  }
  return data;
}

async function loadHealth() {
  try {
    const health = await fetchJson("/api/health");
    if (health.tokenConfigured) {
      els.statusBanner.className = "status-banner ok";
      els.statusBanner.innerHTML = `
        <strong>数据通道已就绪</strong>
        <span>当前走 Tushare 实时联网查询。部分高阶接口取决于你的积分权限。</span>
      `;
    } else {
      els.statusBanner.className = "status-banner warn";
      els.statusBanner.innerHTML = `
        <strong>还没配置 Tushare Token</strong>
        <span>请先在本项目目录创建 <code>config.local.json</code>，填入你的 token，再刷新页面。</span>
      `;
    }
  } catch (error) {
    els.statusBanner.className = "status-banner warn";
    els.statusBanner.innerHTML = `
      <strong>健康检查失败</strong>
      <span>${error.message}</span>
    `;
  }
}

async function searchStocks(query) {
  if (!query || query.trim().length < 1) {
    els.searchResults.innerHTML = "";
    return;
  }

  try {
    const result = await fetchJson(`/api/search?q=${encodeURIComponent(query.trim())}`);
    const items = result.items || [];
    els.searchResults.innerHTML = items.length
      ? items.map(item => `
          <button class="result-item" data-code="${item.ts_code}" type="button">
            <strong>${item.name}</strong>
            <span>${item.ts_code} · ${item.market || "--"} · ${item.industry || "未分类"}</span>
          </button>
        `).join("")
      : `<div class="result-empty">没有匹配结果</div>`;

    els.searchResults.querySelectorAll("[data-code]").forEach(node => {
      node.addEventListener("click", () => {
        els.searchInput.value = `${node.dataset.code}`;
        els.searchResults.innerHTML = "";
        loadStock(node.dataset.code);
      });
    });
  } catch (error) {
    els.searchResults.innerHTML = `<div class="result-empty">${error.message}</div>`;
  }
}

function renderQuoteCards(data) {
  const quote = data.quote;
  const priceTone = quote.pctChg >= 0 ? "up" : "down";
  els.quoteCards.innerHTML = `
    <article class="mini-card emphasis">
      <p>最新价</p>
      <strong>${formatNumber(quote.close)}</strong>
      <span class="${priceTone}">${formatPct(quote.pctChg)}</span>
    </article>
    <article class="mini-card">
      <p>成交额</p>
      <strong>${formatNumber(quote.amount / 10000, 0)}万</strong>
      <span>${quote.tradeDate}</span>
    </article>
    <article class="mini-card">
      <p>总市值</p>
      <strong>${formatLargeMarketCap(data.fundamental.totalMv)}</strong>
      <span>流通市值 ${formatLargeMarketCap(data.fundamental.circMv)}</span>
    </article>
    <article class="mini-card">
      <p>股息率</p>
      <strong>${formatNumber(data.fundamental.dvRatio)}</strong>
      <span>PE ${formatNumber(data.fundamental.pe)} / PB ${formatNumber(data.fundamental.pb)}</span>
    </article>
  `;
}

function renderScoreCards(data) {
  const cards = [
    ["综合评分", data.scores.total],
    ["基本面", data.scores.fundamental],
    ["技术面", data.scores.technical],
    ["政策/风格", data.scores.policy]
  ];

  els.scoreCards.innerHTML = cards.map(([label, score]) => `
    <article class="score-card ${scoreTone(score)}">
      <p>${label}</p>
      <strong>${score}</strong>
    </article>
  `).join("");
}

function renderDiagnostics(data) {
  els.diagnostics.innerHTML = `
    <div class="diag-block">
      <h3>当前结论</h3>
      <p>${data.summary}</p>
    </div>
    <div class="diag-block">
      <h3>数据状态</h3>
      <ul>${(data.warnings?.length ? data.warnings : ["核心行情已联网获取。"]).map(item => `<li>${item}</li>`).join("")}</ul>
    </div>
    <div class="diag-block">
      <h3>正向信号</h3>
      <ul>${data.positives.map(item => `<li>${item}</li>`).join("")}</ul>
    </div>
    <div class="diag-block">
      <h3>需要盯住的风险</h3>
      <ul>${data.risks.map(item => `<li>${item}</li>`).join("")}</ul>
    </div>
  `;
}

function renderMetaPanel(data) {
  const meta = data.meta;
  els.metaPanel.innerHTML = `
    <div class="panel-head">
      <div>
        <p class="section-kicker">标的概况</p>
        <h2>${meta.name}</h2>
      </div>
      <div class="identity-chip">${meta.tsCode}</div>
    </div>
    <div class="info-grid">
      <div><span>市场</span><strong>${meta.market || "--"}</strong></div>
      <div><span>行业</span><strong>${meta.industry || "--"}</strong></div>
      <div><span>交易所</span><strong>${meta.exchange || "--"}</strong></div>
      <div><span>上市日期</span><strong>${meta.listDate || "--"}</strong></div>
      <div><span>沪深港通</span><strong>${meta.isHs || "否"}</strong></div>
      <div><span>风控等级</span><strong>${data.risk.level}</strong></div>
    </div>
  `;
}

function renderMetricsPanel(data) {
  const items = [
    ["PE(TTM)", formatNumber(data.fundamental.pe)],
    ["PB", formatNumber(data.fundamental.pb)],
    ["PS(TTM)", formatNumber(data.fundamental.psTtm)],
    ["ROE", `${formatNumber(data.fundamental.roe)}%`],
    ["ROA", `${formatNumber(data.fundamental.roa)}%`],
    ["毛利率", `${formatNumber(data.fundamental.grossMargin)}%`],
    ["资产负债率", `${formatNumber(data.fundamental.debtToAssets)}%`],
    ["营收同比", `${formatNumber(data.fundamental.yoySales)}%`],
    ["扣非净利同比", `${formatNumber(data.fundamental.yoyDeduNp)}%`],
    ["每股经营现金流", formatNumber(data.fundamental.ocfps)],
    ["换手率", `${formatNumber(data.fundamental.turnoverRate)}%`],
    ["量比", formatNumber(data.fundamental.volumeRatio)]
  ];

  els.metricsPanel.innerHTML = `
    <div class="panel-head">
      <div>
        <p class="section-kicker">基本面与估值</p>
        <h2>更多股票指标</h2>
      </div>
    </div>
    <div class="info-grid metrics-grid">
      ${items.map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("")}
    </div>
  `;
}

function renderCompanyPanel(data) {
  const company = data.company || {};
  els.companyPanel.innerHTML = `
    <div class="panel-head">
      <div>
        <p class="section-kicker">公司画像</p>
        <h2>经营与治理概况</h2>
      </div>
    </div>
    <div class="info-grid metrics-grid">
      <div><span>公司全称</span><strong>${company.fullName || "--"}</strong></div>
      <div><span>董事长</span><strong>${company.chairman || "--"}</strong></div>
      <div><span>总经理</span><strong>${company.manager || "--"}</strong></div>
      <div><span>董秘</span><strong>${company.secretary || "--"}</strong></div>
      <div><span>员工人数</span><strong>${company.employees ?? "--"}</strong></div>
      <div><span>注册资本</span><strong>${company.regCapital ?? "--"}</strong></div>
      <div><span>省份</span><strong>${company.province || "--"}</strong></div>
      <div><span>城市</span><strong>${company.city || "--"}</strong></div>
    </div>
    <p class="panel-note">${company.mainBusiness || "暂无主营业务描述。"}</p>
    ${company.website ? `<p class="panel-note">官网：<a href="${company.website}" target="_blank" rel="noreferrer">${company.website}</a></p>` : ""}
  `;
}

function renderTechnicalPanel(data) {
  const t = data.technical;
  const items = [
    ["MA5", formatNumber(t.ma5)],
    ["MA10", formatNumber(t.ma10)],
    ["MA20", formatNumber(t.ma20)],
    ["MA60", formatNumber(t.ma60)],
    ["RSI14", formatNumber(t.rsi14)],
    ["DIF", formatNumber(t.macd.dif)],
    ["DEA", formatNumber(t.macd.dea)],
    ["MACD", formatNumber(t.macd.hist)]
  ];

  els.technicalPanel.innerHTML = `
    <div class="panel-head">
      <div>
        <p class="section-kicker">技术面</p>
        <h2>趋势、动量与量能</h2>
      </div>
      <div class="identity-chip">${t.trendLabel}</div>
    </div>
    <div class="info-grid metrics-grid">
      ${items.map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("")}
    </div>
    <p class="panel-note">${t.commentary}</p>
  `;
}

function renderPolicyPanel(data) {
  els.policyPanel.innerHTML = `
    <div class="panel-head">
      <div>
        <p class="section-kicker">政策面与 A 股适配</p>
        <h2>行业主题与制度约束</h2>
      </div>
      <div class="identity-chip">${data.scores.policy}分</div>
    </div>
    <div class="tag-cloud">
      ${data.policy.tags.map(tag => `<span class="tag">${tag}</span>`).join("")}
    </div>
    <ul class="policy-list">
      ${data.policy.notes.map(item => `<li>${item}</li>`).join("")}
    </ul>
    <div class="risk-strip">
      <div><span>ST 风险</span><strong>${data.risk.isSt ? "是" : "否"}</strong></div>
      <div><span>质押比例</span><strong>${formatNumber(data.risk.pledgeRatio)}%</strong></div>
      <div><span>板块波动</span><strong>${data.risk.boardRule}</strong></div>
    </div>
  `;
}

function renderAnnouncementsPanel(data) {
  const items = data.announcements || [];
  els.announcementsPanel.innerHTML = `
    <div class="panel-head">
      <div>
        <p class="section-kicker">事件面</p>
        <h2>最新公告</h2>
      </div>
      <div class="identity-chip">${items.length}条</div>
    </div>
    <div class="announcement-list">
      ${items.length ? items.map(item => `
        <article class="announcement-item">
          <div class="announcement-date">${item.annDate || "--"}</div>
          <div class="announcement-body">
            <strong>${item.title || "无标题公告"}</strong>
            ${item.url ? `<a href="${item.url}" target="_blank" rel="noreferrer">打开原文</a>` : `<span class="announcement-muted">暂无原文链接</span>`}
          </div>
        </article>
      `).join("") : `<div class="result-empty">暂无可展示公告</div>`}
    </div>
  `;
}

function renderWatchlist(items) {
  if (!items?.length) {
    els.watchlistTable.innerHTML = `<div class="result-empty">输入代码后即可联网批量评分</div>`;
    return;
  }

  els.watchlistTable.innerHTML = `
    <div class="watchlist-header row-grid">
      <span>股票</span>
      <span>综合分</span>
      <span>涨跌幅</span>
      <span>PE / PB</span>
      <span>ROE</span>
      <span>趋势</span>
      <span>风险</span>
    </div>
    ${items.map(item => `
      <button class="watchlist-row row-grid" data-code="${item.tsCode}" type="button">
        <span><strong>${item.name}</strong><small>${item.tsCode}</small></span>
        <span>${item.score}</span>
        <span class="${item.pctChg >= 0 ? "up" : "down"}">${formatPct(item.pctChg)}</span>
        <span>${formatNumber(item.pe)} / ${formatNumber(item.pb)}</span>
        <span>${formatNumber(item.roe)}%</span>
        <span>${item.trendLabel}</span>
        <span>${item.riskLevel}</span>
      </button>
    `).join("")}
  `;

  els.watchlistTable.querySelectorAll("[data-code]").forEach(node => {
    node.addEventListener("click", () => {
      const code = node.dataset.code;
      els.searchInput.value = code;
      loadStock(code);
    });
  });
}

async function loadWatchlist(rawCodes) {
  const cleaned = String(rawCodes || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);

  if (!cleaned.length) {
    renderWatchlist([]);
    return;
  }

  els.watchlistTable.innerHTML = `<div class="result-empty">正在联网批量评分...</div>`;

  try {
    const payload = await fetchJson(`/api/watchlist?codes=${encodeURIComponent(cleaned.join(","))}`);
    renderWatchlist(payload.items || []);
  } catch (error) {
    els.watchlistTable.innerHTML = `<div class="result-empty">${error.message}</div>`;
  }
}

function renderChart(data) {
  if (!window.echarts) {
    els.chartContainer.innerHTML = "<div class='chart-fallback'>ECharts 未加载成功，无法显示 K 线图。</div>";
    return;
  }

  if (!state.chart) {
    state.chart = window.echarts.init(els.chartContainer);
    window.addEventListener("resize", () => state.chart && state.chart.resize());
  }

  const chart = data.chart;
  const upColor = "#c2392f";
  const downColor = "#0f7a57";

  state.chart.setOption({
    animation: false,
    backgroundColor: "transparent",
    legend: {
      top: 0,
      textStyle: { color: "#524841" },
      data: ["K线", "MA5", "MA10", "MA20", "MA60", "成交量"]
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross" }
    },
    axisPointer: {
      link: [{ xAxisIndex: "all" }]
    },
    grid: [
      { left: 40, right: 20, top: 40, height: "56%" },
      { left: 40, right: 20, top: "72%", height: "16%" }
    ],
    xAxis: [
      {
        type: "category",
        data: chart.labels,
        boundaryGap: false,
        axisLine: { lineStyle: { color: "#b0a59b" } },
        axisLabel: { color: "#6c6259" },
        min: "dataMin",
        max: "dataMax"
      },
      {
        type: "category",
        gridIndex: 1,
        data: chart.labels,
        boundaryGap: false,
        axisLine: { lineStyle: { color: "#b0a59b" } },
        axisLabel: { show: false },
        min: "dataMin",
        max: "dataMax"
      }
    ],
    yAxis: [
      {
        scale: true,
        splitLine: { lineStyle: { color: "rgba(31,26,23,0.08)" } },
        axisLabel: { color: "#6c6259" }
      },
      {
        gridIndex: 1,
        scale: true,
        splitNumber: 2,
        axisLabel: { color: "#6c6259" },
        splitLine: { show: false }
      }
    ],
    dataZoom: [
      { type: "inside", xAxisIndex: [0, 1], start: 55, end: 100 },
      { show: true, xAxisIndex: [0, 1], type: "slider", bottom: 10, height: 22 }
    ],
    series: [
      {
        name: "K线",
        type: "candlestick",
        data: chart.candles,
        itemStyle: {
          color: upColor,
          color0: downColor,
          borderColor: upColor,
          borderColor0: downColor
        }
      },
      {
        name: "MA5",
        type: "line",
        data: chart.ma5,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 1.5, color: "#d24d57" }
      },
      {
        name: "MA10",
        type: "line",
        data: chart.ma10,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 1.4, color: "#d6a742" }
      },
      {
        name: "MA20",
        type: "line",
        data: chart.ma20,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 1.4, color: "#4676d7" }
      },
      {
        name: "MA60",
        type: "line",
        data: chart.ma60,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 1.4, color: "#7a58c1" }
      },
      {
        name: "成交量",
        type: "bar",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: chart.volume,
        itemStyle: {
          color: params => chart.candles[params.dataIndex][1] >= chart.candles[params.dataIndex][0] ? upColor : downColor
        }
      }
    ]
  });
}

async function loadStock(tsCode = state.selectedCode) {
  state.selectedCode = tsCode.toUpperCase();
  setLoading(true);

  try {
    const payload = await fetchJson(`/api/stock/${encodeURIComponent(state.selectedCode)}?range=${state.range}&adj=${state.adjustment}`);
    renderMetaPanel(payload);
    renderQuoteCards(payload);
    renderScoreCards(payload);
    renderDiagnostics(payload);
    renderCompanyPanel(payload);
    renderMetricsPanel(payload);
    renderTechnicalPanel(payload);
    renderPolicyPanel(payload);
    renderAnnouncementsPanel(payload);
    renderChart(payload);
  } catch (error) {
    els.metaPanel.innerHTML = `
      <div class="panel-head">
        <div>
          <p class="section-kicker">加载失败</p>
          <h2>还没拿到真实数据</h2>
        </div>
      </div>
      <p class="panel-note">${error.message}</p>
    `;
    els.quoteCards.innerHTML = "";
    els.scoreCards.innerHTML = "";
    els.diagnostics.innerHTML = "";
    els.companyPanel.innerHTML = "";
    els.metricsPanel.innerHTML = "";
    els.technicalPanel.innerHTML = "";
    els.policyPanel.innerHTML = "";
    els.announcementsPanel.innerHTML = "";
    if (state.chart) state.chart.clear();
  } finally {
    setLoading(false);
  }
}

els.searchInput.addEventListener("input", event => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => searchStocks(event.target.value), 180);
});

els.searchButton.addEventListener("click", () => {
  const raw = els.searchInput.value.trim();
  if (raw) loadStock(raw);
});

els.searchInput.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    const raw = els.searchInput.value.trim();
    if (raw) loadStock(raw);
  }
});

els.adjustment.addEventListener("change", event => {
  state.adjustment = event.target.value;
  loadStock(state.selectedCode);
});

els.range.addEventListener("change", event => {
  state.range = event.target.value;
  loadStock(state.selectedCode);
});

els.quickLinks.forEach(node => {
  node.addEventListener("click", () => {
    const code = node.dataset.tsCode;
    els.searchInput.value = code;
    loadStock(code);
  });
});

els.watchlistButton.addEventListener("click", () => {
  loadWatchlist(els.watchlistInput.value);
});

els.watchlistInput.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    loadWatchlist(els.watchlistInput.value);
  }
});

loadHealth();
renderWatchlist([]);
loadStock(state.selectedCode);
