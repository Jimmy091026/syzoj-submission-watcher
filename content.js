// ============================================================
// SYZOJ 提交监视器 - content script
// 职责：注入悬浮面板（Shadow DOM 隔离样式）、渲染数据、
//       处理拖动/折叠/加载更多、驱动轮询（数据经 background 抓取）。
// 红线：除注入本面板外，绝不改动宿主页面的任何内容/样式/行为。
// ============================================================
'use strict';

(() => {
  // 避免重复注入（扩展热重载 / 重复执行时，host 已存在则跳过）
  if (document.getElementById('syzoj-sub-watcher-host')) return;

  const POLL_INTERVAL_MS = 20000; // 轮询间隔：20 秒
  const Z_INDEX = 2147483000;

  // ---- 运行时状态 ----
  let username = '';
  let firstPageItems = [];   // 第一页（最新一页），轮询会刷新
  let firstNextQuery = null; // 第一页的「下一页」query
  let morePages = [];        // [{ query, items, nextQuery }, ...] 加载更多的历史页
  let lastUpdateTime = null;
  let loadingMore = false;

  // ---- DOM 引用 ----
  let panel, bodyEl, listEl, footerEl, moreBtn, toggleBtn;
  let userEl, timeEl, countEl;

  // ============================================================
  // 1. 注入面板
  // ============================================================
  function injectPanel() {
    const host = document.createElement('div');
    host.id = 'syzoj-sub-watcher-host';
    // 注意顺序：all:initial 必须在前，否则会重置后面的 position/z-index
    host.style.cssText = `all:initial;position:fixed;z-index:${Z_INDEX};`;
    (document.body || document.documentElement).appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS_TEXT;

    const root = document.createElement('div');
    root.className = 'ojp-root';
    root.innerHTML = PANEL_HTML;

    shadow.appendChild(style);
    shadow.appendChild(root);

    panel = shadow.querySelector('#ojp-panel');
    bodyEl = shadow.querySelector('#ojp-body');
    listEl = shadow.querySelector('#ojp-list');
    footerEl = shadow.querySelector('#ojp-footer');
    moreBtn = shadow.querySelector('#ojp-more');
    toggleBtn = shadow.querySelector('#ojp-toggle');
    userEl = shadow.querySelector('#ojp-username');
    timeEl = shadow.querySelector('#ojp-time');
    countEl = shadow.querySelector('#ojp-count');

    toggleBtn.addEventListener('click', onToggle);
    moreBtn.addEventListener('click', onLoadMore);
    bindDrag(shadow.querySelector('#ojp-header'));
  }

  // ============================================================
  // 2. 初始化
  // ============================================================
  function init() {
    injectPanel();

    // 同步注册消息监听与轮询，避免错过 background 的推送
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'USER_CHANGED') {
        setUsername(msg.username || '');
        resetPages();
        if (username) pollRefresh(true);
        else showEmpty('请先点击扩展图标设置用户名');
      }
    });
    setInterval(() => {
      if (username) pollRefresh(false);
    }, POLL_INTERVAL_MS);

    // 异步加载初始状态
    (async () => {
      const pos = await readStorage('position');
      applyPosition(pos);

      const state = await sendToBackground({ type: 'GET_STATE' });
      if (state && state.username) {
        setUsername(state.username);
        await pollRefresh(true);
      } else {
        showEmpty('请先点击扩展图标设置用户名');
      }
    })();
  }

  function setUsername(name) {
    username = name;
    if (userEl) userEl.textContent = name || '-';
  }

  function resetPages() {
    firstPageItems = [];
    firstNextQuery = null;
    morePages = [];
    lastUpdateTime = null;
  }

  // ============================================================
  // 3. 数据获取（经 background）
  // ============================================================
  function sendToBackground(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(res);
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  // 轮询：只刷新第一页（最新页，状态变化都发生在这里）
  async function pollRefresh(isInitial) {
    const res = await sendToBackground({ type: 'FETCH', username });

    if (res && res.ok) {
      firstPageItems = res.items || [];
      firstNextQuery = res.nextQuery || null;
      lastUpdateTime = new Date();
      render();
      return;
    }
    // 失败处理：无任何数据时显示错误；已有数据时静默，下轮继续重试
    if (firstPageItems.length === 0 && morePages.length === 0) {
      showError((res && res.error) || '请求失败');
    }
  }

  // 加载更多：用上一页返回的「下一页」query 拉取（兼容普通/快速分页）
  async function onLoadMore() {
    if (loadingMore) return;
    const query = morePages.length === 0
      ? firstNextQuery
      : morePages[morePages.length - 1].nextQuery;
    if (!query) { render(); return; }

    loadingMore = true;
    moreBtn.textContent = '加载中…';
    moreBtn.disabled = true;

    const res = await sendToBackground({ type: 'FETCH', username, query });
    if (res && res.ok) {
      morePages.push({
        query,
        items: res.items || [],
        nextQuery: res.nextQuery || null
      });
      render();
    }
    // 失败静默，按钮恢复后可直接重试

    loadingMore = false;
    moreBtn.textContent = '加载更多';
    moreBtn.disabled = false;
  }

  // ============================================================
  // 4. 渲染
  // ============================================================
  function render() {
    if (timeEl) timeEl.textContent = formatTime(lastUpdateTime);
    const all = dedupeById(firstPageItems.concat(...morePages.map((p) => p.items)));
    if (countEl) countEl.textContent = '共 ' + all.length + ' 条';

    listEl.textContent = '';
    const frag = document.createDocumentFragment();
    for (const item of all) frag.appendChild(renderRow(item));
    listEl.appendChild(frag);

    const canLoadMore = morePages.length === 0
      ? !!firstNextQuery
      : !!morePages[morePages.length - 1].nextQuery;
    footerEl.style.display = canLoadMore ? 'block' : 'none';
  }

  function renderRow(item) {
    const info = (item && item.info) || {};
    const result = item && item.result ? item.result : null;

    const status = result ? result.result : (item && item.running ? 'Judging' : 'Waiting');
    const score = (result && result.score != null && result.score !== '') ? result.score : '-';
    const user = info.user || '-';
    const problemId = (info.problemId != null && info.problemId !== '') ? info.problemId : '';
    const problemName = info.problemName || info.problemTitle || '';
    const shortName = truncateName(problemName, 5);
    const problem = problemId !== '' ? `#${problemId}. ${shortName}` : (shortName || '-');
    const problemFull = problemId !== '' ? `#${problemId}. ${problemName}` : (problemName || '-');

    const row = document.createElement('div');
    row.className = 'ojp-row';

    const cStatus = document.createElement('div');
    cStatus.className = 'ojp-cell ojp-status';
    const badge = document.createElement('span');
    badge.className = 'ojp-badge ' + statusClass(status);
    badge.textContent = status;
    badge.title = status;
    cStatus.appendChild(badge);

    const cScore = document.createElement('div');
    cScore.className = 'ojp-cell ojp-score';
    cScore.textContent = String(score);

    const cUser = document.createElement('div');
    cUser.className = 'ojp-cell ojp-user';
    cUser.textContent = user;
    cUser.title = user;

    const cProblem = document.createElement('div');
    cProblem.className = 'ojp-cell ojp-problem';
    cProblem.textContent = problem;
    cProblem.title = problemFull;

    row.appendChild(cStatus);
    row.appendChild(cScore);
    row.appendChild(cUser);
    row.appendChild(cProblem);
    return row;
  }

  // 题目名超过 max 个字符时截断加省略号（按 Unicode 码点计数，中文 1 字 = 1）
  function truncateName(name, max) {
    const chars = Array.from(String(name == null ? '' : name));
    if (chars.length <= max) return name;
    return chars.slice(0, max).join('') + '…';
  }

  // 状态 → 颜色分类
  function statusClass(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'accepted') return 'st-ac';
    if (s.includes('wrong')) return 'st-wa';
    if (s.includes('time limit') || s.includes('memory limit')) return 'st-lim';
    if (s.includes('compile')) return 'st-ce';
    if (s.includes('runtime')) return 'st-re';
    if (s.includes('judging') || s.includes('waiting')) return 'st-pending';
    if (s.includes('partially')) return 'st-partial';
    return 'st-other';
  }

  function showEmpty(msg) {
    listEl.textContent = '';
    const d = document.createElement('div');
    d.className = 'ojp-hint';
    d.textContent = msg;
    listEl.appendChild(d);
    footerEl.style.display = 'none';
    if (countEl) countEl.textContent = '共 0 条';
    if (timeEl) timeEl.textContent = '--:--:--';
  }

  function showError(msg) {
    listEl.textContent = '';
    const d = document.createElement('div');
    d.className = 'ojp-hint ojp-error';
    d.textContent = msg || '请求失败';
    const retry = document.createElement('button');
    retry.className = 'ojp-retry';
    retry.textContent = '重试';
    retry.addEventListener('click', () => pollRefresh(true));
    d.appendChild(retry);
    listEl.appendChild(d);
    footerEl.style.display = 'none';
  }

  // 按 submissionId 去重（快速分页下刷新第一页后可能与历史页重叠）
  function dedupeById(list) {
    const seen = new Set();
    const out = [];
    for (const it of list) {
      const id = it && it.info && it.info.submissionId;
      if (id != null && seen.has(id)) continue;
      if (id != null) seen.add(id);
      out.push(it);
    }
    return out;
  }

  function formatTime(d) {
    if (!d) return '--:--:--';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // ============================================================
  // 5. 折叠 / 拖动
  // ============================================================
  function onToggle() {
    const wasCollapsed = bodyEl.style.display === 'none';
    bodyEl.style.display = wasCollapsed ? 'block' : 'none';
    toggleBtn.textContent = wasCollapsed ? '▁' : '□';
    if (!wasCollapsed) clampPosition(); // 展开后确保不越界
  }

  function bindDrag(handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.target === toggleBtn) return; // 点折叠按钮不触发拖动
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);

      const startX = e.clientX;
      const startY = e.clientY;
      const origLeft = panel.offsetLeft;
      const origTop = panel.offsetTop;

      const onMove = (ev) => {
        let nx = origLeft + (ev.clientX - startX);
        let ny = origTop + (ev.clientY - startY);
        nx = Math.max(0, Math.min(nx, window.innerWidth - panel.offsetWidth));
        ny = Math.max(0, Math.min(ny, window.innerHeight - 32));
        panel.style.left = nx + 'px';
        panel.style.top = ny + 'px';
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.releasePointerCapture(e.pointerId);
        writeStorage('position', { x: panel.offsetLeft, y: panel.offsetTop });
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  }

  function applyPosition(pos) {
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x, y;
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      x = pos.x;
      y = pos.y;
    } else {
      // 默认右下角：right:16px, bottom:16px
      x = vw - w - 16;
      y = vh - h - 16;
    }
    x = Math.max(0, Math.min(x, Math.max(0, vw - w)));
    y = Math.max(0, Math.min(y, Math.max(0, vh - 32)));
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  }

  function clampPosition() {
    let x = panel.offsetLeft;
    let y = panel.offsetTop;
    x = Math.max(0, Math.min(x, Math.max(0, window.innerWidth - panel.offsetWidth)));
    y = Math.max(0, Math.min(y, Math.max(0, window.innerHeight - 32)));
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  }

  // ============================================================
  // 6. storage 辅助
  // ============================================================
  function readStorage(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (data) => resolve(data[key]));
    });
  }
  function writeStorage(key, value) {
    chrome.storage.local.set({ [key]: value });
  }

  // ============================================================
  // 7. 样式与结构模板
  // ============================================================
  const PANEL_HTML = `
    <div id="ojp-panel">
      <div id="ojp-header">
        <span class="ojp-at">@<span id="ojp-username">-</span></span>
        <div class="ojp-hr">
          <span id="ojp-time">--:--:--</span>
          <span id="ojp-count">共 0 条</span>
          <button id="ojp-toggle" title="折叠/展开">▁</button>
        </div>
      </div>
      <div id="ojp-body">
        <div id="ojp-list"></div>
        <div id="ojp-footer">
          <button id="ojp-more">加载更多</button>
        </div>
      </div>
    </div>
  `;

  const CSS_TEXT = `
    :host {
      all: initial;
    }
    #ojp-panel {
      position: fixed;
      z-index: 2147483000;
      width: 360px;
      max-width: calc(100vw - 24px);
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Microsoft YaHei", sans-serif;
      font-size: 12px;
      color: #1f2937;
      overflow: hidden;
    }
    #ojp-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 6px 10px;
      background: #f9fafb;
      border-bottom: 1px solid #e5e7eb;
      cursor: grab;
      user-select: none;
      -webkit-user-select: none;
    }
    #ojp-header:active { cursor: grabbing; }
    .ojp-at { color: #6b7280; font-size: 12px; }
    #ojp-username { color: #2563eb; font-weight: 600; }
    .ojp-hr { display: flex; align-items: center; gap: 8px; color: #9ca3af; font-size: 11px; }
    #ojp-toggle {
      border: none; background: transparent; cursor: pointer;
      color: #6b7280; font-size: 12px; line-height: 1; padding: 2px 5px;
      border-radius: 4px;
    }
    #ojp-toggle:hover { background: #e5e7eb; }
    #ojp-body { max-height: 150px; overflow-y: auto; }
    #ojp-list { padding: 2px 0; }
    .ojp-row {
      display: grid;
      grid-template-columns: 100px 36px 60px 1fr;
      gap: 6px;
      align-items: center;
      padding: 5px 10px;
      border-bottom: 1px solid #f1f5f9;
    }
    .ojp-row:last-child { border-bottom: none; }
    .ojp-cell { min-width: 0; }
    .ojp-status { overflow: hidden; }
    .ojp-user { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #374151; }
    .ojp-score { text-align: center; font-weight: 600; color: #111827; }
    .ojp-problem {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: #1f2937;
    }
    .ojp-badge {
      display: inline-block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 1px 6px;
      border-radius: 999px;
      font-size: 11px;
      line-height: 16px;
    }
    .st-ac      { background: #dcfce7; color: #166534; }
    .st-wa      { background: #fee2e2; color: #991b1b; }
    .st-lim     { background: #ffedd5; color: #9a3412; }
    .st-ce      { background: #fef9c3; color: #854d0e; }
    .st-re      { background: #f3e8ff; color: #6b21a8; }
    .st-pending { background: #e2e8f0; color: #475569; }
    .st-partial { background: #ffedd5; color: #9a3412; }
    .st-other   { background: #f1f5f9; color: #475569; }
    #ojp-footer { padding: 6px 10px 8px; text-align: center; }
    #ojp-more {
      border: 1px solid #d1d5db; background: #ffffff; color: #374151;
      border-radius: 6px; padding: 4px 14px; font-size: 12px; cursor: pointer;
    }
    #ojp-more:hover { background: #f3f4f6; }
    #ojp-more:disabled { color: #9ca3af; cursor: default; }
    .ojp-hint {
      padding: 16px 12px; text-align: center; color: #6b7280; font-size: 12px;
    }
    .ojp-error { color: #b91c1c; }
    .ojp-retry {
      display: block; margin: 10px auto 0;
      border: 1px solid #fca5a5; background: #fef2f2; color: #b91c1c;
      border-radius: 6px; padding: 4px 14px; font-size: 12px; cursor: pointer;
    }
    .ojp-retry:hover { background: #fee2e2; }
  `;

  init();
})();
