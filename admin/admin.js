// 增长仪表盘：打开时和点「刷新」时各取一次 /api/admin/growth，不轮询。所有文字用 textContent 写入。
const $ = s => document.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); parent?.appendChild(e); return e; };
const el = (tag, text, parent, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; parent?.appendChild(e); return e; };
const md = d => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

// 纵轴：4 格，每格是 1/2/5 × 10^k 的整数（人数不出现小数刻度）
function niceMax(v) { const raw = Math.max(1, Math.ceil(v / 4)), p = 10 ** Math.floor(Math.log10(raw)); for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p * 4; return raw * 4; }

// 单系列图：kind = 'bar' | 'line'。points = [{ date, n }]。悬停（含触屏点按）显示日期和数值
function chart(box, points, kind, unit) {
  box.textContent = '';
  const W = Math.max(280, Math.round(box.clientWidth || 640)), H = 200, L = 30, R = 8, T = 10, B = 22;   // 按实际宽度画：手机上字不会被缩小
  const max = niceMax(Math.max(0, ...points.map(p => p.n || 0)));
  const iw = W - L - R, ih = H - T - B, step = iw / points.length;
  const x = i => L + step * i + step / 2, y = v => T + ih - (v / max) * ih;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${unit}，近 ${points.length} 天` }, box);
  const grid = svgEl('g', { class: 'grid' }, svg);
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    svgEl('line', { x1: L, x2: W - R, y1: yy, y2: yy }, grid);
    svgEl('text', { x: L - 6, y: yy + 3, 'text-anchor': 'end' }, svg).textContent = v;
  }
  const every = W < 420 ? 10 : 5;
  points.forEach((p, i) => { if ((points.length - 1 - i) % every === 0) svgEl('text', { x: x(i), y: H - 6, 'text-anchor': 'middle' }, svg).textContent = md(p.date); });
  const tip = el('div', null, box, 'tip');
  const marks = [];
  if (kind === 'bar') {
    const bw = Math.max(2, step - 4);   // 柱子之间留 2px 以上的空
    points.forEach((p, i) => {
      if (!p.n) { marks.push(null); return; }
      const h = Math.max(1, ih - (y(p.n) - T)), r = Math.min(4, bw / 2, h);
      const x0 = x(i) - bw / 2, y0 = y(p.n), yb = T + ih;
      // 只圆顶部两个角，底部贴着基线
      marks.push(svgEl('path', { class: 'bar', d: `M${x0},${yb}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x0 + bw - r}Q${x0 + bw},${y0} ${x0 + bw},${y0 + r}V${yb}Z` }, svg));
    });
  } else {
    // n 为 null（开始统计之前）不画线
    svgEl('polyline', { class: 'lineS', points: points.map((p, i) => (p.n == null ? null : `${x(i)},${y(p.n)}`)).filter(Boolean).join(' ') }, svg);
    points.forEach((p, i) => marks.push(p.n == null ? null : svgEl('circle', { class: 'dot', cx: x(i), cy: y(p.n), r: 4, style: 'display:none' }, svg)));
    const lastI = points.findLastIndex(p => p.n != null);   // 最新一天的点一直显示（只有一天数据时也看得见）
    if (lastI >= 0) svgEl('circle', { class: 'dot', cx: x(lastI), cy: y(points[lastI].n), r: 4 }, svg);
  }
  // 命中区比图形大：每天一整列
  points.forEach((p, i) => {
    const hit = svgEl('rect', { class: 'hit', x: L + step * i, y: T, width: step, height: ih }, svg);
    const show = () => {
      marks.forEach(m => m && (kind === 'bar' ? m.classList.remove('on') : (m.style.display = 'none')));
      const m = marks[i];
      if (m) kind === 'bar' ? m.classList.add('on') : (m.style.display = '');
      const k = svg.getBoundingClientRect().width / W;   // 坐标以图表容器为基准（SVG 元素没有 offsetLeft）
      tip.textContent = p.n == null ? `${md(p.date)} · 还没开始统计` : `${md(p.date)} · ${p.n} ${unit}`; tip.style.display = 'block';
      const half = tip.offsetWidth / 2, cx = box.offsetLeft + x(i) * k;   // 提示框不出图表左右边
      tip.style.left = `${Math.min(Math.max(cx, box.offsetLeft + half), box.offsetLeft + box.clientWidth - half)}px`;
      tip.style.top = `${box.offsetTop + y(p.n || 0) * k}px`;
    };
    hit.addEventListener('pointerenter', show); hit.addEventListener('click', show);
  });
  svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; marks.forEach(m => m && (kind === 'bar' ? m.classList.remove('on') : (m.style.display = 'none'))); });
}

function table(t, head, rows) {
  t.textContent = '';
  const tr = el('tr', null, el('thead', null, t)); head.forEach(h => el('th', h, tr));
  const tb = el('tbody', null, t); rows.forEach(r => { const row = el('tr', null, tb); r.forEach(c => el('td', String(c), row)); });
}

let last = null;
function render(g) {
  last = g;
  const main = $('#main'); main.textContent = '';
  main.appendChild($('#tpl').content.cloneNode(true));
  $('#meta').textContent = `今天 ${g.today}（多伦多时间）· 活跃数据${g.since ? `自 ${g.since} 起统计` : '刚开始统计'}`;
  const k = [
    [`${g.accounts.total} / ${g.accounts.max}`, '账号总数 / 上限'], [g.accounts.new7, '近 7 天新注册'], [g.accounts.new30, '近 30 天新注册'],
    [g.active.today, '今天活跃'], [g.active.d7, '近 7 天活跃'], [g.active.d30, '近 30 天活跃'],
    [`${g.activation.activated}（${pct(g.activation.activated, g.accounts.total)}）`, '已激活账号'],
    [g.activation.withFavs, '有收藏'], [g.activation.withPush, '开了到站提醒'],
  ];
  for (const [v, l] of k) { const c = el('div', null, $('#kpis'), 'kpi'); el('div', String(v), c, 'v'); el('div', l, c, 'l'); }
  $('#signSub').textContent = `近 30 天共 ${g.accounts.new30} 个，累计 ${g.signups.at(-1)?.total ?? 0} 个`;
  chart($('#signChart'), g.signups, 'bar', '个新注册');
  table($('#signTable'), ['日期', '新注册', '累计'], [...g.signups].reverse().map(s => [s.date, s.n, s.total]));
  $('#dauSub').textContent = '当天打开过 App 的账号数（登录状态下）';
  chart($('#dauChart'), g.dau, 'line', '个活跃账号');
  table($('#dauTable'), ['日期', '活跃账号'], [...g.dau].reverse().map(d => [d.date, d.n ?? '—']));
  table($('#chTable'), ['渠道', '注册', '激活', '激活率'],
    g.channels.length ? g.channels.map(c => [c.ref ?? '未知', c.signups, c.activated, pct(c.activated, c.signups)]) : [['还没有注册', '—', '—', '—']]);
}

async function load() {
  const r = await fetch('/api/admin/growth', { headers: { accept: 'application/json' }, cache: 'no-store' }).catch(() => null);
  if (r?.status === 401) { location.href = '/login'; return; }
  if (!r?.ok) { $('#main').textContent = ''; el('div', r?.status === 404 ? '没有权限查看。' : '载入失败，请稍后刷新。', $('#main'), 'msg'); return; }
  render(await r.json());
}
$('#refresh').onclick = () => load();
let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => last && render(last), 200); });
load();
