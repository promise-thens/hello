---
name: hello
description: 本地浏览器抓包与 HTTP 请求调试。当用户要抓取或查看 fetch/XHR 流量、打开包监控看板、检查 8910 网关、设置发送前或响应前断点、修改 Header/Body、Mock、丢弃、重放请求、使用 Postman 风格请求 Tab 或导出 curl 时使用。不要因为普通问候而触发。
---

# 包监控

本技能操作本地抓包工具链：Chrome 扩展负责捕获页面的 `fetch` 与 `XMLHttpRequest`，Node 网关在 `8910` 端口保存最近流量、管理断点和规则；看板的“抓包”Tab 用于查看、修改、Mock 与重放，“请求”Tab 用于编辑并由网关直发 HTTP 请求。

## 关键位置

- 网关入口：`/Users/huyaohang/plugins/hello/gateway/proxy_gateway.mjs`
- 启动脚本：`/Users/huyaohang/plugins/hello/scripts/start_packet_monitor.mjs`
- Chrome 扩展：`/Users/huyaohang/plugins/hello/extension`
- 抓包看板：`http://localhost:8910/`
- 网关探活：`http://127.0.0.1:8910/__api/status`

响应前断点现在同时覆盖 `fetch` 与 `XMLHttpRequest`：开启「同时拦响应」并重新触发请求后，看板修改的响应会在页面 `load` / `loadend` 事件前回传。已经完成的记录点「修改后发送」会把改后响应当成一次性回写，并刷新原业务页让它重新请求。

内部插件标识仍为 `hello`，用于兼容已安装的 `hello@personal`、`hello:hello`、旧看板地址和扩展通信 Header；面向用户统一称为“包监控”。

## 工作方式

1. 用户要求启动、查看或打开包监控时，运行幂等启动脚本；脚本会先探活 `8910`，只有网关未运行时才派生后台进程，不结束来源不明的进程：

   ```bash
   # 中文说明：启动并探活本地包监控网关；脚本输出 Codex 侧边栏看板地址
   node /Users/huyaohang/plugins/hello/scripts/start_packet_monitor.mjs
   ```

2. 脚本探活成功后，调用 Codex 宿主的 `open_in_codex`，使用 `placement: "right"` 和 `target: { type: "browser", url: "http://localhost:8910/" }` 打开侧边栏浏览器。不要用普通 `open` 命令冒充 Codex 侧边栏；脚本本身只负责网关，侧边栏由宿主工具完成。
3. 如果用户只想检查状态，报告网关、规则数量和待放行请求，不擅自修改规则。
4. 用户要求抓取真实网页请求时，提醒其在 Chrome 中加载或启用 `/Users/huyaohang/plugins/hello/extension`，然后在目标页面产生请求。不得把网关内置“模拟测试请求”当成真实站点抓包证据。
5. 修改、放行、丢弃、Mock 或重放请求前，明确目标请求和变更内容。优先使用看板现有操作；不要直接改动扩展内部兼容标识。
6. 用户要改某个响应字段并让原页面刷新时，调用 MCP `apply_edited_to_page`，不要用 `replay_request` 代替。

## 能力边界

- 当前工具只捕获注入页面后的 `fetch` 与 `XMLHttpRequest`，不等同于系统级代理、TLS 中间人或全设备抓包。
- 默认关闭发送前劫持，避免业务页面被挂起。只有用户要求时才启用 `match`、`all` 或 `once`。
- 抓包记录与规则保存在网关运行时内存中，网关重启后不要假设历史仍存在。
- `x-hello-internal`、`HELLO_EXTENSION_BRIDGE`、`__HELLO_INJECT_LOADED__` 和旧看板路径属于内部兼容协议。品牌更新时保留，除非用户明确要求迁移协议并接受完整回归测试。
- 页面可能包含令牌、Cookie、个人信息或业务数据。本插件是自用调试工具，MCP 详情和看板默认保留完整原文；只有用户明确要求时才脱敏或裁剪。

## 回复要求

- 默认使用中文，先说明当前是否抓到真实流量，再给出关键请求、状态码、耗时及命中的规则。
- 区分“网关可用”“Chrome 扩展已连接”“模拟请求成功”和“真实目标请求已捕获”四种证据，不能相互替代。
- 涉及代码或配置修改时写清晰中文注释，说明修改目的。
