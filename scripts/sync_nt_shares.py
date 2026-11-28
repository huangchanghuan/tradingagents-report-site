#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
国家队份额监控数据管道（宽基 ETF 申赎）。
数据源：上交所官方零鉴权接口（一次请求=全市场 ETF 当日规模，含份额 TOT_VOL 万份），
存档自 2015 年起完整；仅覆盖沪市（5 开头），深市 ETF（159 开头）不在口径内。

用法:
    python3 scripts/sync_nt_shares.py            # 增量：补最近缺失交易日 + 缺失月份
    python3 scripts/sync_nt_shares.py --backfill # 全量：重建月频历史（约 3~5 分钟）
    python3 scripts/sync_nt_shares.py --days 60  # 日频回补窗口加宽

输出: site/data/nt_shares.json（sync.py 每次同步会自动调用本脚本）
"""
import argparse
import json
import random
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
OUT_JSON = SITE / "data" / "nt_shares.json"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
SSE_URL = "https://query.sse.com.cn/commonQuery.do"
TENCENT_HOSTS = ("https://web.ifzq.gtimg.cn", "https://proxy.finance.qq.com/ifzqgtimg", "https://ifzq.gtimg.cn")

# 监控篮子：全部为沪市宽基（历史上被汇金明确持有并公示过的大额品种）
BASKET = {
    "510300": "沪深300ETF华泰柏瑞",
    "510310": "沪深300ETF易方达",
    "510330": "沪深300ETF华夏",
    "510050": "上证50ETF华夏",
    "510500": "中证500ETF南方",
    "512100": "中证1000ETF南方",
    "588000": "科创50ETF华夏",
}
CAL_SYMBOL = "sh510300"  # 用 510300 日线当交易日历
MONTHLY_START = "2015-01-01"
DAILY_WINDOW = 45  # 日频序列保留的交易日数


def _http_json(url, params, referer, timeout=25, retries=3):
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    for i in range(retries):
        try:
            req = urllib.request.Request(f"{url}?{qs}", headers={"User-Agent": UA, "Referer": referer})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (OSError, ValueError, json.JSONDecodeError):
            time.sleep(1.5 * (i + 1))
    return None


def sse_shares(day: str) -> dict | None:
    """上交所 ETF 规模归档：返回 {code: 份额(万份)}；该日无数据返回 None"""
    d = _http_json(SSE_URL, {
        "sqlId": "COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L",
        "STAT_DATE": day, "isPagination": "true", "pageHelp.pageSize": 10000,
        "pageHelp.pageNo": 1, "pageHelp.beginPage": 1, "pageHelp.cacheSize": 1, "pageHelp.endPage": 1,
    }, "https://www.sse.com.cn/")
    if not d or not d.get("result"):
        return None
    out = {}
    for rec in d["result"]:
        code = rec.get("SEC_CODE") or ""
        v = rec.get("TOT_VOL")
        if code in BASKET and v not in (None, "", "-"):
            try:
                out[code] = float(str(v).replace(",", ""))
            except ValueError:
                continue
    return out or None


def tencent_calendar(start: str, end: str) -> list:
    """腾讯日线只当交易日历用（不复权无所谓），返回 [date,...]"""
    dates = {}
    cur = datetime.strptime(start, "%Y-%m-%d").date()
    stop = datetime.strptime(end, "%Y-%m-%d").date()
    while cur <= stop:
        w_end = min(cur + timedelta(days=699), stop)
        param = f"{CAL_SYMBOL},day,{cur:%Y-%m-%d},{w_end:%Y-%m-%d},640,"
        payload = None
        for host in TENCENT_HOSTS:
            payload = _http_json(f"{host}/appstock/app/fqkline/get", {"param": param},
                                 "https://gu.qq.com/", timeout=25, retries=2)
            if payload and payload.get("data"):
                break
            time.sleep(1)
        node = (payload or {}).get("data", {}).get(CAL_SYMBOL) or {}
        for it in (node.get("day") or node.get("qfqday") or []):
            dates[str(it[0])[:10]] = True
        cur = w_end + timedelta(days=1)
        time.sleep(0.5)
    return sorted(dates)


def load_state() -> dict:
    if OUT_JSON.exists():
        try:
            return json.loads(OUT_JSON.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {"etfs": {k: v for k, v in BASKET.items()}, "daily": {}, "monthly": {}, "updated": ""}


def save_state(st: dict):
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    st["etfs"] = {k: v for k, v in BASKET.items()}
    st["generatedAt"] = datetime.now().isoformat(timespec="seconds")
    OUT_JSON.write_text(json.dumps(st, ensure_ascii=False, indent=0), encoding="utf-8")


def ensure_monthly(st: dict, force: bool = False):
    """月频历史（每月首个交易日采样，510300 长周期主口径）。只补缺失月份。"""
    today = date.today().isoformat()
    have_months = set(st.get("monthly", {}).keys())
    all_months = []
    y, m = 2015, 1
    while (y, m) <= (date.today().year, date.today().month):
        all_months.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            y, m = y + 1, 1
    missing = [x for x in all_months if force or x not in have_months]
    if not missing:
        return 0
    print(f"[月频] 缺 {len(missing)} 个月，拉交易日历…")
    cal = tencent_calendar(MONTHLY_START, today)
    month_first = {}
    for d in cal:
        ym = d[:7]
        if ym not in month_first and ym in set(missing):
            month_first[ym] = d
    todo = {month_first[ym]: ym for ym, d in month_first.items()}
    print(f"[月频] 采样 {len(todo)} 个日期（每请求约0.5s，预计 {len(todo) * 0.6:.0f} 秒）")
    n = 0
    for i, (d, ym) in enumerate(sorted(todo.items())):
        got = sse_shares(d)
        if got and "510300" in got:
            st.setdefault("monthly", {})[ym] = {"date": d, "shares": got}
            n += 1
        if i % 20 == 19:
            print(f"  … {i + 1}/{len(todo)}")
        time.sleep(0.4 + random.uniform(0, 0.2))
    return n


def ensure_daily(st: dict, days: int):
    """日频增量：最近 N 个交易日，逐日补缺失（一次请求拿全篮子）。"""
    end = date.today()
    start = end - timedelta(days=days * 2 + 10)
    cal = tencent_calendar(start.isoformat(), end.isoformat())
    todo = [d for d in cal[-days:] if d not in st.get("daily", {})]
    if not todo:
        return 0
    print(f"[日频] 补 {len(todo)} 个交易日: {todo[0]} ~ {todo[-1]}")
    n = 0
    for d in todo:
        got = sse_shares(d)
        if got:
            st.setdefault("daily", {})[d] = got
            n += 1
        else:
            st.setdefault("daily", {})[d] = {}  # 占位避免反复重试（节假日/未归档）
        time.sleep(0.4 + random.uniform(0, 0.2))
    # 滑窗：只保留最近 DAILY_WINDOW 个有数据的交易日
    keys = sorted(k for k, v in st.get("daily", {}).items() if v)
    for k in keys[:-DAILY_WINDOW]:
        st["daily"].pop(k, None)
    return n


def build_series(st: dict) -> dict:
    """给前端的预计算序列（亿份）。"""
    yi = lambda w: round(w / 1e4, 2)

    monthly = [[v["date"], yi(v["shares"]["510300"])]
               for k, v in sorted(st.get("monthly", {}).items()) if "510300" in v.get("shares", {})]
    daily = {code: [[d, yi(v[code])] for d, v in sorted(st.get("daily", {}).items()) if code in v]
             for code in BASKET}

    basket = []
    for code, name in BASKET.items():
        ser = daily.get(code) or []
        if not ser:
            continue
        latest = ser[-1][1]

        def pick(n):
            return round(ser[-1][1] - ser[-1 - n][1], 1) if len(ser) > n else None

        basket.append({
            "code": code, "name": name, "latest": latest,
            "chg5": pick(5), "chg20": pick(20), "points": len(ser),
        })
    updated = max([d for d, _ in daily.get("510300", [])] or [""])
    return {"monthly510300": monthly, "daily": daily, "basket": basket, "updated": updated}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill", action="store_true", help="强制重建月频历史")
    ap.add_argument("--days", type=int, default=DAILY_WINDOW, help="日频回补窗口（交易日）")
    args = ap.parse_args()

    st = load_state()
    n_m = ensure_monthly(st, force=args.backfill)
    n_d = ensure_daily(st, args.days)
    ser = build_series(st)
    st["series"] = ser
    st["updated"] = ser["updated"]
    save_state(st)
    print(f"[完成] 月频+{n_m} 日频+{n_d}；最新 {st['updated']}，"
          f"510300={ser['basket'][0]['latest'] if ser['basket'] else '?'}亿份，输出 {OUT_JSON}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
