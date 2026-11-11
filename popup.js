// SYZOJ 提交监视器 - popup
'use strict';

const input = document.getElementById('username');
const currentUserEl = document.getElementById('current-user');
const statusEl = document.getElementById('status');
const saveBtn = document.getElementById('save');

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

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.className = isError ? 'error' : '';
}

// 解析输入：换行 / 逗号（中英文）/ 空格分隔，去重、去空白
function parseUsernames(text) {
  const parts = String(text || '').split(/[\s,，]+/).filter((s) => s.length > 0);
  return Array.from(new Set(parts));
}

// 更新「当前」摘要
function renderCurrent(names) {
  if (!names || names.length === 0) {
    currentUserEl.textContent = '未设置';
    return;
  }
  currentUserEl.textContent = names.length + ' 人：' + names.join('、');
}

// 初始化：读取当前用户列表
async function init() {
  const state = await sendToBackground({ type: 'GET_STATE' });
  const names = state && Array.isArray(state.usernames) ? state.usernames : [];
  input.value = names.join('\n');
  renderCurrent(names);
}

async function save() {
  const names = parseUsernames(input.value);
  if (names.length === 0) {
    setStatus('请输入至少一个用户名', true);
    input.focus();
    return;
  }
  const res = await sendToBackground({ type: 'SET_USERNAMES', usernames: names });
  if (res && res.ok) {
    // 回显为「每行一个」的规范格式
    input.value = names.join('\n');
    renderCurrent(names);
    setStatus('已保存，面板已刷新', false);
  } else {
    setStatus((res && res.error) || '保存失败', true);
  }
}

saveBtn.addEventListener('click', save);
input.addEventListener('keydown', (e) => {
  // Ctrl/Cmd + Enter 保存（textarea 内 Enter 用于换行）
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    save();
  }
});

init();
