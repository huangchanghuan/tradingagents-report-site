#!/usr/bin/env python3
"""
增量同步 TradingAgents 报告目录 -> 静态网站数据。

用法:
    python3 sync.py                 # 增量同步（默认只保留最近 3 天报告）
    python3 sync.py --keep-days 7   # 保留最近 7 天
    python3 sync.py --keep-days 0   # 不限制（全量保留）
    python3 sync.py --full          # 全量重建（清空 site/reports 后重新拉取）

原理:
    1. 扫描源目录下所有 {ticker}_{YYYYMMDD_HHMMSS} 报告目录;
    2. 对每个目录计算签名(各 md 文件的 size+mtime), 与 manifest.json 对比;
       签名不变则跳过(增量), 变化则只重拷该目录;
    3. 从 complete_report.md / decision.md 提取元数据(评级/日期/目标价/摘要);
    4. 生成 site/data/reports.json 供前端 SPA 读取;
    5. K线/点位辅助数据只给**当日**报告生成(历史报告无意义, 省时省 LLM 调用);
       已生成过的(json 存在)直接复用, 不重复生成。
    6. 滑出保留窗口(--keep-days, 默认 3 天)的报告从站点 mv 归档到
       archive/site_reports/（不删除，manifest/reports.json 同步收缩）。

零第三方依赖, 仅用 Python 标准库。
"""

import argparse
import json
import os
import re
import shutil
import sys
import time
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

# 报告源目录: Windows 用 %USERPROFILE%\.tradingagents\logs\reports, 其他环境用原 Linux 路径
SRC = Path.home() / ".tradingagents" / "logs" / "reports" if os.name == "nt" else Path("/home/sun/.tradingagents/logs/reports")
ROOT = Path(__file__).resolve().parent
SITE = ROOT / "site"
DATA_DIR = SITE / "data"
REPORTS_OUT = SITE / "reports"
ARCHIVE_DIR = ROOT / "archive" / "site_reports"  # 滑出保留窗口的报告归档处（mv，不删除）
MANIFEST = DATA_DIR / "manifest.json"
INDEX_JSON = DATA_DIR / "reports.json"
KLINE_DIR = SITE / "data" / "kline"

# LLM 网关（点位提取用）：读 TradingAgents 项目的 .env
# Windows: C:\Users\<用户>\Desktop\project\TradingAgents\.env（与报告站同级的 TradingAgents 仓库）
_TA_ENV_WIN = Path.home() / "Desktop" / "project" / "TradingAgents" / ".env"
TA_ENV = _TA_ENV_WIN if os.name == "nt" else Path("/home/sun/Desktop/project/tradingagents/.env")
GATEWAY_BASE = "http://127.0.0.1:3425/v1"
GATEWAY_MODEL = "group/combo-flash"
# K线/点位辅助数据只给当日报告生成（历史报告无意义，跳过省时省 LLM 调用）

DIR_RE = re.compile(r"^(?P<ticker>[A-Za-z0-9.\-]+)_(?P<stamp>\d{8}_\d{6})$")

# 阶段目录定义: key -> (显示名, 子目录)。complete 单独处理。
SECTIONS = [
    ("analysts", "分析师团队", "1_analysts"),
    ("research", "研究辩论", "2_research"),
    ("trading", "交易计划", "3_trading"),
    ("risk", "风险讨论", "4_risk"),
    ("decision", "组合决策", "5_portfolio"),
]

SUB_LABELS = {
    "market": "市场分析师",
    "news": "新闻分析师",
    "fundamentals": "基本面分析师",
    "social": "社媒分析师",
    "bull": "多方观点",
    "bear": "空方观点",
    "manager": "研究经理",
    "trader": "交易员",
    "aggressive": "激进派",
    "neutral": "中立派",
    "conservative": "保守派",
    "decision": "最终决策",
}

# ---------- 评级评分 / 近一周简报与整体策略 ----------

RATING_SCORES = [
    ("买入", 2), ("强烈推荐", 2), ("增持", 1), ("推荐", 1),
    ("中性", 0), ("持有", 0),
    ("减持", -1), ("回避", -1),
    ("卖出", -2),
]

# 大概率大机会（用户手工维护的高胜率打法清单，展示在总结页；要改内容直接改这里）
BIG_CHANCE = [
    "指数深坑回调，对比历史和各种数据，直接重仓杠杆买指数反弹，反弹减仓兑现。",
]

# 失败总结（用户手工维护的失败复盘与教训，展示在总结页；要改内容直接改这里）
FAIL_CASES = [
    "等待到了机会入场，然后盈利，最后放任不管，盈利减半，还没行动，最后亏损。",
    "破位必须止损离场。",
    "过于相信、没有计划，吃了港股 ETF（周线已破）的破位下跌趋势，利润回撤巨大。",
    "老奶奶下楼梯博指数反弹：极端冰点进场后没有计划，反弹做成了等待大反转，有盈利不止损，最后变破位亏损。",
]
FAIL_LESSON = "必须有计划。盈利后，最重要的是锁住利润，重点考虑什么时候离场，不要变成亏本了。"


def rating_score(rating: str) -> int:
    """评级 -> 分数: 买入 2 / 增持 1 / 中性 0 / 减持 -1 / 卖出 -2"""
    if not rating:
        return 0
    for k, v in RATING_SCORES:
        if k and k in rating:
            return v
    low = rating.lower()
    if "strong buy" in low or "buy" in low:
        return 2
    if "overweight" in low or "accumulate" in low:
        return 1
    if "hold" in low or "neutral" in low:
        return 0
    if "underweight" in low or "reduce" in low:
        return -1
    if "sell" in low:
        return -2
    return 0


def classify_rating(rating: str) -> str:
    """评级 -> 统一四类口径（总结/策略共用，保证数字一致）:
    买入(>=2) / 增持(=1) / 中性(=0) / 偏空(<0)"""
    s = rating_score(rating)
    if s >= 2:
        return "买入"
    if s == 1:
        return "增持"
    if s == 0:
        return "中性"
    return "偏空"


def stamp_to_dt(stamp: str):
    try:
        return datetime.strptime(stamp, "%Y%m%d_%H%M%S")
    except (ValueError, TypeError):
        return None


def build_brief_and_strategy(entries: list) -> tuple:
    """基于近一周报告的评级分布, 规则化生成周总结与整体策略。"""
    now = datetime.now()
    week_ago = now - timedelta(days=7)
    recent = []
    for e in entries:
        dt = stamp_to_dt(e.get("stamp", ""))
        if dt and dt >= week_ago:
            recent.append((dt, e))
    recent.sort(key=lambda x: x[0], reverse=True)

    # 每只股票取最新一份报告作为其当前评级
    latest = {}
    for dt, e in recent:
        latest.setdefault(e["ticker"], (dt, e))
    stocks = sorted(latest.values(), key=lambda x: x[0], reverse=True)

    def score_of(item):
        return rating_score(item[1].get("rating"))

    def cls_of(item):
        return classify_rating(item[1].get("rating"))

    buy = [x for x in stocks if cls_of(x) == "买入"]
    overweight = [x for x in stocks if cls_of(x) == "增持"]
    hold = [x for x in stocks if cls_of(x) == "中性"]
    sell = [x for x in stocks if cls_of(x) == "偏空"]

    brief = {
        "start": week_ago.strftime("%m-%d"),
        "end": now.strftime("%m-%d"),
        "reportCount": len(recent),
        "stockCount": len(stocks),
        "buyCount": len(buy),
        "overweightCount": len(overweight),
        "holdCount": len(hold),
        "sellCount": len(sell),
        "bigChance": BIG_CHANCE,
        "failCases": FAIL_CASES,
        "failLesson": FAIL_LESSON,
    }

    strategy = []
    if not stocks:
        strategy.append("近一周暂无报告，无法给出策略建议，保持观望。")
        return brief, strategy

    scores = [score_of(x) for x in stocks]
    avg = sum(scores) / len(scores)
    n_buy = len(buy)        # 满配级信心
    n_ow = len(overweight)  # 方向看多但证据未满配
    n_hold = len(hold)      # 不新开仓
    n_sell = len(sell)

    LADDER = ("评级阶梯：Buy（买入）→ Overweight（增持）→ Hold（持有）→ Reduce（减持）→ Sell（卖出）；"
              "买入=标准配置甚至满配立即建仓，增持=分批小仓位挂确认条件，持有=不新开仓。")

    if n_sell > n_buy + n_ow:
        stance, pos, both = ("空头主导，市场环境很差",
                             "空仓止损，严格执行止损纪律，耐心等待右侧信号",
                             "空仓")
        strategy.append(f"市场判断：{stance}——近一周 买入 {n_buy} / 增持 {n_ow} / 中性 {n_hold} / 减持·卖出 {n_sell}（平均评级分 {avg:+.1f}）。")
        strategy.append("是否右侧：尚在左侧，不要抄底，不做的模式不做，等待放量收复关键均线再入场。")
    elif n_buy >= 2 and n_buy >= n_ow:
        stance, pos, both = ("多头主导，存在满配级信心标的，趋势右侧",
                             "80%-100%（满仓）：Buy 级标的立即标准/满配建仓，增持级标的分批介入，配合移动止盈",
                             "满仓")
        strategy.append(f"市场判断：{stance}——近一周 买入 {n_buy} / 增持 {n_ow} / 中性 {n_hold} / 减持·卖出 {n_sell}（平均评级分 {avg:+.1f}）。")
        strategy.append("是否右侧：多数标的处于右侧或右侧临界，可积极寻找入场机会；持仓标的若破位仍须立即止损。")
    elif n_buy + n_ow > 0:
        stance = "偏多但未达满配信心（以 Overweight/增持 为主）"
        pos = "20%-50% 分批小仓位介入，挂确认条件（放量突破 / 日线站上 MA5/MA10 / 回踩不破关键位），确认后逐步加仓"
        both = "空仓（增持只是可新开仓但需克制，未达满配信心宁缺毋滥）"
        strategy.append(f"市场判断：{stance}——近一周 买入 {n_buy} / 增持 {n_ow} / 中性 {n_hold} / 减持·卖出 {n_sell}（平均评级分 {avg:+.1f}）。")
        strategy.append("是否右侧：方向看多但证据未强到满配级，增持标的可新开仓但要分批、小仓位；持有级标的不新开仓。")
    else:
        stance, pos, both = ("中性 / 观望区，方向未明",
                             "0%-20% 试探仓或空仓观望，不做不适合自己的模式",
                             "空仓")
        strategy.append(f"市场判断：{stance}——近一周 买入 {n_buy} / 增持 {n_ow} / 中性 {n_hold} / 减持·卖出 {n_sell}。")
        strategy.append("是否右侧：缺乏明确右侧信号，只做已确认右侧的标的，其余观望。")

    strategy.append(f"仓位建议：{pos}。")
    strategy.append(f"若只有空仓和满仓两个选择：{both}。")
    if sell:
        bad = "、".join(e["ticker"] for _, e in sell[:5])
        strategy.append(f"风险纪律：{bad} 评级偏空，已持仓的立即严格执行止损，未持仓的不要接飞刀。")
    else:
        strategy.append("风险纪律：近一周暂无偏空标的，但仍需设好止损，防止利好变利空。")
    strategy.append(LADDER)
    strategy.append("（以上为基于近一周报告评级的规则化推断，不构成投资建议）")
    return brief, strategy


# ============ K 线拉取 + 执行计划点位提取（组合决策页图表用） ============

TENCENT_HOSTS = ("https://web.ifzq.gtimg.cn", "https://proxy.finance.qq.com/ifzqgtimg", "https://ifzq.gtimg.cn")


def _gateway_key() -> str:
    try:
        for line in TA_ENV.read_text(encoding="utf-8").splitlines():
            if line.startswith("OPENAI_COMPATIBLE_API_KEY="):
                return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return ""


def _qq_symbol(ticker: str) -> str | None:
    """159857.SZ -> sz159857; 601689.SS -> sh601689; 非 A 股返回 None"""
    m = re.match(r"^(\d{6})\.(SZ|SS|SH)$", ticker.upper())
    if not m:
        return None
    return ("sh" if m.group(2) in ("SS", "SH") else "sz") + m.group(1)


def fetch_kline(ticker: str, days: int = 200) -> list | None:
    """腾讯 fqkline 日线，返回 [[date,open,close,high,low,volume],...]（不复权，原始价）"""
    sym = _qq_symbol(ticker)
    if not sym:
        return None
    end = datetime.now()
    start = end - timedelta(days=days)
    param = f"{sym},day,{start:%Y-%m-%d},{end:%Y-%m-%d},640,"
    for host in TENCENT_HOSTS:
        try:
            req = urllib.request.Request(
                f"{host}/appstock/app/fqkline/get?param={param}",
                headers={"Referer": "https://gu.qq.com/", "User-Agent": "Mozilla/5.0"},
            )
            with urllib.request.urlopen(req, timeout=25) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            node = (payload.get("data") or {}).get(sym) or {}
            items = node.get("day") or node.get("qfqday")
            if items:
                return [[str(x[0])[:10], float(x[1]), float(x[2]), float(x[3]), float(x[4])] for x in items]
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            continue
    return None


PLAN_PROMPT = (
    "你是交易计划结构化助手。从 TradingAgents 报告的最终决策文本中提取所有关键交易价位，"
    '只输出 JSON，不要任何其他文字：{"levels":[{"type":"entry|trim|stop|clear|target|trigger|avoid",'
    '"price":数字,"price2":数字或null,"label":"不超过10字的中文短标签"}]}。\n'
    "type 含义：entry=建仓/买入位，trim=减仓位，stop=止损位，clear=清仓/清零线，"
    "target=止盈/目标位，trigger=加仓/翻多触发条件位，avoid=回避/重估线。\n"
    "区间（如 0.618-0.620）用 price+price2 表示；没有区间则 price2=null。"
    "最多 10 条，按价格从低到高排序；文本中没有明确价位则输出 {\"levels\":[]}。"
)


def llm_plan(text: str, session: str = "") -> list | None:
    """调 magpie 网关从决策文本提取点位；失败返回 None（由规则兜底）"""
    key = _gateway_key()
    if not key:
        return None
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if session:
        # magpie 会话归属：按报告 id 分组，usage 视图里可辨认，不散落在"无会话"桶
        headers["X-Magpie-Session"] = re.sub(r"[^\x20-\x7e]", "", session).strip("-") or "report-site-sync"
    body = json.dumps({
        "model": GATEWAY_MODEL,
        "temperature": 0,
        "messages": [{"role": "user", "content": PLAN_PROMPT + "\n\n---\n" + text[:6000]}],
    }).encode("utf-8")
    try:
        req = urllib.request.Request(
            f"{GATEWAY_BASE}/chat/completions",
            data=body,
            headers=headers,
        )
        with urllib.request.urlopen(req, timeout=90) as resp:
            content = json.loads(resp.read().decode("utf-8"))["choices"][0]["message"]["content"]
        m = re.search(r"\{.*\}", content, re.S)
        if not m:
            return None
        levels = json.loads(m.group(0)).get("levels") or []
        out = []
        for lv in levels:
            try:
                p = float(lv["price"])
                p2 = float(lv["price2"]) if lv.get("price2") is not None else None
            except (TypeError, ValueError, KeyError):
                continue
            if not (0 < p < 100000):
                continue
            if p2 is not None and not (0 < p2 < 100000):
                p2 = None
            out.append({"type": str(lv.get("type") or "entry"), "price": p, "price2": p2,
                        "label": str(lv.get("label") or "")[:16]})
        return out or None
    except (OSError, KeyError, IndexError, json.JSONDecodeError, ValueError):
        return None


PLAN_KEYWORDS = [
    ("clear", ("清仓", "清零", "全面回避", "无条件离场")),
    ("stop", ("止损", "强制减仓")),
    ("trigger", ("触发", "站稳", "突破", "确认", "翻多")),
    ("target", ("目标", "止盈", "第一目标")),
    ("trim", ("减仓", "减持到", "降到")),
    ("entry", ("建仓", "买入", "回踩", "低吸", "介入")),
]


def regex_plan(text: str, target: str) -> list:
    """规则兜底：关键词邻近匹配数字"""
    levels, seen = [], set()
    for typ, words in PLAN_KEYWORDS:
        for w in words:
            for m in re.finditer(re.escape(w) + r"[^0-9.\-]{0,12}(\d+\.\d+)", text):
                p = float(m.group(1))
                if p <= 0 or p in seen:
                    continue
                seen.add(p)
                levels.append({"type": typ, "price": p, "price2": None, "label": w})
    return levels or ([{"type": "target", "price": float(target), "price2": None, "label": "目标价"}] if target else [])


def build_aux(rid: str, ticker: str, dirpath: Path, entry: dict, stamp: str = "") -> None:
    """为报告生成辅助数据 site/data/kline/<id>.json：日K + 结构化点位。
    只给当日(运行日)报告生成, 历史报告直接跳过; 已生成的 json 直接复用。"""
    KLINE_DIR.mkdir(parents=True, exist_ok=True)
    out = KLINE_DIR / f"{rid}.json"
    if out.exists():
        entry["aux"] = f"data/kline/{rid}.json"
        return
    st = stamp_to_dt(stamp)
    if not st or st.date() != datetime.now().date():
        return  # 非当日报告：不拉 K 线、不调 LLM 提取点位
    aux = {"ticker": ticker, "candles": None, "plan": None}
    try:
        aux["candles"] = fetch_kline(ticker)
    except Exception as exc:  # noqa: BLE001
        print(f"  [K线失败] {ticker}: {exc}")
    decision = safe_read(dirpath / "5_portfolio" / "decision.md") or safe_read(dirpath / "complete_report.md")
    if decision:
        plan = llm_plan(decision, session=f"report-site-sync-{rid}")
        if not plan:
            plan = regex_plan(decision, entry.get("target") or "")
        if plan:
            plan.sort(key=lambda x: x["price"])
            aux["plan"] = plan
    if aux["candles"] or aux["plan"]:
        out.write_text(json.dumps(aux, ensure_ascii=False), encoding="utf-8")
        entry["aux"] = f"data/kline/{rid}.json"
        n = len(aux["candles"] or [])
        print(f"  [辅助] K线 {n} 根, 点位 {len(aux['plan'] or [])} 条")


def signature(dirpath: Path) -> dict:
    """目录内所有 .md 文件的签名表: 相对路径 -> size:mtime"""
    sig = {}
    for p in sorted(dirpath.rglob("*.md")):
        st = p.stat()
        sig[str(p.relative_to(dirpath))] = f"{st.st_size}:{int(st.st_mtime)}"
    return sig


def safe_read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def extract_meta(ticker: str, dirpath: Path, stamp: str) -> dict:
    meta = {
        "id": dirpath.name,
        "ticker": ticker,
        "name": "",
        "date": "",
        "rating": "",
        "generated": "",
        "target": "",
        "horizon": "",
        "summary": "",
        "stamp": stamp,
    }
    complete = dirpath / "complete_report.md"
    if complete.exists():
        text = safe_read(complete)
        m = re.search(r"分析日期[:：]\s*(\d{4}-\d{2}-\d{2})", text)
        if m:
            meta["date"] = m.group(1)
        m = re.search(r"^[-*]\s*评级[:：]\s*([^\n（(]+)", text, re.M)
        if m:
            meta["rating"] = m.group(1).strip()
        m = re.search(r"生成时间[:：]\s*([0-9:\- ]+)", text)
        if m:
            meta["generated"] = m.group(1).strip()
        m = re.search(re.escape(ticker) + r"（([^（）]+)）", text)
        if m:
            meta["name"] = m.group(1).strip()

    decision = dirpath / "5_portfolio" / "decision.md"
    if decision.exists():
        t = safe_read(decision)
        m = re.search(r"\*\*评级\*\*[:：]\s*([^\n（(]+)", t)
        if m and not meta["rating"]:
            meta["rating"] = m.group(1).strip()
        m = re.search(r"\*\*目标价\*\*[:：]\s*([^\n]+)", t)
        if m:
            meta["target"] = m.group(1).strip()
        m = re.search(r"\*\*期限\*\*[:：]\s*([^\n]+)", t)
        if m:
            meta["horizon"] = m.group(1).strip()
        m = re.search(r"\*\*执行摘要\*\*[:：]\s*([^\n]+)", t)
        if m:
            s = m.group(1).strip()
            meta["summary"] = (s[:150] + "…") if len(s) > 150 else s
    return meta


def collect_files(dirpath: Path) -> dict:
    """收集报告内的 md 文件清单, 按阶段组织。"""
    files = {}
    complete = dirpath / "complete_report.md"
    if complete.exists():
        files["complete"] = {"path": "complete_report.md", "label": "完整报告"}
    for key, _label, sub in SECTIONS:
        sub_dir = dirpath / sub
        if not sub_dir.is_dir():
            continue
        items = []
        for md in sorted(sub_dir.glob("*.md")):
            stem = md.stem
            items.append({
                "path": f"{sub}/{md.name}",
                "label": SUB_LABELS.get(stem, stem),
            })
        if items:
            files[key] = items
    return files


def copy_report(dirpath: Path, out_dir: Path) -> int:
    """拷贝目录内所有 md 文件到输出目录, 返回拷贝的文件数。"""
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    n = 0
    for md in dirpath.rglob("*.md"):
        rel = md.relative_to(dirpath)
        dest = out_dir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(md, dest)
        n += 1
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description="增量同步 TradingAgents 报告到静态网站")
    ap.add_argument("--full", action="store_true", help="全量重建")
    ap.add_argument("--src", default=str(SRC), help="报告源目录")
    ap.add_argument("--keep-days", type=int, default=3,
                    help="站点只保留最近 N 天的报告（按目录名日期，含今天），0=不限制；默认 3")
    args = ap.parse_args()
    src = Path(args.src)

    if not src.is_dir():
        print(f"[错误] 源目录不存在: {src}", file=sys.stderr)
        return 1

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {}
    if MANIFEST.exists() and not args.full:
        try:
            manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            manifest = {}
    if args.full and REPORTS_OUT.exists():
        shutil.rmtree(REPORTS_OUT)
    REPORTS_OUT.mkdir(parents=True, exist_ok=True)

    report_dirs = [d for d in sorted(src.iterdir()) if d.is_dir() and DIR_RE.match(d.name)]
    if not report_dirs:
        print(f"[警告] 源目录中没有匹配的报告目录: {src}", file=sys.stderr)
        return 1

    # 保留窗口：只保留最近 keep_days 天的报告（静态站点瘦身，加快 sync/deploy）
    if args.keep_days > 0:
        cutoff = (datetime.now() - timedelta(days=args.keep_days - 1)).date()
        kept, dropped = [], 0
        for d in report_dirs:
            m = DIR_RE.match(d.name)
            dt = stamp_to_dt(m.group("stamp"))
            if dt and dt.date() >= cutoff:
                kept.append(d)
            else:
                dropped += 1
        report_dirs = kept
        print(f"[窗口] 保留 {cutoff:%Y-%m-%d} 起的报告 {len(kept)} 份，跳过更早 {dropped} 份")

    entries = []
    copied = skipped = removed = 0

    for d in report_dirs:
        rid = d.name
        m = DIR_RE.match(rid)
        sig = signature(d)
        if manifest.get(rid, {}).get("sig") == sig:
            skipped += 1
            entry = manifest[rid]["entry"]
            # 兜底：当日报告的 aux 缺失(被删/上次生成失败)则补生成; 历史报告不补
            st = stamp_to_dt(m.group("stamp"))
            if (st and st.date() == datetime.now().date()
                    and not (KLINE_DIR / f"{rid}.json").exists()):
                build_aux(rid, entry["ticker"], d, entry, m.group("stamp"))
            entries.append(entry)
            continue
        n = copy_report(d, REPORTS_OUT / rid)
        meta = extract_meta(m.group("ticker"), d, m.group("stamp"))
        entry = {**meta, "files": collect_files(d)}
        build_aux(rid, entry["ticker"], d, entry, m.group("stamp"))
        entries.append(entry)
        manifest[rid] = {"sig": sig, "entry": entry}
        copied += 1
        print(f"[同步] {rid}  ({n} 个 md 文件)")

    # 清理源目录中已删除的报告，以及滑出保留窗口的报告
    # （一律 shutil.move 归档到 ARCHIVE_DIR，不 rmtree：rename 不触发
    #   WorkBuddy 安全删除钩子的批量删除阈值，历史数据也可随时找回）
    valid_ids = {d.name for d in report_dirs}
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    for rid in list(manifest.keys()):
        if rid not in valid_ids:
            manifest.pop(rid)
            out_dir = REPORTS_OUT / rid
            if out_dir.exists():
                shutil.move(str(out_dir), str(ARCHIVE_DIR / rid))
            kline_json = KLINE_DIR / f"{rid}.json"
            if kline_json.exists():
                shutil.move(str(kline_json), str(ARCHIVE_DIR / f"{rid}.json"))
            removed += 1
            print(f"[归档] {rid}")

    entries.sort(key=lambda e: e.get("stamp", ""), reverse=True)

    brief, strategy = build_brief_and_strategy(entries)

    INDEX_JSON.write_text(
        json.dumps({"generatedAt": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
                    "source": str(src), "count": len(entries),
                    "brief": brief, "strategy": strategy,
                    "reports": entries},
                   ensure_ascii=False, indent=1),
        encoding="utf-8")
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")

    print(f"\n完成: 新同步 {copied}, 跳过(无变化) {skipped}, 归档 {removed}, 共 {len(entries)} 份报告")
    print(f"数据文件: {INDEX_JSON}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
