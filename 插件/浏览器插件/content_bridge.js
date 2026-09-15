// ========================================================
// 文件名: content_bridge.js
// 功能定位: Chrome 扩展隔离上下文 (ISOLATED) 通信桥梁
// 核心职责:
//   1. 读取 chrome.storage 中持久化的全局拦截总开关状态
//   2. 在页面启动阶段以及配置变更时，通过 window.postMessage 热推到主页面 inject.js
//   3. 监听网关 /__events 长连接，把规则、断点配置和页面回写任务推给 inject.js
// ========================================================

(function () {
  'use strict';

  const GATEWAY_BASE = 'http://localhost:8910';
  const EVENTS_URL = GATEWAY_BASE + '/__events';

  function isGatewayPage() {
    const host = location.hostname;
    return (host === 'localhost' || host === '127.0.0.1') && String(location.port) === '8910';
  }

  function postToInject(payload) {
    window.postMessage(Object.assign({ source: 'HELLO_EXTENSION_BRIDGE' }, payload), '*');
  }

  // 1. 初始化时从 storage 读取开关配置并广播给网页宿主环境
  chrome.storage.local.get({ interceptor_enabled: true }, (res) => {
    postToInject({
      type: 'SYNC_SWITCH',
      enabled: Boolean(res.interceptor_enabled)
    });
  });

  // 中文说明：把当前页 URL 报给网关，相对路径重放时才能补全域名。
  try {
    fetch(GATEWAY_BASE + '/__api/runtime/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hello-internal': '1' },
      body: JSON.stringify({ pageUrl: String(location.href || '') })
    }).catch(function () {});
  } catch (e) {}

  // 2. 监听扩展 popup 中开关实时变更，立即通知 inject.js 切换拦截状态
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.interceptor_enabled !== undefined) {
      postToInject({
        type: 'SYNC_SWITCH',
        enabled: Boolean(changes.interceptor_enabled.newValue)
      });
    }
  });

  // 中文说明：隔离世界访问 localhost 更稳，这里负责看到回写任务后刷新当前业务页。
  function normalizePageHref(url) {
    try {
      const parsed = new URL(String(url || ''), location.href);
      parsed.hash = '';
      return parsed.href;
    } catch (e) {
      return String(url || '');
    }
  }

  async function reloadIfPageApply(apply) {
    if (!apply || apply.reloadConsumed) return;
    if (normalizePageHref(apply.pageUrl) !== normalizePageHref(location.href)) return;
    try {
      const ackRes = await fetch(GATEWAY_BASE + '/__api/page-apply/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hello-internal': '1' },
        body: JSON.stringify({ id: apply.id, action: 'reloaded' })
      });
      const ack = ackRes.ok ? await ackRes.json() : {};
      if (ack && ack.shouldReload) location.reload();
    } catch (e) {}
  }

  function handleGatewayEvent(payload) {
    if (!payload || !payload.type) return;
    const type = payload.type;
    const data = payload.data;
    if (type === 'init') {
      postToInject({
        type: 'SYNC_RUNTIME',
        rules: data && data.rules,
        config: data && data.config,
        pageApplies: data && data.pageApplies
      });
      ((data && data.pageApplies) || []).forEach(reloadIfPageApply);
      return;
    }
    if (type === 'rules_updated') {
      postToInject({ type: 'SYNC_RUNTIME', rules: data });
      return;
    }
    if (type === 'intercept_config') {
      postToInject({ type: 'SYNC_RUNTIME', config: data });
      return;
    }
    if (type === 'page_apply') {
      postToInject({ type: 'RUNTIME_PAGE_APPLY', apply: data });
      reloadIfPageApply(data);
    }
  }

  // 中文说明：看板页自己已经连着 SSE，扩展不必再占一条长连接。
  if (isGatewayPage()) return;

  // 中文说明：复用网关现成 SSE，替代原来 800ms 轮询 /__api/runtime。
  function connectRuntimeEvents() {
    let source;
    try {
      source = new EventSource(EVENTS_URL);
    } catch (e) {
      setTimeout(connectRuntimeEvents, 2000);
      return;
    }
    source.onmessage = function (event) {
      try { handleGatewayEvent(JSON.parse(event.data)); } catch (err) {}
    };
    source.onerror = function () {
      // 中文说明：浏览器会自动重连；只有彻底关闭时才由我们补建。
      if (source.readyState === EventSource.CLOSED) {
        try { source.close(); } catch (err) {}
        setTimeout(connectRuntimeEvents, 2000);
      }
    };
  }

  connectRuntimeEvents();
})();
