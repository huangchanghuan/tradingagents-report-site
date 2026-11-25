#!/usr/bin/env python3
"""最小 MCP streamable-HTTP 客户端：直接调用腾讯文档 MCP 服务。

读取 ~/.mcporter/mcporter.json 中的服务配置（baseUrl + Authorization）。
用法:
    python3 mcp_call.py <server> <tool> '<json args>'
    python3 mcp_call.py tencent-docs manage.folder_list '{"folder_id":"xxx"}'
"""

import json
import sys
import urllib.request
import urllib.error

CONFIG = __import__("pathlib").Path.home() / ".mcporter" / "mcporter.json"
PROTOCOL_VERSION = "2024-11-05"


def load_server(name: str):
    cfg = json.loads(CONFIG.read_text())
    servers = cfg.get("mcpServers", {})
    if name not in servers:
        raise SystemExit(f"[错误] 配置中没有服务 {name}，可选: {list(servers)}")
    return servers[name]


def post(url: str, token: str, payload: dict, session_id: str | None = None):
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if token:
        headers["Authorization"] = token
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
    try:
        resp = urllib.request.urlopen(req, timeout=120)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise SystemExit(f"[HTTP {e.code}] {body[:500]}")
    sid = resp.headers.get("Mcp-Session-Id")
    ctype = resp.headers.get("Content-Type", "")
    raw = resp.read().decode(errors="replace")
    if "text/event-stream" in ctype:
        # 解析 SSE: 取最后一个 data: 行的 JSON
        result = None
        for line in raw.splitlines():
            if line.startswith("data:"):
                try:
                    result = json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    pass
        return result, sid
    return (json.loads(raw) if raw.strip() else None), sid


def parse_result(resp: dict) -> str:
    """从 tools/call 响应提取文本内容。"""
    if resp is None:
        return ""
    if "error" in resp and resp["error"]:
        raise SystemExit(f"[MCP 错误] {json.dumps(resp['error'], ensure_ascii=False)[:800]}")
    result = resp.get("result", {})
    if result.get("isError"):
        texts = [c.get("text", "") for c in result.get("content", [])]
        raise SystemExit(f"[工具错误] {''.join(texts)[:800]}")
    parts = []
    for c in result.get("content", []):
        if c.get("type") == "text":
            parts.append(c.get("text", ""))
    return "\n".join(parts)


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    server_name, tool = sys.argv[1], sys.argv[2]
    args = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
    srv = load_server(server_name)
    url, token = srv["baseUrl"], srv.get("headers", {}).get("Authorization", "")

    # 1. initialize
    resp, sid = post(url, token, {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                   "clientInfo": {"name": "ta-report-sync", "version": "1.0"}}})
    # 2. initialized 通知
    post(url, token, {"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
    # 3. tools/call
    resp, _ = post(url, token, {
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": tool, "arguments": args}}, sid)
    print(parse_result(resp))
    return 0


if __name__ == "__main__":
    sys.exit(main())
