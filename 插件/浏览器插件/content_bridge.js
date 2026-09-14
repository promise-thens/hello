// ========================================================
// 文件名: content_bridge.js
// 功能定位: Chrome 扩展隔离上下文 (ISOLATED) 通信桥梁
// 核心职责:
//   1. 读取 chrome.storage 中持久化的全局拦截总开关状态
//   2. 在页面启动阶段以及配置变更时，通过 window.postMessage 热推到主页面 inject.js
// ========================================================

(function () {
  'use strict';

  // 1. 初始化时从 storage 读取开关配置并广播给网页宿主环境
  chrome.storage.local.get({ interceptor_enabled: true }, (res) => {
    window.postMessage({
      source: 'HELLO_EXTENSION_BRIDGE',
      type: 'SYNC_SWITCH',
      enabled: Boolean(res.interceptor_enabled)
    }, '*');
  });

  // 中文说明：把当前页 URL 报给网关，相对路径重放时才能补全域名。
  try {
    fetch('http://localhost:8910/__api/runtime/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hello-internal': '1' },
      body: JSON.stringify({ pageUrl: String(location.href || '') })
    }).catch(function () {});
  } catch (e) {}

  // 2. 监听扩展 popup 中开关实时变更，立即通知 inject.js 切换拦截状态
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.interceptor_enabled !== undefined) {
      window.postMessage({
        source: 'HELLO_EXTENSION_BRIDGE',
        type: 'SYNC_SWITCH',
        enabled: Boolean(changes.interceptor_enabled.newValue)
      }, '*');
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

  async function pollPageApplyReload() {
    try {
      const res = await fetch('http://localhost:8910/__api/runtime', {
        headers: { 'x-hello-internal': '1' }
      });
      if (!res.ok) return;
      const json = await res.json();
      const applies = (json && json.pageApplies) || [];
      const apply = applies.find(function (item) {
        return item && !item.reloadConsumed && normalizePageHref(item.pageUrl) === normalizePageHref(location.href);
      });
      if (!apply) return;
      const ackRes = await fetch('http://localhost:8910/__api/page-apply/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hello-internal': '1' },
        body: JSON.stringify({ id: apply.id, action: 'reloaded' })
      });
      const ack = ackRes.ok ? await ackRes.json() : {};
      if (ack && ack.shouldReload) location.reload();
    } catch (e) {}
  }

  setInterval(pollPageApplyReload, 800);
  pollPageApplyReload();
})();
