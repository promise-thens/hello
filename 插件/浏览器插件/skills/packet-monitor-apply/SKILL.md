---
name: packet-monitor-apply
description: 把已捕获请求的响应字段改掉，再走看板「修改后发送」：登记一次性回写并刷新原业务页。当用户要改某个 JSON 字段、让页面显示改后数据、或让 AI 代替点击修改后发送时使用。不要用于网关直发重放或普通抓包查看。
---

# 修改后发送

对应看板报文审查里的「修改后发送」。已完成的抓包不能改已经结束的那一发，所以网关会登记一次性响应回写，并让 Chrome 里的原业务页自己刷新再请求。

## 工具

- 先用 `list_recent_requests` 或 `get_request_detail` 确认目标记录和现有 JSON 字段。
- 调用 `apply_edited_to_page`：
  - `id`：抓包记录 ID；没有 ID 时用 `matchUrl`
  - `fields`：响应 JSON 点路径补丁，例如 `{ "data.installAddress": "测试地址999号" }`
  - `waitMs`：默认 12000，等待原页刷新并吃到改后响应
- 挂起中的断点也会走这个工具：直接放行改后响应，不再刷新页面。

## 不要用错工具

- `replay_request` / `send_request` 是网关自己发出去的，原页面不会刷新。
- 已完成记录改的是响应给页面看的数据，不是让浏览器带着改过的 Request Headers 再打一枪。
- 字段路径从响应 JSON 根算起，这个项目常见是 `data.xxx`，不要写成丢了 `data` 的短路径。

## 操作纪律

1. 这是写操作。先复述要改的记录、字段和值，再调用。
2. 看返回里的 `refreshedPage` 和 `note`。超时不等于改失败，只说明 Chrome 页还没吃到回写。
3. 记录没有业务页地址时，让用户在 Chrome 打开目标页再抓一次，不要改成重放凑数。
