// ========================================================
// 文件名: popup.js
// 功能定位: Chrome 扩展暗黑悬浮窗控制器
// 核心职责:
//   1. 实时探活与同步本地 8910 网关服务状态及有效规则数
//   2. 管理全局抓包总开关，持久化至 chrome.storage
//   3. 提供一键直达抓包看板的快捷入口
// ========================================================

document.addEventListener('DOMContentLoaded', () => {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const rulesCount = document.getElementById('rulesCount');
  const toggleSwitch = document.getElementById('toggleSwitch');
  const toggleHold = document.getElementById('toggleHold');
  const holdCount = document.getElementById('holdCount');
  const btnOpenDashboard = document.getElementById('btnOpenDashboard');

  const GATEWAY_RULES_URL = 'http://localhost:8910/__api/rules';
  const DASHBOARD_URL = 'http://localhost:8910/hello_dashboard.html';

  // ------------------------------------------------------
  // 1. 初始化读取全局开关状态
  // ------------------------------------------------------
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get({ interceptor_enabled: true }, (res) => {
      toggleSwitch.checked = Boolean(res.interceptor_enabled);
    });
  } else {
    // 降级支持普通浏览器调试环境
    toggleSwitch.checked = localStorage.getItem('interceptor_enabled') !== 'false';
  }

  // ------------------------------------------------------
  // 2. 切换全局总开关
  // ------------------------------------------------------
  toggleSwitch.addEventListener('change', (e) => {
    const isChecked = e.target.checked;
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ interceptor_enabled: isChecked }, () => {
        console.log('[包监控] 拦截开关已保存:', isChecked);
      });
    } else {
      localStorage.setItem('interceptor_enabled', String(isChecked));
    }
  });

  // ------------------------------------------------------
  // 3. 探活检测 8910 网关并统计生效规则数
  // ------------------------------------------------------
  async function checkGatewayHealth() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1500);

      const res = await fetch(GATEWAY_RULES_URL, {
        method: 'GET',
        headers: { 'x-hello-internal': '1' },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        const activeRules = (data.rules || []).filter((r) => r.enabled);

        // 更新状态指示灯与文案
        statusDot.className = 'status-dot';
        statusText.textContent = '已连接包监控服务';
        statusText.style.color = '#10b981';

        // 显示生效规则数
        rulesCount.textContent = `${activeRules.length} 条生效中`;
        rulesCount.style.borderColor = 'rgba(236, 72, 153, 0.4)';

        // 同步发送前劫持开关与待放行数量
        try {
          const cfgRes = await fetch('http://localhost:8910/__api/intercept/config', { headers: { 'x-hello-internal': '1' } });
          if (cfgRes.ok) {
            const cfgJson = await cfgRes.json();
            const mode = (cfgJson.config && cfgJson.config.mode) || 'off';
            toggleHold.checked = mode !== 'off';
            const n = (cfgJson.holds || []).length;
            holdCount.textContent = n + ' 条';
          }
        } catch {}
        return;
      }
      throw new Error('HTTP ' + res.status);
    } catch {
      // 连接失败降级提示
      statusDot.className = 'status-dot offline';
      statusText.textContent = '未连接包监控服务';
      statusText.style.color = '#ef4444';
      rulesCount.textContent = '离线 / 0 条';
      rulesCount.style.borderColor = 'rgba(239, 68, 68, 0.3)';
    }
  }

  // 发送前劫持：popup 一键打开「全部」模式，精细匹配请去看板
  toggleHold.addEventListener('change', async () => {
    const enabled = toggleHold.checked;
    try {
      await fetch('http://localhost:8910/__api/intercept/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hello-internal': '1' },
        body: JSON.stringify({ mode: enabled ? 'all' : 'off' })
      });
    } catch {}
  });

  // 立即检查一次
  checkGatewayHealth();
  setInterval(checkGatewayHealth, 3000);

  // ------------------------------------------------------
  // 4. 一键直达看板快捷按钮
  // ------------------------------------------------------
  btnOpenDashboard.addEventListener('click', () => {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: DASHBOARD_URL });
    } else {
      window.open(DASHBOARD_URL, '_blank');
    }
  });
});
