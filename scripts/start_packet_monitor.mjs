#!/usr/bin/env node
// 中文说明：启动并探活包监控网关，供插件生命周期和手动启动统一调用。
// 中文说明：脚本只负责本地网关，不直接操作 Codex UI；侧边栏看板由 Codex 宿主工具打开。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const GATEWAY_SCRIPT = process.env.PACKET_MONITOR_GATEWAY_SCRIPT
  || path.join(PLUGIN_ROOT, 'gateway', 'proxy_gateway.mjs');
const GATEWAY_BASE = process.env.PACKET_MONITOR_GATEWAY || 'http://127.0.0.1:8910';
const DASHBOARD_URL = process.env.PACKET_MONITOR_DASHBOARD || 'http://localhost:8910/';
const PROBE_TIMEOUT_MS = 1200;
const RETRIES = 20;

// 中文说明：给单次探活设置超时，避免网关异常时阻塞 Codex 生命周期钩子。
async function probeGateway() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${GATEWAY_BASE}/__api/status`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload?.success ? payload : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// 中文说明：通过网关已有的 --daemon 入口派生后台进程，不重复接管来源不明的进程。
function spawnGateway() {
  const child = spawn(process.execPath, [GATEWAY_SCRIPT, '--daemon'], {
    cwd: PLUGIN_ROOT,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  return child.pid;
}

// 中文说明：等待网关真正开始监听，确保后续 Codex 侧边栏打开时页面可访问。
async function waitForGateway() {
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    const status = await probeGateway();
    if (status) return status;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

const initialStatus = await probeGateway();
let spawnedPid = null;
if (!initialStatus) spawnedPid = spawnGateway();

const status = initialStatus || await waitForGateway();
if (!status) {
  console.error(`包监控启动失败：无法连接 ${GATEWAY_BASE}`);
  process.exitCode = 1;
} else {
  const action = spawnedPid ? `已启动网关（派生 PID ${spawnedPid}）` : '网关已在线，跳过重复启动';
  console.log(`包监控启动器：${action}。`);
  console.log(`包监控启动器：看板地址 ${DASHBOARD_URL}`);
  // 中文说明：这个标记供插件/宿主识别下一步打开 Codex 侧边栏浏览器，不代表已捕获真实流量。
  console.log(`包监控启动器：CODEX_BROWSER_PANEL_URL=${DASHBOARD_URL}`);
}
