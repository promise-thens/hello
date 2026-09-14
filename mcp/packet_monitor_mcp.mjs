#!/usr/bin/env node
// 中文说明：包监控 MCP 服务，通过 stdio 为 Codex 提供本地抓包查询与调试工具。
// 该服务只连接现有 8910 网关，不改变网关的监听地址、CORS 或鉴权策略。

import readline from 'node:readline';

const SERVER_NAME = 'packet-monitor';
const SERVER_VERSION = '0.1.0';
const GATEWAY_BASE = process.env.PACKET_MONITOR_GATEWAY || 'http://127.0.0.1:8910';

// 中文说明：MCP 的 stdout 只允许输出 JSON-RPC，日志统一写入 stderr。
function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function gateway(pathname, options = {}) {
  const response = await fetch(`${GATEWAY_BASE}${pathname}`, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) }
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { success: false, error: text || `HTTP ${response.status}` };
  }
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || `网关请求失败：HTTP ${response.status}`);
  }
  return payload;
}

function textResult(value, structuredContent = value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent,
    isError: false
  };
}

function toolSchemas() {
  return [
    {
      name: 'packet_status',
      title: '查看包监控状态',
      description: '检查 8910 网关、规则、断点数量和当前拦截模式。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'list_recent_requests',
      title: '列出最近抓包',
      description: '读取最近捕获的完整请求记录，包含请求头、请求体、响应头和响应体。',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, description: '返回条数，默认 20。' },
          method: { type: 'string', description: '可选 HTTP 方法过滤，例如 GET。' }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'get_request_detail',
      title: '查看抓包详情',
      description: '按抓包记录 ID 返回完整原始请求与响应，不脱敏、不截断。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '抓包记录 ID。' } },
        required: ['id'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'list_alerts',
      title: '列出异常请求',
      description: '根据状态码和耗时筛选失败或慢请求，返回完整原始记录。',
      inputSchema: {
        type: 'object',
        properties: {
          minDurationMs: { type: 'integer', minimum: 0, description: '慢请求阈值，默认 1000 毫秒。' },
          include4xx: { type: 'boolean', description: '是否包含 4xx，默认 true。' },
          include5xx: { type: 'boolean', description: '是否包含 5xx，默认 true。' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: '返回条数，默认 20。' }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'wait_for_request',
      title: '等待下一条抓包',
      description: '通过网关 SSE 等待下一条匹配 URL 的真实抓包记录或断点事件。',
      inputSchema: {
        type: 'object',
        properties: {
          matchUrl: { type: 'string', description: '可选 URL 包含文本或正则表达式。' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000, description: '等待时长，默认 30000 毫秒。' }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'set_intercept_mode',
      title: '设置发送前断点',
      description: '设置发送前拦截模式：off、match、all 或 once。',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['off', 'match', 'all', 'once'] },
          matchUrl: { type: 'string', description: 'match/once 模式下的 URL 包含文本或正则。' },
          timeoutMs: { type: 'integer', minimum: 3000, maximum: 120000 },
          interceptResponse: { type: 'boolean' }
        },
        required: ['mode'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'resume_intercept',
      title: '处理断点请求',
      description: '对挂起请求执行原样放行、修改后发送、Mock 或丢弃。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '断点 ID。' },
          action: { type: 'string', enum: ['continue', 'mock', 'drop'] },
          request: { type: 'object', description: '可选修改后的 method/url/headers/body。' },
          response: { type: 'object', description: '响应断点可选修改后的 status/headers/body。' },
          mock: { type: 'object', description: 'Mock 动作的 status/headers/body。' }
        },
        required: ['id', 'action'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    {
      name: 'replay_request',
      title: '重放抓包请求',
      description: '使用指定 method、URL、headers 和 body 从网关重放请求，并返回新抓包记录。',
      inputSchema: {
        type: 'object',
        properties: {
          method: { type: 'string' },
          url: { type: 'string' },
          headers: { type: 'object' },
          body: { type: ['string', 'null'] }
        },
        required: ['url'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    },
    // 中文说明：手工请求工具对应看板“请求”Tab，直发网关并回流为新的抓包记录。
    {
      name: 'send_request',
      title: '发送编辑请求',
      description: '像 Postman 一样由 8910 网关直发一条手工 HTTP 请求，并把结果写入抓包历史。',
      inputSchema: {
        type: 'object',
        properties: {
          method: { type: 'string', description: 'HTTP 方法，默认 GET。' },
          url: { type: 'string', description: '完整的 http(s) URL。' },
          headers: { type: 'object', description: '请求头键值对。' },
          body: { type: ['string', 'null'], description: '请求体；GET/HEAD 会忽略。' },
          name: { type: 'string', description: '可选请求名称，写入抓包记录。' }
        },
        required: ['url'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    },
    {
      name: 'apply_edited_to_page',
      title: '修改后发送到原页面',
      description: '对应看板「修改后发送」：按抓包记录改响应 JSON 字段，登记一次性回写并刷新原业务页。不要用 replay_request 代替，因为重放不会刷新原页面。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '抓包记录 ID；挂起断点也可传入 hold id。' },
          matchUrl: { type: 'string', description: '未给 id 时，按 URL 包含文本或正则取最近一条匹配记录。' },
          fields: {
            type: 'object',
            additionalProperties: true,
            description: '响应 JSON 字段补丁，键为点路径，例如 data.installAddress。'
          },
          responseBody: { type: ['string', 'null'], description: '可选完整响应体；提供后优先生效，不再用 fields 打补丁。' },
          status: { type: 'integer', description: '可选 HTTP 状态码，默认沿用原记录。' },
          responseHeaders: { type: 'object', description: '可选响应头覆盖/合并。' },
          waitMs: { type: 'integer', minimum: 0, maximum: 60000, description: '等待原页刷新并吃到改后响应的时长，默认 12000；0 表示只登记不等待。' }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    {
      name: 'clear_capture_history',
      title: '清空抓包历史',
      description: '清空网关内存中的抓包记录；不可恢复，必须在用户明确要求时调用。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    }
  ];
}

function matches(value, pattern) {
  if (!pattern) return true;
  try { return new RegExp(pattern, 'i').test(value || ''); } catch { return String(value || '').toLowerCase().includes(String(pattern).toLowerCase()); }
}

function isAbsoluteHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// 中文说明：把 data.installAddress 或 data.list[0].name 写进 JSON 对象。
function setByPath(target, path, value) {
  const parts = String(path || '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  if (!parts.length) throw new Error('字段路径不能为空');
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    const nextIsIndex = /^\d+$/.test(parts[i + 1]);
    if (cursor[key] == null || typeof cursor[key] !== 'object') {
      cursor[key] = nextIsIndex ? [] : {};
    }
    cursor = cursor[key];
  }
  const last = parts[parts.length - 1];
  cursor[/^\d+$/.test(last) ? Number(last) : last] = value;
  return target;
}

function parseJsonBody(text) {
  const raw = text == null ? '' : String(text);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new Error(`响应体不是 JSON，不能按字段打补丁：${cause.message}`);
  }
}

function applyResponseFields(record, args) {
  const headers = { ...(record.responseHeaders || {}) };
  const extraHeaders = args.responseHeaders && typeof args.responseHeaders === 'object' ? args.responseHeaders : {};
  Object.assign(headers, extraHeaders);
  if (!headers['content-type'] && !headers['Content-Type']) {
    headers['content-type'] = 'application/json; charset=utf-8';
  }
  let body;
  if (args.responseBody != null && String(args.responseBody) !== '') {
    body = String(args.responseBody);
  } else if (args.fields && typeof args.fields === 'object' && Object.keys(args.fields).length) {
    const parsed = parseJsonBody(record.responseBody);
    for (const [path, value] of Object.entries(args.fields)) setByPath(parsed, path, value);
    body = JSON.stringify(parsed, null, 2);
  } else {
    body = record.responseBody == null ? '' : String(record.responseBody);
  }
  return {
    status: Number(args.status || record.status || 200),
    headers,
    body
  };
}

async function findTargetRecord(args) {
  const id = String(args.id || '').trim();
  if (id) {
    const payload = await gateway(`/__api/records?id=${encodeURIComponent(id)}`);
    if (payload.records?.[0]) return payload.records[0];
    const holdsPayload = await gateway('/__api/intercept/holds');
    const hold = (holdsPayload.holds || []).find((item) => item.id === id);
    if (hold) return { ...hold, isHold: true, targetUrl: hold.url, requestHeaders: hold.headers, requestBody: hold.body };
    throw new Error(`未找到抓包记录或挂起断点：${id}`);
  }
  const matchUrl = String(args.matchUrl || '').trim();
  const payload = await gateway('/__api/records?limit=100');
  const records = payload.records || [];
  const found = matchUrl
    ? records.find((record) => matches(record.url, matchUrl) || matches(record.targetUrl, matchUrl))
    : records[0];
  if (!found) throw new Error(matchUrl ? `没有匹配 ${matchUrl} 的抓包记录` : '当前没有抓包记录');
  return found;
}

async function waitForPageApply(applyId, timeoutMs) {
  const waitMs = Math.min(Math.max(Number(timeoutMs) || 0, 0), 60000);
  if (waitMs <= 0) return { event: 'created', data: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), waitMs);
  const events = [];
  try {
    const response = await fetch(`${GATEWAY_BASE}/__events`, { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`SSE 连接失败：HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const frame of frames) {
        const line = frame.split('\n').find((entry) => entry.startsWith('data:'));
        if (!line) continue;
        const payload = JSON.parse(line.slice(5).trim());
        if (payload.type !== 'page_apply') continue;
        const data = payload.data || {};
        if (applyId && data.id !== applyId) continue;
        events.push(data);
        if (data.stage === 'applied') return { event: 'applied', data, events };
      }
    }
    const last = events[events.length - 1] || null;
    return { event: last?.stage || 'timeout', data: last, events };
  } catch (cause) {
    if (cause?.name === 'AbortError') {
      const last = events[events.length - 1] || null;
      return { event: last?.stage || 'timeout', data: last, events };
    }
    throw cause;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function applyEditedToPage(args) {
  const record = await findTargetRecord(args);
  const response = applyResponseFields(record, args);
  if (record.isHold) {
    const body = {
      interceptId: record.id,
      action: 'continue',
      request: {
        method: record.method,
        url: record.url,
        headers: record.requestHeaders || record.headers || {},
        body: record.requestBody || record.body || ''
      },
      response,
      mock: response
    };
    const resumed = await gateway('/__api/intercept/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return {
      mode: 'hold_resume',
      refreshedPage: false,
      note: '请求仍挂在页面里，已按改后响应直接放行，无需刷新。',
      recordId: record.id,
      response,
      result: resumed
    };
  }
  const runtime = await gateway('/__api/runtime');
  const targetUrl = record.targetUrl || record.url || '';
  const pageUrl = record.pageUrl || runtime.lastPageUrl || '';
  if (!isAbsoluteHttpUrl(targetUrl)) throw new Error('这条 URL 不是完整地址，没法回写原页面');
  if (!isAbsoluteHttpUrl(pageUrl)) throw new Error('这条记录没有业务页地址。请在 Chrome 打开目标页再抓一次，然后再修改后发送');
  const applied = await gateway('/__api/page-apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method: record.method || 'GET',
      url: targetUrl,
      pageUrl,
      response
    })
  });
  const apply = applied.apply || {};
  const waitMs = args.waitMs == null ? 12000 : Number(args.waitMs);
  const wait = await waitForPageApply(apply.id, waitMs);
  const refreshedPage = wait.event === 'applied' || wait.event === 'reloaded';
  let note = '已登记改后响应。';
  if (wait.event === 'applied') note = '原页面已刷新，并吃到改后响应。';
  else if (wait.event === 'reloaded') note = '原页面已开始刷新，但还没确认吃到改后响应。';
  else if (waitMs > 0) note = '已把改后数据交给原页面，但还没刷新。请确认 Chrome 开着这个地址，并刷新「包监控」扩展。';
  return {
    mode: 'page_apply',
    refreshedPage,
    note,
    recordId: record.id,
    pageUrl,
    url: targetUrl,
    fields: args.fields || {},
    apply,
    wait,
    response
  };
}

async function waitForRequest(args) {
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 30000, 1000), 120000);
  const matchUrl = String(args.matchUrl || '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${GATEWAY_BASE}/__events`, { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`SSE 连接失败：HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const frame of frames) {
        const line = frame.split('\n').find((entry) => entry.startsWith('data:'));
        if (!line) continue;
        const payload = JSON.parse(line.slice(5).trim());
        if (!['new_record', 'hold_created'].includes(payload.type)) continue;
        const record = payload.data || {};
        if (matches(record.url, matchUrl)) return { event: payload.type, data: record };
      }
    }
    return { event: 'timeout', data: null };
  } catch (cause) {
    if (cause?.name === 'AbortError') return { event: 'timeout', data: null };
    throw cause;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function callTool(name, args) {
  if (name === 'packet_status') return textResult(await gateway('/__api/status'));
  if (name === 'list_recent_requests') {
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
    const query = new URLSearchParams({ limit: String(limit) });
    if (args.method) query.set('method', String(args.method).toUpperCase());
    return textResult(await gateway(`/__api/records?${query}`));
  }
  if (name === 'get_request_detail') {
    const id = String(args.id || '').trim();
    if (!id) throw new Error('id 不能为空');
    const payload = await gateway(`/__api/records?id=${encodeURIComponent(id)}`);
    if (!payload.records?.length) throw new Error(`未找到抓包记录：${id}`);
    return textResult(payload.records[0], { record: payload.records[0] });
  }
  if (name === 'list_alerts') {
    const payload = await gateway('/__api/records?limit=100');
    const minDurationMs = Math.max(Number(args.minDurationMs) || 1000, 0);
    const include4xx = args.include4xx !== false;
    const include5xx = args.include5xx !== false;
    const records = (payload.records || []).filter((record) => {
      const status = Number(record.status) || 0;
      const statusAlert = (include4xx && status >= 400 && status < 500) || (include5xx && status >= 500);
      return statusAlert || Number(record.duration) >= minDurationMs;
    }).slice(0, Math.min(Math.max(Number(args.limit) || 20, 1), 100));
    return textResult({ records, total: records.length, minDurationMs });
  }
  if (name === 'wait_for_request') return textResult(await waitForRequest(args));
  if (name === 'set_intercept_mode') {
    const body = {
      mode: args.mode,
      matchUrl: args.matchUrl || '',
      timeoutMs: args.timeoutMs,
      interceptResponse: Boolean(args.interceptResponse)
    };
    return textResult(await gateway('/__api/intercept/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  }
  if (name === 'resume_intercept') {
    const body = { interceptId: args.id, action: args.action, request: args.request, response: args.response, mock: args.mock };
    return textResult(await gateway('/__api/intercept/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  }
  if (name === 'replay_request') {
    const body = { method: args.method || 'GET', url: args.url, headers: args.headers || {}, body: args.body ?? '' };
    return textResult(await gateway('/__api/replay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  }
  // 中文说明：调用请求工作台的网关接口，保留用户明确传入的 Headers 与 Body。
  if (name === 'send_request') {
    const body = {
      method: args.method || 'GET',
      url: args.url,
      headers: args.headers || {},
      body: args.body ?? '',
      name: args.name || ''
    };
    return textResult(await gateway('/__api/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  }
  if (name === 'apply_edited_to_page') return textResult(await applyEditedToPage(args));
  if (name === 'clear_capture_history') {
    return textResult(await gateway('/__api/clear', { method: 'POST' }));
  }
  throw new Error(`未知工具：${name}`);
}

async function handle(message) {
  if (!message || typeof message !== 'object') return error(null, -32600, 'Invalid Request');
  const id = message.id;
  const method = message.method;
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  if (!method) return error(id, -32600, 'Invalid Request');
  if (method.startsWith('notifications/') || method === '$/cancelRequest') return null;
  if (method === 'initialize') {
    return result(id, {
      protocolVersion: params.protocolVersion || '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, title: '包监控', version: SERVER_VERSION },
      instructions: '使用 packet_status 检查网关；用 list_recent_requests 或 get_request_detail 读取完整原始抓包；用户要改某个响应字段并刷新原页面时，必须用 apply_edited_to_page，不要用 replay_request；请求面板或 send_request 会由网关直发并写入抓包历史；涉及清空、放行、重放、修改后发送和发送请求时仅在用户明确要求后执行。'
    });
  }
  if (method === 'ping') return result(id, {});
  if (method === 'tools/list') return result(id, { tools: toolSchemas() });
  if (method === 'tools/call') {
    try { return result(id, await callTool(params.name, params.arguments || {})); }
    catch (cause) { return result(id, { content: [{ type: 'text', text: `包监控 MCP 失败：${cause.message}` }], isError: true }); }
  }
  if (['resources/list', 'resources/templates/list', 'prompts/list'].includes(method)) {
    const key = method === 'resources/list' ? 'resources' : method === 'prompts/list' ? 'prompts' : 'resourceTemplates';
    return result(id, { [key]: [] });
  }
  return error(id, -32601, `Method not found: ${method}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  try {
    const message = JSON.parse(line);
    const reply = await handle(message);
    if (reply) writeMessage(reply);
  } catch (cause) {
    writeMessage(error(null, -32700, `Parse error: ${cause.message}`));
  }
}
