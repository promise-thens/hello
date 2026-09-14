# 包监控 (hello)

Codex 个人插件：浏览器抓包与 HTTP 请求调试。

仓库按「插件 → 浏览器插件」组织。Chrome 扩展加载目录就是 `插件/浏览器插件/`。

## 目录

- `插件/浏览器插件/` Chrome MV3 扩展（加载已解压扩展时选这个目录）
- `插件/浏览器插件/gateway/` 本地 8910 网关和看板托管
- `插件/浏览器插件/mcp/` 包监控 MCP 服务
- `插件/浏览器插件/skills/` Codex Skill 说明
- `插件/浏览器插件/scripts/` 启动脚本
- `hooks/` Codex 生命周期钩子

## 本地使用

1. 启动网关：`node 插件/浏览器插件/scripts/start_packet_monitor.mjs`
2. 打开看板：[http://localhost:8910/](http://localhost:8910/)
3. 在 Chrome 打开 `chrome://extensions/`，开启开发者模式，加载已解压扩展目录 `插件/浏览器插件/`
