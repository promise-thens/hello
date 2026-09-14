---
name: packet-monitor-inspect
description: 分析包监控捕获的 HTTP 请求。当用户要查看最近请求、读取完整请求响应、筛选 4xx/5xx、查慢请求或等待下一条匹配流量时使用；默认只读。
---

# 抓包分析

负责从包监控中取证，默认保留完整原始请求和响应字段，不脱敏、不截断。

## 工具选择

- `list_recent_requests`：按数量或 HTTP 方法查看最近抓包。
- `get_request_detail`：按记录 ID 读取完整 headers、body、状态码、耗时和响应。
- `list_alerts`：筛选 4xx、5xx 和慢请求。
- `wait_for_request`：通过网关 SSE 等待下一条匹配 URL 的请求或断点事件。

## 分析要求

1. 先确认记录来自真实页面、网关模拟测试还是看板重放。
2. 报告 method、URL、状态码、耗时和命中规则，再展开完整原文。
3. 不要把 8910 网关自通信（`/__api/*`）当成业务请求。
4. 页面数据可能含 Cookie、Token 和 Authorization；自用模式默认原样返回，只有用户要求时才隐藏。
