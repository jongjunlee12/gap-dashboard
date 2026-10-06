/* 갭 내비 v2 — 지도·목록·순위·상세 탭 구조. 데이터는 ../data/ (v1 파이프라인) 를 그대로 읽는다 */
'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 2) => v == null || isNaN(v) ? '—' : (+v).toFixed(d).replace(/\.?0+$/, '');
const pct = v => v == null ? '—' : (v > 0 ? '+' : '') + fmt(v, 1) + '%';
const TILE = 'https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png?key=cb1_2jst_1_f20036d2498b9af9e4827f69';
const INFRA = { transit: ['교통', '#172126'], culture: ['문화', '#7a4fd1'], public: ['공공', '#1a9e6c'], education: ['교육', '#d9a21b'] };
const SHOP_COL = '#d9742a';
const LAYER_PRI = { transit: 0, education: 1, culture: 2, public: 3 };
let D, units = [], map, infraFC = null, infraReady = false, mapReady = false;
const state = { view: 'map', q: '', region: 'all', req: 3.5, ratio: 0, danji: 200, built: 2000, areas: new Set([49, 59, 74, 84]), favOnly: false, sort: 'score', sel: null, page: 1, rankTab: 'summary', layers: { transit: true, culture: true, public: true, education: true, shop: true } };
let favs = []; try { favs = JSON.parse(localStorage.getItem('gapnavi-favs') || '[]'); } catch (e) {}
const FAV_MAX = 5;

/* ---------- 데이터 정규화 ---------- */
function distM(a, b) { const R = 6371000, p1 = a[1] * Math.PI / 180, p2 = b[1] * Math.PI / 180, dp = (b[1] - a[1]) * Math.PI / 180, dl = (b[0] - a[0]) * Math.PI / 180; const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
function regionKey(s) { s = String(s || ''); if (s.includes('남양주')) return '남양주시'; if (s.includes('광주')) return '광주시'; if (s.includes('수원')) return '수원'; if (s.includes('성남')) return '성남'; return s; }
function score(u) {
  const B = D.budget.max;
  const fit = u.required == null ? 0 : u.required > B ? Math.max(0, 1 - (u.required - B) / B) : 0.6 + 0.4 * (u.required / B);
  const ratio = Math.min(1, (u.ratio || 0) / 90), chg = u.chg == null ? 0.5 : Math.min(1, Math.max(0, (u.chg + 10) / 30));
  const sed = Math.min(1, (u.danji || u.sedae || 0) / 2000), built = u.built ? Math.min(1, Math.max(0, (+u.built - 1995) / 30)) : 0.3;
  return Math.round(100 * (0.4 * fit + 0.25 * ratio + 0.15 * chg + 0.1 * sed + 0.1 * built));
}
function normalize(d) {
  const out = [];
  (d.complexes || []).forEach(c => c.units.forEach(u => {
    if (u.sale_median == null) return;
    out.push({ key: `${c.name}|${u.area}`, kind: 'cand', id: c.id, name: c.name, area: u.area, region: regionKey(c.region_label), regionLabel: c.region_label, umd: c.umd, lat: c.lat, lng: c.lng,
      sale: u.sale_median, sale_n: u.sale_n, sale_min: u.sale_min, sale_max: u.sale_max, jeonse: u.jeonse_median, jeonse_n: u.jeonse_n, jeonse_all: u.jeonse_all_median, ratio: u.jeonse_ratio, gap: u.gap, required: u.required,
      sedae: c.households, danji: c.households, built: c.built, chg: u.change_1y, chg3: u.change_3y, infra: c.infra, shops: c.shops, quarters: u.quarters || [], trades: u.trades || [], rents: u.rents || [], source: u.source, station: c.station, group: c.group, tags: c.tags || [], asking: u.asking, low: u.low_floor_share });
  }));
  (d.discovered || []).forEach(x => {
    if (x.lat == null || x.sale_median == null) return;
    out.push({ key: `${x.name}|${x.area}`, kind: 'disc', name: x.name, area: x.area, region: regionKey(x.region), regionLabel: x.region, umd: x.umd, lat: x.lat, lng: x.lng,
      sale: x.sale_median, sale_n: x.sale_n, sale_min: x.sale_min, sale_max: x.sale_max, jeonse: x.jeonse_median, jeonse_n: x.jeonse_n, jeonse_all: x.jeonse_all_median, ratio: x.jeonse_ratio, gap: x.gap, required: x.required,
      sedae: x.sedae, danji: x.danji, built: x.built, chg: x.mm_chg, infra: x.infra, shops: x.shops, quarters: [], trades: [], rents: [], source: x.source, station: x.subway || x.infra?.nearest?.transit?.name, low: x.low_floor_share, sise: x.sise });
  });
  out.forEach(u => { u.score = score(u); u.shopN = u.shops?.n1000 || 0; u.shopSales = u.shops?.sales1000 || 0; });
  return out;
}

/* ---------- 필터 ---------- */
function filtered() {
  const q = state.q.trim().toLowerCase();
  let xs = units.filter(u => (state.region === 'all' || u.region === state.region) && (u.required == null || u.required <= state.req) && (u.ratio || 0) >= state.ratio && (u.danji || u.sedae || 0) >= state.danji && (!u.built || +u.built >= state.built) && state.areas.has(u.area) && (!q || u.name.toLowerCase().includes(q) || (u.umd || '').toLowerCase().includes(q)) && (!state.favOnly || favs.some(f => f.key === u.key)));
  const k = state.sort;
  xs.sort((a, b) => k === 'score' ? b.score - a.score || a.required - b.required : k === 'required' ? a.required - b.required : k === 'ratio' ? (b.ratio || 0) - (a.ratio || 0) : k === 'chg' ? (b.chg ?? -99) - (a.chg ?? -99) : k === 'shops' ? b.shopSales - a.shopSales : k === 'sedae' ? (b.danji || 0) - (a.danji || 0) : k === 'built' ? (+b.built || 0) - (+a.built || 0) : 0);
  return xs;
}
const SORT_LABEL = { score: '추천 점수', required: '필요자금 적은 순', ratio: '전세가율 높은 순', chg: '1년 상승률', shops: '상권 규모', sedae: '세대수', built: '신축 순' };
function renderApplied() {
  const chips = [];
  if (state.region !== 'all') chips.push(state.region);
  if (state.req !== 3.5) chips.push(`필요자금 ≤ ${fmt(state.req)}억`);
  if (state.ratio) chips.push(`전세가율 ≥ ${state.ratio}%`);
  if (state.danji !== 200) chips.push(`${state.danji}세대 이상`);
  if (state.built !== 2000) chips.push(`${state.built}년 이후`);
  if (state.areas.size < 4) chips.push([...state.areas].sort((a, b) => a - b).join('·') + '㎡');
  if (state.favOnly) chips.push('★ 즐겨찾기만');
  if (state.q) chips.push(`"${state.q}"`);
  $('applied').innerHTML = chips.length ? '적용 조건 ' + chips.map(c => `<span class="chip">${esc(c)}</span>`).join('') : '';
}
function refresh() { renderApplied(); renderList(); renderRank(); renderMapMarkers(); renderFavs(); $('fav-count').textContent = favs.length; $('tab-list-n').textContent = filtered().length.toLocaleString(); }

/* ---------- 탭 ---------- */
function moveInd(v) {
  const btns = [...$('tabbar').querySelectorAll('button')], i = Math.max(0, btns.findIndex(b => b.dataset.v === v)), b = btns[i];
  const ind = $('tab-ind'); if (!ind || !b) return; const r = b.getBoundingClientRect(), pr = $('tabbar').getBoundingClientRect();
  ind.style.left = (r.left - pr.left) + 'px'; ind.style.width = r.width + 'px';
}
function show(v) {
  state.view = v;
  ['map', 'list', 'rank', 'detail', 'favs'].forEach(k => { const el = $('view-' + k); if (el) el.hidden = k !== v; });
  $('tabbar').querySelectorAll('button').forEach(b => { const on = b.dataset.v === v; b.setAttribute('aria-pressed', String(on)); if (on) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); } });
  moveInd(v === 'favs' ? 'detail' : v);
  const hint = $('tab-hint'); if (hint && !hint.classList.contains('gone')) { hint.classList.add('gone'); try { localStorage.setItem('gapnavi-hint', '1'); } catch (e) {} }
  if (v === 'map' && map) setTimeout(() => { map.resize(); scheduleLabels(); }, 60);
  window.scrollTo({ top: v === 'map' ? 0 : $('view-' + v).offsetTop - 70, behavior: 'smooth' });
}

/* ---------- 목록 ---------- */
const PAGE = 20;
function card(u, i) {
  const st = u.required < D.budget.min ? 'under' : u.required <= D.budget.max ? 'in' : 'over';
  const on = favs.some(f => f.key === u.key);
  return `<div class="item" data-key="${esc(u.key)}">
    <div class="nm">${esc(u.name)} <span class="badge">${u.area}㎡</span>${u.kind === 'cand' ? '<span class="badge cand">후보</span>' : ''}${u.score >= 70 ? `<span class="badge">추천 ${u.score}</span>` : ''}</div>
    <div class="sub">${u.danji ? u.danji.toLocaleString() + '세대' : (u.sedae ? u.sedae + '세대' : '')}${u.built ? ` · ${u.built}년` : ''}${u.station ? ` · ${esc(u.station)}` : ''}${u.shopN ? ` · 상권 ${u.shopN.toLocaleString()}개` : ''}</div>
    <button class="fav-b${on ? ' on' : ''}" data-key="${esc(u.key)}" title="즐겨찾기">${on ? '★' : '☆'}</button>
    <div class="tri"><div>매매<b>${fmt(u.sale)}억</b></div><div>전세 최고<b>${fmt(u.jeonse)}억</b></div><div class="${st === 'over' ? '' : 'hi'}">필요자금<b>${fmt(u.required)}억</b><small class="muted">전세가율 ${fmt(u.ratio, 1)}%${u.chg != null ? ` · 1년 ${pct(u.chg)}` : ''}</small></div></div>
    <div class="addr">${esc(u.regionLabel)} ${esc(u.umd || '')}${u.sale_n ? ` · 최근 매매 ${u.sale_n}건` : ''}${u.jeonse_n ? ` · 전세 ${u.jeonse_n}건` : ''}</div>
  </div>`;
}
function renderList() {
  const xs = filtered();
  $('list-count').textContent = xs.length.toLocaleString() + '개';
  $('btn-sort').textContent = SORT_LABEL[state.sort] + ' ▾';
  const shown = xs.slice(0, PAGE * state.page);
  $('list').innerHTML = shown.length ? shown.map(card).join('') : '<p class="muted">조건에 맞는 단지가 없습니다. 필터를 풀어 보세요.</p>';
  $('btn-more').hidden = shown.length >= xs.length;
  $('btn-more').textContent = `더 보기 (${shown.length}/${xs.length})`;
  bindCards($('list'));
}
function bindCards(root) {
  root.querySelectorAll('.item').forEach(el => el.onclick = e => { if (e.target.closest('.fav-b')) return; openDetail(el.dataset.key); });
  root.querySelectorAll('.fav-b').forEach(b => b.onclick = e => { e.stopPropagation(); toggleFav(b.dataset.key); });
}

/* ---------- 순위 ---------- */
const RANK_DEF = { score: ['추천 점수', u => u.score, v => v + '점'], required: ['필요자금 적은 순', u => u.required, v => fmt(v) + '억'], ratio: ['전세가율 높은 순', u => u.ratio, v => fmt(v, 1) + '%'], chg: ['1년 상승률', u => u.chg, v => pct(v)], shops: ['상권 규모 (1km 월매출)', u => u.shopSales, v => (v / 10000).toFixed(0) + '억/월'] };
function rankList(k, n) {
  const xs = filtered().filter(u => RANK_DEF[k][1](u) != null);
  xs.sort((a, b) => k === 'required' ? a.required - b.required : RANK_DEF[k][1](b) - RANK_DEF[k][1](a));
  return xs.slice(0, n);
}
function rankRows(k, xs) { return xs.map((u, i) => `<div class="rk" data-key="${esc(u.key)}"><span class="n">${i + 1}</span><span class="t"><b>${esc(u.name)} ${u.area}</b><small>${esc(u.regionLabel)} ${esc(u.umd || '')} · 매매 ${fmt(u.sale)}억 · 필요 ${fmt(u.required)}억</small></span><span class="v">${RANK_DEF[k][2](RANK_DEF[k][1](u))}</span></div>`).join(''); }
function renderRank() {
  $('rank-meta').textContent = `${D.generated_at} · 조건에 맞는 단지 ${filtered().length}개`;
  $('rank-tabs').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.k === state.rankTab)));
  if (state.rankTab === 'summary') {
    $('rank').innerHTML = Object.keys(RANK_DEF).map(k => `<div class="rank-sec"><h3>${RANK_DEF[k][0]} Top 3 <button data-k="${k}">더 보기</button></h3>${rankRows(k, rankList(k, 3))}</div>`).join('');
    $('rank').querySelectorAll('h3 button').forEach(b => b.onclick = () => { state.rankTab = b.dataset.k; renderRank(); });
  } else {
    $('rank').innerHTML = `<div class="rank-sec"><h3>${RANK_DEF[state.rankTab][0]} Top 20</h3>${rankRows(state.rankTab, rankList(state.rankTab, 20))}</div>`;
  }
  $('rank').querySelectorAll('.rk').forEach(el => el.onclick = () => openDetail(el.dataset.key));
}

/* ---------- 즐겨찾기 ---------- */
function toggleFav(key) {
  const u = units.find(x => x.key === key); if (!u) return;
  if (favs.some(f => f.key === key)) favs = favs.filter(f => f.key !== key);
  else { if (favs.length >= FAV_MAX) { alert(`즐겨찾기는 ${FAV_MAX}개까지입니다. 비교표에서 하나를 빼 주세요.`); return; } favs.push({ key }); }
  try { localStorage.setItem('gapnavi-favs', JSON.stringify(favs)); } catch (e) {}
  refresh(); if (state.sel) renderDetail();
}
function renderFavs() {
  const xs = favs.map(f => units.find(u => u.key === f.key)).filter(Boolean);
  $('favs-meta').textContent = `${xs.length}/${FAV_MAX}`;
  $('btn-fav').setAttribute('aria-pressed', String(state.favOnly));
  if (!xs.length) { $('favs').innerHTML = '<p class="muted">목록·상세에서 ☆를 누르면 최대 5개까지 한 표에서 비교할 수 있습니다.</p>'; return; }
  const best = (k, min) => { const v = xs.map(u => u[k]).filter(x => x != null); return v.length ? (min ? Math.min(...v) : Math.max(...v)) : null; };
  const B = { required: best('required', true), ratio: best('ratio'), chg: best('chg'), shopSales: best('shopSales'), score: best('score') };
  const hi = (u, k) => u[k] != null && u[k] === B[k] ? ' class="best"' : '';
  $('favs').innerHTML = `<div class="cmp"><table><tr><th>단지</th><th>추천</th><th>매매</th><th>전세</th><th>전세가율</th><th>필요자금</th><th>1년</th><th>세대·연식</th><th>역</th><th>시설 1km</th><th>상권 1km</th><th></th></tr>
  ${xs.map(u => `<tr data-key="${esc(u.key)}"><td><b>${esc(u.name)}</b> ${u.area}㎡<br><small class="muted">${esc(u.regionLabel)} ${esc(u.umd || '')}</small></td><td${hi(u, 'score')}>${u.score}</td><td>${fmt(u.sale)}억</td><td>${fmt(u.jeonse)}억</td><td${hi(u, 'ratio')}>${fmt(u.ratio, 1)}%</td><td${hi(u, 'required')}><b>${fmt(u.required)}억</b></td><td${hi(u, 'chg')}>${u.chg != null ? pct(u.chg) : '—'}</td><td>${u.danji || u.sedae || '—'}·${u.built || '—'}</td><td>${u.infra?.nearest?.transit ? `${esc(u.infra.nearest.transit.name)} ${u.infra.nearest.transit.d}m` : esc(u.station || '—')}</td><td>${Object.values(u.infra?.r1000 || {}).reduce((a, b) => a + b, 0)}</td><td${hi(u, 'shopSales')}>${u.shopN ? `${u.shopN.toLocaleString()}개 · ${(u.shopSales / 10000).toFixed(0)}억` : '—'}</td><td><button class="x" data-key="${esc(u.key)}">✕</button></td></tr>`).join('')}</table></div>
  <p class="foot">색칠 칸 = 다섯 중 가장 좋은 값 · 행을 누르면 상세</p><div class="d-actions"><button id="favs-map" class="primary">지도에서 함께 보기</button></div>`;
  $('favs').querySelectorAll('tr[data-key]').forEach(tr => tr.onclick = e => { if (e.target.closest('.x')) return; openDetail(tr.dataset.key); });
  $('favs').querySelectorAll('.x').forEach(b => b.onclick = e => { e.stopPropagation(); toggleFav(b.dataset.key); });
  $('favs-map').onclick = () => { show('map'); clearFocus(); const b = new maplibregl.LngLatBounds(); xs.forEach(u => b.extend([u.lng, u.lat])); map.fitBounds(b, { padding: 70, maxZoom: 14 }); };
}

/* ---------- 지도 ---------- */
let pins = [], bubbles = [], focus = null, labelTimer = null, labelLayer, labelSvg, tip;
function initMap() {
  map = new maplibregl.Map({ container: 'map', style: { version: 8, sources: { carto: { type: 'raster', tiles: [TILE], tileSize: 256, attribution: '© OpenStreetMap contributors © CARTO' } }, layers: [{ id: 'bg', type: 'raster', source: 'carto' }] }, center: [127.12, 37.46], zoom: 9.6 });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  tip = document.createElement('div'); tip.className = 'tip'; document.body.appendChild(tip);
  const c = map.getContainer();
  labelSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); labelSvg.setAttribute('class', 'ilines'); labelLayer = document.createElement('div'); labelLayer.className = 'ilabels'; c.appendChild(labelSvg); c.appendChild(labelLayer);
  map.on('load', () => { mapReady = true; addInfraLayers(); renderMapMarkers(); fitAll(); });
  map.on('zoomend', renderMapMarkers); map.on('moveend', scheduleLabels); map.on('idle', scheduleLabels); map.on('movestart', () => { labelLayer.innerHTML = ''; labelSvg.innerHTML = ''; });
  $('btn-fit').onclick = () => { clearFocus(); fitAll(); };
  $('btn-labels').onclick = () => { const on = $('btn-labels').getAttribute('aria-pressed') !== 'true'; $('btn-labels').setAttribute('aria-pressed', String(on)); document.body.classList.toggle('labels', on); };
  $('btn-full').onclick = () => { document.body.classList.toggle('map-full'); $('btn-full').textContent = document.body.classList.contains('map-full') ? '✕' : '⤢'; setTimeout(() => map.resize(), 50); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.classList.contains('map-full')) $('btn-full').click(); });
}
function fitAll() { const xs = filtered(); if (!xs.length) return; const b = new maplibregl.LngLatBounds(); xs.forEach(u => b.extend([u.lng, u.lat])); map.fitBounds(b, { padding: 50, maxZoom: 13, duration: 500 }); }
function renderMapMarkers() {
  if (!map || !mapReady) return;
  pins.forEach(m => m.remove()); bubbles.forEach(m => m.remove()); pins = []; bubbles = [];
  const xs = filtered(); $('map-meta').textContent = `${xs.length}개 단지`;
  // 같은 좌표(같은 단지 다른 평형)는 하나로
  const byPos = new Map(); xs.forEach(u => { const k = `${u.name}@${u.lng.toFixed(5)},${u.lat.toFixed(5)}`; if (!byPos.has(k)) byPos.set(k, []); byPos.get(k).push(u); });
  if (map.getZoom() < 11.5 && !focus) {
    const g = new Map(); xs.forEach(u => { const k = u.region; if (!g.has(k)) g.set(k, { n: 0, lng: 0, lat: 0, names: new Set() }); const o = g.get(k); o.names.add(u.name); o.lng += u.lng; o.lat += u.lat; o.n++; });
    g.forEach((o, k) => { const el = document.createElement('div'); el.className = 'bubble'; el.innerHTML = `<b>${esc(k)}</b><small>${o.names.size}개 단지</small>`; el.onclick = () => map.flyTo({ center: [o.lng / o.n, o.lat / o.n], zoom: 12.5 }); bubbles.push(new maplibregl.Marker({ element: el }).setLngLat([o.lng / o.n, o.lat / o.n]).addTo(map)); });
    return;
  }
  byPos.forEach(list => {
    const u = list.slice().sort((a, b) => b.score - a.score)[0];
    const st = u.required < D.budget.min ? 'under' : u.required <= D.budget.max ? 'in' : 'over';
    const el = document.createElement('div'); el.className = `pin ${st}${u.kind === 'cand' ? ' cand' : ''}${state.sel && list.some(x => x.key === state.sel) ? ' sel' : ''}${list.some(x => favs.some(f => f.key === x.key)) ? ' fav' : ''}`;
    el.innerHTML = `<span>${esc(u.name)} <small>${[...new Set(list.map(x => x.area))].sort((a, b) => a - b).join('·')}</small></span>`;
    el.onclick = e => { e.stopPropagation(); openDetail(u.key); };
    el.onmouseenter = e => { tip.style.display = 'block'; tip.textContent = `${u.name} ${list.map(x => x.area).join('/')}㎡ · 매매 ${fmt(u.sale)}억 · 필요 ${fmt(u.required)}억`; };
    el.onmousemove = e => { tip.style.left = e.clientX + 12 + 'px'; tip.style.top = e.clientY + 12 + 'px'; };
    el.onmouseleave = () => tip.style.display = 'none';
    pins.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([u.lng, u.lat]).addTo(map));
  });
  scheduleLabels();
}
/* 반경 포커스 · 시설 · 상권 */
function circlePoly(c, r, n = 64) { const [lng, lat] = c, kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110574, ring = []; for (let i = 0; i <= n; i++) { const t = i / n * 2 * Math.PI; ring.push([lng + r * Math.cos(t) / kx, lat + r * Math.sin(t) / ky]); } return { type: 'Feature', properties: { r }, geometry: { type: 'Polygon', coordinates: [ring] } }; }
function addInfraLayers() {
  map.addSource('ring', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'ring-fill', type: 'fill', source: 'ring', paint: { 'fill-color': '#0b5c4d', 'fill-opacity': ['case', ['==', ['get', 'r'], 500], 0.10, 0.05] } });
  map.addLayer({ id: 'ring-line', type: 'line', source: 'ring', paint: { 'line-color': '#0b5c4d', 'line-width': 1.2, 'line-dasharray': [3, 2], 'line-opacity': 0.7 } });
  map.addSource('near', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  Object.entries(INFRA).forEach(([k, [label, col]]) => {
    map.addLayer({ id: 'near-' + k, type: 'circle', source: 'near', filter: ['==', ['get', 'layer'], k], paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 4, 15, k === 'transit' ? 9 : 7], 'circle-color': col, 'circle-opacity': .85, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
    hoverLayer('near-' + k, p => `${label} · ${p.name} · ${p.d}m`);
  });
  map.addSource('shops', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'shops', type: 'circle', source: 'shops', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 4, 15, ['-', 11, ['*', .5, ['get', 'rank']]]], 'circle-color': SHOP_COL, 'circle-opacity': .9, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
  hoverLayer('shops', p => `상권 ${p.rank}위 · ${p.name} (${p.cat}) · 월매출 ${(p.sales / 10000).toFixed(1)}억 · ${p.d}m`);
  $('map-chips').innerHTML = Object.entries(INFRA).map(([k, [l, col]]) => `<button data-k="${k}" aria-pressed="true"><i style="background:${col}"></i>${l}</button>`).join('') + `<button data-k="shop" aria-pressed="true"><i style="background:${SHOP_COL}"></i>상권</button>`;
  $('map-chips').querySelectorAll('button').forEach(b => b.onclick = () => { const k = b.dataset.k; state.layers[k] = !state.layers[k]; b.setAttribute('aria-pressed', String(state.layers[k])); map.setLayoutProperty(k === 'shop' ? 'shops' : 'near-' + k, 'visibility', state.layers[k] ? 'visible' : 'none'); scheduleLabels(); });
}
function hoverLayer(id, text) { map.on('mouseenter', id, () => map.getCanvas().style.cursor = 'pointer'); map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; tip.style.display = 'none'; }); map.on('mousemove', id, e => { tip.style.display = 'block'; tip.textContent = text(e.features[0].properties); tip.style.left = e.originalEvent.clientX + 12 + 'px'; tip.style.top = e.originalEvent.clientY + 12 + 'px'; }); }
function focusOn(u) {
  focus = u;
  if (!map || !mapReady) return;
  map.getSource('ring').setData({ type: 'FeatureCollection', features: [circlePoly([u.lng, u.lat], 1000), circlePoly([u.lng, u.lat], 500)] });
  if (infraFC) map.getSource('near').setData({ type: 'FeatureCollection', features: infraFC.features.filter(f => { const d = distM([u.lng, u.lat], f.geometry.coordinates); if (d > 1000) return false; f.properties.d = Math.round(d); return true; }) });
  const top = u.shops?.top || [];
  map.getSource('shops').setData({ type: 'FeatureCollection', features: top.map((t, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [t.lng, t.lat] }, properties: { layer: 'shop', name: t.name, d: t.d, sales: t.sales, cat: t.cat, rank: i + 1 } })) });
  const b = new maplibregl.LngLatBounds(); circlePoly([u.lng, u.lat], 1000, 16).geometry.coordinates[0].forEach(c => b.extend(c));
  const H = map.getContainer().clientHeight; map.fitBounds(b, { padding: { top: Math.min(110, H * .3), bottom: Math.min(90, H * .25), left: 16, right: 16 }, maxZoom: 15.5, duration: 600 });
  const inf = u.infra || {}, n1 = Object.values(inf.r1000 || {}).reduce((a, b) => a + b, 0), n5 = Object.values(inf.r500 || {}).reduce((a, b) => a + b, 0);
  $('map-note').innerHTML = `<b>${esc(u.name)} ${u.area}㎡</b> · 매매 ${fmt(u.sale)}억 · 전세 ${fmt(u.jeonse)}억 · <b>필요자금 ${fmt(u.required)}억</b><br><span class="muted">반경 1km 시설 ${n1}개 (500m ${n5}) ${u.shopN ? `· 점포 ${u.shopN.toLocaleString()}개 · 월매출 ${(u.shopSales / 10000).toFixed(0)}억` : ''}</span> <button class="ghost" id="note-detail" style="padding:3px 9px;font-size:.78rem">상세</button> <button class="ghost" id="note-x" style="padding:3px 9px;font-size:.78rem">닫기</button>`;
  $('note-detail').onclick = () => show('detail'); $('note-x').onclick = clearFocus;
  renderMapMarkers();
}
function clearFocus() {
  focus = null; if (!map || !mapReady) return;
  ['ring', 'near', 'shops'].forEach(s => map.getSource(s).setData({ type: 'FeatureCollection', features: [] }));
  $('map-note').innerHTML = ''; renderMapMarkers();
}
/* 시설·상권 라벨 (0.7배, 지시선, 겹침 회피) */
function scheduleLabels() { clearTimeout(labelTimer); labelTimer = setTimeout(placeLabels, 80); }
function placeLabels() {
  if (!map || !mapReady) return;
  labelLayer.innerHTML = ''; labelSvg.innerHTML = '';
  if (!focus || map.getZoom() < 12) return;
  const W = map.getContainer().clientWidth, H = map.getContainer().clientHeight, placed = [];
  const cr = map.getContainer().getBoundingClientRect();
  ['.map-ctl', '.map-chips', '.map-note', '.map-legend', '.maplibregl-ctrl-top-right'].forEach(s => { const el = map.getContainer().parentElement.querySelector(s); if (!el || !el.offsetParent) return; const r = el.getBoundingClientRect(); placed.push({ x1: r.left - cr.left - 4, y1: r.top - cr.top - 4, x2: r.right - cr.left + 4, y2: r.bottom - cr.top + 4 }); });
  pins.forEach(m => { const p = map.project(m.getLngLat()); placed.push({ x1: p.x - 12, y1: p.y - 12, x2: p.x + 12, y2: p.y + 12 }); const sp = m.getElement().querySelector('span'); if (sp && getComputedStyle(sp).display !== 'none') { const r = sp.getBoundingClientRect(); placed.push({ x1: r.left - cr.left, y1: r.top - cr.top, x2: r.right - cr.left, y2: r.bottom - cr.top }); } });
  const overlaps = b => placed.some(o => !(b.x2 < o.x1 || b.x1 > o.x2 || b.y2 < o.y1 || b.y1 > o.y2));
  const layers = Object.keys(INFRA).filter(k => state.layers[k]).map(k => 'near-' + k).concat(state.layers.shop ? ['shops'] : []);
  let feats = []; try { feats = map.queryRenderedFeatures({ layers }); } catch (e) { return; }
  const seen = new Set();
  const pts = feats.map(f => ({ layer: f.properties.layer, name: f.properties.layer === 'shop' ? `${f.properties.rank}. ${f.properties.name}` : f.properties.name, d: f.properties.d || 0, rank: f.properties.rank || 99, ll: f.geometry.coordinates })).filter(f => { const k = f.layer + f.name; if (seen.has(k)) return false; seen.add(k); return true; });
  pts.sort((a, b) => (a.layer === 'shop') !== (b.layer === 'shop') ? (a.layer === 'shop' ? -1 : 1) : a.layer === 'shop' ? a.rank - b.rank : ((a.d <= 500) === (b.d <= 500) ? (LAYER_PRI[a.layer] - LAYER_PRI[b.layer]) || a.d - b.d : a.d <= 500 ? -1 : 1));
  const maxN = W < 600 ? 14 : 36, fs = 11; let n = 0;
  for (const pt of pts) {
    if (n >= maxN) break;
    const p = map.project(pt.ll); if (p.x < 0 || p.y < 0 || p.x > W || p.y > H) continue;
    const text = pt.name.length > 14 ? pt.name.slice(0, 13) + '…' : pt.name, w = text.length * fs * .95 + 10, h = fs + 6;
    const cands = [[10, -h / 2], [-w - 10, -h / 2], [-w / 2, -h - 10], [-w / 2, 10], [22, -h - 18], [-w - 22, -h - 18], [22, 18], [-w - 22, 18]];
    let hit = null;
    for (const [dx, dy] of cands) { const b = { x1: p.x + dx, y1: p.y + dy, x2: p.x + dx + w, y2: p.y + dy + h }; if (b.x1 < 2 || b.y1 < 2 || b.x2 > W - 2 || b.y2 > H - 2) continue; if (!overlaps(b)) { hit = b; break; } }
    if (!hit) continue;
    placed.push(hit); n++;
    const col = pt.layer === 'shop' ? SHOP_COL : INFRA[pt.layer][1];
    const el = document.createElement('div'); el.className = 'ilabel'; el.style.cssText = `left:${hit.x1}px;top:${hit.y1}px;border-color:${col};color:${col}${pt.layer === 'shop' ? ';font-weight:700' : ''}`; el.textContent = text; labelLayer.appendChild(el);
    const cx = Math.max(hit.x1, Math.min(hit.x2, p.x)), cy = Math.max(hit.y1, Math.min(hit.y2, p.y));
    if (Math.hypot(cx - p.x, cy - p.y) > 6) { const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line'); ln.setAttribute('x1', p.x); ln.setAttribute('y1', p.y); ln.setAttribute('x2', cx); ln.setAttribute('y2', cy); ln.setAttribute('stroke', col); labelSvg.appendChild(ln); }
  }
}

/* ---------- 상세 ---------- */
function openDetail(key) {
  state.sel = key; const u = units.find(x => x.key === key); if (!u) return;
  $('tab-detail').querySelector('span').textContent = '상세'; $('tab-detail').classList.add('flash'); setTimeout(() => $('tab-detail').classList.remove('flash'), 2500);
  renderDetail(); show('detail'); focusOn(u);
}
function locScores(u) {
  const inf = u.infra || {}, r = inf.r1000 || {}, near = inf.nearest || {};
  const tr = near.transit ? Math.max(0, Math.min(100, Math.round(100 - (near.transit.d - 300) / 12))) : 10;
  const edu = Math.min(100, (r.education || 0) * 12);
  const life = Math.min(100, Math.round((u.shopN || 0) / 15));
  const cul = Math.min(100, ((r.culture || 0) + (r.public || 0)) * 15);
  const inv = u.score;
  return [['교통', tr, near.transit ? `${near.transit.name} ${near.transit.d}m` : '역 2.5km 밖'], ['교육', edu, `1km 학교 ${r.education || 0}곳`], ['생활 상권', life, u.shopN ? `점포 ${u.shopN.toLocaleString()}개` : '자료 없음'], ['문화·공공', cul, `${(r.culture || 0) + (r.public || 0)}곳`], ['투자 매력', inv, '추천 점수']];
}
function lineChart(u) {
  const qs = (u.quarters || []).filter(q => q.sale_median); if (qs.length < 2) return '';
  const W = 640, H = 220, pl = 44, pr = 12, pt = 16, pb = 30, iw = W - pl - pr, ih = H - pt - pb;
  const ys = qs.flatMap(q => [q.sale_median, q.jeonse_median]).filter(Boolean), y0 = Math.min(...ys) * .9, y1 = Math.max(...ys) * 1.05;
  const x = i => pl + i / (qs.length - 1) * iw, y = v => pt + ih - (v - y0) / (y1 - y0) * ih;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}">`;
  for (let i = 0; i < 4; i++) { const v = y0 + (y1 - y0) * i / 3; s += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="#e4e9e7"/><text x="${pl - 6}" y="${y(v) + 4}" font-size="11" fill="#8e9995" text-anchor="end">${v.toFixed(1)}</text>`; }
  s += `<path d="${qs.map((q, i) => (i ? 'L' : 'M') + x(i) + ' ' + y(q.sale_median)).join(' ')}" fill="none" stroke="#0b5c4d" stroke-width="2.5"/>`;
  const js = qs.map((q, i) => q.jeonse_median ? [x(i), y(q.jeonse_median)] : null).filter(Boolean);
  if (js.length > 1) s += `<path d="${js.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' ')}" fill="none" stroke="#d9742a" stroke-width="2" stroke-dasharray="5 3"/>`;
  qs.forEach((q, i) => { s += `<circle cx="${x(i)}" cy="${y(q.sale_median)}" r="3.5" fill="#0b5c4d"/><text x="${x(i)}" y="${H - 10}" font-size="10.5" fill="#8e9995" text-anchor="middle">${q.q}</text>`; });
  s += `<text x="${W - pr}" y="${pt + 2}" font-size="11" text-anchor="end" fill="#0b5c4d">매매 ─</text><text x="${W - pr}" y="${pt + 16}" font-size="11" text-anchor="end" fill="#d9742a">전세 ╌</text>`;
  return s + '</svg>';
}
function gapChart(u) {
  const qs = (u.quarters || []).filter(q => q.sale_median && q.jeonse_median); if (qs.length < 2) return '';
  const W = 640, H = 150, pl = 44, pr = 12, pt = 10, pb = 28, iw = W - pl - pr, ih = H - pt - pb, gaps = qs.map(q => q.sale_median - q.jeonse_median), y1 = Math.max(...gaps) * 1.15, bw = iw / qs.length * .6;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}">`;
  qs.forEach((q, i) => { const g = gaps[i], h = g / y1 * ih, x = pl + (i + .2) * iw / qs.length; s += `<rect x="${x}" y="${pt + ih - h}" width="${bw}" height="${h}" rx="4" fill="${g <= D.budget.max ? '#0b5c4d' : '#c9ced0'}"/><text x="${x + bw / 2}" y="${pt + ih - h - 4}" font-size="10.5" text-anchor="middle" fill="#14231f">${g.toFixed(1)}</text><text x="${x + bw / 2}" y="${H - 8}" font-size="10.5" text-anchor="middle" fill="#8e9995">${q.q}</text>`; });
  return s + '</svg>';
}
function renderDetail() {
  const u = units.find(x => x.key === state.sel); if (!u) return;
  const sibs = units.filter(x => x.name === u.name && x.regionLabel === u.regionLabel).sort((a, b) => a.area - b.area);
  const on = favs.some(f => f.key === u.key);
  const inf = u.infra || {}, r5 = inf.r500 || {}, r10 = inf.r1000 || {}, near = inf.nearest || {}, sh = u.shops;
  const trades = (u.trades || []).slice(-10).reverse(), rents = (u.rents || []).slice(-6).reverse();
  $('detail').innerHTML = `
  <div class="d-head"><div><h2>${esc(u.name)} <span class="badge">${esc(u.region)}</span>${u.kind === 'cand' ? '<span class="badge" style="background:#14231f;color:#fff">후보 단지</span>' : ''}</h2>
  <div class="d-meta"><span>📍 ${esc(u.regionLabel)} ${esc(u.umd || '')}</span><span>🏢 ${u.danji ? u.danji.toLocaleString() + '세대' : (u.sedae ? u.sedae + '세대' : '세대 미상')}${u.built ? ` · ${u.built}년` : ''}</span>${u.station ? `<span>🚇 ${esc(u.station)}</span>` : ''}</div></div>
  <button class="ghost" id="d-fav" style="${on ? 'background:#fff6d6;border-color:#c9a227;color:#7a5a00' : ''}">${on ? '★ 즐겨찾기 중' : '☆ 즐겨찾기'}</button></div>
  <div class="d-area"><select id="d-area">${sibs.map(x => `<option value="${esc(x.key)}"${x.key === u.key ? ' selected' : ''}>전용 ${x.area}㎡ (${Math.round(x.area / 3.3058)}평) · 매매 ${fmt(x.sale)}억 · 필요자금 ${fmt(x.required)}억</option>`).join('')}</select></div>
  <div class="tiles"><div><small>매매 중앙값</small><b>${fmt(u.sale)}<em>억</em></b><span>${u.sale_n ? `최근 ${u.sale_n}건 · ${fmt(u.sale_min, 1)}~${fmt(u.sale_max, 1)}` : '시세 기준'}</span></div><div><small>전세 최고가</small><b>${fmt(u.jeonse)}<em>억</em></b><span>${u.jeonse_n ? `최근 ${u.jeonse_n}건` : ''}${u.jeonse_all && u.jeonse_all !== u.jeonse ? ` · 중앙 ${fmt(u.jeonse_all)}` : ''}</span></div><div class="hi"><small>필요자금 (갭+취득세)</small><b>${fmt(u.required)}<em>억</em></b><span>전세가율 ${fmt(u.ratio, 1)}% · ${u.required <= D.budget.max ? (u.required >= D.budget.min ? '예산 안' : '예산 여유') : '예산 초과'}</span></div></div>
  <div class="d-actions"><button id="d-map" class="primary">지도에서 반경 보기</button><a class="ghost" style="text-decoration:none;display:inline-block" target="_blank" rel="noopener" href="https://search.naver.com/search.naver?query=${encodeURIComponent(u.name + ' 아파트 ' + (u.umd || ''))}">네이버 단지 검색 ↗</a>${u.asking ? `<span class="muted">현재 호가 ${fmt(u.asking.min)}~${fmt(u.asking.max)}억</span>` : ''}</div>
  <div class="d-sec"><h3>입지 지표 <small>교통=역 거리, 교육=1km 학교, 생활=상권 점포, 투자=추천 점수</small></h3><div class="scores">${locScores(u).map(([l, v, d]) => `<div class="score"><small>${l}</small><b>${v}</b><small>${esc(d)}</small></div>`).join('')}</div></div>
  <div class="d-sec"><h3>주변 시설 · 500m / 1km <small>OpenStreetMap</small></h3>${Object.entries(INFRA).map(([k, [l, col]]) => { const mx = Math.max(1, ...Object.keys(INFRA).map(x => r10[x] || 0)); return `<div class="bar-row"><span>${l}</span><div class="bar"><i style="width:${(r10[k] || 0) / mx * 100}%;background:${col};opacity:.3"></i><i style="width:${(r5[k] || 0) / mx * 100}%;background:${col}"></i></div><span>${r5[k] || 0} / ${r10[k] || 0}${near[k] ? ` <small class="muted">${near[k].d}m</small>` : ''}</span></div>`; }).join('')}</div>
  ${sh && sh.n1000 ? `<div class="d-sec"><h3>주변 상권 <small>오픈업 · 최근 12개월 월평균 · 주유소 제외 상위</small></h3><p class="muted" style="margin:0 0 6px">500m 안 ${sh.n500.toLocaleString()}개 · 월매출 ${(sh.sales500 / 10000).toFixed(0)}억 / 1km 안 ${sh.n1000.toLocaleString()}개 · ${(sh.sales1000 / 10000).toFixed(0)}억</p><table class="mini"><tr><th></th><th>매장</th><th>월매출</th><th>월 거래</th><th>거리</th></tr>${sh.top.map((t, i) => `<tr><td>${i + 1}</td><td><b>${esc(t.name)}</b> <small class="muted">${esc(t.cat)}</small></td><td>${(t.sales / 10000).toFixed(1)}억</td><td>${t.cnt.toLocaleString()}</td><td>${t.d}m</td></tr>`).join('')}</table></div>` : ''}
  ${lineChart(u) ? `<div class="d-sec"><h3>매매 · 전세 실거래 추이 <small>분기 중앙값 · 억</small></h3>${lineChart(u)}</div><div class="d-sec"><h3>매매 − 전세 갭 <small>분기 · 억 · 초록 = 예산 ${D.budget.max}억 안</small></h3>${gapChart(u)}</div>` : `<div class="d-sec"><h3>가격 범위</h3><p class="muted" style="margin:0">최근 매매 ${u.sale_n || 0}건 · ${fmt(u.sale_min, 1)}~${fmt(u.sale_max, 1)}억${u.chg != null ? ` · 1년 변동 ${pct(u.chg)}` : ''}${u.low != null ? ` · 저층 비중 ${u.low}%` : ''}${u.sise ? ` · PropX 시세 매매 ${fmt(u.sise.mm)} / 전세 ${fmt(u.sise.js)}` : ''}</p></div>`}
  ${trades.length ? `<div class="d-sec"><h3>최근 매매 실거래 <small>해제 제외</small></h3><table class="mini"><tr><th>계약일</th><th>가격</th><th>층</th><th>구분</th></tr>${trades.map(t => `<tr><td>${t.date}</td><td><b>${fmt(t.price)}억</b></td><td>${t.floor}층${t.low_floor ? ' <small class="muted">저층</small>' : ''}</td><td>${esc(t.dealing || '')}</td></tr>`).join('')}</table></div>` : ''}
  ${rents.length ? `<div class="d-sec"><h3>최근 전세 계약</h3><table class="mini"><tr><th>계약일</th><th>보증금</th><th>층</th></tr>${rents.map(t => `<tr><td>${t.date}</td><td><b>${fmt(t.deposit)}억</b></td><td>${t.floor}층</td></tr>`).join('')}</table></div>` : ''}
  <p class="foot">출처: ${({ rtms: '국토부 실거래', propx_rt: 'PropX 실거래', propx: 'PropX 시세', seed: '보고서 값' })[u.source] || u.source} · 전세 기준가는 최근 계약 최고가 · 판단 근거이며 매수 권유가 아닙니다.</p>`;
  $('d-fav').onclick = () => toggleFav(u.key);
  $('d-area').onchange = e => { state.sel = e.target.value; renderDetail(); focusOn(units.find(x => x.key === state.sel)); };
  $('d-map').onclick = () => { show('map'); focusOn(u); };
}

/* ---------- 초기화 ---------- */
function bind() {
  $('tabbar').querySelectorAll('button').forEach(b => b.onclick = () => { if (b.dataset.v === 'detail' && !state.sel) { show('favs'); return; } show(b.dataset.v); });
  $('btn-fav-top').onclick = () => show('favs');
  $('q').oninput = e => { state.q = e.target.value; state.page = 1; refresh(); if (state.view === 'map' && state.q) { const xs = filtered(); if (xs.length && xs.length < 30) { const b = new maplibregl.LngLatBounds(); xs.forEach(u => b.extend([u.lng, u.lat])); map.fitBounds(b, { padding: 60, maxZoom: 14 }); } } };
  $('region-seg').querySelectorAll('button').forEach(b => b.onclick = () => { state.region = b.dataset.r; $('region-seg').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); state.page = 1; refresh(); if (map) { clearFocus(); fitAll(); } });
  $('btn-filter').onclick = () => { $('filter-panel').hidden = !$('filter-panel').hidden; $('btn-filter').setAttribute('aria-pressed', String(!$('filter-panel').hidden)); };
  $('btn-fav').onclick = () => { state.favOnly = !state.favOnly; state.page = 1; refresh(); };
  $('btn-reset').onclick = () => { Object.assign(state, { q: '', region: 'all', req: 3.5, ratio: 0, danji: 200, built: 2000, areas: new Set([49, 59, 74, 84]), favOnly: false, sort: 'score', page: 1 }); $('q').value = ''; ['req', 'ratio', 'danji', 'built'].forEach(k => $('f-' + k).value = state[k]); $('f-sort').value = 'score'; syncOutputs(); $('f-area').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', 'true')); $('region-seg').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.r === 'all'))); refresh(); if (map) { clearFocus(); fitAll(); } };
  const syncOutputs = () => { $('o-req').textContent = fmt(state.req) + '억'; $('o-ratio').textContent = state.ratio + '%'; $('o-danji').textContent = state.danji; $('o-built').textContent = state.built; };
  ['req', 'ratio', 'danji', 'built'].forEach(k => $('f-' + k).oninput = e => { state[k] = +e.target.value; syncOutputs(); state.page = 1; refresh(); });
  $('f-area').querySelectorAll('button').forEach(b => b.onclick = () => { const a = +b.dataset.a; if (state.areas.has(a)) { if (state.areas.size === 1) return; state.areas.delete(a); } else state.areas.add(a); b.setAttribute('aria-pressed', String(state.areas.has(a))); state.page = 1; refresh(); });
  $('f-sort').onchange = e => { state.sort = e.target.value; state.page = 1; refresh(); };
  $('btn-more').onclick = () => { state.page++; renderList(); };
  $('btn-sort').onclick = e => { e.stopPropagation(); let m = document.querySelector('.sort-menu'); if (m) { m.remove(); return; } m = document.createElement('div'); m.className = 'sort-menu'; m.innerHTML = Object.entries(SORT_LABEL).map(([k, l]) => `<button data-k="${k}" aria-pressed="${k === state.sort}">${l}</button>`).join(''); $('view-list').style.position = 'relative'; $('view-list').appendChild(m); m.querySelectorAll('button').forEach(b => b.onclick = () => { state.sort = b.dataset.k; $('f-sort').value = state.sort; state.page = 1; refresh(); m.remove(); }); document.addEventListener('click', () => m.remove(), { once: true }); };
  $('rank-tabs').querySelectorAll('button').forEach(b => b.onclick = () => { state.rankTab = b.dataset.k; renderRank(); });
  $('btn-guide').onclick = () => $('guide').showModal(); $('guide-x').onclick = () => $('guide').close();
}
fetch('../data/dashboard.json?v=' + Date.now()).then(r => r.json()).then(d => {
  D = d; units = normalize(d); bind(); refresh(); initMap();
  try { if (localStorage.getItem('gapnavi-hint')) $('tab-hint').classList.add('gone'); } catch (e) {}
  setTimeout(() => $('tab-hint').classList.add('gone'), 12000);
  requestAnimationFrame(() => moveInd('map')); window.addEventListener('resize', () => moveInd(state.view === 'favs' ? 'detail' : state.view));
  fetch('../data/infra.json?v=' + Date.now()).then(r => r.ok ? r.json() : null).then(j => { if (!j) return; infraFC = { type: 'FeatureCollection', features: j.points.filter(p => INFRA[p.layer]).map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { layer: p.layer, name: p.name } })) }; infraReady = true; if (focus) focusOn(focus); }).catch(() => {});
}).catch(e => { document.querySelector('.wrap').innerHTML = `<p class="card">데이터를 불러오지 못했습니다. ${esc(e.message)}</p>`; });
