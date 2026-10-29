// ============================================================
// SYZOJ 提交监视器 - background service worker (Manifest V3)
// 职责：所有数据抓取都在这里通过 fetch 完成（规避 CORS），
//       content script 只负责渲染与接收本 worker 返回的数据。
//
// 安全约定：本扩展只请求「提交列表页」 /submissions ，
//           绝不访问单个提交详情页 /submission/:id 。
// ============================================================
'use strict';

// ---- 常量 ----
const DOMAINS = [
  'https://in.7fa4.cn:8888', // 主域名（优先）
  'https://jx.7fa4.cn:8888'  // 备用域名
];
const PAGE_SIZE = 20;      // SYZOJ 默认每页条数（仅用于兜底判断，不作为分页依据）
const TIMEOUT_MS = 10000;  // 单次请求超时阈值：10 秒

// ---- 消息路由 ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // 保持通道开启，等待异步 sendResponse
});

async function handleMessage(msg) {
  switch (msg && msg.type) {
    case 'SET_USERNAME':
      return setUsername(msg.username);
    case 'GET_STATE':
      return getState();
    case 'FETCH':
      // query：加载更多时复用服务器生成的完整 query（含 page 或 currPageTop/currPageBottom）
      return fetchSubmissions(msg.username, msg.query || null);
    default:
      return { ok: false, error: '未知消息类型: ' + (msg && msg.type) };
  }
}

// ---- 保存用户名，并通知所有已打开页面立即刷新 ----
async function setUsername(username) {
  const name = String(username || '').trim();
  await chrome.storage.local.set({ username: name });

  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id != null) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'USER_CHANGED', username: name });
      } catch (_) {
        // 该页面没有注入 content script（如 chrome:// 页），忽略
      }
    }
  }
  return { ok: true, username: name };
}

// ---- 读取全局状态（用户名 / 面板位置 / 上次成功域名） ----
async function getState() {
  const data = await chrome.storage.local.get(['username', 'position', 'lastGoodDomain']);
  return {
    username: data.username || '',
    position: data.position || null,
    lastGoodDomain: data.lastGoodDomain || null
  };
}

// ---- 数据抓取（含多域名容错） ----
async function fetchSubmissions(username, queryOverride) {
  const name = String(username || '').trim();
  if (!name) return { ok: false, error: '用户名未设置' };

  const { lastGoodDomain } = await chrome.storage.local.get('lastGoodDomain');

  // 域名优先级：若上次成功的是备用域名，本轮先尝试它；否则主域名优先。
  const ordered = (lastGoodDomain === DOMAINS[1])
    ? [DOMAINS[1], DOMAINS[0]]
    : [DOMAINS[0], DOMAINS[1]];

  let lastError = null;
  for (const domain of ordered) {
    try {
      const url = buildUrl(domain, name, queryOverride);
      const html = await fetchTextWithTimeout(url);
      const parsed = parsePage(html);
      if (!parsed) {
        // 站点要求登录时返回登录墙页面（无 itemList），给出可操作的提示
        if (looksLikeLoginWall(html)) {
          throw new Error('需要登录：请先在浏览器打开并登录目标 OJ，再重试');
        }
        throw new Error('返回内容不合法（未找到 itemList）');
      }

      await chrome.storage.local.set({ lastGoodDomain: domain }); // 记住成功域名
      return {
        ok: true,
        items: parsed.items,
        hasMore: parsed.hasMore,
        nextQuery: parsed.nextQuery,
        domain
      };
    } catch (e) {
      lastError = e; // 记录错误，切到下一个域名重试
    }
  }
  return { ok: false, error: lastError ? lastError.message : '请求失败' };
}

function buildUrl(domain, username, queryOverride) {
  // 加载更多：直接复用服务器算好的 query（普通分页=page=N，快速分页=currPageTop/currPageBottom）
  if (queryOverride) {
    return `${domain}/submissions?${queryOverride}`;
  }
  // 初始 / 轮询刷新：按提交者过滤，取最新一页
  return `${domain}/submissions?submitter=${encodeURIComponent(username)}`;
}

async function fetchTextWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // credentials:'include' 携带目标域已有的登录 cookie（用户需先在浏览器登录该 OJ）。
    // 匿名（omit）时该站点会返回登录墙，导致拿不到 itemList。
    const res = await fetch(url, { signal: controller.signal, credentials: 'include' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// 从 HTML 提取 `const itemList = [...]` 的 JSON。
// 用括号配对法（忽略字符串内部的括号），避免题目名里含 ']' 时被误截断。
function extractItemList(html) {
  const marker = 'const itemList = ';
  const idx = html.indexOf(marker);
  if (idx === -1) return null;

  let start = idx + marker.length;
  while (start < html.length && /\s/.test(html[start])) start++;
  if (html[start] !== '[') return null;

  let depth = 0, inString = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return null;
}

// 提取「下一页」链接（id="page_next"）的完整 query。
// 普通分页 → 含 page=N+1；快速分页 → 含 currPageTop/currPageBottom&page=1。
// disabled 的 page_next 没有 href，即表示没有下一页。
function extractNextQuery(html) {
  const tagMatch = html.match(/<a\b[^>]*id="page_next"[^>]*>/);
  if (!tagMatch) return null;
  const hrefMatch = tagMatch[0].match(/href="([^"]*)"/);
  if (!hrefMatch || !hrefMatch[1]) return null;
  const href = decodeEntities(hrefMatch[1]);
  const qIdx = href.indexOf('?');
  return qIdx === -1 ? '' : href.slice(qIdx + 1);
}

// 判断返回页面是否为「请登录」错误页
function looksLikeLoginWall(html) {
  return /请登录后继续|请先登录|请登录|Please (log|sign) in|login required/i.test(html);
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function parsePage(html) {
  const json = extractItemList(html);
  if (json == null) return null;

  let items;
  try {
    items = JSON.parse(json);
  } catch (_) {
    return null;
  }
  if (!Array.isArray(items)) return null;

  const nextQuery = extractNextQuery(html);
  return {
    items,
    hasMore: !!nextQuery,
    nextQuery: nextQuery || null
  };
}
