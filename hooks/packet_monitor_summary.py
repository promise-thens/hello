#!/usr/bin/env python3
"""中文说明：为 Codex Hook 输出轻量包监控摘要，不自动输出完整请求 Body。"""

import json
import sys
import urllib.error
import urllib.request


def fetch_json(path):
    """中文说明：读取本机 8910 网关接口；网关未启动时返回 None。"""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:8910{path}", timeout=1.5) as response:
            return json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, urllib.error.URLError):
        return None


def main():
    # 中文说明：Hook stdin 可能包含 UserPromptSubmit 事件，但摘要只依赖网关状态。
    _ = sys.stdin.read()
    status = fetch_json("/__api/status")
    if not status or not status.get("success"):
        # 中文说明：纯文本 stdout 会作为额外 developer context 注入，兼容 SessionStart 与 UserPromptSubmit。
        print("包监控网关当前未连接（8910）。不要把模拟测试当成真实抓包证据。")
        return

    records_payload = fetch_json("/__api/records?limit=100") or {}
    records = records_payload.get("records") or []
    failures = [item for item in records if int(item.get("status") or 0) >= 400]
    slow = [item for item in records if float(item.get("duration") or 0) >= 1000]
    recent = records[:3]
    recent_text = "；".join(f"{item.get('method', 'GET')} {item.get('url', '')} [{item.get('status', 0)}]" for item in recent)
    summary = (
        f"包监控网关在线（8910），当前内存记录 {len(records)} 条，失败 {len(failures)} 条，慢请求 {len(slow)} 条，"
        f"活动规则 {status.get('activeRuleCount', 0)} 条，挂起断点 {status.get('holdCount', 0)} 条。"
    )
    if recent_text:
        summary += f" 最近请求：{recent_text}。"
    print(summary)


if __name__ == "__main__":
    main()
