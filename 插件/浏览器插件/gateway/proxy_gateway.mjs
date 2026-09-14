// ========================================================
// 文件名: proxy_gateway.mjs
// 功能定位: 包监控插件的极简抓包与请求修改网关服务
// 技术架构: 纯原生 Node.js (零 npm 依赖)，采用 ESM 规范
// 监听端口: 8910
// 核心能力:
//   1. 看板静态托管 (/ 或 /hello_dashboard.html)
//   2. SSE 实时推流通道 (/__events)
//   3. Mock 与请求篡改动态规则引擎 (/__api/rules)
//   4. 快捷模拟测试请求触发 (/__api/test)
//   5. 发送前/响应前断点挂起 (hold / resume / drop / mock)
//   6. 看板重放与 Postman 风格请求直发 (/__api/replay、/__api/request)
//   7. 运行时配置
//   8. 透明代理中枢 (支持 CORS 补齐、Header 注入、Body 篡改、Mock 短路)
//   9. 已完成记录把改后响应一次性回写原页面 (/__api/page-apply)
// ========================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// --------------------------------------------------------
// 1. 常量与基础路径配置
// --------------------------------------------------------
const PORT = 8910;
const DEFAULT_UPSTREAM = 'https://jsonplaceholder.typicode.com';

// 解析当前文件所在目录与根路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PID_FILE = path.join(__dirname, 'gateway.pid');
const LOG_FILE = path.join(__dirname, 'gateway.log');

// 优先查找资产目录下的看板文件，若不存在则回退至当前目录
// 中文说明：看板文件跟着插件目录走，避免写死旧的绝对路径
const ASSET_DASHBOARD_PATH = path.join(__dirname, '..', 'skills', 'hello', 'assets', 'hello_dashboard.html');
const LOCAL_DASHBOARD_PATH = path.join(__dirname, 'hello_dashboard.html');

// --------------------------------------------------------
// 2. 守护进程化支持 (--daemon 参数)
// --------------------------------------------------------
if (process.argv.includes('--daemon')) {
  // 如果当前是前台入口，通过 spawn 创建完全脱离终端的子进程
  const outLog = fs.openSync(LOG_FILE, 'a');
  const errLog = fs.openSync(LOG_FILE, 'a');

  const child = spawn(process.execPath, [__filename], {
    detached: true,
    stdio: ['ignore', outLog, errLog],
    cwd: __dirname
  });

  // 解除父子引用，让父进程体面退出，子进程后台独立常驻
  child.unref();
  console.log(`[包监控 Gateway] 守护进程已派生，PID: ${child.pid}`);
  process.exit(0);
}

// --------------------------------------------------------
// 3. 运行时内存状态 (状态规则、抓包历史、SSE 订阅客户端)
// --------------------------------------------------------
// 规则库定义：支持请求头注入、一键 500 模拟、用户信息 Mock 等
let rules = [
  {
    id: 'rule-trace-header',
    name: 'Header 注入 (X-Packet-Monitor-Trace)',
    enabled: false,
    type: 'inject_header',
    matchUrl: '.*',
    headerKey: 'x-packet-monitor-trace',
    headerValue: 'packet-monitor-active'
  },
  {
    id: 'rule-mock-error-500',
    name: '一键模拟 500 服务端故障',
    enabled: false,
    type: 'mock_response',
    matchUrl: '/api/error.*',
    mockStatus: 500,
    mockBody: JSON.stringify({
      error: 'Internal Server Error (Mocked)',
      message: '这是网关主动模拟的 500 异常响应，用于排查前端容错能力！',
      timestamp: new Date().toISOString()
    }, null, 2)
  },
  {
    id: 'rule-mock-user-info',
    name: 'Mock 用户信息 (/api/user)',
    enabled: false,
    type: 'mock_response',
    matchUrl: '/api/user.*',
    mockStatus: 200,
    mockBody: JSON.stringify({
      id: 520,
      username: '亲爱的男友大人',
      role: 'Boss & 架构指挥官',
      sweetheart: '永远守护你的专属技术小女友 ❤️',
      status: 'Super Active',
      vipLevel: 'Supreme',
      tags: ['高颜值', '极致性能', '零依赖网关']
    }, null, 2)
  }
];

// 抓包流水记录（内存滚动保留最近 100 条）
const MAX_RECORDS = 100;
let records = [];
const LAST_PAGE_FILE = path.join(__dirname, 'last-page-url.txt');
// 中文说明：记住最近一次业务页地址，用来给相对路径补 http(s) 域名。
let lastPageUrl = '';
try {
  if (fs.existsSync(LAST_PAGE_FILE)) lastPageUrl = String(fs.readFileSync(LAST_PAGE_FILE, 'utf8') || '').trim();
} catch {}

// SSE 连接客户端集合
const sseClients = new Set();

// 发送前劫持配置：默认关闭，避免误拦把业务页卡死
let interceptConfig = {
  mode: 'off',          // off | all | match | once
  matchUrl: '',
  timeoutMs: 30000,
  interceptResponse: false,
  once: false,
  // 中文说明：只拦一次且同时拦响应时，先消费 request，再等待同一轮 response。
  onceStage: ''         // '' | request | response
};

// 正在挂起的请求：id -> { snapshot, resolve, timeoutId }
const holds = new Map();
const MAX_HOLDS = 30;

// 中文说明：已完成抓包不能改已经结束的那一发，这里保存“下一次原页面请求要用的改后响应”。
const MAX_PAGE_APPLIES = 8;
const PAGE_APPLY_TTL_MS = 60000;
let pageApplies = [];

function prunePageApplies() {
  const now = Date.now();
  pageApplies = pageApplies.filter((item) => item && Number(item.expiresAt) > now);
}

function publicPageApply(item, stage) {
  if (!item) return null;
  const published = {
    id: item.id,
    method: item.method,
    url: item.url,
    pageUrl: item.pageUrl,
    response: item.response || { status: 200, headers: {}, body: '' },
    reloadConsumed: Boolean(item.reloadConsumed),
    createdAt: item.createdAt,
    expiresAt: item.expiresAt
  };
  if (stage) published.stage = stage;
  return published;
}

function listPublicPageApplies() {
  prunePageApplies();
  return pageApplies.map((item) => publicPageApply(item));
}

// 输出 JSON 响应的小工具
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// 把 hold 对象序列化给看板（去掉内部 Promise）
function publicHold(hold) {
  return {
    id: hold.id,
    phase: hold.phase,
    method: hold.method,
    url: hold.url,
    headers: hold.headers || {},
    body: hold.body || '',
    status: hold.status,
    responseHeaders: hold.responseHeaders || {},
    responseBody: hold.responseBody || '',
    pageUrl: hold.pageUrl || '',
    createdAt: hold.createdAt,
    expiresAt: hold.expiresAt,
    paused: true
  };
}

// 结束一次挂起，把决策交还给浏览器扩展
function resolveHold(id, result) {
  const hold = holds.get(id);
  if (!hold) return false;
  if (hold.timeoutId) clearTimeout(hold.timeoutId);
  holds.delete(id);
  try { hold.resolve(result); } catch {}
  broadcastSSE('hold_resolved', { id, action: result.action, timedOut: Boolean(result.timedOut) });
  return true;
}

function listPublicHolds() {
  return Array.from(holds.values()).map(publicHold);
}

// --------------------------------------------------------
// 4. 辅助工具函数
// --------------------------------------------------------
// 广播 SSE 消息到所有在线的看板客户端
function broadcastSSE(type, data) {
  const payload = `data: ${JSON.stringify({ type, data })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// 为响应体补全标准宽松的 CORS 跨域头
function applyCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

// 读取 HTTP 请求的完整 Body 文本
function readRequestBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', () => resolve(''));
  });
}

// 获取看板 HTML 页面物理路径
function getDashboardFilePath() {
  if (fs.existsSync(ASSET_DASHBOARD_PATH)) {
    return ASSET_DASHBOARD_PATH;
  }
  if (fs.existsSync(LOCAL_DASHBOARD_PATH)) {
    return LOCAL_DASHBOARD_PATH;
  }
  return null;
}

// 中文说明：把相对路径按 pageUrl 补成绝对 http(s) 地址；解析失败则原样返回。
function toAbsoluteUrl(url, base) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  } catch {}
  if (base) {
    try {
      const parsed = new URL(raw, base);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
    } catch {}
  }
  return raw;
}

function isAbsoluteHttpUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function backfillRelativeRecords(base) {
  if (!base) return;
  for (const record of records) {
    const nextUrl = toAbsoluteUrl(record.url, base);
    if (nextUrl && nextUrl !== record.url) {
      record.url = nextUrl;
      record.targetUrl = toAbsoluteUrl(record.targetUrl || record.url, base);
      if (!record.pageUrl) record.pageUrl = base;
    }
  }
}

function rememberPageUrl(pageUrl) {
  const absolute = toAbsoluteUrl(pageUrl);
  if (!isAbsoluteHttpUrl(absolute)) return lastPageUrl;
  lastPageUrl = absolute;
  try { fs.writeFileSync(LAST_PAGE_FILE, lastPageUrl); } catch {}
  backfillRelativeRecords(lastPageUrl);
  return lastPageUrl;
}

// 中文说明：由网关直发一条请求，统一服务于“重放”和 Postman 风格“请求”面板。
// 保持原抓包记录/SSE 写入路径不变，只通过 appliedRule 标记来源。
async function sendDirectRequest(payload, appliedRule) {
  const method = String(payload.method || 'GET').toUpperCase();
  const url = toAbsoluteUrl(String(payload.url || '').trim(), payload.pageUrl || lastPageUrl);
  if (!url) {
    const error = new Error('缺少 url');
    error.code = 'INVALID_REQUEST';
    throw error;
  }

  let parsedUrl;
  try { parsedUrl = new URL(url); } catch {
    const error = new Error('url 必须是完整的 http(s) 地址');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    const error = new Error('url 只支持 http(s) 协议');
    error.code = 'INVALID_REQUEST';
    throw error;
  }

  const headers = {};
  for (const [key, value] of Object.entries(payload.headers || {})) {
    if (['host', 'content-length', 'connection'].includes(String(key).toLowerCase())) continue;
    headers[key] = value;
  }
  const startTime = Date.now();
  const fetchOptions = { method, headers };
  if (method !== 'GET' && method !== 'HEAD' && payload.body != null && payload.body !== '') {
    fetchOptions.body = String(payload.body);
  }

  const upstreamRes = await fetch(parsedUrl.toString(), fetchOptions);
  const responseBody = await upstreamRes.text();
  const responseHeaders = {};
  upstreamRes.headers.forEach((value, key) => { responseHeaders[key] = value; });
  const record = {
    id: 'replay_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    timestamp: new Date().toLocaleTimeString(),
    method,
    url,
    targetUrl: url,
    status: upstreamRes.status,
    duration: Date.now() - startTime,
    isMock: false,
    isModified: true,
    appliedRule,
    requestHeaders: headers,
    requestBody: payload.body || '',
    responseHeaders,
    responseBody
  };
  if (payload.name) record.requestName = String(payload.name);
  records.unshift(record);
  if (records.length > MAX_RECORDS) records.pop();
  broadcastSSE('new_record', record);
  return record;
}

// --------------------------------------------------------
// 5. HTTP 服务主路由逻辑
// --------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = reqUrl.pathname;

  // 统一补齐跨域响应头
  applyCORS(res);

  // 处理 OPTIONS 预检请求直接放行
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ------------------------------------------------------
  // 路由 A: 看板 HTML 托管入口 (/ 或 /hello_dashboard.html)
  // ------------------------------------------------------
  if (pathname === '/' || pathname === '/hello_dashboard.html' || pathname === '/index.html') {
    const filePath = getDashboardFilePath();
    if (filePath && fs.existsSync(filePath)) {
      const html = fs.readFileSync(filePath, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      });
      res.end(html);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('未找到看板 HTML 文件，请检查部署资产路径。');
    return;
  }

  // ------------------------------------------------------
  // 路由 B: SSE 实时事件推流通道 (/__events)
  // ------------------------------------------------------
  if (pathname === '/__events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    // 首次连入时下发当前已有的规则与最近抓包历史
    const initialPayload = JSON.stringify({
      type: 'init',
      data: { rules, records, config: interceptConfig, holds: listPublicHolds(), lastPageUrl, pageApplies: listPublicPageApplies() }
    });
    res.write(`data: ${initialPayload}\n\n`);

    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // ------------------------------------------------------
  // 路由 C: 规则读取与管理 API (/__api/rules)
  // ------------------------------------------------------
  if (pathname === '/__api/rules') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, rules }));
      return;
    }
    if (req.method === 'POST') {
      try {
        const bodyStr = await readRequestBody(req);
        const payload = JSON.parse(bodyStr || '{}');

        // 支持全量更新或局部操作
        if (payload.action === 'toggle' && payload.id) {
          const target = rules.find((r) => r.id === payload.id);
          if (target) target.enabled = !target.enabled;
        } else if (payload.action === 'add' && payload.rule) {
          rules.push({
            id: 'rule-' + Date.now(),
            enabled: true,
            ...payload.rule
          });
        } else if (payload.action === 'delete' && payload.id) {
          rules = rules.filter((r) => r.id !== payload.id);
        } else if (Array.isArray(payload.rules)) {
          rules = payload.rules;
        }

        // 广播规则变动
        broadcastSSE('rules_updated', rules);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, rules }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }
  }

  // ------------------------------------------------------
  // 路由 C2: 包监控状态与原始抓包记录查询 API
  // 说明：这些只读接口供 Codex MCP 使用，完整保留原始字段，不做脱敏。
  // ------------------------------------------------------
  if (pathname === '/__api/status' && req.method === 'GET') {
    sendJSON(res, 200, {
      success: true,
      gateway: { running: true, port: PORT, bind: '0.0.0.0' },
      recordCount: records.length,
      activeRuleCount: rules.filter((rule) => rule.enabled).length,
      holdCount: holds.size,
      interceptConfig,
      pageApplyCount: listPublicPageApplies().length
    });
    return;
  }

  if (pathname === '/__api/records' && req.method === 'GET') {
    const requestedLimit = Number(reqUrl.searchParams.get('limit') || 20);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), MAX_RECORDS) : 20;
    const requestedId = reqUrl.searchParams.get('id');
    const method = (reqUrl.searchParams.get('method') || '').toUpperCase();
    const filtered = records.filter((record) => {
      if (requestedId && record.id !== requestedId) return false;
      if (method && record.method !== method) return false;
      return true;
    });
    sendJSON(res, 200, {
      success: true,
      records: requestedId ? filtered.slice(0, 1) : filtered.slice(0, limit),
      total: filtered.length,
      limit
    });
    return;
  }

  // ------------------------------------------------------
  // 路由 D: 清空抓包历史记录 (/__api/clear)
  // ------------------------------------------------------
  if (pathname === '/__api/clear' && req.method === 'POST') {
    records = [];
    broadcastSSE('clear', null);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, message: '抓包历史已清空' }));
    return;
  }

  // ------------------------------------------------------
  // 路由: 扩展运行时快照（规则 + 断点配置一次拿齐，降低发送前延迟）
  // ------------------------------------------------------
  if (pathname === '/__api/runtime' && req.method === 'GET') {
    sendJSON(res, 200, { success: true, rules, config: interceptConfig, lastPageUrl, pageApplies: listPublicPageApplies() });
    return;
  }

  // 中文说明：扩展或看板上报当前业务页地址，供相对路径补全域名。
  if (pathname === '/__api/runtime/page' && req.method === 'POST') {
    try {
      const payload = JSON.parse((await readRequestBody(req)) || '{}');
      const remembered = rememberPageUrl(payload.pageUrl || payload.url || '');
      sendJSON(res, 200, { success: true, lastPageUrl: remembered });
    } catch (err) {
      sendJSON(res, 400, { success: false, error: err.message });
    }
    return;
  }

  // 中文说明：看板「修改后发送」把改后响应登记下来，等原页面刷新后的下一次匹配请求直接回写。
  if (pathname === '/__api/page-apply' && req.method === 'POST') {
    try {
      const payload = JSON.parse((await readRequestBody(req)) || '{}');
      const method = String(payload.method || 'GET').toUpperCase();
      const url = toAbsoluteUrl(payload.url || '', payload.pageUrl || lastPageUrl);
      const pageUrl = toAbsoluteUrl(payload.pageUrl || lastPageUrl);
      if (!isAbsoluteHttpUrl(url)) {
        sendJSON(res, 400, { success: false, error: '回写目标 URL 必须是完整的 http(s) 地址' });
        return;
      }
      if (!isAbsoluteHttpUrl(pageUrl)) {
        sendJSON(res, 400, { success: false, error: '缺少业务页地址，无法刷新原页面' });
        return;
      }
      const response = payload.response || {};
      const headers = response.headers && typeof response.headers === 'object' ? response.headers : {};
      prunePageApplies();
      pageApplies = pageApplies.filter((item) => !(item.method === method && item.url === url));
      const apply = {
        id: 'apply_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        method,
        url,
        pageUrl,
        response: {
          status: Number(response.status || 200),
          headers,
          body: response.body == null ? '' : String(response.body)
        },
        reloadConsumed: false,
        createdAt: Date.now(),
        expiresAt: Date.now() + PAGE_APPLY_TTL_MS
      };
      pageApplies.unshift(apply);
      if (pageApplies.length > MAX_PAGE_APPLIES) pageApplies.pop();
      const published = publicPageApply(apply, 'created');
      broadcastSSE('page_apply', published);
      sendJSON(res, 200, { success: true, apply: published });
    } catch (err) {
      sendJSON(res, 400, { success: false, error: err.message });
    }
    return;
  }

  // 中文说明：扩展先确认“已刷新”，再确认“已把改后响应交给页面”，避免重复刷新或重复 Mock。
  if (pathname === '/__api/page-apply/ack' && req.method === 'POST') {
    try {
      const payload = JSON.parse((await readRequestBody(req)) || '{}');
      prunePageApplies();
      const id = payload.id || payload.applyId;
      const action = String(payload.action || '').trim();
      const item = pageApplies.find((entry) => entry.id === id);
      if (!item) {
        sendJSON(res, 200, { success: true, already: true, shouldReload: false });
        return;
      }
      if (action === 'reloaded') {
        if (item.reloadConsumed) {
          sendJSON(res, 200, { success: true, already: true, shouldReload: false });
          return;
        }
        item.reloadConsumed = true;
        const published = publicPageApply(item, 'reloaded');
        broadcastSSE('page_apply', published);
        sendJSON(res, 200, { success: true, shouldReload: true, apply: published });
        return;
      }
      if (action === 'applied') {
        pageApplies = pageApplies.filter((entry) => entry.id !== id);
        const published = publicPageApply(item, 'applied');
        broadcastSSE('page_apply', published);
        sendJSON(res, 200, { success: true, apply: published });
        return;
      }
      sendJSON(res, 400, { success: false, error: 'ack 只支持 reloaded 或 applied' });
    } catch (err) {
      sendJSON(res, 400, { success: false, error: err.message });
    }
    return;
  }

  // ------------------------------------------------------
  // 路由: 发送前劫持开关与匹配条件
  // ------------------------------------------------------
  if (pathname === '/__api/intercept/config') {
    if (req.method === 'GET') {
      sendJSON(res, 200, { success: true, config: interceptConfig, holds: listPublicHolds() });
      return;
    }
    if (req.method === 'POST') {
      try {
        const payload = JSON.parse((await readRequestBody(req)) || '{}');
        const next = { ...interceptConfig };
        if (payload.mode === 'off' || payload.mode === 'all' || payload.mode === 'match' || payload.mode === 'once') {
          next.mode = payload.mode;
        }
        if (typeof payload.matchUrl === 'string') next.matchUrl = payload.matchUrl.trim();
        if (payload.timeoutMs != null) {
          const n = Number(payload.timeoutMs);
          next.timeoutMs = Number.isFinite(n) ? Math.min(Math.max(n, 3000), 120000) : 30000;
        }
        if (payload.interceptResponse != null) next.interceptResponse = Boolean(payload.interceptResponse);
        if (payload.once != null) next.once = Boolean(payload.once);
        // 中文说明：重新启用只拦一次时从 request 阶段开始；关闭或普通模式清理阶段标记。
        next.onceStage = next.mode === 'once' ? 'request' : '';
        interceptConfig = next;
        broadcastSSE('intercept_config', interceptConfig);
        sendJSON(res, 200, { success: true, config: interceptConfig });
      } catch (err) {
        sendJSON(res, 400, { success: false, error: err.message });
      }
      return;
    }
  }

  // 当前挂起队列（看板刷新兜底）
  if (pathname === '/__api/intercept/holds' && req.method === 'GET') {
    sendJSON(res, 200, { success: true, holds: listPublicHolds() });
    return;
  }

  // 扩展在真正发出请求前调用：连接会挂起直到看板决策或超时
  if (pathname === '/__api/intercept/hold' && req.method === 'POST') {
    try {
      const payload = JSON.parse((await readRequestBody(req)) || '{}');
      if (payload.pageUrl) rememberPageUrl(payload.pageUrl);
      const id = payload.interceptId || ('hold_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
      const timeoutMs = interceptConfig.timeoutMs || 30000;

      // 中文说明：响应断点开启时，一次性模式要跨过 request → response 两个阶段后再关闭。
      if (interceptConfig.mode === 'once' && (payload.phase === 'response' || !interceptConfig.interceptResponse)) {
        interceptConfig = { ...interceptConfig, mode: 'off', once: false, onceStage: '' };
        broadcastSSE('intercept_config', interceptConfig);
      } else if (interceptConfig.mode === 'once' && payload.phase === 'request') {
        interceptConfig = { ...interceptConfig, once: true, onceStage: 'response' };
        broadcastSSE('intercept_config', interceptConfig);
      }

      if (holds.size >= MAX_HOLDS) {
        sendJSON(res, 200, { success: true, interceptId: id, action: 'continue', timedOut: true, overflow: true });
        return;
      }

      const result = await new Promise((resolve) => {
        const createdAt = Date.now();
        const hold = {
          id,
          phase: payload.phase === 'response' ? 'response' : 'request',
          method: String(payload.method || 'GET').toUpperCase(),
          url: toAbsoluteUrl(payload.url || '', payload.pageUrl || lastPageUrl),
          headers: payload.headers || {},
          body: payload.body || '',
          status: payload.status,
          responseHeaders: payload.responseHeaders || {},
          responseBody: payload.responseBody || '',
          pageUrl: payload.pageUrl || '',
          createdAt,
          expiresAt: createdAt + timeoutMs,
          resolve
        };
        hold.timeoutId = setTimeout(() => {
          resolveHold(id, {
            action: 'continue',
            timedOut: true,
            request: { method: hold.method, url: hold.url, headers: hold.headers, body: hold.body },
            response: { status: hold.status, headers: hold.responseHeaders, body: hold.responseBody }
          });
        }, timeoutMs);
        holds.set(id, hold);
        broadcastSSE('hold_created', publicHold(hold));
      });

      sendJSON(res, 200, { success: true, interceptId: id, ...result });
    } catch (err) {
      sendJSON(res, 400, { success: false, error: err.message, action: 'continue', timedOut: true });
    }
    return;
  }

  // 看板决策：放行 / 改完发送 / 丢弃 / Mock
  if (pathname === '/__api/intercept/resume' && req.method === 'POST') {
    try {
      const payload = JSON.parse((await readRequestBody(req)) || '{}');
      const id = payload.interceptId || payload.id;
      if (!id || !holds.has(id)) {
        sendJSON(res, 404, { success: false, error: 'hold not found' });
        return;
      }
      const hold = holds.get(id);
      const action = payload.action || 'continue';
      const result = { action, timedOut: false };
      // 中文说明：一次性双阶段断点若在 request 阶段被丢弃/Mock，就没有 response 可等，立即结束本轮状态。
      if (hold.phase === 'request' && interceptConfig.mode === 'once' && action !== 'continue') {
        interceptConfig = { ...interceptConfig, mode: 'off', once: false, onceStage: '' };
        broadcastSSE('intercept_config', interceptConfig);
      }
      if (action === 'continue') {
        result.request = {
          method: String((payload.request && payload.request.method) || payload.method || hold.method).toUpperCase(),
          url: (payload.request && payload.request.url) || payload.url || hold.url,
          headers: (payload.request && payload.request.headers) || payload.headers || hold.headers,
          body: (payload.request && payload.request.body != null) ? payload.request.body : (payload.body != null ? payload.body : hold.body)
        };
        if (hold.phase === 'response') {
          result.response = {
            status: Number((payload.response && payload.response.status) || payload.mockStatus || hold.status || 200),
            headers: (payload.response && payload.response.headers) || hold.responseHeaders,
            body: (payload.response && payload.response.body != null) ? payload.response.body : (hold.responseBody || '')
          };
        }
      } else if (action === 'mock') {
        result.mock = {
          status: Number((payload.mock && payload.mock.status) || payload.mockStatus || 200),
          headers: (payload.mock && payload.mock.headers) || { 'content-type': 'application/json; charset=utf-8' },
          body: (payload.mock && payload.mock.body != null) ? payload.mock.body : (payload.mockBody || hold.responseBody || '{}')
        };
        if (hold.phase === 'response') {
          result.response = {
            status: result.mock.status,
            headers: result.mock.headers,
            body: result.mock.body
          };
        }
      }
      resolveHold(id, result);
      sendJSON(res, 200, { success: true, interceptId: id, action });
    } catch (err) {
      sendJSON(res, 400, { success: false, error: err.message });
    }
    return;
  }

  // 看板重放与请求工作台都由 Node 直发，不受页面 CORS 限制。
  if ((pathname === '/__api/replay' || pathname === '/__api/request') && req.method === 'POST') {
    try {
      const payload = JSON.parse((await readRequestBody(req)) || '{}');
      const appliedRule = pathname === '/__api/request' ? '请求面板发送' : '看板重放';
      const record = await sendDirectRequest(payload, appliedRule);
      sendJSON(res, 200, { success: true, record });
    } catch (err) {
      sendJSON(res, err.code === 'INVALID_REQUEST' ? 400 : 502, { success: false, error: err.message });
    }
    return;
  }


  // ------------------------------------------------------
  // 路由 F: 接收浏览器扩展/外部上报的抓包数据 (/__api/capture)
  // ------------------------------------------------------
  if (pathname === "/__api/capture" && req.method === "POST") {
    try {
      const bodyStr = await readRequestBody(req);
      const payload = JSON.parse(bodyStr || "{}");

      // 提取并标准化抓包字段，保证与看板完美兼容
      if (payload.pageUrl) rememberPageUrl(payload.pageUrl);
      const pageUrl = payload.pageUrl || lastPageUrl || "";
      const absoluteUrl = toAbsoluteUrl(payload.url || "", pageUrl);
      const record = {
        id: payload.id || ("ext_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7)),
        timestamp: payload.timestamp || new Date().toLocaleTimeString(),
        method: (payload.method || "GET").toUpperCase(),
        url: absoluteUrl,
        targetUrl: toAbsoluteUrl(payload.targetUrl || payload.url || "", pageUrl) || absoluteUrl,
        pageUrl,
        status: payload.status !== undefined ? Number(payload.status) : 200,
        duration: payload.duration !== undefined ? Number(payload.duration) : 0,
        isMock: Boolean(payload.isMock),
        isModified: Boolean(payload.isModified),
        appliedRule: payload.appliedRule || (payload.isMock ? "插件 Mock 拦截" : (payload.isModified ? "插件篡改上报" : "Chrome 扩展抓包")),
        requestHeaders: payload.requestHeaders || {},
        requestBody: typeof payload.requestBody === "object" ? JSON.stringify(payload.requestBody, null, 2) : (payload.requestBody || ""),
        responseHeaders: payload.responseHeaders || {},
        responseBody: typeof payload.responseBody === "object" ? JSON.stringify(payload.responseBody, null, 2) : (payload.responseBody || "")
      };

      // 记录存入内存队列（限制最大数量）
      records.unshift(record);
      if (records.length > MAX_RECORDS) records.pop();

      // 实时通过 SSE 广播到已打开的抓包看板
      broadcastSSE("new_record", record);

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ success: true, message: "抓包上报成功", id: record.id }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // ------------------------------------------------------
  // 路由 E: 快捷模拟测试请求 (/__api/test)
  // 方便前台一键触发流量流动，验证网关链路
  // ------------------------------------------------------
  if (pathname === '/__api/test' && req.method === 'POST') {
    // 异步触发一次自测试，可以是上游请求或 Mock 请求
    const testEndpoints = ['/api/posts/1', '/api/user', '/api/users/2', '/api/error'];
    const selected = testEndpoints[Math.floor(Math.random() * testEndpoints.length)];

    // 内部调用本机端口执行测试请求
    setTimeout(async () => {
      try {
        await fetch(`http://127.0.0.1:${PORT}${selected}`, {
          method: 'GET',
          headers: { 'x-test-client': 'packet-monitor-dashboard' }
        });
      } catch (e) {
        console.error('自测试请求发送失败:', e.message);
      }
    }, 50);

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, targetTriggered: selected }));
    return;
  }

  // ------------------------------------------------------
  // 路由 F: 透明代理中枢与拦截引擎 (处理 /api/* 及外部一切请求)
  // ------------------------------------------------------
  const startTime = Date.now();
  const rawBody = await readRequestBody(req);

  // 过滤出当前启用的规则
  const activeRules = rules.filter((r) => r.enabled);

  // 1. 检查是否命中 Mock 短路规则
  const matchedMock = activeRules.find((r) => {
    if (r.type !== 'mock_response' || !r.matchUrl) return false;
    try {
      return new RegExp(r.matchUrl).test(req.url);
    } catch {
      return false;
    }
  });

  if (matchedMock) {
    const duration = Date.now() - startTime;
    const mockStatus = parseInt(matchedMock.mockStatus, 10) || 200;
    const mockBody = matchedMock.mockBody || '';

    // 构造抓包记录并存入历史
    const record = {
      id: 'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      timestamp: new Date().toLocaleTimeString(),
      method: req.method,
      url: req.url,
      targetUrl: '[MOCK 短路 - 无需上游]',
      status: mockStatus,
      duration,
      isMock: true,
      isModified: false,
      appliedRule: matchedMock.name,
      requestHeaders: req.headers,
      requestBody: rawBody,
      responseHeaders: { 'content-type': 'application/json; charset=utf-8', 'x-powered-by': 'Packet-Monitor-Mock-Gateway' },
      responseBody: mockBody
    };

    records.unshift(record);
    if (records.length > MAX_RECORDS) records.pop();
    broadcastSSE('new_record', record);

    res.writeHead(mockStatus, {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Powered-By': 'Packet-Monitor-Mock-Gateway'
    });
    res.end(mockBody);
    return;
  }

  // 2. 检查 Header 注入与 Body 篡改规则
  let isModified = false;
  const forwardedHeaders = { ...req.headers };
  delete forwardedHeaders['host']; // 移除原宿主 Host 头，避免上游校验失败

  let modifiedBody = rawBody;

  for (const rule of activeRules) {
    const match = rule.matchUrl ? new RegExp(rule.matchUrl).test(req.url) : true;
    if (!match) continue;

    if (rule.type === 'inject_header' && rule.headerKey) {
      forwardedHeaders[rule.headerKey.toLowerCase()] = rule.headerValue || '';
      isModified = true;
    }

    if (rule.type === 'tamper_body' && rule.newBody) {
      modifiedBody = rule.newBody;
      isModified = true;
    }
  }

  // 3. 向上游发起代理请求
  // 转换请求路径：将 /api/xxx 映射为上游根路径下的 /xxx
  let targetSubPath = req.url;
  if (targetSubPath.startsWith('/api/')) {
    targetSubPath = targetSubPath.replace(/^\/api/, '');
  }
  const upstreamUrl = new URL(targetSubPath, DEFAULT_UPSTREAM);

  try {
    const fetchOptions = {
      method: req.method,
      headers: forwardedHeaders
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fetchOptions.body = modifiedBody;
    }

    const upstreamRes = await fetch(upstreamUrl.toString(), fetchOptions);
    const duration = Date.now() - startTime;
    const responseBodyText = await upstreamRes.text();

    // 收集上游响应头
    const resHeadersObj = {};
    upstreamRes.headers.forEach((val, key) => {
      // 过滤 hop-by-hop 头
      if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(key.toLowerCase())) {
        resHeadersObj[key] = val;
      }
    });

    // 构造抓包流水记录
    const record = {
      id: 'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      timestamp: new Date().toLocaleTimeString(),
      method: req.method,
      url: req.url,
      targetUrl: upstreamUrl.toString(),
      status: upstreamRes.status,
      duration,
      isMock: false,
      isModified,
      appliedRule: isModified ? 'Header/Body 篡改' : '标准透明转发',
      requestHeaders: forwardedHeaders,
      requestBody: modifiedBody,
      responseHeaders: resHeadersObj,
      responseBody: responseBodyText
    };

    records.unshift(record);
    if (records.length > MAX_RECORDS) records.pop();
    broadcastSSE('new_record', record);

    // 响应客户端
    res.writeHead(upstreamRes.status, resHeadersObj);
    res.end(responseBodyText);
  } catch (err) {
    const duration = Date.now() - startTime;
    const errBody = JSON.stringify({
      error: 'Gateway Upstream Error',
      message: err.message,
      target: upstreamUrl.toString()
    });

    const record = {
      id: 'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      timestamp: new Date().toLocaleTimeString(),
      method: req.method,
      url: req.url,
      targetUrl: upstreamUrl.toString(),
      status: 502,
      duration,
      isMock: false,
      isModified,
      appliedRule: '上游网关异常捕获',
      requestHeaders: forwardedHeaders,
      requestBody: modifiedBody,
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: errBody
    };

    records.unshift(record);
    broadcastSSE('new_record', record);

    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(errBody);
  }
});

// --------------------------------------------------------
// 6. 监听端口并写入运行 PID 文件
// --------------------------------------------------------
server.listen(PORT, '0.0.0.0', () => {
  fs.writeFileSync(PID_FILE, String(process.pid));
  console.log(`[包监控 Gateway] 极简抓包网关已成功启动！`);
  console.log(`- 监听地址: http://localhost:${PORT}`);
  console.log(`- 托管看板: http://localhost:${PORT}/hello_dashboard.html`);
  console.log(`- 默认上游: ${DEFAULT_UPSTREAM}`);
  console.log(`- 进程 PID: ${process.pid}`);
});

// 优雅关闭处理
process.on('SIGTERM', () => {
  server.close(() => {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    process.exit(0);
  });
});
