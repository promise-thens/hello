# 包监控 (hello)

Codex 个人插件：浏览器抓包与 HTTP 请求调试。

支持实时查看 fetch/XHR 流量，发送前/响应前断点，Mock、重放、curl 导出，以及「修改后发送」回写原页面。

## 目录

- `extension/` Chrome MV3 扩展，注入页面抓包
- `gateway/` 本地 8910 网关和看板托管
- `mcp/` 包监控 MCP 服务
- `skills/` Codex Skill 说明
- `scripts/` 启动脚本

## 本地使用

1. 启动网关：`node scripts/start_packet_monitor.mjs`
2. 打开看板：[http://localhost:8910/](http://localhost:8910/)
3. 在 Chrome 打开 `chrome://extensions/`，开启开发者模式，加载已解压扩展目录 `extension/`

Codex 侧可安装为个人插件后，用包监控相关 Skill 查看流量、断点、重放和直发请求。
