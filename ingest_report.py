#!/usr/bin/env python3
"""把生成的 md 报告收录进 TradingAgents 报告站。

供 etf-analysis / stock-pool-scan-v2 等分析 skill 在报告生成后调用，
替代原来的"上传腾讯文档"归档方式。

用法:
    python3 ingest_report.py <报告.md> [--title "标题"] [--kind "分类"] [--url "原文链接"]

行为:
    1. 生成唯一 id（时间戳 + 内容哈希，天然不覆盖）;
    2. 复制 md 到 site/tdocs/<id>.md;
    3. 解析日期、自动分类，更新 site/data/tdocs.json 与 manifest。
"""

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SITE = ROOT / "site"
TDOCS_OUT = SITE / "tdocs"
DATA_DIR = SITE / "data"
MANIFEST = DATA_DIR / "tdocs_manifest.json"
INDEX_JSON = DATA_DIR / "tdocs.json"

DATE_RE = re.compile(r"(\d{4}-\d{1,2}-\d{1,2})")
DATE_COMPACT_RE = re.compile(r"(\d{8})")


def parse_date(title: str) -> str:
    m = DATE_RE.search(title)
    if m:
        parts = m.group(1).split("-")
        return f"{parts[0]}-{int(parts[1]):02d}-{int(parts[2]):02d}"
    m = DATE_COMPACT_RE.search(title)
    if m:
        s = m.group(1)
        return f"{s[:4]}-{s[4:6]}-{s[6:8]}"
    return ""


def classify(title: str) -> str:
    low = title.lower()
    if "stock-pool" in low:
        return "股票池扫描"
    if "finance" in low:
        return "Finance 报告"
    if "etf" in low:
        return "ETF 技术分析"
    return "其他报告"


def main() -> int:
    ap = argparse.ArgumentParser(description="收录 md 报告到报告站")
    ap.add_argument("source", help="报告 md 文件路径")
    ap.add_argument("--title", default="", help="报告标题（默认用文件名）")
    ap.add_argument("--kind", default="", help="分类（默认按标题自动识别）")
    ap.add_argument("--url", default="", help="原文链接（可选）")
    args = ap.parse_args()

    src = Path(args.source).expanduser()
    if not src.is_file():
        print(f"[错误] 文件不存在: {src}", file=sys.stderr)
        return 1
    text = src.read_text(encoding="utf-8", errors="replace")
    if not text.strip():
        print("[错误] 文件内容为空", file=sys.stderr)
        return 1

    title = (args.title or src.stem).strip()
    kind = args.kind or classify(title)
    date = parse_date(title) or datetime.now().strftime("%Y-%m-%d")

    TDOCS_OUT.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    doc_id = f"local-{datetime.now():%Y%m%d-%H%M%S}-{hashlib.md5(text.encode()).hexdigest()[:6]}"
    dest = TDOCS_OUT / f"{doc_id}.md"
    dest.write_text(text.replace("\r\n", "\n"), encoding="utf-8")

    entry = {"id": doc_id, "title": title, "url": args.url,
             "kind": kind, "date": date, "path": f"tdocs/{doc_id}.md"}

    manifest = {}
    if MANIFEST.exists():
        try:
            manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            manifest = {}
    manifest[doc_id] = {"title": title, "entry": entry}

    docs = [v["entry"] for v in manifest.values()]
    docs.sort(key=lambda d: d.get("date") or "0000-00-00", reverse=True)

    INDEX_JSON.write_text(
        json.dumps({"generatedAt": datetime.now().isoformat(timespec="seconds"),
                    "count": len(docs), "docs": docs},
                   ensure_ascii=False, indent=1),
        encoding="utf-8")
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")

    print(f"[收录成功] {title}")
    print(f"  分类: {kind} | 日期: {date} | 字符数: {len(text)}")
    print(f"  文件: {dest}")
    print(f"  索引: {INDEX_JSON} (共 {len(docs)} 篇)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
