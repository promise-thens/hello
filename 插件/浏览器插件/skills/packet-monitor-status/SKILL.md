---
name: packet-monitor-status
description: 查看包监控本地网关、Chrome 扩展、规则和断点状态。当用户要启动、探活、确认连接或排查“为什么没有抓到请求”时使用；只读，不修改规则。
---

# 包监控状态

负责回答“包监控现在是否可用”，不直接处理具体请求内容。

## 工作流程

1. 调用 MCP `packet_status` 查询 8910 网关、活动规则、挂起断点和拦截模式。
2. 如果网关未运行，且用户明确要求启动，执行幂等启动脚本：

   ```bash
   # 中文说明：启动并探活自用抓包网关；该服务仍按用户约定监听 0.0.0.0
   node /Users/huyaohang/plugins/hello/插件/浏览器插件/scripts/start_packet_monitor.mjs
   ```

3. 如果用户要求打开看板，探活成功后调用 Codex 宿主 `open_in_codex`，把 `http://localhost:8910/` 放入右侧浏览器面板；不要把普通 Chrome 窗口当成 Codex 侧边栏。
4. 说明“网关在线”不等于“Chrome 扩展已注入”，也不等于“真实目标请求已捕获”。需要真实流量时，提醒用户在 Chrome 加载 `/Users/huyaohang/plugins/hello/插件/浏览器插件` 并刷新目标页面。

## 证据边界

- 网关状态来自 `/__api/status`。
- 扩展是否真正捕获，必须以 MCP `list_recent_requests` 中出现目标请求为准。
- 网关内置模拟测试只证明本机演示链路，不证明真实站点请求链路。
