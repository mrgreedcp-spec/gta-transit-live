// GTA 公交实时 · 全屏实时地图
const REFRESH_MS = 20000;
const DOM_LIMIT = 250;          // 视野内车辆超过这个数，改用 canvas 小圆点
const BUS_ZOOM = 12;            // 「缩小时只显示火车」开启时，公交从这一级开始显示
const STOP_ZOOM = 15;           // 站点图层从这一级开始显示
const TWEEN_MS = REFRESH_MS;    // 车辆平滑移动：两次刷新之间线性补间
const DOM_STEP_MS = 50, CV_STEP_MS = 250; // 动画步长：DOM 车标 20 帧/秒，canvas 圆点 4 帧/秒
const MAX_TWEEN_M = 1500;       // 一次位移超过这个距离就直接跳过去（换班、数据跳变）
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
// 所有矢量图层共用一个 canvas：两个 canvas 叠放时只有上层能收到点击，会导致车辆圆点、站点点不中
// 触屏上放大命中范围：小圆点半径 5，加 12px 容差后手指更容易点中
const canvas = L.canvas({ padding: 0.3, tolerance: (isMobile() || matchMedia('(pointer: coarse)').matches) ? 12 : 0 });
const map = L.map('map', { zoomControl: false, preferCanvas: true, renderer: canvas }).setView(ls.get('view', [43.68, -79.52, 10]).slice(0, 2), ls.get('view', [0, 0, 10])[2]);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ position: 'bottomright', imperial: false }).addTo(map);
// 淡色底图：OSM 瓦片 + CSS 灰度（见 style.css .base-tiles）
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, className: 'base-tiles', attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);
const vehLayer = L.layerGroup().addTo(map);
const stopLayer = L.layerGroup().addTo(map);
const tripLayer = L.layerGroup().addTo(map); // 选中车辆的线路走向和剩余站点
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
let selected = null; // 选中的车辆 { key, v, trip, follow }
const enabledModes = new Set(ls.get('modes', ['rail', 'metro', 'bus']));
const modeGroup = v => v.mode === 'train' ? 'rail' : (v.mode === 'subway' || v.mode === 'tram') ? 'metro' : 'bus';
const vkey = v => `${v.agency}:${v.id}`;
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
  return lastVehicles.filter(v => (selected && vkey(v) === selected.key) || (enabled.has(v.agency)
    && enabledModes.has(modeGroup(v))
    && !hiddenRoutes.has(`${v.agency}:${v.routeShort}`)
    && (!busGate || z >= BUS_ZOOM || isRail(v))));
}

// ---------- 平滑移动 ----------
const motion = new Map(); // key -> { fLat, fLon, tLat, tLon, t0, dur, at }
let activeUntil = 0, settled = true, lastDom = 0, lastCv = 0, rafOn = false;
// 只在有车在补间时跑逐帧循环；车都停稳就停下，手机更省电
const kickAnim = () => { if (!rafOn) { rafOn = true; requestAnimationFrame(animateFrame); } };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

function posOf(key, v, now = performance.now()) {
  const e = motion.get(key);
  if (!e) return [v.lat, v.lon];
  const k = e.dur ? Math.min(1, Math.max(0, (now - e.t0) / e.dur)) : 1;
  return [e.fLat + (e.tLat - e.fLat) * k, e.fLon + (e.tLon - e.fLon) * k];
}

function updateMotion(vehicles) {
  const now = performance.now();
  const seen = new Set();
  for (const v of vehicles) {
    const key = vkey(v);
    seen.add(key);
    const e = motion.get(key);
    if (!e) { motion.set(key, { fLat: v.lat, fLon: v.lon, tLat: v.lat, tLon: v.lon, t0: now, dur: 0, at: now }); continue; }
    if (e.tLat === v.lat && e.tLon === v.lon) { e.at = now; continue; }
    const [cl, co] = posOf(key, v, now);
    const dist = Math.hypot(cl - v.lat, (co - v.lon) * Math.cos(v.lat * Math.PI / 180)) * 111000;
    const jump = dist > MAX_TWEEN_M || now - e.at > 2 * REFRESH_MS || reducedMotion.matches;
    motion.set(key, { fLat: jump ? v.lat : cl, fLon: jump ? v.lon : co, tLat: v.lat, tLon: v.lon, t0: now, dur: jump ? 0 : TWEEN_MS, at: now });
    if (!jump) { activeUntil = Math.max(activeUntil, now + TWEEN_MS); settled = false; }
  }
  for (const k of motion.keys()) if (!seen.has(k)) motion.delete(k);
  if (!settled) kickAnim();
}

function animateFrame(now) {
  if (map._animatingZoom) { requestAnimationFrame(animateFrame); return; }
  const live = now <= activeUntil;
  if (!live && settled) { rafOn = false; return; }
  requestAnimationFrame(animateFrame);
  const domStep = !live || now - lastDom >= DOM_STEP_MS, cvStep = !live || now - lastCv >= CV_STEP_MS;
  if (!domStep && !cvStep) return;
  if (domStep) lastDom = now;
  if (cvStep) lastCv = now;
  for (const [key, rec] of markers) {
    if (rec.kind === 'cv' ? !cvStep : !domStep) continue;
    const e = motion.get(key);
    if (e?.dur) rec.m.setLatLng(posOf(key, rec.v, now));
  }
  settled = !live;
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

function tripHead(v, r) {
  const age = v.ts ? Math.max(0, Math.round(serverNow - v.ts)) : null;
  const extra = [];
  if (v.occupancy != null) extra.push(`满载 ${v.occupancy}%`);
  if (v.cars) extra.push(`${v.cars} 节车厢`);
  const head = r?.headsign || v.headsign || r?.routeLong || '';
  return `<div class="trip-head"><span class="line" style="background:${v.routeColor};color:${v.textColor}">${esc(v.routeShort ?? '?')}</span>
    <div class="tt"><b>${esc(head)}</b><br><span class="code">${esc(nameOf(v.agency))} · 车辆 ${esc(v.label || v.id)}</span><br>
    ${esc(delayText(r?.stops?.[0]?.delaySec ?? v.delaySec ?? r?.delaySec ?? null))}${extra.length ? ' · ' + esc(extra.join(' · ')) : ''}
    <span class="code">${age != null ? ` · 位置 ${age} 秒前` : ''}</span></div></div>`;
}

function renderVehicles() {
  const bounds = map.getBounds().pad(0.1);
  const vis = visibleVehicles().filter(v => bounds.contains([v.lat, v.lon]));
  const useDom = vis.length <= DOM_LIMIT;
  const seen = new Set();
  for (const v of vis) {
    const key = vkey(v);
    seen.add(key);
    const dc = delayClass(v.delaySec);
    const sel = selected?.key === key;
    const dom = useDom || v.agency === 'go' || sel;
    const b = dom ? bearingOf(v, key) : null;
    const sig = dom ? `${v.routeShort}|${v.routeColor}|${dc}|${b == null ? '' : Math.round(b / 10)}|${v.mode}|${sel}` : `${v.routeColor}|${dc}`;
    const pos = posOf(key, v);
    let rec = markers.get(key);
    if (rec && rec.kind !== (dom ? 'dom' : 'cv')) { vehLayer.removeLayer(rec.m); rec = null; }
    if (!rec) {
      const m = dom
        ? L.marker(pos, { icon: vehIcon(v, dc, b, sel), keyboard: false, zIndexOffset: sel ? 1000 : 0 })
        : L.circleMarker(pos, { renderer: canvas, radius: 5, weight: 2, color: delayColor[dc], fillColor: v.routeColor, fillOpacity: 1 });
      m.addTo(vehLayer);
      rec = { m, kind: dom ? 'dom' : 'cv', sig, v };
      m.on('click', () => selectVehicle(rec.v));
      markers.set(key, rec);
    } else {
      rec.v = v;
      rec.m.setLatLng(pos); // 用当前插值位置，不把补间中的车拉到终点
      if (rec.sig !== sig) {
        if (dom) { rec.m.setIcon(vehIcon(v, dc, b, sel)); rec.m.setZIndexOffset(sel ? 1000 : 0); } else rec.m.setStyle({ color: delayColor[dc], fillColor: v.routeColor });
        rec.sig = sig;
      }
    }
  }
  for (const [k, rec] of markers) if (!seen.has(k)) { vehLayer.removeLayer(rec.m); markers.delete(k); }
  $('#vehCount').textContent = `视野内 ${vis.length} 辆，全部 ${lastVehicles.length} 辆`;
}

function vehIcon(v, dc, b, sel = false) {
  const label = esc(String(v.routeShort ?? '?').slice(0, 4));
  const arrow = b == null ? '' : `<i class="arrow" style="--b:${Math.round(b)}deg"></i>`;
  const sz = v.mode === 'train' ? 32 : 28;
  return L.divIcon({
    className: 'veh-wrap', iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2], popupAnchor: [0, -sz / 2],
    html: `<div class="veh ${dc} ${v.mode === 'train' ? 'train' : ''} ${sel ? 'sel' : ''}" style="background:${v.routeColor};color:${v.textColor}">${arrow}<span>${label}</span></div>`,
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
  updateMotion(r.vehicles);
  if (selected) { const nv = r.vehicles.find(v => vkey(v) === selected.key); if (nv) selected.v = nv; }
  renderVehicles();
  renderChips();
  if (selected?.follow) followPan();
}

// ---------- 点车：线路走向 + 剩余站点 + 跟随 ----------
function selectVehicle(v) {
  const key = vkey(v);
  showTab('veh');
  if (selected?.key === key) return;
  selected = { key, v, trip: null, follow: false };
  tripLayer.clearLayers();
  $('#tripPane').innerHTML = `${tripHead(v)}<div class="empty">行程加载中…</div>`;
  renderVehicles();
  setFollow(true);
  loadTrip().catch(() => {});
  syncBack();
}

function clearVehicle() {
  selected = null;
  tripLayer.clearLayers();
  $('#tripPane').innerHTML = '<div class="hint">在地图上点一辆车，查看线路走向和剩余站点。</div>';
  renderVehicles();
  syncBack();
}

async function loadTrip() {
  if (!selected) return;
  const sel = selected, v = sel.v;
  const r = await api(`/api/trip/${v.agency}/${encodeURIComponent(v.tripId || '-')}?veh=${encodeURIComponent(v.id)}&route=${encodeURIComponent(v.routeId || v.routeShort || '')}`);
  if (selected !== sel) return;
  sel.trip = r;
  renderTrip(r);
  drawTrip(r);
}

function renderTrip(r) {
  const v = selected.v;
  const rows = r.stops.map((s, i) => {
    const min = Math.round((s.time - r.now) / 60);
    const d = s.delaySec;
    const dl = d == null || Math.abs(d) < 60 ? '' : d > 0 ? `<span class="late">晚 ${Math.round(d / 60)} 分</span>` : `<span class="early">早 ${Math.round(-d / 60)} 分</span>`;
    const sch = s.sched && Math.abs(s.sched - s.time) >= 60 ? `<s>${fmtClock(s.sched)}</s>` : '';
    return `<li class="${i === 0 ? 'first' : ''} ${s.skipped ? 'skip' : ''}" data-i="${i}"><span class="tm">${fmtClock(s.time)}${sch}</span>
      <span>${esc(s.name || s.id || '?')} ${dl}</span><span class="mn">${s.skipped ? '跳站' : min <= 0 ? '即到' : min + ' 分'}</span></li>`;
  }).join('');
  $('#tripPane').innerHTML = `${tripHead(v, r)}
    <div class="trip-ops"><button type="button" data-follow class="${selected.follow ? 'on' : ''}">${selected.follow ? '跟随中' : '跟随'}</button><button type="button" data-close>关闭</button></div>
    ${r.passedCount ? `<div class="hint">已过 ${r.passedCount} 站，剩余 ${r.stops.length} 站</div>` : ''}
    ${rows ? `<ul class="trip-stops" style="--line:${v.routeColor}">${rows}</ul>` : `<div class="empty">${esc(r.note || '这趟车暂时没有逐站数据。')}</div>`}`;
}

function drawTrip(r) {
  tripLayer.clearLayers();
  const color = selected.v.routeColor;
  for (const s of r.shapes) {
    const pts = decodePolyline(s, 5);
    // 线画在车辆圆点下面
    L.polyline(pts, { color, weight: 5, opacity: 0.95, interactive: false }).addTo(tripLayer).bringToBack();
    L.polyline(pts, { color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(tripLayer).bringToBack();
  }
  for (const s of r.stops) {
    if (s.lat == null) continue;
    L.circleMarker([s.lat, s.lon], { radius: 4, weight: 2, color, fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip(`${fmtClock(s.time)} ${s.name || ''}`, { direction: 'top' }).addTo(tripLayer);
  }
}

$('#tripPane').addEventListener('click', e => {
  if (!selected) return;
  if (e.target.closest('[data-follow]')) return setFollow(!selected.follow);
  if (e.target.closest('[data-close]')) return clearVehicle();
  const li = e.target.closest('li[data-i]');
  const s = li && selected.trip?.stops[+li.dataset.i];
  if (s?.id && s.lat != null) selectStop({ agency: selected.v.agency, id: s.id, code: s.code, name: s.name, lat: s.lat, lon: s.lon });
});

// 让车停在可见区域中央：手机避开底部抽屉，桌面避开左侧面板
function followCenter(lat, lon, z) {
  const p = map.project([lat, lon], z);
  const r = $('#drawer').getBoundingClientRect();
  const off = isMobile() ? L.point(0, drawerPx / 2) : L.point(-(r.right) / 2, 0); // 手机用目标高度，抽屉过渡中也算得对
  return map.unproject(p.add(off), z);
}

function followPan() {
  if (!selected?.follow) return;
  const e = motion.get(selected.key);
  const now = performance.now();
  const [la, lo] = e ? [e.tLat, e.tLon] : [selected.v.lat, selected.v.lon];
  const remain = e?.dur ? Math.max(0, e.t0 + e.dur - now) / 1000 : 0;
  map.panTo(followCenter(la, lo, map.getZoom()), { animate: true, duration: Math.max(0.3, remain), easeLinearity: remain > 0.3 ? 1 : 0.25 });
}

function setFollow(on) {
  if (!selected) return;
  selected.follow = on;
  const b = $('#tripPane [data-follow]');
  if (b) { b.classList.toggle('on', on); b.textContent = on ? '跟随中' : '跟随'; }
  if (!on) return;
  const z = Math.max(map.getZoom(), 14);
  const [la, lo] = posOf(selected.key, selected.v);
  map.setView(followCenter(la, lo, z), z, { animate: false });
  followPan();
}
map.on('dragstart', () => { if (selected?.follow) setFollow(false); }); // 用户拖地图就退出跟随
map.on('zoomend', () => { if (selected?.follow) followPan(); });

// 手机：用户手指拖地图超过 24px 就把抽屉收到最低（程序平移、缩放不触发 dragstart，不受影响）
const TEXT_IN = '#drawer input:not([type]), #drawer input[type=text], #drawer input[type=search]';
let dragC0 = null;
map.on('dragstart', () => { dragC0 = isMobile() && drawerState !== 'min' ? map.getCenter() : null; });
map.on('drag', () => {
  if (!dragC0 || map.latLngToContainerPoint(dragC0).distanceTo(map.getSize().divideBy(2)) < 24) return;
  dragC0 = null;
  if (!document.activeElement?.matches?.(TEXT_IN)) setDrawer('min');
});

// ---------- 筛选面板 ----------
$('#filterBtn').onclick = () => {
  const p = $('#filterPanel');
  p.hidden = !p.hidden;
  $('#filterBtn').innerHTML = p.hidden ? '筛选 <b>+</b>' : '筛选 <b>−</b>';
  if (!p.hidden) renderChips();
  document.body.classList.toggle('filter-open', !p.hidden);
  if (!p.hidden && isMobile()) setDrawer('min'); // 手机上让出空间给筛选面板
  syncBack();
};
$('#busGate').checked = busGate;
$('#showStops').checked = showStops;
$('#busGate').onchange = e => { busGate = e.target.checked; ls.set('busGate', busGate); renderVehicles(); };
$('#showStops').onchange = e => { showStops = e.target.checked; ls.set('showStops', showStops); loadStops(); };
for (const [id, m] of [['modeRail', 'rail'], ['modeMetro', 'metro'], ['modeBus', 'bus']]) {
  $('#' + id).checked = enabledModes.has(m);
  $('#' + id).onchange = e => { e.target.checked ? enabledModes.add(m) : enabledModes.delete(m); ls.set('modes', [...enabledModes]); renderVehicles(); };
}

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
  // 跟随时地图一直在平移，不额外拉车辆（每 20 秒的刷新足够）
  stopTimer = setTimeout(() => { loadStops().catch(() => {}); renderVehicles(); if (map.getZoom() >= 12 && !selected?.follow) loadVehicles().catch(() => {}); }, 300);
});
map.on('zoomend', renderVehicles);

// ---------- 抽屉与标签 ----------
// min 按实际高度算：把手 + 标签栏 + 底部安全区
const DRAWER = {
  min: () => $('#handle').offsetHeight + $('#tabs').offsetHeight + (parseFloat(getComputedStyle($('#drawer')).paddingBottom) || 0),
  half: () => innerHeight * 0.45, full: () => innerHeight * 0.88,
};
let drawerState = 'half', drawerPx = 0;
function setDrawer(state) {
  drawerState = state;
  drawerPx = state === 'min' ? DRAWER.min() : state === 'half' ? DRAWER.half() : DRAWER.full();
  document.documentElement.style.setProperty('--drawer-h', drawerPx + 'px');
}
function showTab(name) {
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const s of document.querySelectorAll('#panes section')) s.classList.toggle('on', s.dataset.pane === name);
  ls.set('tab', name);
  if (name !== 'stop' && name !== 'veh') returnTab = name;
  if (isMobile() && drawerState === 'min') setDrawer('half');
  if (name !== 'veh' && selected?.follow) setFollow(false); // 去看站点、规划路线时不抢地图
}
$('#tabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); };
$('#handle').onclick = () => setDrawer(drawerState === 'min' ? 'half' : drawerState === 'half' ? 'full' : 'min');
// 拖动把手
(() => {
  let startY, startH, moved;
  $('#handle').addEventListener('pointerdown', e => { startY = e.clientY; startH = $('#drawer').getBoundingClientRect().height; moved = false; $('#drawer').classList.add('dragging'); e.target.setPointerCapture(e.pointerId); });
  $('#handle').addEventListener('pointermove', e => {
    if (startY == null) return;
    const h = Math.min(DRAWER.full(), Math.max(DRAWER.min(), startH + startY - e.clientY));
    if (Math.abs(startY - e.clientY) > 5) moved = true;
    document.documentElement.style.setProperty('--drawer-h', h + 'px');
  });
  const end = () => {
    $('#drawer').classList.remove('dragging');
    if (startY == null) return;
    const h = $('#drawer').getBoundingClientRect().height;
    startY = null;
    if (!moved) return;
    const opts = [['min', DRAWER.min()], ['half', DRAWER.half()], ['full', DRAWER.full()]];
    setDrawer(opts.sort((a, b) => Math.abs(a[1] - h) - Math.abs(b[1] - h))[0][0]);
    $('#handle').onclick = null; setTimeout(() => { $('#handle').onclick = () => setDrawer(drawerState === 'min' ? 'half' : drawerState === 'half' ? 'full' : 'min'); }, 0);
  };
  $('#handle').addEventListener('pointerup', end);
  $('#handle').addEventListener('pointercancel', end); // 被系统手势打断时也要收尾
})();

// 手机键盘：抽屉里的输入框聚焦时展开到最高，失焦后恢复
let kbPrev = null, kbTimer;
$('#drawer').addEventListener('focusin', e => {
  if (!isMobile() || !e.target.matches(TEXT_IN)) return;
  clearTimeout(kbTimer);
  if (kbPrev == null) kbPrev = drawerState;
  if (drawerState !== 'full') setDrawer('full');
  $('#panes').scrollTop = 0;
  setTimeout(() => { scrollTo(0, 0); syncKb(); fitPlanTo(); }, 350); // iOS 可能已把页面上推
});
// 小屏：终点框下面放不下候选列表时，把终点这一行滚到面板顶部（不用 scrollIntoView，它会带动整页）
function fitPlanTo() {
  const panes = $('#panes'), row = document.activeElement?.id === 'planTo' && $('#planTo').closest('.pf-row');
  if (!row || !isMobile() || panes.clientHeight >= 300) return;
  panes.scrollTop += row.getBoundingClientRect().top - panes.getBoundingClientRect().top - 4;
}
$('#drawer').addEventListener('transitionend', e => { if (e.target === e.currentTarget && e.propertyName === 'height') fitPlanTo(); }); // 键盘弹出后抽屉变矮，过渡结束再对齐
$('#drawer').addEventListener('focusout', () => {
  if (kbPrev == null) return;
  kbTimer = setTimeout(() => {
    syncKb();
    if (document.activeElement?.matches?.(TEXT_IN)) return;
    if (drawerState === 'full' && kbPrev !== 'full') setDrawer(kbPrev);
    kbPrev = null;
  }, 300);
});
// 软键盘：iOS Safari 和新版 Android Chrome 弹键盘只缩 visualViewport，fixed 抽屉的下半截会被键盘盖住。
// 算出被挡的底部高度写进 --kb，CSS 用它把抽屉抬到键盘上方；--vvh 限制抽屉和候选列表的高度。
function syncKb() {
  const vv = window.visualViewport, st = document.documentElement.style;
  // 只管抽屉里的输入框：顶部站点搜索弹键盘时抽屉不动，否则会盖住顶部的搜索结果
  const inDrawer = !!document.activeElement?.closest?.('#drawer');
  const occ = !vv || vv.scale > 1.01 || !inDrawer ? 0 : innerHeight - (vv.offsetTop + vv.height);
  if (occ > 120) {
    st.setProperty('--kb', Math.round(occ) + 'px'); st.setProperty('--vvh', Math.round(vv.height) + 'px');
  }
  else { st.removeProperty('--kb'); st.removeProperty('--vvh'); }
}
if (window.visualViewport) { visualViewport.addEventListener('resize', syncKb); visualViewport.addEventListener('scroll', syncKb); }
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
  syncBack();
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
const saveFavs = () => {
  ls.set('favStops', favs); window.syncDigestStops?.();
  if (window.account) pushFavsSoon();
  else if (ls.get('favsUid', null) !== null) { favsEdits++; ls.set('favsDirty', true); }   // 账号还没就绪（离线、冷启动）：先记待上传，就绪后 pullFavs 会传
};

// ---------- 收藏跟账号同步（账号模式） ----------
// 本浏览器第一次登录账号（本地收藏还没归属任何账号）：服务器和本地取并集；本地收藏属于别的账号：直接用服务器的，不上传别人的收藏。
// 之后没有待上传的改动时以服务器为准。改动 1.5 秒后上传，带版本号，冲突时并集后重试一次。
const unionFavs = (a, b) => { const seen = new Set(a.map(favKey)); return [...a, ...b.filter(f => !seen.has(favKey(f)))]; };
let favsTimer = null, favsPulled = 0, favsEdits = 0;   // favsEdits：本页的改动计数，上传返回时用来判断期间有没有新改动
function pushFavsSoon() { favsEdits++; ls.set('favsDirty', true); clearTimeout(favsTimer); favsTimer = setTimeout(() => pushFavs().catch(() => {}), 1500); }
async function pushFavs(retry = true) {
  const ed = favsEdits;
  const r = await fetch('/api/favs', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ favs, base: ls.get('favsRev', 0) }) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 409 && retry && Array.isArray(j.favs)) { favs = unionFavs(j.favs, favs); ls.set('favStops', favs); ls.set('favsRev', j.rev); renderFavs(); return pushFavs(false); }
  if (!r.ok) return;   // 留着 favsDirty，下次打开或回到前台再传
  ls.set('favsRev', j.rev);
  if (favsEdits === ed) ls.set('favsDirty', false);   // 上传期间又改过：保持待上传，等计时器再传
}
async function pullFavs() {
  if (!window.account || Date.now() - favsPulled < 60000) return;
  favsPulled = Date.now();
  const r = await fetch('/api/favs', { headers: { accept: 'application/json' } }).catch(() => null);
  if (!r?.ok) { favsPulled = 0; return; }   // 没拿到：下次回到前台再试
  const { favs: srv, rev } = await r.json();
  const owner = ls.get('favsUid', null);
  if (owner !== null && owner !== account.id) {   // 本地是别的账号留下的：换成这个账号的，丢掉别人的待上传改动
    ls.set('favsUid', account.id); ls.set('favsRev', rev); ls.set('favsDirty', false);
    favs = srv; ls.set('favStops', favs); renderFavs(); loadFavArrivals().catch(() => {});
  } else if (owner === null) {   // 登录前的本地收藏：并进账号
    const merged = unionFavs(srv, favs);
    ls.set('favsUid', account.id); ls.set('favsRev', rev);
    favs = merged; ls.set('favStops', favs); renderFavs(); loadFavArrivals().catch(() => {});
    if (merged.length !== srv.length) { favsEdits++; ls.set('favsDirty', true); await pushFavs(); }   // 先记待上传：失败了下次再传
  } else if (ls.get('favsDirty', false)) {
    await pushFavs();
  } else if (rev !== ls.get('favsRev', 0)) {
    favs = srv; ls.set('favStops', favs); ls.set('favsRev', rev); renderFavs(); loadFavArrivals().catch(() => {});
  }
  window.syncDigestStops?.();
}
addEventListener('account-ready', () => pullFavs().catch(() => {}));
document.addEventListener('visibilitychange', () => { if (!document.hidden) pullFavs().catch(() => {}); });

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

// ---------- 账号（服务端开了 ACCOUNTS 才有；旧模式 /api/account/me 返回 404） ----------
window.account = null;
async function initAccount(wait = 2000) {
  const r = await fetch('/api/account/me', { headers: { accept: 'application/json' } }).catch(() => null);
  // 服务冷启动（503）或断网：稍后重试，不然这一页一直当成旧模式，收藏改动不会同步
  if (!r || r.status === 503) { setTimeout(() => initAccount(Math.min(wait * 2, 30000)).catch(() => {}), wait); return; }
  if (r.status === 401) { location.href = '/login'; return; }
  if (!r.ok) return;   // 404 = 旧模式
  const user = (await r.json()).user;
  if (user.mustChange) { if ($('#mustPw')) $('#mustPw').hidden = false; else alert('管理员重置了你的密码，请刷新页面后设置新密码。'); return; }   // 管理员重置过密码：先改密码，其他功能不启用
  window.account = user;
  document.body.classList.add('acct-mode');
  $('#acctName').textContent = account.name;
  $('#acctBox').hidden = false;
  $('#logout').hidden = true;
  window.dispatchEvent(new Event('account-ready'));
  if (user.admin && $('#adminBox')) { $('#adminBox').hidden = false; loadAdmin().catch(() => {}); }
}
const acctLogout = async () => {
  try { await fetch('/api/account/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dev: localStorage.getItem('pushDev') }) }); } catch {}
  for (const k of ['favStops', 'favsUid', 'favsRev', 'favsDirty', 'pushDev']) localStorage.removeItem(k);
  location.href = '/login';
};
$('#acctLogout').onclick = acctLogout;
// 新增元素的绑定都判空：缓存里的旧 index.html 配新 app.js 时，不让整页脚本停掉
const on = (sel, prop, fn) => { const el = $(sel); if (el) el[prop] = fn; };
on('#mustLogout', 'onclick', acctLogout);
on('#mustForm', 'onsubmit', async e => {
  e.preventDefault();
  const msg = $('#mustMsg'); msg.textContent = '保存中…';
  const r = await fetch('/api/account/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ old: $('#mustOld').value, new: $('#mustNew').value }) }).catch(() => null);
  if (r?.ok) { location.reload(); return; }   // 重新载入：走正常的 account-ready，推送设备自动绑到新会话
  const j = await r?.json().catch(() => ({})) || {};
  msg.textContent = { bad_password: '临时密码不对。', weak_password: '新密码至少 8 位，不能和用户名、邀请码或临时密码相同。', rate_limited: '太频繁了，过几分钟再试。' }[j.error] || '没保存成功，请稍后再试。';
});
on('#nameForm', 'onsubmit', async e => {
  e.preventDefault();
  const msg = $('#nameMsg'); msg.textContent = '保存中…';
  const r = await fetch('/api/account/name', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: $('#nameNew').value, password: $('#namePw').value }) }).catch(() => null);
  const j = await r?.json().catch(() => ({})) || {};
  if (r?.ok) { account.name = j.user.name; $('#acctName').textContent = j.user.name; msg.textContent = '已改好，下次用新用户名登录。'; $('#nameForm').reset(); return; }
  msg.textContent = { bad_username: '用户名要 3–20 位小写字母、数字或下划线。', bad_password: '密码不对。', name_taken: '这个用户名不能用，换一个。',
    name_locked: '这个账号的用户名被系统配置使用，不能改。', weak_password: '密码不能和新用户名相同，先改密码。', same_name: '和现在的用户名一样。',
    rate_limited: '太频繁了，过几分钟再试。' }[j.error] || '没保存成功，请稍后再试。';
});
// 管理员：只在打开时和点「刷新」时取，不进轮询
async function loadAdmin() {
  const r = await fetch('/api/admin/accounts', { headers: { accept: 'application/json' } });
  if (!r.ok) return;
  const j = await r.json();
  $('#adminCount').textContent = `${j.count} / ${j.max}`;
  $('#adminList').innerHTML = j.users.map(u => `<div class="admin-row"><span><b>${esc(u.name)}</b>${u.self ? '（你）' : ''}${u.mustChange ? ' <span class="tag">待改密</span>' : ''}<br>
    <small>${esc(new Date(u.created).toLocaleDateString('zh-CN'))} 注册 · 会话 ${u.sessions} · 设备 ${u.devices}</small></span>
    ${u.self ? '' : `<button type="button" data-reset="${esc(u.id)}" data-name="${esc(u.name)}">重置密码</button>`}</div>`).join('');
}
on('#adminRefresh', 'onclick', () => { $('#adminMsg').textContent = ''; loadAdmin().catch(() => {}); });
on('#adminList', 'onclick', async e => {
  const b = e.target.closest('button[data-reset]');
  if (!b || !confirm(`重置 ${b.dataset.name} 的密码？对方的所有设备会立刻退出登录。`)) return;
  const msg = $('#adminMsg'); msg.textContent = '重置中…';
  const r = await fetch('/api/admin/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: b.dataset.reset }) }).catch(() => null);
  const j = await r?.json().catch(() => ({})) || {};
  if (!r?.ok) { msg.textContent = j.error === 'rate_limited' ? '太频繁了，过几分钟再试。' : '没重置成功。'; return; }
  msg.innerHTML = `${esc(j.name)} 的临时密码：<code id="adminTemp">${esc(j.tempPassword)}</code><br>只显示这一次，请私下发给对方；对方登录后要马上改密码。`;
  loadAdmin().catch(() => {});
});
$('#pwForm').onsubmit = async e => {
  e.preventDefault();
  const msg = $('#pwMsg'); msg.textContent = '保存中…';
  const r = await fetch('/api/account/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ old: $('#pwOld').value, new: $('#pwNew').value }) }).catch(() => null);
  const err = { bad_password: '原密码不对。', weak_password: '新密码至少 8 位，且不能和用户名或邀请码相同。', rate_limited: '太频繁了，过几分钟再试。' };
  if (r?.ok) { msg.textContent = '已改好。其他设备需要重新登录。'; $('#pwForm').reset(); return; }
  const j = await r?.json().catch(() => ({})) || {};
  msg.textContent = err[j.error] || '没保存成功，请稍后再试。';
};

async function loadStatus() {
  const r = await api('/api/status');
  for (const id of ['#fbBtn', '#fbLink']) { const b = $(id); if (b) b.hidden = !r.feedback; }   // 服务端没开反馈（或没持久存储）就不显示入口
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

// ---------- 意见反馈 ----------
// 用 function 声明（会提升）：下面 hasOverlay 在加载时就会调用 fbOpen
function fbOpen() { const m = $('#fbModal'); return !!m && !m.hidden; }
function openFeedback() {
  const m = $('#fbModal'); if (!m) return;
  m.hidden = false; $('#fbMsg').textContent = '';
  syncBack();
  if (!isMobile()) $('#fbText').focus();
}
function closeFeedback() {
  const m = $('#fbModal'); if (!m || m.hidden) return;
  m.hidden = true; document.activeElement?.blur?.();
  syncBack();
}
// 当前缓存的 App 版本（gta-shell-vNN 里最大的那个）
async function appVer() {
  try { return (await caches.keys()).map(k => /^gta-shell-(v\d+)$/.exec(k)?.[1]).filter(Boolean).sort((a, b) => +b.slice(1) - +a.slice(1))[0] || ''; }
  catch { return ''; }
}
on('#fbBtn', 'onclick', openFeedback);
on('#fbLink', 'onclick', openFeedback);
on('#fbClose', 'onclick', closeFeedback);
on('#fbModal', 'onclick', e => { if (e.target === e.currentTarget) closeFeedback(); });
addEventListener('keydown', e => { if (e.key === 'Escape' && fbOpen()) closeFeedback(); });
on('#fbForm', 'onsubmit', async e => {
  e.preventDefault();
  const msg = $('#fbMsg'), btn = $('#fbSend'), text = $('#fbText').value.trim();
  if (!text) { msg.textContent = '请先写点内容。'; return; }
  btn.disabled = true; msg.textContent = '提交中…';
  try {
    const ctx = { tab: document.querySelector('#tabs button.on')?.dataset.tab || '', ver: await appVer(),
      standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true, w: innerWidth };
    const r = await fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, contact: $('#fbContact').value.trim(), ctx }) }).catch(() => null);
    if (r?.status === 401) { location.href = '/login'; return; }
    if (r?.ok) { $('#fbForm').reset(); msg.textContent = '谢谢，已收到！'; return; }
    const j = await r?.json().catch(() => ({})) || {};
    msg.textContent = { rate_limited: '提交太频繁，过一会儿再试。', too_long: '内容太长，请删到 1000 字以内。' }[j.error] || '没提交成功，请稍后再试。';
  } finally { btn.disabled = false; }
});

// ---------- 手机返回键：先关面板，再退出 ----------
// 历史里最多一条占位记录；用界面按钮关完所有面板时把它退掉
let backArmed = !!history.state?.overlay, skipPop = 0, returnTab = 'near';
const hasOverlay = () => isMobile() && (fbOpen() || !$('#filterPanel').hidden || !!selected || !!selectedStop);
function syncBack() {
  const want = hasOverlay();
  if (want && !backArmed) { history.pushState({ overlay: 1 }, ''); backArmed = true; }
  else if (!want && backArmed) { backArmed = false; skipPop++; history.back(); }
}
function clearStop() {
  selectedStop = null;
  if (stopPin) { map.removeLayer(stopPin); stopPin = null; }
  $('#remindForm').innerHTML = '';
  $('#arrivals').innerHTML = '<div class="hint">在地图上点站点，或搜索站点。</div>';
  syncBack();
}
function closeTop() {
  if (fbOpen()) return closeFeedback();
  if (!$('#filterPanel').hidden) return $('#filterBtn').click();
  const tab = document.querySelector('#tabs button.on')?.dataset.tab, st = drawerState;
  if (selectedStop && (tab === 'stop' || !selected)) { clearStop(); showTab(selected ? 'veh' : returnTab); }
  else if (selected) { clearVehicle(); showTab(selectedStop ? 'stop' : returnTab); }
  setDrawer(st); // showTab 会把 min 升到 half，这里还原
}
addEventListener('popstate', () => {
  if (skipPop) { skipPop--; return; }
  if (!backArmed) return;
  backArmed = false;
  closeTop(); // 还有下一层时，里面的 syncBack 会重新占位
});
syncBack(); // 刷新后如果停在占位记录上，把它退掉

// ---------- 刷新循环 ----------
let retryTimer;
async function tick() {
  if (document.hidden) return; // 后台不轮询：省流量，也让云端能休眠
  clearTimeout(retryTimer);
  const rs = await Promise.allSettled([loadVehicles(), loadArrivals(), loadFavArrivals(), refreshNear(), loadTrip()]);
  const down = rs[0].status === 'rejected' && rs[0].reason instanceof TypeError;
  $('#banner').hidden = !down;
  if (down) { $('#banner').textContent = '服务唤醒中或网络断开，约 1 分钟内自动恢复…'; retryTimer = setTimeout(tick, 5000); return; }
  loadStatus().catch(() => {});
  loadGoExtra().catch(() => {});
}

(async () => {
  setDrawer('half');
  showTab(ls.get('tab', favs.length ? 'favs' : 'near') === 'veh' ? (favs.length ? 'favs' : 'near') : ls.get('tab', favs.length ? 'favs' : 'near'));
  renderFavs();
  try { await loadStatus(); } catch (e) { if (e instanceof TypeError) { $('#banner').hidden = false; $('#banner').textContent = '服务唤醒中，约 1 分钟…'; } }
  renderFavs();
  fetch('/api/status', { method: 'HEAD' }).then(() => {}).catch(() => {});
  $('#logout').hidden = false;
  initAccount().catch(() => {});
  tick();
  loadStops().catch(() => {});
  // 从通知点进来：/?tab=favs（每日收藏摘要）或 /?stop=agency:id
  if (new URLSearchParams(location.search).get('tab') === 'favs') { showTab('favs'); history.replaceState(history.state, '', '/'); }
  const sp = new URLSearchParams(location.search).get('stop');
  if (sp && sp.includes(':')) {
    const [ag, id] = [sp.slice(0, sp.indexOf(':')), sp.slice(sp.indexOf(':') + 1)];
    api(`/api/stops/search?q=${encodeURIComponent(id)}&agencies=${ag}&limit=5`).then(l => {
      const s = l.find(x => x.id === id) || l[0];
      history.replaceState(history.state, '', '/'); // 先清 URL，再选站（选站会占一条返回记录）
      if (s) selectStop(s);
    }).catch(() => {});
  }
  setInterval(tick, REFRESH_MS);
})();
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
addEventListener('resize', () => { map.invalidateSize(); setDrawer(drawerState); });
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
