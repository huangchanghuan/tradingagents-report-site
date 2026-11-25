# TradingAgents 报告站

两个数据源统一收录的静态报告站：

1. **TradingAgents 分析报告**：`~/.tradingagents/logs/reports/`（sync.py 增量拉取）
2. **每日报告文档**（Finance/股票池扫描/ETF 分析）：由 `etf-analysis`、`stock-pool-scan-v2` 等 skill 生成后调用 `ingest_report.py` 直接落盘收录（2026-11-02 起不再经腾讯文档中转）

## 用法

```bash
# 1. 同步 TradingAgents 报告（增量）
python3 sync.py

# 2. skill 生成的报告收录（由 skill 自动调用，也可手动执行）
python3 ingest_report.py "<报告.md>" --title "报告标题"

# 3. （可选）从腾讯文档文件夹手动补拉
python3 sync_docs.py

# 4. 本地预览
cd site && python3 -m http.server 8000
```

发布：把 `site/` 目录重新发布即可（工作台「发布为应用」）。

## 结构

```
sync.py              TradingAgents 报告增量同步（评级打分 + 近一周总结/整体策略生成）
sync_docs.py         腾讯文档文件夹手动补拉（遗留通路，local- 文档不会被误删）
ingest_report.py     skill 报告收录入口（时间戳+内容哈希生成唯一 id）
mcp_call.py          腾讯文档 MCP 最小调用客户端（备用）
site/
  index.html         前端 SPA 入口
  app.js             侧栏（近一周总结/整体策略/每日报告文档/TradingAgents 报告树）+ 阅读器
  data/reports.json  TradingAgents 报告索引（含 brief/strategy）
  data/tdocs.json    每日报告文档索引（按日期分组展示）
  tdocs/             每日报告文档 md
  reports/           TradingAgents 报告 md
```

## 工作机制

- TradingAgents 报告按「文件 size+mtime 签名」增量同步；评级打分：买入 2 / 增持 1 / 中性 0 / 减持 -1 / 卖出 -2。
- 整体策略遵循评级阶梯语义：**买入=满配立即建仓，增持=分批小仓位挂确认条件，持有=不新开仓，减持/卖出=止损**；买入数量不足时仓位建议自动降档。
- 每日报告文档：skill 落盘（ingest_report.py）为主，sync_docs.py 仅作腾讯文档手动补拉。

