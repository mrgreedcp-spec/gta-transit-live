// GTA 公交实时 · 全屏实时地图
const REFRESH_MS = 20000;
const DOM_LIMIT = 250;          // 视野内车辆超过这个数，改用 canvas 小圆点
const BUS_ZOOM = 12;            // 「缩小时只显示火车」开启时，公交从这一级开始显示
const STOP_ZOOM = 15;           // 站点图层从这一级开始显示
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isMobile = () => matchMedia('(max-width: 760px)').matches;
const ls = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => localStorage.setItem(k, JSON.stringify(v)) };
const fmtClock = t => new Date(t * 1000).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Toronto' });

// ---------- 网络 ----------
async function api(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (r.status === 401) { location.href = '/login'; throw new Error('login'); }
  if (!r.ok && r.status !== 503) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ---------- 地图 ----------
const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView(ls.get('view', [43.68, -79.52, 10]).slice(0, 2), ls.get('view', [0, 0, 10])[2]);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ position: 'bottomright', imperial: false }).addTo(map);
// 淡色底图：OSM 瓦片 + CSS 灰度（见 style.css .base-tiles）
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, className: 'base-tiles', attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);
const canvas = L.canvas({ padding: 0.3 });
const vehLayer = L.layerGroup().addTo(map);
const stopLayer = L.layerGroup().addTo(map);
map.on('moveend', () => { const c = map.getCenter(); ls.set('view', [c.lat, c.lng, map.getZoom()]); });

// ---------- 状态 ----------
let agencies = [];
let lastVehicles = [];
let serverNow = Date.now() / 1000;
const enabled = new Set(ls.get('enabledAgencies', ['ttc', 'go', 'miway', 'brampton', 'yrt', 'durham']));
const hiddenRoutes = new Set(ls.get('hiddenRoutes', []));
let busGate = ls.get('busGate', false);
let showStops = ls.get('showStops', true);
let selectedStop = null;
const agColor = id => agencies.find(a => a.id === id)?.color || '#555';
const nameOf = id => agencies.find(a => a.id === id)?.name || id;

const delayClass = d => d == null ? 'd-none' : d < -60 ? 'd-early' : d < 180 ? 'd-ok' : d < 300 ? 'd-warn' : 'd-late';
const delayColor = { 'd-none': '#a6a6a6', 'd-early': '#111', 'd-ok': '#2e9e44', 'd-warn': '#f2b705', 'd-late': '#d6302a' };
const delayText = d => d == null ? '无晚点数据' : Math.abs(d) < 60 ? '准点' : d > 0 ? `晚 ${Math.round(d / 60)} 分` : `早 ${Math.round(-d / 60)} 分`;
const isRail = v => v.mode === 'train' || v.mode === 'subway' || v.mode === 'tram';

// ---------- 车辆 ----------
const markers = new Map(); // key -> { m, kind, sig }
const lastPos = new Map(); // key -> [lat, lon, bearing]  方向兜底

function visibleVehicles() {
  const z = map.getZoom();
  return lastVehicles.filter(v => enabled.has(v.agency)
    && !hiddenRoutes.has(`${v.agency}:${v.routeShort}`)
    && (!busGate || z >= BUS_ZOOM || isRail(v)));
}

function bearingOf(v, key) {
  if (v.bearing != null) return v.bearing;
  const p = lastPos.get(key);
  if (!p) { lastPos.set(key, [v.lat, v.lon, null]); return null; }
  const dy = v.lat - p[0], dx = (v.lon - p[1]) * Math.cos(v.lat * Math.PI / 180);
  if (Math.hypot(dx, dy) * 111000 < 15) return p[2]; // 移动不到 15 米，沿用上次
  const b = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  lastPos.set(key, [v.lat, v.lon, b]);
  return b;
}

function popupHtml(v) {
  const age = v.ts ? Math.max(0, Math.round(serverNow - v.ts)) : null;
  const extra = [];
  if (v.occupancy != null) extra.push(`满载 ${v.occupancy}%`);
  if (v.cars) extra.push(`${v.cars} 节车厢`);
  return `<div class="veh-pop"><span class="line" style="background:${v.routeColor};color:${v.textColor}">${esc(v.routeShort ?? '?')}</span>
    <b> ${esc(v.headsign || '')}</b><br>${esc(nameOf(v.agency))} · 车辆 ${esc(v.label || v.id)}<br>
    ${esc(delayText(v.delaySec))}${extra.length ? ' · ' + esc(extra.join(' · ')) : ''}<br>
    <span class="code">${age != null ? `${age} 秒前更新` : ''}</span></div>`;
}

function renderVehicles() {
  const bounds = map.getBounds().pad(0.1);
  const vis = visibleVehicles().filter(v => bounds.contains([v.lat, v.lon]));
  const useDom = vis.length <= DOM_LIMIT;
  const seen = new Set();
  for (const v of vis) {
    const key = `${v.agency}:${v.id}`;
    seen.add(key);
    const dc = delayClass(v.delaySec);
    const dom = useDom || v.agency === 'go';
    const b = dom ? bearingOf(v, key) : null;
    const sig = dom ? `${v.routeShort}|${v.routeColor}|${dc}|${b == null ? '' : Math.round(b / 10)}|${v.mode}` : `${v.routeColor}|${dc}`;
    let rec = markers.get(key);
    if (rec && rec.kind !== (dom ? 'dom' : 'cv')) { vehLayer.removeLayer(rec.m); rec = null; }
    if (!rec) {
      const m = dom
        ? L.marker([v.lat, v.lon], { icon: vehIcon(v, dc, b), keyboard: false })
        : L.circleMarker([v.lat, v.lon], { renderer: canvas, radius: 5, weight: 2, color: delayColor[dc], fillColor: v.routeColor, fillOpacity: 1 });
      m.addTo(vehLayer);
      rec = { m, kind: dom ? 'dom' : 'cv', sig };
      markers.set(key, rec);
    } else {
      rec.m.setLatLng([v.lat, v.lon]);
      if (rec.sig !== sig) {
        if (dom) rec.m.setIcon(vehIcon(v, dc, b)); else rec.m.setStyle({ color: delayColor[dc], fillColor: v.routeColor });
        rec.sig = sig;
      }
    }
    rec.m.bindPopup(popupHtml(v));
  }
  for (const [k, rec] of markers) if (!seen.has(k)) { vehLayer.removeLayer(rec.m); markers.delete(k); }
  $('#vehCount').textContent = `视野内 ${vis.length} 辆，全部 ${lastVehicles.length} 辆`;
}

function vehIcon(v, dc, b) {
  const label = esc(String(v.routeShort ?? '?').slice(0, 4));
  const arrow = b == null ? '' : `<i class="arrow" style="--b:${Math.round(b)}deg"></i>`;
  const sz = v.mode === 'train' ? 32 : 28;
  return L.divIcon({
    className: 'veh-wrap', iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2], popupAnchor: [0, -sz / 2],
    html: `<div class="veh ${dc} ${v.mode === 'train' ? 'train' : ''}" style="background:${v.routeColor};color:${v.textColor}">${arrow}<span>${label}</span></div>`,
  });
}

async function loadVehicles() {
  const ids = [...enabled].join(',');
  if (!ids) { lastVehicles = []; renderVehicles(); return; }
  // 低缩放看全区；放大后只取视野附近，省流量
  const b = map.getBounds().pad(0.5);
  const bbox = map.getZoom() >= 12 ? `&bbox=${[b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(x => x.toFixed(4)).join(',')}` : '';
  const r = await api(`/api/vehicles?agencies=${ids}${bbox}`);
  serverNow = r.now;
  lastVehicles = r.vehicles;
  renderVehicles();
  renderChips();
}

// ---------- 筛选面板 ----------
$('#filterBtn').onclick = () => {
  const p = $('#filterPanel');
  p.hidden = !p.hidden;
  $('#filterBtn').innerHTML = p.hidden ? '筛选 <b>+</b>' : '筛选 <b>−</b>';
  if (!p.hidden) renderChips();
};
$('#busGate').checked = busGate;
$('#showStops').checked = showStops;
$('#busGate').onchange = e => { busGate = e.target.checked; ls.set('busGate', busGate); renderVehicles(); };
$('#showStops').onchange = e => { showStops = e.target.checked; ls.set('showStops', showStops); loadStops(); };

function renderChips() {
  if ($('#filterPanel').hidden) return;
  const groups = new Map(); // agency -> Map(routeShort -> v)
  for (const v of lastVehicles) {
    if (!groups.has(v.agency)) groups.set(v.agency, new Map());
    const g = groups.get(v.agency);
    if (!g.has(v.routeShort)) g.set(v.routeShort, v);
  }
  const html = agencies.filter(a => groups.has(a.id)).map(a => {
    const routes = [...groups.get(a.id).values()].sort((x, y) => String(x.routeShort).localeCompare(String(y.routeShort), 'en', { numeric: true }));
    return `<div class="chip-group"><h4><span><span class="tag" style="background:${a.color}">${esc(a.name)}</span> ${routes.length} 条线在跑</span>
      <span><button class="link-btn" data-all="${a.id}" data-on="1">全选</button> <button class="link-btn" data-all="${a.id}" data-on="0">全不选</button></span></h4>
      <div class="chips">${routes.map(v => {
        const k = `${a.id}:${v.routeShort}`;
        return `<button class="chip ${hiddenRoutes.has(k) ? 'off' : ''}" data-route="${esc(k)}" style="background:${v.routeColor};color:${v.textColor}">${esc(v.routeShort)}</button>`;
      }).join('')}</div></div>`;
  }).join('');
  $('#routeChips').innerHTML = html || '<div class="hint">暂无在跑的车辆。</div>';
}
$('#routeChips').addEventListener('click', e => {
  const chip = e.target.closest('[data-route]');
  const all = e.target.closest('[data-all]');
  if (chip) { const k = chip.dataset.route; hiddenRoutes.has(k) ? hiddenRoutes.delete(k) : hiddenRoutes.add(k); }
  else if (all) {
    for (const v of lastVehicles) if (v.agency === all.dataset.all) {
      const k = `${v.agency}:${v.routeShort}`;
      all.dataset.on === '1' ? hiddenRoutes.delete(k) : hiddenRoutes.add(k);
    }
  } else return;
  ls.set('hiddenRoutes', [...hiddenRoutes]);
  renderChips(); renderVehicles();
});

// ---------- 站点图层 ----------
let stopTimer;
async function loadStops() {
  if (!showStops || map.getZoom() < STOP_ZOOM) { stopLayer.clearLayers(); return; }
  const b = map.getBounds();
  const r = await api(`/api/stops/bbox?w=${b.getWest()}&s=${b.getSouth()}&e=${b.getEast()}&n=${b.getNorth()}&limit=400&agencies=${[...enabled].join(',')}`);
  stopLayer.clearLayers();
  for (const s of r.stops) {
    L.circleMarker([s.lat, s.lon], { renderer: canvas, radius: 6, weight: 2, color: agColor(s.agency), fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip(`${s.name} #${s.code || s.id}`, { direction: 'top' })
      .on('click', () => selectStop(s))
      .addTo(stopLayer);
  }
}
map.on('moveend', () => {
  clearTimeout(stopTimer);
  stopTimer = setTimeout(() => { loadStops().catch(() => {}); renderVehicles(); if (map.getZoom() >= 12) loadVehicles().catch(() => {}); }, 300);
});
map.on('zoomend', renderVehicles);

// ---------- 抽屉与标签 ----------
const DRAWER = { min: 96, half: () => innerHeight * 0.45, full: () => innerHeight * 0.88 };
let drawerState = 'half';
function setDrawer(state) {
  drawerState = state;
  const h = state === 'min' ? DRAWER.min : state === 'half' ? DRAWER.half() : DRAWER.full();
  document.documentElement.style.setProperty('--drawer-h', h + 'px');
}
function showTab(name) {
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const s of document.querySelectorAll('#panes section')) s.classList.toggle('on', s.dataset.pane === name);
  ls.set('tab', name);
  if (isMobile() && drawerState === 'min') setDrawer('half');
}
$('#tabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); };
$('#handle').onclick = () => setDrawer(drawerState === 'min' ? 'half' : drawerState === 'half' ? 'full' : 'min');
// 拖动把手
(() => {
  let startY, startH, moved;
  $('#handle').addEventListener('pointerdown', e => { startY = e.clientY; startH = $('#drawer').getBoundingClientRect().height; moved = false; $('#drawer').classList.add('dragging'); e.target.setPointerCapture(e.pointerId); });
  $('#handle').addEventListener('pointermove', e => {
    if (startY == null) return;
    const h = Math.min(DRAWER.full(), Math.max(DRAWER.min, startH + startY - e.clientY));
    if (Math.abs(startY - e.clientY) > 5) moved = true;
    document.documentElement.style.setProperty('--drawer-h', h + 'px');
  });
  $('#handle').addEventListener('pointerup', e => {
    $('#drawer').classList.remove('dragging');
    if (startY == null) return;
    const h = $('#drawer').getBoundingClientRect().height;
    startY = null;
    if (!moved) return;
    const opts = [['min', DRAWER.min], ['half', DRAWER.half()], ['full', DRAWER.full()]];
    setDrawer(opts.sort((a, b) => Math.abs(a[1] - h) - Math.abs(b[1] - h))[0][0]);
    $('#handle').onclick = null; setTimeout(() => { $('#handle').onclick = () => setDrawer(drawerState === 'min' ? 'half' : drawerState === 'half' ? 'full' : 'min'); }, 0);
  });
})();
$('#legendToggle').onclick = () => $('#legend').classList.toggle('open');

// ---------- 搜索 ----------
let searchTimer;
$('#stopSearch').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $('#stopSearch').value.trim();
    if (!q) { $('#stopResults').innerHTML = ''; return; }
    const list = await api(`/api/stops/search?q=${encodeURIComponent(q)}&agencies=${[...enabled].join(',')}`);
    $('#stopResults').innerHTML = list.length ? list.map((s, i) => `<li data-i="${i}">
      <span class="tag" style="background:${agColor(s.agency)}">${esc(nameOf(s.agency))}</span>
      <span>${esc(s.name)} <span class="code">#${esc(s.code || s.id)}</span></span></li>`).join('')
      : '<li class="hint">没找到</li>';
    $('#stopResults').querySelectorAll('li[data-i]').forEach(li => li.onclick = () => {
      $('#stopResults').innerHTML = ''; $('#stopSearch').value = ''; $('#stopSearch').blur();
      selectStop(list[+li.dataset.i]);
    });
  }, 250);
};

// ---------- 到站 ----------
let stopPin = null;
function selectStop(s, { pan = true } = {}) {
  selectedStop = s;
  if (stopPin) map.removeLayer(stopPin);
  stopPin = L.marker([s.lat, s.lon]).addTo(map);
  if (pan) map.setView([s.lat, s.lon], Math.max(map.getZoom(), 16));
  $('#arrivals').innerHTML = `${stopTitle(s)}<div class="empty">实时到站加载中…</div>`;
  $('#remindForm').innerHTML = '';
  showTab('stop');
  loadArrivals();
}

function stopTitle(s) {
  const fav = isFav(s);
  return `<div class="stop-title"><div class="title">${esc(s.name)} <span class="code">#${esc(s.code || s.id)} · ${esc(nameOf(s.agency))}</span></div>
    <button class="star" type="button" data-star aria-label="${fav ? '取消收藏' : '收藏'}" title="${fav ? '取消收藏' : '收藏'}">${fav ? '★' : '☆'}</button></div>
    <div><button class="link-btn" type="button" data-remind>🔔 提醒我</button> · <button class="link-btn" type="button" data-planfrom>从这里出发</button> · <button class="link-btn" type="button" data-planto>到这里去</button></div>`;
}

async function loadArrivals() {
  if (!selectedStop) return;
  const s = selectedStop;
  const r = await api(`/api/stops/${s.agency}/${encodeURIComponent(s.id)}/arrivals`);
  if (selectedStop !== s) return;
  const rows = r.arrivals.map(a => {
    const min = Math.round((a.time - r.now) / 60);
    const d = a.delaySec;
    const dl = d == null || Math.abs(d) < 60 ? '' : d > 0 ? `<span class="late">晚 ${Math.round(d / 60)} 分</span>` : `<span class="early">早 ${Math.round(-d / 60)} 分</span>`;
    return `<tr><td><span class="line" style="background:${a.routeColor || agColor(s.agency)};color:${a.textColor || '#fff'}">${esc(a.routeShort)}</span></td>
      <td>${esc(a.headsign)}${a.platform ? ` <span class="code">站台 ${esc(a.platform)}</span>` : ''} ${dl}</td>
      <td class="min">${min <= 0 ? '即将到站' : min + ' 分'}<br><span class="code">${fmtClock(a.time)}</span></td></tr>`;
  }).join('');
  $('#arrivals').innerHTML = `${stopTitle(s)}${rows ? `<table class="dep">${rows}</table>` : `<div class="empty">${esc(r.note || '未来 90 分钟内没有实时到站数据')}</div>`}`;
}

// ---------- 收藏 ----------
const favKey = s => `${s.agency}:${s.id}`;
let favs = ls.get('favStops', []);
let favEditing = false;
const nextTxt = new Map(); // key -> "19 3分 · 19 12分"
const isFav = s => favs.some(f => favKey(f) === favKey(s));
const saveFavs = () => ls.set('favStops', favs);

function toggleFav(s) {
  if (isFav(s)) favs = favs.filter(f => favKey(f) !== favKey(s));
  else favs.push({ agency: s.agency, id: s.id, code: s.code, name: s.name, lat: s.lat, lon: s.lon });
  saveFavs(); renderFavs(); loadFavArrivals().catch(() => {}); renderNear();
  const btn = $('#arrivals [data-star]');
  if (btn && selectedStop) { const f = isFav(selectedStop); btn.textContent = f ? '★' : '☆'; btn.title = btn.ariaLabel = f ? '取消收藏' : '收藏'; }
}
$('#arrivals').addEventListener('click', e => {
  if (!selectedStop) return;
  if (e.target.closest('[data-star]')) toggleFav(selectedStop);
  else if (e.target.closest('[data-planfrom]')) planFromStop(selectedStop, 'from');
  else if (e.target.closest('[data-planto]')) planFromStop(selectedStop, 'to');
  else if (e.target.closest('[data-remind]')) openRemindForm(selectedStop);
});

function stopRow(s, i, extra = '') {
  return `<li data-i="${i}" data-key="${esc(favKey(s))}">
    <span class="tag" style="background:${agColor(s.agency)}">${esc(nameOf(s.agency))}</span>
    <span class="nm"><div>${esc(s.name)}</div><span class="code">#${esc(s.code || s.id)}</span>${extra}</span>
    <span class="next">${esc(nextTxt.get(favKey(s)) ?? '…')}</span></li>`;
}

function renderFavs() {
  $('#favEdit').hidden = !favs.length;
  $('#favEdit').textContent = favEditing ? '完成' : '编辑';
  $('#favHint').textContent = favs.length ? '' : '';
  if (!favs.length) { favEditing = false; $('#favList').innerHTML = '<li class="hint">搜索或点地图上的站点，再点 ☆ 收藏。这里会显示每站下两班。</li>'; return; }
  $('#favList').innerHTML = favs.map((f, i) => favEditing
    ? `<li data-i="${i}"><span class="tag" style="background:${agColor(f.agency)}">${esc(nameOf(f.agency))}</span><span class="nm"><div>${esc(f.name)}</div></span>
       <span class="ops"><button data-op="up" aria-label="上移" ${i === 0 ? 'disabled' : ''}>↑</button><button data-op="down" aria-label="下移" ${i === favs.length - 1 ? 'disabled' : ''}>↓</button><button data-op="del" aria-label="删除">✕</button></span></li>`
    : stopRow(f, i)).join('');
}
$('#favEdit').onclick = () => { favEditing = !favEditing; renderFavs(); };
$('#favList').addEventListener('click', e => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  const i = +li.dataset.i;
  const op = e.target.closest('[data-op]')?.dataset.op;
  if (op === 'up' && i > 0) [favs[i - 1], favs[i]] = [favs[i], favs[i - 1]];
  else if (op === 'down' && i < favs.length - 1) [favs[i + 1], favs[i]] = [favs[i], favs[i + 1]];
  else if (op === 'del') favs.splice(i, 1);
  else if (!favEditing) return selectStop(favs[i]);
  else return;
  saveFavs(); renderFavs();
});

async function batchNext(list) {
  if (!list.length) return;
  const qs = list.slice(0, 30).map(f => 's=' + encodeURIComponent(favKey(f))).join('&');
  const r = await api(`/api/arrivals?${qs}&limit=2`);
  for (const x of r.results) {
    nextTxt.set(`${x.agency}:${x.id}`, x.arrivals.length
      ? x.arrivals.map(a => { const m = Math.round((a.time - r.now) / 60); return `${a.routeShort} ${m <= 0 ? '即到' : m + '分'}`; }).join(' · ')
      : (x.note?.includes('加载中') ? '…' : '—'));
  }
}
function patchNext(ul) {
  for (const li of ul.querySelectorAll('li[data-key]')) { const el = li.querySelector('.next'); if (el) el.textContent = nextTxt.get(li.dataset.key) ?? '—'; }
}
async function loadFavArrivals() { await batchNext(favs); if (!favEditing) patchNext($('#favList')); }

// ---------- 附近 ----------
let nearStops = [];
let mePin = null, meCircle = null, watchId = null;
function renderNear() {
  $('#nearList').innerHTML = nearStops.map((s, i) => stopRow(s, i, ` <span class="dist">· ${s.dist} 米</span>`)).join('');
}
$('#nearList').addEventListener('click', e => { const li = e.target.closest('li[data-i]'); if (li) selectStop(nearStops[+li.dataset.i]); });

async function loadNear(lat, lon, label) {
  $('#nearHead').textContent = `${label}：查找中…`;
  showTab('near');
  let list = await api(`/api/stops/near?lat=${lat}&lon=${lon}&radius=800&limit=12&agencies=${[...enabled].join(',')}`);
  if (!list.length) list = await api(`/api/stops/near?lat=${lat}&lon=${lon}&radius=3000&limit=12&agencies=${[...enabled].join(',')}`);
  nearStops = list;
  if (!list.length) {
    $('#nearHead').textContent = `${label}：3 公里内没有站点。你可能不在 GTA 范围内。`;
    renderNear(); return;
  }
  $('#nearHead').textContent = `${label}：最近 ${list.length} 个站点`;
  renderNear();
  await batchNext(list);
  patchNext($('#nearList'));
}
async function refreshNear() { if (nearStops.length) { await batchNext(nearStops); patchNext($('#nearList')); } }
$('#nearCenter').onclick = () => { const c = map.getCenter(); loadNear(c.lat, c.lng, '地图中心附近').catch(() => {}); };

const Locate = L.Control.extend({
  options: { position: 'bottomright' },
  onAdd() {
    const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-locate');
    div.innerHTML = '<a href="#" role="button" title="定位，查附近站点" aria-label="定位">◎</a>';
    L.DomEvent.disableClickPropagation(div);
    div.querySelector('a').onclick = e => { e.preventDefault(); locate(div); };
    return div;
  },
});
new Locate().addTo(map);

function locate(btn) {
  if (!navigator.geolocation || !window.isSecureContext) {
    showTab('near');
    $('#nearHead').textContent = '定位需要 HTTPS 地址（局域网 http 下浏览器不允许定位）。可以先用地图中心查附近。';
    return;
  }
  btn.classList.add('busy');
  const ok = pos => {
    btn.classList.remove('busy');
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    if (!mePin) {
      mePin = L.marker([lat, lon], { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false }).addTo(map);
      meCircle = L.circle([lat, lon], { radius: accuracy, weight: 1, color: '#1a73e8', fillOpacity: 0.08, interactive: false }).addTo(map);
    }
    mePin.setLatLng([lat, lon]); meCircle.setLatLng([lat, lon]).setRadius(accuracy);
    map.setView([lat, lon], 16);
    loadNear(lat, lon, '你附近').catch(() => {});
    if (watchId == null) watchId = navigator.geolocation.watchPosition(p => { // 只更新蓝点，不抢地图
      mePin.setLatLng([p.coords.latitude, p.coords.longitude]);
      meCircle.setLatLng([p.coords.latitude, p.coords.longitude]).setRadius(p.coords.accuracy);
    }, () => {}, { enableHighAccuracy: true, maximumAge: 30000 });
  };
  const fail = (err, retried) => {
    if (!retried && err.code !== err.PERMISSION_DENIED) { // 超时/不可用：降精度再试一次
      navigator.geolocation.getCurrentPosition(ok, e2 => fail(e2, true), { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
      return;
    }
    btn.classList.remove('busy');
    showTab('near');
    $('#nearHead').textContent = err.code === err.PERMISSION_DENIED
      ? '定位被拒绝。iPhone：设置 → 隐私与安全性 → 定位服务 → Safari 网站，改成「使用 App 期间」。也可以用地图中心查附近。'
      : '暂时拿不到位置。可以用地图中心查附近。';
  };
  navigator.geolocation.getCurrentPosition(ok, e => fail(e, false), { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
}

// ---------- 状态页 ----------
function stateText(v) {
  return {
    ok: ['ok', `实时 ✓ ${v.count} 条`], stale: ['warn', `实时数据过期：${v.error}`], error: ['err', `实时不可用：${v.error}`],
    no_key: ['warn', '实时需要 API key'], disabled: ['', '已停用'], idle: ['', '等待首次请求'],
  }[v.state] || ['', v.state];
}
const linkify = s => esc(s).replace(/(https?:\/\/\S+)/g, '<a href="$1" target="_blank" rel="noopener">申请页面</a>');

async function loadStatus() {
  const r = await api('/api/status');
  agencies = r.agencies;
  $('#agencies').innerHTML = agencies.map(a => {
    const [cls, txt] = stateText(a.vehicles);
    const s = a.static;
    const stTxt = s.state === 'ready' ? `站点 ${s.stops}` : s.state === 'loading' ? '时刻表下载中…' : s.state === 'error' ? `时刻表失败：${esc(s.error)}` : '';
    return `<label class="ag"><input type="checkbox" data-id="${a.id}" ${enabled.has(a.id) ? 'checked' : ''}>
      <span class="dot" style="background:${a.color}"></span>
      <span><span class="name">${esc(a.name)}</span><br><span class="st ${cls}">${esc(txt)}</span> <span class="st">· ${stTxt}</span>
      ${a.note ? `<div class="note">${linkify(a.note)}</div>` : ''}</span></label>`;
  }).join('');
  $('#agencies').querySelectorAll('input').forEach(cb => cb.onchange = () => {
    cb.checked ? enabled.add(cb.dataset.id) : enabled.delete(cb.dataset.id);
    ls.set('enabledAgencies', [...enabled]);
    loadVehicles().catch(() => {}); loadStops().catch(() => {});
  });
  const go = agencies.find(a => a.id === 'go');
  $('#goExtra').hidden = !(go && go.vehicles.state !== 'no_key' && enabled.has('go'));
}

async function loadGoExtra() {
  if ($('#goExtra').hidden) return;
  const [u, al] = await Promise.all([api('/api/go/union'), api('/api/go/alerts')]);
  $('#goUnion').innerHTML = u.departures ? `<table>${u.departures.slice(0, 10).map(d =>
    `<tr><td>${d.time ? fmtClock(d.time) : ''}</td><td>${esc(d.service)}</td><td>站台 ${esc(d.platform || '-')}</td><td class="code">${esc(d.info || '')}</td></tr>`).join('')}</table>`
    : `<div class="empty">${esc(u.error || '')}</div>`;
  $('#goAlerts').innerHTML = (al.alerts || []).slice(0, 5).map(a => `<div class="alert"><b>${esc(a.subject)}</b><br>${esc(a.body).slice(0, 300)}</div>`).join('') || '<div class="empty">暂无公告</div>';
}

// ---------- 刷新循环 ----------
let retryTimer;
async function tick() {
  if (document.hidden) return; // 后台不轮询：省流量，也让云端能休眠
  clearTimeout(retryTimer);
  const rs = await Promise.allSettled([loadVehicles(), loadArrivals(), loadFavArrivals(), refreshNear()]);
  const down = rs[0].status === 'rejected' && rs[0].reason instanceof TypeError;
  $('#banner').hidden = !down;
  if (down) { $('#banner').textContent = '服务唤醒中或网络断开，约 1 分钟内自动恢复…'; retryTimer = setTimeout(tick, 5000); return; }
  loadStatus().catch(() => {});
  loadGoExtra().catch(() => {});
}

(async () => {
  setDrawer('half');
  showTab(ls.get('tab', favs.length ? 'favs' : 'near'));
  renderFavs();
  try { await loadStatus(); } catch (e) { if (e instanceof TypeError) { $('#banner').hidden = false; $('#banner').textContent = '服务唤醒中，约 1 分钟…'; } }
  renderFavs();
  fetch('/api/status', { method: 'HEAD' }).then(() => {}).catch(() => {});
  $('#logout').hidden = false;
  tick();
  loadStops().catch(() => {});
  // 从通知点进来：/?stop=agency:id
  const sp = new URLSearchParams(location.search).get('stop');
  if (sp && sp.includes(':')) {
    const [ag, id] = [sp.slice(0, sp.indexOf(':')), sp.slice(sp.indexOf(':') + 1)];
    api(`/api/stops/search?q=${encodeURIComponent(id)}&agencies=${ag}&limit=5`).then(l => {
      const s = l.find(x => x.id === id) || l[0];
      if (s) selectStop(s);
      history.replaceState(null, '', '/');
    }).catch(() => {});
  }
  setInterval(tick, REFRESH_MS);
})();
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
addEventListener('resize', () => { map.invalidateSize(); setDrawer(drawerState); });
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
