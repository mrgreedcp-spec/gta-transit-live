// 到站推送提醒。依赖 app.js 的全局：$, esc, api, selectStop, agColor, nameOf, showTab
const push = { id: localStorage.getItem('pushDev'), rules: [], key: null, enabled: false, reason: '' };
const DAY_ZH = ['日', '一', '二', '三', '四', '五', '六'];
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function pushSupport() {
  if (!window.isSecureContext) return '推送提醒需要 HTTPS 地址（云端地址或 localhost）。';
  if (isIOS && !isStandalone()) return 'iPhone 需要先把本页「添加到主屏幕」，再从主屏图标打开，才能收推送（iOS 16.4 以上）。步骤：Safari 底部「分享」→「添加到主屏幕」。';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return '这个浏览器不支持推送通知。';
  if (!push.enabled) return `服务器暂未开启推送：${push.reason || '缺少配置'}。`;
  return '';
}

function b64ToUint8(b64) {
  const s = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

async function postJson(url, body, method = 'POST') {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// 确保本设备已订阅推送，返回设备 id
async function ensureSubscribed() {
  const why = pushSupport();
  if (why) throw new Error(why);
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('通知权限被拒绝。请在系统或浏览器设置里允许本站发送通知。');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(push.key) });
  const r = await postJson('/api/push/subscribe', { sub: sub.toJSON(), lang: localStorage.getItem('lang') || 'zh' });
  push.id = r.id; push.rules = r.rules || [];
  localStorage.setItem('pushDev', r.id);
  return r.id;
}

// ---------- 设置提醒表单（到站页） ----------
async function openRemindForm(s) {
  const box = $('#remindForm');
  const why = pushSupport();
  if (why) { box.innerHTML = `<div class="remind"><b>🔔 到站提醒</b><div class="empty">${esc(why)}</div><button class="link-btn" data-rclose>关闭</button></div>`; return; }
  let routes = [];
  try {
    const r = await api(`/api/stops/${s.agency}/${encodeURIComponent(s.id)}/arrivals`);
    routes = [...new Set(r.arrivals.map(a => a.routeShort))];
  } catch {}
  const now = new Date();
  // 规则按多伦多时间生效，默认值也取多伦多时间
  const hm = d => d.toLocaleTimeString('en-GB', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit' });
  box.innerHTML = `<div class="remind"><b>🔔 到站提醒 · ${esc(s.name)}</b>
    <label>线路 <select id="rRoute"><option value="">任意线路</option>${routes.map(x => `<option>${esc(x)}</option>`).join('')}</select></label>
    <label>提前 <select id="rLead">${[2, 3, 5, 8, 10, 15].map(m => `<option value="${m}" ${m === 5 ? 'selected' : ''}>${m} 分钟</option>`).join('')}</select> 提醒</label>
    <div class="days">${DAY_ZH.map((d, i) => `<label class="day"><input type="checkbox" value="${i}" ${i >= 1 && i <= 5 ? 'checked' : ''}>${d}</label>`).join('')}</div>
    <label>时间段 <input id="rFrom" type="time" value="${hm(now)}"> – <input id="rTo" type="time" value="${hm(new Date(now.getTime() + 2 * 3600e3))}"></label>
    <label class="switch"><input id="rOnce" type="checkbox"> 只提醒一次</label>
    <div class="hint">时间按多伦多时间。服务器休眠时不会推送（云端每 10 分钟保活）。</div>
    <div><button class="primary" data-rsave>保存提醒</button> <button class="link-btn" data-rclose>取消</button></div>
    <div id="rMsg" class="empty"></div></div>`;
  box.dataset.stop = JSON.stringify({ agency: s.agency, id: s.id, name: s.name });
}

$('#remindForm').addEventListener('click', async e => {
  if (e.target.closest('[data-rclose]')) { $('#remindForm').innerHTML = ''; return; }
  if (!e.target.closest('[data-rsave]')) return;
  const msg = $('#rMsg');
  msg.textContent = '开通推送中…';
  try {
    const id = await ensureSubscribed();
    const rule = {
      stop: JSON.parse($('#remindForm').dataset.stop), route: $('#rRoute').value || null, lead: +$('#rLead').value,
      days: [...document.querySelectorAll('#remindForm .day input:checked')].map(x => +x.value),
      from: $('#rFrom').value, to: $('#rTo').value, once: $('#rOnce').checked,
    };
    if (!rule.days.length) throw new Error('至少选一天。');
    const saved = await postJson('/api/push/rules', { id, rule });
    push.rules.push(saved);
    renderPushBox();
    $('#remindForm').innerHTML = `<div class="remind ok">✅ 已设置：${esc(saved.stop.name)} ${saved.route ? esc(saved.route) + ' 路' : '任意线路'}，提前 ${saved.lead} 分钟。可在「收藏」页管理提醒。</div>`;
  } catch (err) { msg.textContent = err.message; }
});

// ---------- 我的提醒（收藏页顶部） ----------
function ruleText(r) {
  const days = r.days.length === 7 ? '每天' : r.days.length === 5 && !r.days.includes(0) && !r.days.includes(6) ? '工作日' : '周' + r.days.map(d => DAY_ZH[d]).join('');
  return `${r.route ? r.route + ' 路' : '任意线路'} · 提前 ${r.lead} 分 · ${days} ${r.from}–${r.to}${r.once ? ' · 一次' : ''}${r.enabled ? '' : ' · 已完成'}`;
}

function renderPushBox() {
  const box = $('#pushBox');
  if (!push.id && !push.rules.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<h3>🔔 我的到站提醒</h3><ul class="stop-list">${push.rules.map(r => `<li data-rule="${esc(r.id)}">
      <span class="tag" style="background:${agColor(r.stop.agency)}">${esc(nameOf(r.stop.agency))}</span>
      <span class="nm"><div>${esc(r.stop.name)}</div><span class="code">${esc(ruleText(r))}</span></span>
      <span class="ops"><button data-op="rdel" aria-label="删除提醒">✕</button></span></li>`).join('') || '<li class="hint">还没有提醒。在到站页点「🔔 提醒我」。</li>'}</ul>
    <button class="link-btn" data-ptest>发送测试通知</button> <span id="pTestMsg" class="hint"></span>`;
}

$('#pushBox').addEventListener('click', async e => {
  const li = e.target.closest('li[data-rule]');
  if (li && e.target.closest('[data-op="rdel"]')) {
    await fetch(`/api/push/rules?id=${encodeURIComponent(push.id)}&rule=${encodeURIComponent(li.dataset.rule)}`, { method: 'DELETE' });
    push.rules = push.rules.filter(r => r.id !== li.dataset.rule);
    renderPushBox();
  } else if (li) {
    const r = push.rules.find(x => x.id === li.dataset.rule);
    if (r) api(`/api/stops/search?q=${encodeURIComponent(r.stop.id)}&agencies=${r.stop.agency}&limit=5`).then(l => { const s = l.find(x => x.id === r.stop.id) || l[0]; if (s) selectStop(s); });
  } else if (e.target.closest('[data-ptest]')) {
    $('#pTestMsg').textContent = '发送中…';
    try { await postJson('/api/push/test', { id: push.id }); $('#pTestMsg').textContent = '已发送，请看通知栏。'; }
    catch (err) { $('#pTestMsg').textContent = '发送失败：' + err.message; }
  }
});

// 启动：取公钥和本设备规则
(async () => {
  try {
    const k = await api('/api/push/key');
    push.key = k.publicKey; push.enabled = k.enabled; push.reason = k.reason;
    if (push.id) {
      const r = await fetch(`/api/push/rules?id=${encodeURIComponent(push.id)}`);
      if (r.ok) push.rules = await r.json();
      else if (r.status === 404) { push.id = null; localStorage.removeItem('pushDev'); }
    }
  } catch {}
  renderPushBox();
})();
