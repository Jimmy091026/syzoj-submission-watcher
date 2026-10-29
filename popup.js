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

// 初始化：读取当前用户名
async function init() {
  const state = await sendToBackground({ type: 'GET_STATE' });
  const name = state && state.username ? state.username : '';
  input.value = name;
  currentUserEl.textContent = name || '未设置';
}

async function save() {
  const name = input.value.trim();
  if (!name) {
    setStatus('请输入用户名', true);
    input.focus();
    return;
  }
  const res = await sendToBackground({ type: 'SET_USERNAME', username: name });
  if (res && res.ok) {
    currentUserEl.textContent = name;
    setStatus('已保存，面板已刷新', false);
  } else {
    setStatus((res && res.error) || '保存失败', true);
  }
}

saveBtn.addEventListener('click', save);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') save();
});

init();
