// 路线规划（Transitous）+ 换乘衔接 + Google 地图兜底。依赖 app.js 的全局：$, esc, api, map, showTab, setDrawer, isMobile, fmtClock, agColor, enabled
const planLayer = L.layerGroup().addTo(map);
const plan = { from: null, to: null, results: null, active: -1 };

function decodePolyline(str, precision = 6) {
  const f = 10 ** precision, pts = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lng += d;
    }
    pts.push([lat / f, lng / f]);
  }
  return pts;
}

const MODE_ZH = { WALK: '步行', BUS: '公交', SUBWAY: '地铁', TRAM: '有轨电车', RAIL: '火车', REGIONAL_RAIL: '火车', COACH: '大巴', FERRY: '轮渡' };
const fmtDur = s => { const m = Math.round(s / 60); return m < 60 ? `${m} 分` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`; };
const lineChip = l => `<span class="line" style="background:${l.routeColor || agColor(l.agency) || '#555'};color:${l.textColor || '#fff'}">${esc(l.routeShort || MODE_ZH[l.mode] || l.mode)}</span>`;

// ---------- 起终点输入 ----------
function setPlace(which, place) {
  plan[which] = place;
  $(which === 'from' ? '#planFrom' : '#planTo').value = place ? place.label : '';
  $(which === 'from' ? '#sugFrom' : '#sugTo').innerHTML = '';
}

function myPosition() {
  return new Promise((ok, fail) => {
    if (!navigator.geolocation || !window.isSecureContext) return fail(new Error('需要 HTTPS 才能定位'));
    navigator.geolocation.getCurrentPosition(p => ok([p.coords.latitude, p.coords.longitude]), fail, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  });
}

function bindPlaceInput(which) {
  const input = $(which === 'from' ? '#planFrom' : '#planTo');
  const ul = $(which === 'from' ? '#sugFrom' : '#sugTo');
  let timer, items = [];
  const fixed = () => [
    { label: '📍 我的位置', special: 'me' },
    { label: '🗺 地图中心', special: 'center' },
  ];
  const render = () => {
    ul.innerHTML = items.map((x, i) => `<li data-i="${i}">${esc(x.label)}${x.sub ? ` <span class="code">${esc(x.sub)}</span>` : ''}</li>`).join('');
  };
  input.addEventListener('focus', () => { if (!input.value) { items = fixed(); render(); } });
  input.addEventListener('input', () => {
    plan[which] = null;
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { items = fixed(); render(); return; }
    timer = setTimeout(async () => {
      const [geo, stops] = await Promise.all([
        api(`/api/geocode?q=${encodeURIComponent(q)}`).catch(() => []),
        api(`/api/stops/search?q=${encodeURIComponent(q)}&limit=4&agencies=${[...enabled].join(',')}`).catch(() => []),
      ]);
      items = [
        ...stops.map(s => ({ label: s.name, sub: `${agencies.find(a => a.id === s.agency)?.name || s.agency} #${s.code || s.id}`, lat: s.lat, lon: s.lon })),
        ...(Array.isArray(geo) ? geo : []).map(g => ({ label: g.name, sub: g.area, lat: g.lat, lon: g.lon })),
      ];
      if (!items.length) items = [{ label: '没找到，换个说法试试', special: 'none' }];
      render();
    }, 350);
  });
  ul.addEventListener('click', async e => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    const x = items[+li.dataset.i];
    if (x.special === 'none') return;
    if (x.special === 'center') { const c = map.getCenter(); return setPlace(which, { label: '地图中心', lat: c.lat, lon: c.lng }); }
    if (x.special === 'me') {
      input.value = '定位中…';
      try { const [lat, lon] = await myPosition(); setPlace(which, { label: '我的位置', lat, lon }); }
      catch (err) { input.value = ''; ul.innerHTML = `<li>${esc(err.message || '拿不到位置，可以用地图中心')}</li>`; }
      return;
    }
    setPlace(which, { label: x.label, lat: x.lat, lon: x.lon });
  });
  input.addEventListener('blur', () => setTimeout(() => { ul.innerHTML = ''; }, 200));
}
bindPlaceInput('from');
bindPlaceInput('to');

$('#planSwap').onclick = () => { const f = plan.from, t = plan.to; setPlace('from', t); setPlace('to', f); };
$('#planWhen').onchange = () => {
  const show = $('#planWhen').value !== 'now';
  $('#planTime').hidden = !show;
  if (show && !$('#planTime').value) {
    const d = new Date(Date.now() + 15 * 60000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    $('#planTime').value = d.toISOString().slice(0, 16);
  }
};

// 从到站页一键设起终点
function planFromStop(s, which) {
  setPlace(which, { label: s.name, lat: s.lat, lon: s.lon });
  showTab('plan');
}

function googleUrl() {
  const p = x => `${x.lat},${x.lon}`;
  return `https://www.google.com/maps/dir/?api=1&origin=${p(plan.from)}&destination=${p(plan.to)}&travelmode=transit`;
}

// ---------- 规划 ----------
$('#planGo').onclick = runPlan;
async function runPlan() {
  if (!plan.from || !plan.to) { $('#planResults').innerHTML = '<div class="empty">请先从下拉列表里选好起点和终点。</div>'; return; }
  const when = $('#planWhen').value;
  let qs = `from=${plan.from.lat.toFixed(5)},${plan.from.lon.toFixed(5)}&to=${plan.to.lat.toFixed(5)},${plan.to.lon.toFixed(5)}`;
  if (when !== 'now' && $('#planTime').value) qs += `&time=${Math.floor(new Date($('#planTime').value).getTime() / 1000)}${when === 'arrive' ? '&arriveBy=1' : ''}`;
  $('#planResults').innerHTML = '<div class="empty">规划中…</div>';
  planLayer.clearLayers();
  let r;
  try { r = await api(`/api/plan?${qs}`); }
  catch (e) { r = { fallback: 'google', reason: 'error' }; }
  if (r.error === 'rate_limited') r = { fallback: 'google', reason: 'rate' };
  plan.results = r;
  renderPlan();
}

function legTime(l, which) {
  const sched = which === 'start' ? l.start : l.end;
  const rt = l.rt?.[which];
  if (rt == null || Math.abs(rt - sched) < 60) return `<span class="t">${fmtClock(rt ?? sched)}</span>${l.rt ? ' <span class="rt">实时</span>' : ''}`;
  const d = Math.round((rt - sched) / 60);
  return `<span class="t">${fmtClock(rt)}</span> <span class="rt ${d > 0 ? 'late' : ''}">${d > 0 ? `晚 ${d} 分` : `早 ${-d} 分`}</span> <s class="code">${fmtClock(sched)}</s>`;
}

function connHtml(c) {
  const m = Math.round(Math.abs(c.bufferSec) / 60);
  const walk = Math.round(c.walkSec / 60);
  const txt = c.status === 'ok' ? `换乘来得及：步行 ${walk} 分，还余 ${m} 分`
    : c.status === 'tight' ? `换乘紧张：步行 ${walk} 分，只余 ${m} 分`
    : `可能赶不上：差 ${m} 分${c.next ? `，下一班 ${fmtClock(c.next.time)}` : ''}`;
  return `<div class="conn ${c.status}">${c.live ? '⚡ ' : ''}${esc(txt)}</div>`;
}

function renderPlan() {
  const r = plan.results;
  const g = plan.from && plan.to ? `<a class="gmaps" href="${googleUrl()}" target="_blank" rel="noopener">在 Google 地图里打开 ↗</a>` : '';
  if (!r || r.fallback) {
    const why = { quota: '今天的规划次数已用完', disabled: '路线规划未开启', empty: '没有找到方案', error: '规划服务暂时不可用', rate: '请求太频繁，稍等一下' }[r?.reason] || '';
    $('#planResults').innerHTML = `<div class="empty">${esc(why)}。可以改用 Google 地图。</div>${g}`;
    return;
  }
  $('#planResults').innerHTML = r.itineraries.map((it, i) => {
    const transit = it.legs.filter(l => l.transit);
    const chain = it.legs.filter(l => l.transit || l.duration > 180)
      .map(l => (l.transit ? lineChip(l) : `🚶${Math.round(l.duration / 60)}`)).join(' › ');
    const warn = it.connections.some(c => c.status === 'miss') ? ' ⚠️' : it.connections.some(c => c.status === 'tight') ? ' ⏱' : '';
    const legs = [];
    let ci = 0;
    it.legs.forEach((l, li) => {
      if (l.transit) {
        legs.push(`<div class="leg" style="border-color:${l.routeColor || '#999'}">${lineChip(l)} ${esc(l.headsign)}
          <div>${legTime(l, 'start')} 上车 · ${esc(l.from.name)}</div>
          <div class="code">${MODE_ZH[l.mode] || l.mode}${l.stops ? ` · 坐 ${l.stops + 1} 站` : ''} · ${fmtDur(l.duration)}</div>
          <div>${legTime(l, 'end')} 下车 · ${esc(l.to.name)}</div></div>`);
        const c = it.connections.find(x => x.fromLeg === li);
        if (c) legs.push(connHtml(c));
        ci++;
      } else if (l.duration > 60 && (li === 0 || li === it.legs.length - 1)) {
        legs.push(`<div class="leg code">🚶 步行 ${Math.round(l.duration / 60)} 分${l.distance ? `（${Math.round(l.distance)} 米）` : ''} → ${esc(l.to.name === 'END' ? '终点' : l.to.name)}</div>`);
      }
    });
    return `<div class="it-card ${plan.active === i ? 'on' : ''}" data-i="${i}">
      <div class="it-head"><span>${fmtClock(it.start)} → ${fmtClock(it.end)}${warn}</span><span class="dur">${fmtDur(it.duration)} · 换乘 ${Math.max(0, transit.length - 1)} 次</span></div>
      <div class="it-chain">${chain}</div><div class="it-legs">${legs.join('')}</div></div>`;
  }).join('') + g;
  if (plan.active < 0 && r.itineraries.length) drawItinerary(0);
}

$('#planResults').addEventListener('click', e => {
  const card = e.target.closest('.it-card');
  if (!card || e.target.closest('a')) return;
  drawItinerary(+card.dataset.i);
});

function drawItinerary(i) {
  plan.active = i;
  planLayer.clearLayers();
  const it = plan.results?.itineraries?.[i];
  if (!it) return;
  const all = [];
  for (const l of it.legs) {
    const pts = l.geometry ? decodePolyline(l.geometry, l.precision) : [[l.from.lat, l.from.lon], [l.to.lat, l.to.lon]];
    all.push(...pts);
    if (l.transit) {
      L.polyline(pts, { color: '#fff', weight: 8, opacity: 0.9, interactive: false }).addTo(planLayer);
      L.polyline(pts, { color: l.routeColor || '#0a66c2', weight: 5, interactive: false }).addTo(planLayer);
      L.circleMarker([l.from.lat, l.from.lon], { radius: 5, weight: 2, color: l.routeColor || '#0a66c2', fillColor: '#fff', fillOpacity: 1 })
        .bindTooltip(`${l.routeShort} 上车 · ${l.from.name}`).addTo(planLayer);
    } else {
      L.polyline(pts, { color: '#555', weight: 3, dashArray: '4 6', interactive: false }).addTo(planLayer);
    }
  }
  L.circleMarker([plan.from.lat, plan.from.lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#2e9e44', fillOpacity: 1 }).addTo(planLayer);
  L.circleMarker([plan.to.lat, plan.to.lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#d6302a', fillOpacity: 1 }).addTo(planLayer);
  if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [40, 40], paddingBottomRight: isMobile() ? [0, innerHeight * 0.45] : [0, 0], paddingTopLeft: isMobile() ? [0, 0] : [380, 0] });
  for (const c of document.querySelectorAll('.it-card')) c.classList.toggle('on', +c.dataset.i === i);
}

// 每 60 秒刷新当前方案的实时衔接（只在路线页可见时）
setInterval(() => {
  if (!document.hidden && plan.results?.itineraries && document.querySelector('#panes section.on')?.dataset.pane === 'plan') {
    const keep = plan.active;
    runPlan().then(() => { if (keep >= 0) drawItinerary(keep); });
  }
}, 60000);
