---
name: packet-monitor-replay
description: 重放包监控中的 HTTP 请求并导出调试信息。当用户要重新发送请求、对比响应、验证修改或复制 curl 时使用；重放属于写操作，必须遵循用户明确目标。
---

# 请求重放

负责把已捕获请求再次发送到目标 URL，并把重放结果作为新的抓包记录返回。

## 工具选择

- 先用 `get_request_detail` 读取原始请求。
- 调用 `replay_request` 发送指定 method、URL、headers 和 body。
- 重放结果返回新的记录，可再用 `get_request_detail` 对比。
- 需要 curl 时，根据完整请求字段生成命令，并保留用户要求的原始 headers/body。

## 操作纪律

1. 重放前明确目标 URL、HTTP 方法以及是否携带原始认证信息。
2. 不擅自把生产请求改发到其他环境，也不擅自删除 Cookie 或 Authorization。
3. 说明重放是网关直接发出的请求，不代表浏览器页面再次执行了该请求。用户要改字段并刷新原页面时，改用 `apply_edited_to_page`。
4. 自用调试模式保留完整原始数据；只有用户要求时才生成脱敏 curl。
