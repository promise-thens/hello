// ========================================================
// 文件名: inject.js
// 运行环境: 网页主上下文 (world: "MAIN", document_start)
// 核心职责:
//   1. 劫持 fetch / XHR，把页面请求接到包监控抓包引擎
//   2. 发送前可向 8910 网关挂起，等看板编辑后再放行/丢弃/Mock
//   3. 响应前可挂起 fetch / XHR，等看板编辑后再交还页面
//   4. 规则引擎：Mock 短路、Header 注入、Body 篡改
//   5. 抓包上报看板，并隔离自身通信防止死循环
// ========================================================

(function () {
  'use strict';
  if (window.__HELLO_INJECT_LOADED__) return;
  window.__HELLO_INJECT_LOADED__ = true;

  const GATEWAY_BASE = 'http://localhost:8910';
  const RUNTIME_API = GATEWAY_BASE + '/__api/runtime';
  const CAPTURE_API = GATEWAY_BASE + '/__api/capture';
  const HOLD_API = GATEWAY_BASE + '/__api/intercept/hold';

  const origFetch = window.fetch;
  // 中文说明：保留原生 XHR 构造器和事件 API，确保响应断点监听器先于业务页监听器注册。
  const OriginalXMLHttpRequest = window.XMLHttpRequest;
  const xhrPrototype = OriginalXMLHttpRequest.prototype;
  const origXHROpen = xhrPrototype.open;
  const origXHRSend = xhrPrototype.send;
  const origXHRSetRequestHeader = xhrPrototype.setRequestHeader;
  const origXHRAddEventListener = xhrPrototype.addEventListener;
  const origXHRDispatchEvent = xhrPrototype.dispatchEvent;

  let globalEnabled = true;
  let rulesCache = [];
  let interceptConfig = { mode: 'off', matchUrl: '', timeoutMs: 30000, interceptResponse: false, once: false, onceStage: '' };
  let pageAppliesCache = [];
  let lastSyncTime = 0;
  const CACHE_TTL = 1000;

  function isInternalUrl(targetUrl) {
    if (!targetUrl) return false;
    const str = String(targetUrl);
    return str.indexOf('8910/__api') >= 0 || str.indexOf('127.0.0.1:8910/__api') >= 0 || str.indexOf('localhost:8910/__events') >= 0;
  }

  // 中文说明：页面 fetch/XHR 经常传相对路径，补成绝对地址后看板重放才能直接发出。
  function toAbsoluteUrl(targetUrl) {
    const raw = String(targetUrl || '').trim();
    if (!raw) return '';
    try { return new URL(raw, location.href).href; } catch (e) { return raw; }
  }

  function normalizeHeaders(headers) {
    const result = {};
    if (!headers) return result;
    if (typeof headers.forEach === 'function') {
      headers.forEach(function (value, key) { result[String(key).toLowerCase()] = value; });
    } else if (Array.isArray(headers)) {
      headers.forEach(function (pair) {
        if (pair) result[String(pair[0]).toLowerCase()] = pair[1];
      });
    } else if (typeof headers === 'object') {
      Object.keys(headers).forEach(function (key) { result[key.toLowerCase()] = headers[key]; });
    }
    return result;
  }

  function stringifyBody(body) {
    if (body == null || body === '') return '';
    if (typeof body === 'string') return body;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
    if (typeof FormData !== 'undefined' && body instanceof FormData) return '[FormData]';
    if (typeof Blob !== 'undefined' && body instanceof Blob) return '[Blob]';
    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return '[ArrayBuffer]';
    if (typeof body === 'object') {
      try { return JSON.stringify(body); } catch (e) { return String(body); }
    }
    return String(body);
  }

  function safeTest(pattern, text) {
    if (!pattern) return false;
    try { return new RegExp(pattern).test(String(text || '')); } catch (e) { return false; }
  }

  function isGatewayPage() {
    const host = location.hostname;
    return (host === 'localhost' || host === '127.0.0.1') && String(location.port) === '8910';
  }

  // 中文说明：把网关快照写进本地缓存，供后续 fetch/XHR 拦截立刻使用。
  function applyRuntimeSnapshot(json) {
    if (!json) return;
    if (Array.isArray(json.rules)) rulesCache = json.rules;
    if (json.config) {
      interceptConfig = {
        mode: json.config.mode || 'off',
        matchUrl: json.config.matchUrl || '',
        timeoutMs: json.config.timeoutMs || 30000,
        interceptResponse: Boolean(json.config.interceptResponse),
        once: Boolean(json.config.once),
        onceStage: json.config.onceStage || ''
      };
    }
    if (Array.isArray(json.pageApplies)) pageAppliesCache = json.pageApplies;
  }

  async function syncRuntime(force) {
    const now = Date.now();
    if (!force && now - lastSyncTime < CACHE_TTL) return;
    lastSyncTime = now;
    try {
      const res = await origFetch(RUNTIME_API, { method: 'GET', headers: { 'x-hello-internal': '1' } });
      if (!res.ok) return;
      const json = await res.json();
      applyRuntimeSnapshot(json);
      await processPageApplyReload();
    } catch (e) {}
  }

  function reportToGateway(payload) {
    try {
      const absoluteUrl = toAbsoluteUrl(payload.url);
      origFetch(CAPTURE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hello-internal': '1' },
        body: JSON.stringify(Object.assign({}, payload, {
          url: absoluteUrl,
          targetUrl: toAbsoluteUrl(payload.targetUrl || payload.url),
          pageUrl: payload.pageUrl || String(location.href || '')
        }))
      }).catch(function () {});
    } catch (e) {}
  }

  function evaluateRules(url, rules) {
    const active = (rules || []).filter(function (r) { return r && r.enabled; });
    const mockRule = active.find(function (r) { return r.type === 'mock_response' && safeTest(r.matchUrl, url); });
    const headerRules = active.filter(function (r) {
      return r.type === 'inject_header' && r.headerKey && safeTest(r.matchUrl, url);
    });
    const bodyRule = active.find(function (r) {
      return r.type === 'tamper_body' && r.newBody != null && safeTest(r.matchUrl, url);
    });
    return { mockRule: mockRule, headerRules: headerRules, bodyRule: bodyRule };
  }

  // 中文说明：去掉 hash 后比较业务页地址，避免路由锚点导致刷新对不上。
  function normalizePageHref(url) {
    try {
      const parsed = new URL(String(url || ''), location.href);
      parsed.hash = '';
      return parsed.href;
    } catch (e) {
      return String(url || '');
    }
  }

  function pageUrlMatches(pageUrl) {
    if (!pageUrl) return false;
    return normalizePageHref(pageUrl) === normalizePageHref(location.href);
  }

  // 中文说明：同一接口经常带时间戳参数，所以按 method + origin + pathname 匹配。
  function requestMatchesApply(apply, method, url) {
    if (!apply || !apply.url) return false;
    if (String(apply.method || 'GET').toUpperCase() !== String(method || 'GET').toUpperCase()) return false;
    try {
      const expected = new URL(apply.url, location.href);
      const actual = new URL(url, location.href);
      return expected.origin === actual.origin && expected.pathname === actual.pathname;
    } catch (e) {
      return String(apply.url) === String(url);
    }
  }

  function findPageApplyForRequest(method, url) {
    return (pageAppliesCache || []).find(function (item) { return requestMatchesApply(item, method, url); }) || null;
  }

  async function ackPageApply(id, action) {
    try {
      const res = await origFetch(GATEWAY_BASE + '/__api/page-apply/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hello-internal': '1' },
        body: JSON.stringify({ id: id, action: action })
      });
      if (!res.ok) return {};
      return (await res.json()) || {};
    } catch (e) {
      return {};
    }
  }

  // 中文说明：先向网关声明“我来刷新”，避免多个注入脚本同时 reload 打成死循环。
  async function processPageApplyReload() {
    const apply = (pageAppliesCache || []).find(function (item) {
      return item && !item.reloadConsumed && pageUrlMatches(item.pageUrl);
    });
    if (!apply) return;
    const result = await ackPageApply(apply.id, 'reloaded');
    if (!result || !result.shouldReload) return;
    location.reload();
  }

  function consumeLocalPageApply(id) {
    pageAppliesCache = (pageAppliesCache || []).filter(function (item) { return item && item.id !== id; });
  }

  function pageApplyResponse(apply) {
    const response = (apply && apply.response) || {};
    const headers = response.headers && typeof response.headers === 'object' ? response.headers : {};
    if (!headers['content-type'] && !headers['Content-Type']) headers['content-type'] = 'application/json; charset=utf-8';
    return {
      status: Number(response.status || 200),
      headers: headers,
      body: response.body == null ? '' : String(response.body)
    };
  }

  function shouldHold(url, phase) {
    const cfg = interceptConfig || {};
    if (!cfg.mode || cfg.mode === 'off') return false;
    if (phase === 'response' && !cfg.interceptResponse) return false;
    if (cfg.mode === 'all') return true;
    if (cfg.mode === 'once') {
      // 中文说明：一次性响应断点在 request 阶段消费后，只允许同一模式继续拦 response。
      if (cfg.onceStage === 'response' && phase !== 'response') return false;
      return cfg.matchUrl ? safeTest(cfg.matchUrl, url) : true;
    }
    if (cfg.mode === 'match') return safeTest(cfg.matchUrl, url);
    return false;
  }

  async function waitHoldDecision(snapshot) {
    try {
      const res = await origFetch(HOLD_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hello-internal': '1' },
        body: JSON.stringify(snapshot)
      });
      if (!res.ok) return { action: 'continue', timedOut: true };
      return (await res.json()) || { action: 'continue' };
    } catch (e) {
      return { action: 'continue', timedOut: true };
    }
  }

  // 中文说明：读取 XHR 原始响应，供响应断点展示和后续改写；二进制响应保留原值，不强行转文本。
  function readXHRResponse(xhr) {
    const responseType = String(xhr.responseType || '');
    let responseValue = null;
    let body = '';
    try { responseValue = xhr.response; } catch (e) {}
    if (responseType === '' || responseType === 'text') {
      try { body = String(xhr.responseText || ''); } catch (e) {}
    } else if (responseType === 'json') {
      try { body = responseValue == null ? '' : JSON.stringify(responseValue); } catch (e) { body = ''; }
    } else if (typeof responseValue === 'string') {
      body = responseValue;
    } else if (responseValue != null) {
      body = '[二进制响应，暂不支持文本编辑]';
    }
    return {
      status: Number(xhr.status || 0),
      statusText: String(xhr.statusText || ''),
      headers: readXHRResponseHeaders(xhr),
      body: body,
      responseType: responseType,
      responseValue: responseValue
    };
  }

  // 中文说明：把原生 getAllResponseHeaders 的结果转换成看板使用的键值对象。
  function readXHRResponseHeaders(xhr) {
    const result = {};
    try {
      String(xhr.getAllResponseHeaders() || '').split(/\r?\n/).forEach(function (line) {
        const idx = line.indexOf(':');
        if (idx > 0) result[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      });
    } catch (e) {}
    return result;
  }

  // 中文说明：响应断点结束后删除上一次请求写入的实例属性，避免复用 XHR 时遮住新的原生状态。
  function resetXHRResponseOverrides(xhr) {
    ['status', 'statusText', 'readyState', 'responseText', 'response', 'responseURL', 'getAllResponseHeaders', 'getResponseHeader'].forEach(function (key) {
      try { delete xhr[key]; } catch (e) {}
    });
  }

  function defineXHRValue(xhr, key, value) {
    try {
      Object.defineProperty(xhr, key, { value: value, configurable: true, enumerable: false, writable: false });
      return true;
    } catch (e) {
      return false;
    }
  }

  // 中文说明：将看板改好的状态、正文和响应头覆盖到 XHR 实例，让业务监听器读到新数据。
  function applyXHRResponse(xhr, responseData, requestUrl) {
    const responseType = String(xhr.responseType || '');
    const headers = responseData.headers || {};
    const headerLines = Object.keys(headers).map(function (key) { return key + ': ' + headers[key]; });
    const status = responseData.status == null ? 200 : Number(responseData.status);
    const body = String(responseData.body == null ? '' : responseData.body);
    defineXHRValue(xhr, 'status', status);
    defineXHRValue(xhr, 'statusText', String(responseData.statusText || (status >= 200 && status < 300 ? 'OK' : '')));
    defineXHRValue(xhr, 'readyState', 4);
    if (requestUrl) defineXHRValue(xhr, 'responseURL', requestUrl);
    if (responseType === '' || responseType === 'text' || responseType === 'document') {
      defineXHRValue(xhr, 'responseText', body);
      defineXHRValue(xhr, 'response', body);
    } else if (responseType === 'json') {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch (e) { parsed = null; }
      defineXHRValue(xhr, 'response', parsed);
    } else if (responseType === 'arraybuffer' && typeof TextEncoder !== 'undefined') {
      defineXHRValue(xhr, 'response', new TextEncoder().encode(body).buffer);
    } else if (responseType === 'blob' && typeof Blob !== 'undefined') {
      defineXHRValue(xhr, 'response', new Blob([body], { type: headers['content-type'] || 'text/plain' }));
    }
    defineXHRValue(xhr, 'getAllResponseHeaders', function () {
      return headerLines.length ? headerLines.join('\r\n') + '\r\n' : '';
    });
    defineXHRValue(xhr, 'getResponseHeader', function (name) {
      const key = String(name || '').toLowerCase();
      return Object.prototype.hasOwnProperty.call(headers, key) ? String(headers[key]) : null;
    });
  }

  // 中文说明：响应断点决定后，按原生 XHR 的终态顺序重新派发事件；内部监听器会跳过这次回放。
  function dispatchSyntheticXHR(xhr, eventNames) {
    xhr.__helloDispatching = true;
    try {
      eventNames.forEach(function (name) {
        origXHRDispatchEvent.call(xhr, new Event(name));
      });
    } finally {
      xhr.__helloDispatching = false;
    }
  }

  // 中文说明：真正执行 XHR 响应前断点，把看板决策回写页面后再触发 load/loadend。
  async function holdXHRResponse(xhr, ctx, snapshot) {
    const original = readXHRResponse(xhr);
    let decision = { action: 'continue' };
    try {
      decision = await waitHoldDecision({
        phase: 'response', method: snapshot.method, url: snapshot.url,
        headers: snapshot.headers, body: snapshot.body, status: original.status,
        responseHeaders: original.headers, responseBody: original.body,
        pageUrl: String(location.href || '')
      });
      const action = decision.action || 'continue';
      if (action === 'drop') {
        applyXHRResponse(xhr, { status: 0, statusText: '', headers: {}, body: '' }, snapshot.url);
        reportToGateway({
          method: snapshot.method, url: snapshot.url, status: 0, duration: Math.round(performance.now() - snapshot.startedAt),
          isMock: false, isModified: true, appliedRule: '响应前劫持 · 已丢弃 (XHR)',
          requestHeaders: snapshot.headers, requestBody: snapshot.body, responseHeaders: original.headers,
          responseBody: '[Dropped by 包监控]'
        });
        dispatchSyntheticXHR(xhr, ['abort', 'loadend']);
        return;
      }

      const response = decision.response || (action === 'mock' ? decision.mock : null);
      const next = response ? {
        status: Number(response.status || original.status || 200),
        statusText: original.statusText,
        headers: response.headers || original.headers,
        body: response.body != null ? String(response.body) : original.body
      } : original;
      const changed = Boolean(response) && (
        next.status !== original.status || next.body !== original.body || JSON.stringify(next.headers || {}) !== JSON.stringify(original.headers || {})
      );
      if (changed) applyXHRResponse(xhr, next, snapshot.url);
      reportToGateway({
        method: snapshot.method, url: snapshot.url, status: next.status, duration: Math.round(performance.now() - snapshot.startedAt),
        isMock: action === 'mock', isModified: Boolean(snapshot.isModified || changed),
        appliedRule: changed ? '响应前劫持 · 已改写 (XHR)' : '响应前劫持 · 已放行 (XHR)',
        requestHeaders: snapshot.headers, requestBody: snapshot.body,
        responseHeaders: next.headers, responseBody: next.body
      });
      dispatchSyntheticXHR(xhr, ['readystatechange', 'load', 'loadend']);
    } catch (err) {
      // 中文说明：响应编辑器或覆盖属性失败时采取 fail-open，避免业务页因调试插件永久卡住。
      reportToGateway({
        method: snapshot.method, url: snapshot.url, status: original.status, duration: Math.round(performance.now() - snapshot.startedAt),
        isMock: false, isModified: Boolean(snapshot.isModified), appliedRule: '响应前劫持 · fail-open (XHR)',
        requestHeaders: snapshot.headers, requestBody: snapshot.body,
        responseHeaders: original.headers, responseBody: original.body
      });
      dispatchSyntheticXHR(xhr, ['readystatechange', 'load', 'loadend']);
    } finally {
      ctx.responseHoldStarted = false;
      xhr.__helloResponsePending = false;
    }
  }

  // 中文说明：在 XHR 实例创建时先注册内部监听器，确保它排在业务页监听器之前，能拦住原始终态事件。
  function installXHRResponseObserver(xhr) {
    if (!xhr || xhr.__helloResponseObserverInstalled) return xhr;
    try { Object.defineProperty(xhr, '__helloResponseObserverInstalled', { value: true, configurable: true }); } catch (e) { xhr.__helloResponseObserverInstalled = true; }
    origXHRAddEventListener.call(xhr, 'readystatechange', function (event) {
      if (xhr.__helloDispatching) return;
      const ctx = xhr.__hello;
      const snapshot = ctx && ctx.active;
      if (!snapshot || ctx.isInternal) return;
      const responseEnabled = Boolean(ctx.responseHoldExpected) || shouldHold(snapshot.url, 'response');
      if (xhr.readyState === 3 && responseEnabled) {
        event.stopImmediatePropagation();
        return;
      }
      if (xhr.readyState !== 4 || ctx.responseHoldStarted || !responseEnabled || Number(xhr.status || 0) === 0) return;
      ctx.responseHoldStarted = true;
      ctx.responseHoldHandled = true;
      xhr.__helloResponsePending = true;
      event.stopImmediatePropagation();
      holdXHRResponse(xhr, ctx, snapshot);
    });
    ['progress', 'load', 'loadend'].forEach(function (name) {
      origXHRAddEventListener.call(xhr, name, function (event) {
        const ctx = xhr.__hello;
        if (!xhr.__helloDispatching && ctx && ctx.responseHoldStarted) event.stopImmediatePropagation();
      });
    });
    return xhr;
  }

  // 中文说明：把一次性回写的响应覆盖到 XHR，并按原生顺序补发终态事件。
  function fulfillXHRMock(xhr, responseData, requestUrl) {
    applyXHRResponse(xhr, {
      status: responseData.status,
      statusText: 'OK (Mocked by 包监控)',
      headers: responseData.headers || { 'content-type': 'application/json; charset=utf-8' },
      body: String(responseData.body == null ? '' : responseData.body)
    }, requestUrl);
    dispatchSyntheticXHR(xhr, ['readystatechange', 'load', 'loadend']);
  }

  function buildMockResponse(decision, fallbackStatus) {
    const status = Number((decision.mock && decision.mock.status) || decision.mockStatus || fallbackStatus || 200);
    const body = (decision.mock && decision.mock.body != null)
      ? decision.mock.body
      : (decision.mockBody != null ? decision.mockBody : '{}');
    const headers = (decision.mock && decision.mock.headers) || {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Powered-By': 'Packet-Monitor-Interceptor-Mock'
    };
    return new Response(String(body), { status: status, statusText: 'OK (Mocked by 包监控)', headers: headers });
  }

  window.addEventListener('message', function (event) {
    const data = event && event.data;
    if (!data || data.source !== 'HELLO_EXTENSION_BRIDGE') return;
    if (data.type === 'SYNC_SWITCH') {
      globalEnabled = Boolean(data.enabled);
      console.log('[包监控 Interceptor] 全局抓包开关:', globalEnabled ? '已开启' : '已关闭');
      return;
    }
    if (data.type === 'SYNC_RUNTIME') {
      applyRuntimeSnapshot(data);
      return;
    }
    if (data.type === 'RUNTIME_PAGE_APPLY') {
      const apply = data.apply;
      if (!apply || !apply.id) return;
      if (apply.stage === 'applied') {
        consumeLocalPageApply(apply.id);
        return;
      }
      const next = (pageAppliesCache || []).filter(function (item) { return item && item.id !== apply.id; });
      next.unshift(apply);
      pageAppliesCache = next;
    }
  });

  // 中文说明：启动时只拉一次快照；规则变更改由 content_bridge 的 SSE 推送，不再每秒轮询。
  if (!isGatewayPage()) syncRuntime(true);

  window.fetch = async function (input, init) {
    init = init || {};
    let requestUrl = '';
    let method = String(init.method || 'GET').toUpperCase();
    if (typeof input === 'string') requestUrl = input;
    else if (typeof URL !== 'undefined' && input instanceof URL) requestUrl = input.toString();
    else if (input && typeof input === 'object' && input.url) {
      requestUrl = input.url;
      method = String(input.method || method).toUpperCase();
    }
    requestUrl = toAbsoluteUrl(requestUrl);

    const incomingHeaders = init.headers || (input && input.headers);
    if (isInternalUrl(requestUrl) || (incomingHeaders && incomingHeaders['x-hello-internal'])) {
      return origFetch.call(this, input, init);
    }
    if (!globalEnabled) return origFetch.call(this, input, init);

    const headersObj = normalizeHeaders(incomingHeaders);
    let requestBody = stringifyBody(init.body || (input && input.body) || '');
    let appliedRule = 'Chrome 插件捕获';
    let isModified = false;

    await syncRuntime(false);
    const evaluated = evaluateRules(requestUrl, rulesCache);
    const pageApply = findPageApplyForRequest(method, requestUrl);
    if (pageApply) {
      consumeLocalPageApply(pageApply.id);
      await ackPageApply(pageApply.id, 'applied');
      const mocked = pageApplyResponse(pageApply);
      reportToGateway({
        method: method, url: requestUrl, status: mocked.status, duration: 1, isMock: true, isModified: true,
        appliedRule: '修改后发送 · 已回写页面', requestHeaders: headersObj, requestBody: requestBody,
        responseHeaders: mocked.headers, responseBody: mocked.body
      });
      return new Response(mocked.body, { status: mocked.status, headers: mocked.headers });
    }

    if (shouldHold(requestUrl, 'request')) {
      const decision = await waitHoldDecision({
        phase: 'request', method: method, url: requestUrl, headers: headersObj, body: requestBody,
        pageUrl: String(location.href || '')
      });
      const action = decision.action || 'continue';
      if (action === 'drop') {
        reportToGateway({
          method: method, url: requestUrl, status: 0, duration: 0, isMock: false, isModified: true,
          appliedRule: '发送前劫持 · 已丢弃', requestHeaders: headersObj, requestBody: requestBody,
          responseHeaders: {}, responseBody: '[Dropped by 包监控]'
        });
        throw new DOMException('包监控已在发送前丢弃该请求', 'AbortError');
      }
      if (action === 'mock') {
        const mockStatus = Number((decision.mock && decision.mock.status) || decision.mockStatus || 200);
        const mockBody = (decision.mock && decision.mock.body != null) ? decision.mock.body : (decision.mockBody || '{}');
        reportToGateway({
          method: method, url: requestUrl, status: mockStatus, duration: 1, isMock: true, isModified: true,
          appliedRule: '发送前劫持 · Mock 返回', requestHeaders: headersObj, requestBody: requestBody,
          responseHeaders: { 'content-type': 'application/json; charset=utf-8' }, responseBody: String(mockBody)
        });
        return buildMockResponse(decision, 200);
      }
      if (decision.request) {
        if (decision.request.method) method = String(decision.request.method).toUpperCase();
        if (decision.request.url) requestUrl = toAbsoluteUrl(decision.request.url);
        if (decision.request.headers) Object.assign(headersObj, normalizeHeaders(decision.request.headers));
        if (decision.request.body != null) requestBody = stringifyBody(decision.request.body);
        isModified = true;
        appliedRule = '发送前劫持 · 已改写发送';
      }
    }

    if (evaluated.mockRule) {
      const mockStatus = evaluated.mockRule.mockStatus || 200;
      const mockBody = evaluated.mockRule.mockBody || '{}';
      reportToGateway({
        method: method, url: requestUrl, status: mockStatus, duration: 1, isMock: true, isModified: false,
        appliedRule: evaluated.mockRule.name || '插件 Mock 短路拦截', requestHeaders: headersObj, requestBody: requestBody,
        responseHeaders: { 'content-type': 'application/json; charset=utf-8', 'x-powered-by': 'Packet-Monitor-Interceptor-Mock' },
        responseBody: mockBody
      });
      return new Response(mockBody, {
        status: mockStatus, statusText: 'OK (Mocked by 包监控)',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Powered-By': 'Packet-Monitor-Interceptor-Mock' }
      });
    }

    if (evaluated.headerRules.length > 0) {
      evaluated.headerRules.forEach(function (hr) { headersObj[String(hr.headerKey).toLowerCase()] = hr.headerValue || ''; });
      isModified = true;
      appliedRule = '插件 Header 注入';
    }
    if (evaluated.bodyRule) {
      requestBody = evaluated.bodyRule.newBody;
      isModified = true;
      appliedRule = appliedRule === 'Chrome 插件捕获' ? '插件 Body 篡改' : (appliedRule + ' + Body 篡改');
    }

    const modifiedInit = Object.assign({}, init, { method: method, headers: headersObj });
    if (method !== 'GET' && method !== 'HEAD') modifiedInit.body = requestBody;
    else delete modifiedInit.body;

    const startTime = performance.now();
    try {
      const response = await origFetch.call(this, requestUrl, modifiedInit);
      const duration = Math.round(performance.now() - startTime);
      let responseBody = '';
      try { responseBody = await response.clone().text(); } catch (e) { responseBody = '[二进制流或已被消费]'; }
      const resHeadersObj = {};
      if (response.headers && typeof response.headers.forEach === 'function') {
        response.headers.forEach(function (val, key) { resHeadersObj[String(key).toLowerCase()] = val; });
      }

      if (shouldHold(requestUrl, 'response')) {
        const resDecision = await waitHoldDecision({
          phase: 'response', method: method, url: requestUrl, headers: headersObj, body: requestBody,
          status: response.status, responseHeaders: resHeadersObj, responseBody: responseBody,
          pageUrl: String(location.href || '')
        });
        const resAction = resDecision.action || 'continue';
        if (resAction === 'drop') {
          reportToGateway({
            method: method, url: requestUrl, status: 0, duration: duration, isMock: false, isModified: true,
            appliedRule: '响应前劫持 · 已丢弃', requestHeaders: headersObj, requestBody: requestBody,
            responseHeaders: resHeadersObj, responseBody: '[Dropped by 包监控]'
          });
          throw new DOMException('包监控已在响应前丢弃该请求', 'AbortError');
        }
        if (resAction === 'mock' || (resDecision.response && (resDecision.response.body != null || resDecision.response.status))) {
          const mockStatus = Number((resDecision.response && resDecision.response.status) || (resDecision.mock && resDecision.mock.status) || resDecision.mockStatus || response.status);
          const mockBody = (resDecision.response && resDecision.response.body != null)
            ? resDecision.response.body
            : ((resDecision.mock && resDecision.mock.body != null) ? resDecision.mock.body : (resDecision.mockBody != null ? resDecision.mockBody : responseBody));
          const mockHeaders = (resDecision.response && resDecision.response.headers) || resHeadersObj;
          reportToGateway({
            method: method, url: requestUrl, status: mockStatus, duration: duration, isMock: true, isModified: true,
            appliedRule: '响应前劫持 · 已改写', requestHeaders: headersObj, requestBody: requestBody,
            responseHeaders: mockHeaders, responseBody: String(mockBody)
          });
          return new Response(String(mockBody), { status: mockStatus, headers: mockHeaders });
        }
      }

      reportToGateway({
        method: method, url: requestUrl, status: response.status, duration: duration, isMock: false,
        isModified: isModified, appliedRule: appliedRule, requestHeaders: headersObj,
        requestBody: String(requestBody || ''), responseHeaders: resHeadersObj, responseBody: responseBody
      });
      return response;
    } catch (err) {
      reportToGateway({
        method: method, url: requestUrl, status: 0, duration: Math.round(performance.now() - startTime),
        isMock: false, isModified: isModified,
        appliedRule: err && err.name === 'AbortError' ? (appliedRule || '请求已中止') : '网络请求异常捕获',
        requestHeaders: headersObj, requestBody: String(requestBody || ''),
        responseHeaders: {}, responseBody: 'Error: ' + (err && err.message ? err.message : String(err))
      });
      throw err;
    }
  };

  window.XMLHttpRequest.prototype.open = function (method, url) {
    installXHRResponseObserver(this);
    resetXHRResponseOverrides(this);
    this.__hello = {
      method: String(method || 'GET').toUpperCase(),
      url: toAbsoluteUrl(url),
      headers: {},
      body: '',
      isInternal: isInternalUrl(url) || isInternalUrl(toAbsoluteUrl(url))
    };
    return origXHROpen.apply(this, arguments);
  };

  window.XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
    if (this.__hello && !this.__hello.isInternal) this.__hello.headers[String(header).toLowerCase()] = value;
    return origXHRSetRequestHeader.call(this, header, value);
  };

  window.XMLHttpRequest.prototype.send = function (body) {
    if (!this.__hello || this.__hello.isInternal || !globalEnabled) return origXHRSend.call(this, body);
    const self = this;
    const ctx = this.__hello;
    ctx.body = stringifyBody(body);

    (async function () {
      await syncRuntime(false);
      const evaluated = evaluateRules(ctx.url, rulesCache);
      let method = ctx.method;
      let url = ctx.url;
      let headersObj = Object.assign({}, ctx.headers);
      let finalBody = ctx.body;
      let isModified = false;
      let appliedRule = 'Chrome 插件捕获 (XHR)';
      ctx.active = null;
      ctx.responseHoldStarted = false;
      ctx.responseHoldHandled = false;
      ctx.responseHoldExpected = false;

      const pageApply = findPageApplyForRequest(method, url);
      if (pageApply) {
        consumeLocalPageApply(pageApply.id);
        await ackPageApply(pageApply.id, 'applied');
        const mocked = pageApplyResponse(pageApply);
        ctx.responseHoldHandled = true;
        reportToGateway({
          method: method, url: url, status: mocked.status, duration: 1, isMock: true, isModified: true,
          appliedRule: '修改后发送 · 已回写页面 (XHR)', requestHeaders: headersObj, requestBody: finalBody,
          responseHeaders: mocked.headers, responseBody: mocked.body
        });
        fulfillXHRMock(self, mocked, url);
        return;
      }

      if (shouldHold(url, 'request')) {
        // 中文说明：once 的 request hold 会让网关切到 response 阶段；本地轮询可能尚未同步，先记住本次要拦响应。
        ctx.responseHoldExpected = interceptConfig.mode === 'once' && Boolean(interceptConfig.interceptResponse);
        const decision = await waitHoldDecision({
          phase: 'request', method: method, url: url, headers: headersObj, body: finalBody,
          pageUrl: String(location.href || '')
        });
        const action = decision.action || 'continue';
        if (action === 'drop') {
          reportToGateway({
            method: method, url: url, status: 0, duration: 0, isMock: false, isModified: true,
            appliedRule: '发送前劫持 · 已丢弃 (XHR)', requestHeaders: headersObj, requestBody: finalBody,
            responseHeaders: {}, responseBody: '[Dropped by 包监控]'
          });
          self.dispatchEvent(new Event('abort'));
          self.dispatchEvent(new Event('loadend'));
          return;
        }
        if (action === 'mock') {
          const mockStatus = Number((decision.mock && decision.mock.status) || decision.mockStatus || 200);
          const mockBody = String((decision.mock && decision.mock.body != null) ? decision.mock.body : (decision.mockBody || '{}'));
          reportToGateway({
            method: method, url: url, status: mockStatus, duration: 1, isMock: true, isModified: true,
            appliedRule: '发送前劫持 · Mock 返回 (XHR)', requestHeaders: headersObj, requestBody: finalBody,
            responseHeaders: { 'content-type': 'application/json; charset=utf-8' }, responseBody: mockBody
          });
          Object.defineProperty(self, 'status', { value: mockStatus, configurable: true });
          Object.defineProperty(self, 'statusText', { value: 'OK (Mocked by 包监控)', configurable: true });
          Object.defineProperty(self, 'readyState', { value: 4, configurable: true });
          Object.defineProperty(self, 'responseText', { value: mockBody, configurable: true });
          Object.defineProperty(self, 'response', { value: mockBody, configurable: true });
          self.dispatchEvent(new Event('readystatechange'));
          self.dispatchEvent(new Event('load'));
          self.dispatchEvent(new Event('loadend'));
          return;
        }
        if (decision.request) {
          if (decision.request.method) method = String(decision.request.method).toUpperCase();
          if (decision.request.url) url = toAbsoluteUrl(decision.request.url);
          if (decision.request.headers) headersObj = Object.assign(headersObj, normalizeHeaders(decision.request.headers));
          if (decision.request.body != null) finalBody = stringifyBody(decision.request.body);
          isModified = true;
          appliedRule = '发送前劫持 · 已改写发送 (XHR)';
        }
      }

      if (evaluated.mockRule) {
        const mockStatus = evaluated.mockRule.mockStatus || 200;
        const mockBody = evaluated.mockRule.mockBody || '{}';
        reportToGateway({
          method: method, url: url, status: mockStatus, duration: 1, isMock: true, isModified: false,
          appliedRule: evaluated.mockRule.name || '插件 Mock 短路拦截 (XHR)',
          requestHeaders: headersObj, requestBody: finalBody,
          responseHeaders: { 'content-type': 'application/json; charset=utf-8' }, responseBody: mockBody
        });
        Object.defineProperty(self, 'status', { value: mockStatus, configurable: true });
        Object.defineProperty(self, 'statusText', { value: 'OK (Mocked by 包监控)', configurable: true });
        Object.defineProperty(self, 'readyState', { value: 4, configurable: true });
        Object.defineProperty(self, 'responseText', { value: mockBody, configurable: true });
        Object.defineProperty(self, 'response', { value: mockBody, configurable: true });
        self.dispatchEvent(new Event('readystatechange'));
        self.dispatchEvent(new Event('load'));
        self.dispatchEvent(new Event('loadend'));
        return;
      }

      if (evaluated.headerRules.length > 0) {
        evaluated.headerRules.forEach(function (hr) { headersObj[String(hr.headerKey).toLowerCase()] = hr.headerValue || ''; });
        isModified = true;
        appliedRule = '插件 Header 注入 (XHR)';
      }
      // 异步断点后必须重新 open，才能干净地套上可能被改过的 method/url/headers
      origXHROpen.call(self, method, url, true);
      Object.keys(headersObj).forEach(function (key) {
        try { origXHRSetRequestHeader.call(self, key, headersObj[key]); } catch (e) {}
      });
      if (evaluated.bodyRule) {
        finalBody = evaluated.bodyRule.newBody;
        isModified = true;
        appliedRule = appliedRule.indexOf('捕获') >= 0 ? '插件 Body 篡改 (XHR)' : (appliedRule + ' + Body 篡改');
      }

      // 中文说明：保存最终实际发出的请求，响应断点必须用改写后的 URL、Header 和 Body 回传看板。
      ctx.active = {
        method: method,
        url: url,
        headers: Object.assign({}, headersObj),
        body: String(finalBody || ''),
        isModified: isModified,
        appliedRule: appliedRule,
        startedAt: performance.now()
      };

      const startTime = performance.now();
      self.addEventListener('loadend', function () {
        // 中文说明：响应断点由 holdXHRResponse 统一上报，避免合成 loadend 造成重复记录。
        if (ctx.responseHoldHandled) return;
        const capturedResponse = readXHRResponse(self);
        reportToGateway({
          method: method, url: url, status: capturedResponse.status, duration: Math.round(performance.now() - startTime),
          isMock: false, isModified: isModified, appliedRule: appliedRule, requestHeaders: headersObj,
          requestBody: String(finalBody || ''), responseHeaders: capturedResponse.headers, responseBody: capturedResponse.body
        });
      });
      origXHRSend.call(self, finalBody);
    })();
  };

  // 中文说明：包装构造器，使内部响应监听器在业务页注册任何回调前就位，覆盖 addEventListener 与 on* 两类用法。
  function HelloXMLHttpRequest() {
    if (!(this instanceof HelloXMLHttpRequest)) return new HelloXMLHttpRequest();
    const xhr = new OriginalXMLHttpRequest();
    installXHRResponseObserver(xhr);
    return xhr;
  }
  HelloXMLHttpRequest.prototype = xhrPrototype;
  try { Object.setPrototypeOf(HelloXMLHttpRequest, OriginalXMLHttpRequest); } catch (e) {}
  window.XMLHttpRequest = HelloXMLHttpRequest;

  console.log('[包监控 Interceptor] 劫持引擎已挂载 (fetch + XHR + 发送前/响应前断点)');
})();
