#!/usr/bin/env python3
"""
增量拉取腾讯文档「finance / stock-pool-scan 报告」文件夹 -> 静态网站数据。

依赖: mcporter 命令行（配置 ~/.mcporter/mcporter.json，tencent-docs 服务）。
用法:
    python3 sync_docs.py            # 增量同步（只拉新文档 / 标题变更的文档）
    python3 sync_docs.py --full     # 全量重新拉取
    python3 sync_docs.py --days 30  # 只保留最近 N 天的文档在网站上（默认全部保留）

原理:
    1. manage.folder_list 拉取文件夹清单（自动翻页）;
    2. 对每个新 file_id（或标题变更的）调用 get_content 下载内容;
       已下载且标题未变的直接跳过（每日报告视为不再修改）;
    3. aio 智能文档的内容丢失了段落换行，按已知章节标记做启发式恢复;
    4. 生成 site/data/tdocs.json（按日期倒序，附分类与原文链接）。
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

FOLDER_ID = "BxFEsBLJxiSd"
ROOT = Path(__file__).resolve().parent
SITE = ROOT / "site"
TDOCS_OUT = SITE / "tdocs"
DATA_DIR = SITE / "data"
MANIFEST = DATA_DIR / "tdocs_manifest.json"
INDEX_JSON = DATA_DIR / "tdocs.json"

MCPORTER = shutil.which("mcporter") or str(Path.home() / ".local/bin" / "mcporter")

# aio 智能文档内容是粘成一行的，按这些章节标记恢复段落
SECTION_KEYWORDS = [
    "一句话总结", "整体策略", "大盘概览", "数据截至", "多周期信号汇总",
    "RSI 极值榜", "分拆/合并异常ETF", "综合研判", "市场总体特征",
    "板块级研判", "操作建议总结", "板块涨跌信号", "代表性ETF详情",
    "近20日涨幅 TOP", "近20日跌幅 TOP", "近5日涨幅 TOP", "近5日跌幅 TOP",
]
SECTION_EMOJIS = "📊💊📦🏦🤖⛏️🏗️⚡🌐🔋🔬🧠🎯🎮📈🚨🧾⚠️✅❌"

DATE_RE = re.compile(r"(\d{4}-\d{1,2}-\d{1,2})")
DATE_COMPACT_RE = re.compile(r"(\d{8})")


def _parse_mcporter_stdout(raw: str) -> dict:
    """宽松解析 mcporter 输出：容忍前缀噪音与字符串内控制字符。"""
    raw = raw.strip()
    idx = raw.find("{")
    if idx > 0:
        raw = raw[idx:]
    try:
        return json.loads(raw, strict=False)
    except json.JSONDecodeError:
        return json.loads(raw[raw.rfind("{"):] if False else raw, strict=False)


def mcp_call(tool: str, args: dict, retries: int = 2) -> dict:
    """调用 tencent-docs MCP 工具，返回解析后的 JSON（失败自动重试）。

    注意: mcporter 写管道在 64KB 处截断（Node 缺少 drain 处理），
    大文档必须重定向到临时文件读取。
    """
    last_err = None
    for attempt in range(retries + 1):
        with tempfile.NamedTemporaryFile("r+", suffix=".json", delete=False) as tf:
            out_path = tf.name
        try:
            with open(out_path, "wb") as out_f:
                proc = subprocess.run(
                    [MCPORTER, "call", "tencent-docs", tool, "--args", json.dumps(args)],
                    stdout=out_f, stderr=subprocess.PIPE, timeout=300)
            raw = Path(out_path).read_text(encoding="utf-8", errors="replace")
            if proc.returncode != 0:
                last_err = RuntimeError(f"MCP 调用失败 ({tool}): {proc.stderr.decode(errors='replace').strip()[:300]}")
            else:
                try:
                    data = json.loads(raw.strip(), strict=False)
                    if data.get("error"):
                        raise RuntimeError(f"MCP 错误 ({tool}): {data['error']}")
                    return data
                except (json.JSONDecodeError, RuntimeError) as e:
                    last_err = e
        finally:
            Path(out_path).unlink(missing_ok=True)
        if attempt < retries:
            print(f"[重试] {tool} 第 {attempt + 1} 次失败: {str(last_err)[:120]}")
    raise RuntimeError(f"MCP 调用失败 ({tool}): {str(last_err)[:300]}")


def list_folder(folder_id: str) -> list:
    """拉取文件夹全部文件（自动翻页）。"""
    items, start, seen = [], 0, set()
    while True:
        data = mcp_call("manage.folder_list", {"folder_id": folder_id, "start": start})
        batch = data.get("list", [])
        for it in batch:
            if it.get("id") and it["id"] not in seen:
                seen.add(it["id"])
                items.append(it)
        if data.get("finish", True) or not batch:
            break
        start += len(batch)
    return items


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


def beautify_aio(text: str) -> str:
    """aio 智能文档 get_content 返回的正文丢失了段落换行，启发式恢复。"""
    for kw in SECTION_KEYWORDS:
        text = re.sub(r"(?<![\n#])(" + re.escape(kw) + ")", r"\n\n\1", text)
    text = re.sub(r"(?<!\n)([" + SECTION_EMOJIS + r"])\s*", r"\n\n\1", text)
    text = re.sub(r"(?<!\n)(\| 代码 \|)", r"\n\n\1", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip() + "\n"


def fetch_content(file_id: str, url: str) -> str:
    data = mcp_call("get_content", {"file_id": file_id})
    text = data.get("content", "")
    if "/aio/" in (url or ""):
        text = beautify_aio(text)
    return text.replace("\r\n", "\n").replace("\r", "\n")


def main() -> int:
    ap = argparse.ArgumentParser(description="增量拉取腾讯文档报告")
    ap.add_argument("--full", action="store_true", help="全量重新拉取")
    ap.add_argument("--days", type=int, default=0, help="只保留最近 N 天的文档（0=全部）")
    args = ap.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    TDOCS_OUT.mkdir(parents=True, exist_ok=True)

    manifest = {}
    if MANIFEST.exists() and not args.full:
        try:
            manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            manifest = {}

    print(f"[拉取] 文件夹 {FOLDER_ID} ...")
    items = [it for it in list_folder(FOLDER_ID) if not it.get("is_folder")]
    print(f"[清单] 共 {len(items)} 个文件")

    docs = []
    fetched = skipped = 0
    for it in items:
        fid, title, url = it["id"], (it.get("title") or "").strip(), it.get("url", "")
        known = manifest.get(fid)
        if known and known.get("title") == title and (TDOCS_OUT / f"{fid}.md").exists():
            docs.append({**known["entry"]})
            skipped += 1
            continue
        try:
            text = fetch_content(fid, url)
        except RuntimeError as e:
            print(f"[警告] 跳过 {title}: {e}")
            continue
        (TDOCS_OUT / f"{fid}.md").write_text(text, encoding="utf-8")
        entry = {
            "id": fid, "title": title, "url": url,
            "kind": classify(title), "date": parse_date(title),
            "path": f"tdocs/{fid}.md",
        }
        manifest[fid] = {"title": title, "entry": entry}
        docs.append(entry)
        fetched += 1
        print(f"[同步] {title}  ({len(text)} 字符)")

    # 移除云端已删除的文档（local- 前缀是 ingest_report.py 本地收录的，不归本脚本管理）
    valid_ids = {it["id"] for it in items}
    for fid in list(manifest.keys()):
        if fid.startswith("local-"):
            continue
        if fid not in valid_ids:
            manifest.pop(fid)
            p = TDOCS_OUT / f"{fid}.md"
            if p.exists():
                p.unlink()
            print(f"[移除] {fid}")

    # 按日期倒序，无日期排最后
    docs.sort(key=lambda d: d.get("date") or "0000-00-00", reverse=True)

    INDEX_JSON.write_text(
        json.dumps({"generatedAt": datetime.now().isoformat(timespec="seconds"),
                    "count": len(docs), "docs": docs},
                   ensure_ascii=False, indent=1),
        encoding="utf-8")
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")

    print(f"\n完成: 新拉取 {fetched}, 跳过 {skipped}, 共 {len(docs)} 篇文档")
    print(f"数据文件: {INDEX_JSON}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
