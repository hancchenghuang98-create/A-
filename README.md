# A股真实数据分析台

这是一个本地运行的 A 股分析网站，使用：

- `Tushare` 作为真实 A 股数据源
- `Node.js` 作为本地数据代理
- `ECharts` 在前端绘制股价走势图、K 线和成交量

## 当前能力

- 股票搜索：代码或名称
- 真实日线行情：近 6 个月 / 1 年 / 3 年 / 5 年
- K 线图 + 成交量 + MA5 / MA10 / MA20 / MA60
- 自选股池批量评分与横向比较
- 最新公告面板
- 公司概况面板
- 指标：PE、PB、PS、ROE、ROA、毛利率、资产负债率、营收同比、扣非净利同比、每股经营现金流、换手率、量比
- 技术因子：均线、MACD、RSI
- A 股风格适配：板块、行业主题、ST、股权质押、波动规则

## 配置真实数据

1. 注册并获取 `Tushare Token`
2. 在项目目录创建 `config.local.json`
3. 文件内容格式如下：

```json
{
  "tushareToken": "你的 Tushare Token"
}
```

也可以不用本地文件，直接设置环境变量：

```powershell
$env:TUSHARE_TOKEN="你的 Tushare Token"
```

## 启动

```powershell
node server.js
```

浏览器打开：

```text
http://127.0.0.1:3030
```

## 线上部署

这个项目现在已经可以直接部署到云上，不需要只在本地运行。

### 方案 1：Render

1. 把项目推到 GitHub
2. 在 Render 新建 `Web Service`
3. 选择仓库
4. Render 会自动识别 [render.yaml](C:/Users/huanghc/Downloads/a-share-analyzer/render.yaml)
5. 在环境变量里填入：

```text
TUSHARE_TOKEN=你的Token
```

部署完成后，直接访问 Render 给你的公网地址。

### 方案 2：Railway / Zeabur / 云服务器

项目已经带了：

- [package.json](C:/Users/huanghc/Downloads/a-share-analyzer/package.json)
- [Dockerfile](C:/Users/huanghc/Downloads/a-share-analyzer/Dockerfile)

所以你可以：

- 直接用 `npm start`
- 或者用 Docker 部署

Docker 示例：

```bash
docker build -t a-share-analyzer .
docker run -p 3030:3030 -e TUSHARE_TOKEN=你的Token a-share-analyzer
```

## 权限说明

这个站点当前用到的 Tushare 接口包括：

- `stock_basic`
- `daily`
- `adj_factor`
- `daily_basic`
- `fina_indicator`
- `pledge_stat`
- `moneyflow`

其中部分接口需要至少 `2000` 积分或相应权限。如果你的权限不足，页面会提示具体哪一类数据拿不到。

## 当前新增联网接口

- `/api/search`
- `/api/stock/:tsCode`
- `/api/watchlist?codes=...`
- `/api/health`

## 说明

- `前复权` 是本地依据 `adj_factor` 计算得到的。
- 当前“政策面”评分是按行业和板块做的 A 股风格映射，不是公告级政策 NLP 解析。
- 如果你后面要继续升级，可以接：
  - 实时分时行情
  - 公告解析
  - 政策数据库
  - 自选股池
  - 回测模块
