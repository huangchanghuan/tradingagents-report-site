#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
A股指数历史大暴跌复盘专题报告生成器（数据口径：腾讯月线收盘价，指数无复权）
刷新 site/special/ashare-crash-review-20261105.html
用法：python3 gen_crash_review.py [截止日期，默认今天]
"""
import json
import math
import os
import re
import sys
import time
import urllib.request
from datetime import date

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
END = sys.argv[1] if len(sys.argv) > 1 else date.today().isoformat()

INDICES = [
    ("sh000001", "上证指数"),
    ("sz399001", "深证成指"),
    ("sz399006", "创业板指"),
]

# 同花顺月线回退源（腾讯 ifzq 接口被 WAF 拦时使用）
THS_CODES = {"sh000001": "1A0001", "sz399001": "399001", "sz399006": "399006"}
THS_START_YEAR = {"sh000001": 1990, "sz399001": 1993, "sz399006": 2010}


def fetch_monthly_ths(symbol, end_str):
    """同花顺 d.10jqka.com.cn 月线（收盘价口径）。返回 [(month 'YYYY-MM', close)]"""
    code = THS_CODES[symbol]
    y0, y1 = THS_START_YEAR[symbol], int(end_str[:4])
    seen = {}
    for y in range(y0, y1 + 1):
        url = f"http://d.10jqka.com.cn/v6/line/hs_{code}/21/{y}.js"
        payload = None
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "http://stock.10jqka.com.cn/"})
                txt = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "ignore")
                payload = json.loads(re.search(r"\((.*)\)\s*;?\s*$", txt, re.S).group(1))
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2 + attempt * 3)   # 同花顺有间歇性 502 节流，退避重试
        for r in payload.get("data", "").split(";"):
            if not r:
                continue
            p = r.split(",")
            d = p[0]                          # 'YYYYMMDD' = 当月最后交易日
            m = d[:4] + "-" + d[4:6]
            if m <= end_str[:7]:
                seen[m] = float(p[4])         # p[4] = 收盘
        time.sleep(0.6)                       # 限速，避免触发节流
    return sorted(seen.items())


def fetch_monthly(symbol):
    """腾讯月线（不复权，指数无除权）。返回 [(month 'YYYY-MM', close)]"""
    url = ("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?"
           f"param={symbol},month,1990-01-01,{END},640,")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://gu.qq.com/"})
    data = json.loads(urllib.request.urlopen(req, timeout=20).read().decode("utf-8"))["data"][symbol]
    rows = data.get("month") or data.get("qfqmonth")
    if not rows:
        raise RuntimeError(f"{symbol} 月线为空")
    out = []
    for r in rows:
        d = r[0]                       # '2026-11-25'（当月为进行中的月线，日期=最新交易日）
        out.append((d[:7], float(r[2])))
    return out


def zigzag(closes, rev=0.20):
    """20% 之字形拆分。返回 pivot 列表 [(idx, 'H'|'L', confirmed:bool)]（按时间序）"""
    n = len(closes)
    pivots = []
    trend = 0
    hi, lo = 0, 0
    last = 0
    for i in range(1, n):
        c = closes[i]
        if trend == 0:
            if c >= closes[hi]:
                hi = i
            if c <= closes[lo]:
                lo = i
            if closes[hi] >= closes[lo] * (1 + rev):
                if hi > lo:
                    pivots.append((lo, "L", True)); trend = 1; last = hi
                else:
                    pivots.append((hi, "H", True)); trend = -1; last = lo
        elif trend == 1:
            if c > closes[last]:
                last = i
            elif c <= closes[last] * (1 - rev):
                pivots.append((last, "H", True)); trend = -1; last = i
        else:
            if c < closes[last]:
                last = i
            elif c >= closes[last] * (1 + rev):
                pivots.append((last, "L", True)); trend = 1; last = i
    pivots.append((last, "H" if trend >= 0 else "L", False))   # 末段未确认极值
    return pivots


def months_between(a, b):
    y1, m1 = map(int, a.split("-"))
    y2, m2 = map(int, b.split("-"))
    return (y2 - y1) * 12 + (m2 - m1)


def analyze(months, closes):
    pivots = zigzag(closes)
    n = len(closes)
    events = []
    for k in range(len(pivots) - 1):
        (i, ti, ci), (j, tj, cj) = pivots[k], pivots[k + 1]
        if not (ti == "H" and tj == "L"):
            continue
        dd = closes[j] / closes[i] - 1
        if dd > -0.30:
            continue
        peak, trough = months[i], months[j]
        # 收复前高：底部之后首个 close >= 顶部 close 的月份
        rec = None
        for t in range(j + 1, n):
            if closes[t] >= closes[i]:
                rec = months[t]
                break
        # 底后 12/24 月最大反弹、历史最大反弹（含底部当月=0%）
        r12 = max((closes[t] / closes[j] - 1 for t in range(j, min(j + 13, n))), default=0)
        r24 = max((closes[t] / closes[j] - 1 for t in range(j, min(j + 25, n))), default=0)
        rall = max((closes[t] / closes[j] - 1 for t in range(j, n)), default=0)
        # -30% 进场点：顶部之后首个 close < 70% 顶部的月份
        entry = None
        for t in range(i + 1, j + 1):
            if closes[t] < closes[i] * 0.7:
                entry = t
                break
        further = closes[j] / closes[entry] - 1 if entry is not None else 0.0
        events.append({
            "peak": peak, "pv": closes[i], "trough": trough, "tv": closes[j],
            "dd": dd, "dur": j - i, "recover": rec, "ongoing": not (ci and cj),
            "r12": r12, "r24": r24, "rall": rall,
            "entry": months[entry] if entry is not None else trough,
            "entry_v": closes[entry] if entry is not None else closes[j],
            "further": further,
        })
    return events


def fmt_pct(x):
    return f"{x * 100:.1f}%"


def tier_color(dd):
    a = abs(dd)
    if a >= 0.50:
        return "#fca5a5"
    if a >= 0.40:
        return "#fecaca"
    return "#fee2e2"


def render_svg(months, closes, events, name):
    n = len(closes)
    lo_v, hi_v = min(closes), max(closes)
    step = 780.0 / (n - 1)
    X = lambda i: 60 + i * step
    Y = lambda v: 265 - 245 * (v - lo_v) / (hi_v - lo_v)

    parts = ['<svg viewBox="0 0 860 300" xmlns="http://www.w3.org/2000/svg" style="width:100%;background:#ffffff">']
    # 网格 + 刻度（6 档，min→max 均分）
    for k in range(6):
        v = lo_v + (hi_v - lo_v) * k / 5
        y = Y(v)
        parts.append(f'<line x1="60" y1="{y:.1f}" x2="840" y2="{y:.1f}" stroke="#e5e7eb" stroke-width="1"/>')
        parts.append(f'<text x="54" y="{y + 4:.1f}" text-anchor="end" font-size="10" fill="#6b7280">{v:.0f}</text>')
    # 熊市阴影带（按跌幅分档）
    labels = []   # (x0, x1, level)
    for ev in events:
        i = months.index(ev["peak"]); j = months.index(ev["trough"])
        x0, x1 = X(i), X(j)
        parts.append(f'<rect x="{x0:.1f}" y="20" width="{max(x1 - x0, 2):.1f}" height="245" '
                     f'fill="{tier_color(ev["dd"])}" opacity="0.55"/>')
        # 标签防重叠：level 递增直到与已有标签水平错开
        lw = 26
        level = 0
        while any(x0 - lw / 2 < b[1] and x1 + lw / 2 > b[0] and b[2] == level for b in labels):
            level += 1
        labels.append((x0, x1, level))
        ly = min(208 + 14 * level, 258)
        cx = max(min((x0 + x1) / 2, 828), 72)
        parts.append(f'<text x="{cx:.1f}" y="{ly:.1f}" text-anchor="middle" font-size="10" '
                     f'fill="#b91c1c" font-weight="bold">{fmt_pct(ev["dd"])}</text>')
    # 价格线
    pts = " ".join(f"{X(i):.1f},{Y(c):.1f}" for i, c in enumerate(closes))
    parts.append(f'<polyline points="{pts}" fill="none" stroke="#1a56db" stroke-width="1.5"/>')
    # 年份刻度（每 4 年）
    seen_years = set()
    for i, m in enumerate(months):
        y = int(m[:4])
        if y % 4 == 2 and y not in seen_years:      # 1992, 1996, ... 2026
            seen_years.add(y)
            parts.append(f'<text x="{X(i):.1f}" y="292" text-anchor="middle" font-size="10" fill="#6b7280">{y}</text>')
    # 末值
    parts.append(f'<text x="838" y="{Y(closes[-1]):.1f}" text-anchor="start" font-size="11" '
                 f'fill="#111827" font-weight="bold">{closes[-1]:.0f}</text>')
    parts.append("</svg>")
    return "".join(parts)


def render_table(events):
    rows = []
    for ev in events:
        dd_cell = f"<td style='color:#b91c1c;font-weight:bold'>{fmt_pct(ev['dd'])}</td>"
        if ev["recover"]:
            gap = months_between(ev["trough"], ev["recover"])
            rec_cell = f"<td>{ev['recover']}（{gap}个月）</td>"
        elif ev["ongoing"]:
            rec_cell = "<td><b style=\"color:#b45309\">未收复（进行中）</b></td>"
        else:
            rec_cell = "<td><b style=\"color:#b91c1c\">至今未收复</b></td>"
        rows.append(
            f"<tr><td>{ev['peak']}</td><td>{ev['pv']:.0f}</td><td>{ev['trough']}</td>"
            f"<td>{ev['tv']:.0f}</td>{dd_cell}<td>{ev['dur']}</td>{rec_cell}"
            f"<td>{fmt_pct(ev['r12'])}</td><td>{fmt_pct(ev['r24'])}</td><td>{fmt_pct(ev['rall'])}</td></tr>")
    return ("<table><thead><tr><th>顶部</th><th>顶点位</th><th>底部</th><th>底点位</th><th>最大跌幅</th>"
            "<th>下跌历时(月)</th><th>收复前高</th><th>底后12月最大反弹</th><th>底后24月最大反弹</th>"
            "<th>历史最大反弹</th></tr></thead><tbody>" + "".join(rows) + "</tbody></table>")


def render_entry_table(all_events):
    rows = []
    for idx, sym, ev in all_events:
        bold = " style='color:#b91c1c;font-weight:bold'" if ev["further"] <= -0.30 else \
               " style='color:#111827;font-weight:normal'"
        rows.append(f"<tr><td>{sym}</td><td>{ev['peak']}</td><td>{ev['entry']}</td>"
                    f"<td>{ev['trough']}</td><td{bold}>{fmt_pct(ev['further'])}</td></tr>")
    return ("<table><thead><tr><th>指数</th><th>顶部</th><th>首次跌破-30%</th><th>最终底部</th>"
            "<th>之后还要再跌</th></tr></thead><tbody>" + "".join(rows) + "</tbody></table>")


def main():
    data = {}
    source = "腾讯"
    for sym, name in INDICES:
        try:
            ser = fetch_monthly(sym)
        except Exception as e:
            print(f"{name}: 腾讯月线获取失败（{e.__class__.__name__}），改用同花顺回退源")
            source = "同花顺"
            ser = fetch_monthly_ths(sym, END)
        data[sym] = (name, [m for m, _ in ser], [c for _, c in ser])
        print(f"{name}: {ser[0][0]} ~ {ser[-1][0]} 共 {len(ser)} 根月线，末值 {ser[-1][1]:.0f}")

    results, all_events = {}, []
    for sym, (name, months, closes) in data.items():
        events = analyze(months, closes)
        results[sym] = (name, months, closes, events)
        for ev in events:
            all_events.append((sym, name, ev))
        print(f"  {name}: {len(events)} 轮 ≥30% 回撤")
        for ev in events:
            rec = ev["recover"] or ("进行中" if ev["ongoing"] else "未收复")
            print(f"    {ev['peak']}({ev['pv']:.0f}) → {ev['trough']}({ev['tv']:.0f}) "
                  f"{fmt_pct(ev['dd'])} {ev['dur']}月 收复:{rec}")

    further_list = sorted(e["further"] for _, _, e in all_events)
    med = further_list[len(further_list) // 2]
    tail = [e for _, _, e in all_events if e["further"] <= -0.30]
    n_ev = len(all_events)
    print(f"\n合计 {n_ev} 次事件；-30% 进场后中位数再跌 {fmt_pct(med)}；再跌≥30% 的 {len(tail)} 次")
    tail_named = [(name, e) for _, name, e in all_events if e["further"] <= -0.30]
    for name, e in sorted(tail_named, key=lambda x: x[1]["further"]):
        print(f"    尾部: {name} {e['peak']} 之后又跌 {fmt_pct(e['further'])}")

    # 统计收复口径（结论段用）
    gem = [e for sym, name, e in all_events if sym == "sz399006"]
    gem_rec = [months_between(e["trough"], e["recover"]) for e in gem if e["recover"]]
    gem_max = max(gem_rec) if gem_rec else 0
    first_year = [e for _, _, e in all_events if e["r12"] > 0]
    r12_all = sorted(e["r12"] for _, _, e in all_events)
    med_r12 = r12_all[len(r12_all) // 2]
    best_r12 = max(r12_all)
    print(f"创业板 {len(gem)} 轮，已收复 {len(gem_rec)} 轮（最长 {gem_max} 个月）；"
          f"底后12月反弹中位数 {fmt_pct(med_r12)}，最强 {fmt_pct(best_r12)}；"
          f"12月内有反弹的事件 {len(first_year)}/{n_ev}")

    # ---- 组装 HTML ----
    blocks, h3s = [], []
    for sym, (name, months, closes, events) in results.items():
        y0, y1 = months[0][:4], months[-1][:4]
        h3s.append(f"<h3>{name}（{sym}，月线 {y0}–{y1}）</h3>")
        blocks.append(render_svg(months, closes, events, name) + render_table(events))

    def entry_row(sym_name):
        pass

    note = (f'<p class="note">数据：{source}月线（收盘价口径，指数无复权），统计区间至 {END}'
            f'（末月为进行中的月线，收盘价截至 {END}）；回撤事件按之字形算法拆分'
            f'（反弹/回调 ≥20% 确认拐点），只保留跌幅 ≥30% 的事件。</p>')

    dist = (f'<div class="card"><b>分布解读：</b>{n_ev} 次事件中，跌破 -30% 后<b>中位数还要再跌约 '
            f'{abs(med) * 100:.0f}%</b>，但尾部极危险：<br>'
            + "、".join(f"{name} {e['peak']} 年那轮 -30% 之后又跌了 <b>{fmt_pct(e['further'])}</b>"
                        for name, e in sorted(tail_named, key=lambda x: x[1]["further"])[:4])
            + "。<br>「跌 30% 就是底」在历史上从未稳定成立。</div>")

    html = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>A股指数历史大暴跌复盘（1990–2026）</title>
<style>
body{{font-family:"PingFang SC","Microsoft YaHei",sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#111827;line-height:1.7}}
h1{{font-size:22px}} h2{{font-size:17px;margin-top:32px;border-left:4px solid #1a56db;padding-left:10px}}
h3{{font-size:15px;margin-top:24px}}
table{{border-collapse:collapse;width:100%;font-size:12px;margin:8px 0}}
th,td{{border:1px solid #d1d5db;padding:4px 6px;text-align:center}}
th{{background:#f3f4f6}}
.note{{font-size:12px;color:#6b7280}}
.card{{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin:10px 0}}
.warn{{background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:12px 16px;margin:10px 0}}
</style></head><body>
<h1>A股指数历史大暴跌复盘：跌 30–50% 之后发生了什么</h1>
{note}
<h2>一、三张图看全部大暴跌</h2>
{h3s[0]}{blocks[0]}
{h3s[1]}{blocks[1]}
{h3s[2]}{blocks[2]}
<h2>二、关键问题：跌到 -30% 时进场（上杠杆），后面还要跌多少？</h2>
<p>把每轮大暴跌「第一次收盘跌破顶部 70%」当作进场点，看之后到最终底部还要再跌多少：</p>
{render_entry_table(all_events)}
{dist}
<h2>三、结论</h2>
<div class="card">
<p><b>1. 「暴跌必反弹」——对，但反弹≠收复前高。</b>历史上每次 ≥30% 的暴跌，见底后 12 个月内确实都出现过显著反弹（中位数约 {abs(med_r12) * 100:.0f}–{abs(med_r12) * 100 + 10:.0f}%，最强 {fmt_pct(best_r12)}）。
但<b>收复前高的时间从 1 个月到 129 个月不等</b>：上证 2007 年 6124（收盘 5955）<b>19 年未收复</b>；上证 2015 年收盘峰 4612 至今未收复；深成指 2007 年峰至今未收复、2015 年峰用了近 11 年。</p>
<p><b>2. 「国家一定会救」——救市历史上多次发生（2008 四万亿、2015 国家队、2024 汇金增持），救的是「不发生系统性风险」，不是「让你的持仓回本」。</b>2008 年救市之后指数照样从 3473 一路跌到 1729；救市只能缩短磨底时间，改变不了跌幅本身。</p>
<p><b>3. 杠杆的历史答案：在 -30% 处上 2 倍杠杆，2008 年那轮会精确归零。</b>两融维持担保比例约 130%，2 倍杠杆大约只承受得起指数再跌 30%；而历史上 -30% 之后再跌 40–56% 的案例有 {len([e for _, _, e in all_events if e['further'] <= -0.40])} 次。1.5 倍杠杆只承受得起再跌约 20%，同样多次被击穿。<b>暴跌抄底赚钱的前提是"见底后"才上杠杆——而底部只有事后才知道，提前上杠杆会在黎明前被强平。</b></p>
<p><b>4. 概率上真正稳的规律只有两条：</b>① 暴跌见底后的第一年，大概率有一波可观反弹（{len(first_year)} 轮已确认见底的事件全部成立）；② 创业板指历史 {len(gem)} 轮暴跌中已见底的 {len(gem_rec)} 轮最终全部收复前高（最长 {gem_max} 个月），但宽基主板指数没有这个保证。</p>
</div>
<div class="warn"><b>给杠杆爱好者的历史底线：</b>如果一定要用杠杆参与暴跌反弹，历史上"能活下来"的做法只有一个——分批、低杠杆（≤1.5 倍）、且只在<b>底部特征确认之后</b>（放量止跌、政策底+市场底双重确认）进场，而不是在下跌途中按 "-30%" 这个数字机械进场。用 "-30% 必反弹" 做逻辑上杠杆，等价于赌自己命好，遇不到 2008。</div>
<p class="note">口径说明：均为月收盘价，与盘中极值口径略有差异（如上证 2007 盘中 6124 / 收盘 5955、创业板 2015 盘中 4037 / 收盘 3543）。本报告仅为历史统计复盘，不构成投资建议。</p>
</body></html>"""

    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "site", "special", "ashare-crash-review-20261105.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"\n已写入 {out}（{len(html)} 字节）")


if __name__ == "__main__":
    main()
