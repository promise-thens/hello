---
name: packet-monitor-intercept
description: 调试包监控的发送前或响应前断点。当用户要暂停请求、修改 method/URL/Header/Body、放行、Mock 或丢弃请求时使用；写操作必须先确认目标与动作。
---

# 断点调试

负责把匹配到的请求挂起，交给用户决定继续、修改、Mock 或丢弃。

## 工具选择

- `set_intercept_mode`：设置 `off`、`match`、`all`、`once`，也可开启响应断点。
- `wait_for_request`：等待 `hold_created` 事件并取得断点 ID。
- `resume_intercept`：对断点执行 `continue`、`mock` 或 `drop`。

## 操作纪律

1. 默认模式为 `off`；只有用户明确要求拦截时才开启。
2. 开启前说明匹配条件和可能暂停业务页面的影响。
3. 修改 Header、Body、URL 或响应内容前复述变更，得到用户确认后再调用写工具。
4. 超时会由网关自动继续，不能假设请求永久挂起。
5. 断点中的 Cookie、Token、Authorization 和 Body 在自用模式下保持原文。

已经完成的记录不需要先开断点。改字段后调用 `apply_edited_to_page`（看板按钮是「修改后发送」），原页面会刷新并使用改后数据。
