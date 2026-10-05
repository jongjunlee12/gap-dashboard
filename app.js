/* 갭 대시보드 · data/dashboard.json 을 읽어 지도·카드·차트를 그립니다 */
const $ = id => document.getElementById(id);
const fmt = (x, d = 2) => x == null ? '—' : (Math.round(x * 10 ** d) / 10 ** d).toLocaleString('ko-KR', { maximumFractionDigits: d });
const pct = x => x == null ? '—' : (x > 0 ? '+' : '') + fmt(x, 1) + '%';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TILE = 'https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png?key=cb1_2jst_1_f20036d2498b9af9e4827f69';

let D, map, markers = {}, tip, discMarkers = [];
const state = { group: 'all', onlyBudget: false, onlyNew: false, sel: null, area: null };

function budgetState(u) {
  if (u.required == null) return 'na';
  if (u.required < D.budget.min) return 'under';
  if (u.required > D.budget.max) return 'over';
  return 'in';
}
const RANK = { in: 0, under: 1, over: 2, na: 3 };
const complexState = c => c.units.map(budgetState).sort((a, b) => RANK[a] - RANK[b])[0] || 'na';
const hasNew = c => c.units.some(u => (u.new_trades || 0) + (u.new_rents || 0) > 0 || (u.listings || []).some(l => l.status === 'new' || l.status === 'reduced'));
function visible(c) {
  if (state.group !== 'all' && c.group !== state.group) return false;
  if (state.onlyBudget && !c.units.some(u => budgetState(u) === 'in')) return false;
  if (state.onlyNew && !hasNew(c)) return false;
  return true;
}
const stateLabel = { in: '예산 안', under: '예산 여유', over: '예산 초과', na: '자료 없음' };

/* ---------- 목록 · KPI ---------- */
function renderList() {
  const vis = D.complexes.filter(visible);
  $('cnt-complex').textContent = vis.length;
  $('cnt-budget').textContent = vis.flatMap(c => c.units).filter(u => budgetState(u) === 'in').length;
  $('complex-list').innerHTML = vis.map(c => {
    const st = complexState(c);
    const best = c.units.filter(u => u.required != null).sort((a, b) => a.required - b.required)[0];
    return `<button class="row ${c.id === state.sel ? 'selected' : ''}" data-id="${c.id}"><span><i class="dot ${st}"></i>${esc(c.name)}${hasNew(c) ? '<span class="badge new">NEW</span>' : ''}<small>${esc(c.region_label)} · ${c.units.map(u => u.area + '㎡').join(' · ')} · ${c.households.toLocaleString()}세대${c.approx ? ' · ≈' : ''}</small></span><span class="amt">${best ? fmt(best.required) + '억' : '—'}<small>${best ? best.area + '㎡ · ' + (best.jeonse_ratio ? fmt(best.jeonse_ratio, 0) + '%' : '전세 미확인') : '확인 필요'}</small></span></button>`;
  }).join('') || '<p class="muted">조건에 맞는 단지가 없습니다.</p>';
  $('complex-list').querySelectorAll('.row').forEach(b => { b.onclick = () => select(b.dataset.id, true); b.onmouseenter = () => markers[b.dataset.id]?.getElement().classList.add('hover'); b.onmouseleave = () => markers[b.dataset.id]?.getElement().classList.remove('hover'); });
  Object.entries(markers).forEach(([id, m]) => m.getElement().style.display = visible(D.complexes.find(c => c.id === id)) ? '' : 'none');
  scheduleLabels();
}
function renderKpis() {
  const units = D.complexes.flatMap(c => c.units);
  const inB = units.filter(u => budgetState(u) === 'in').length;
  const ls = D.listings?.summary;
  $('kpis').innerHTML = `
    <div class="kpi dark"><strong>${inB}<small style="font-size:16px"> / ${units.length}</small></strong><span>예산 2.8~3.5억 안쪽 평형 (실거래 중앙값 기준)</span></div>
    <div class="kpi"><strong>${D.totals.new_trades + D.totals.new_rents}</strong><span>지난 갱신 이후 새로 신고된 매매·전세</span></div>
    <div class="kpi"><strong>${ls ? ls.total : '—'}</strong><span>현재 호가 매물 ${ls ? `· 신규 ${ls.new} · 인하 ${ls.reduced} · 사라짐 ${ls.removed}` : '(listings/ 파일 없음)'}</span></div>
    <div class="kpi"><strong>${D.source === 'rtms' ? '실거래 API' : (D.propx && D.propx.n ? 'PropX 시세' : '보고서 값')}</strong><span>${D.source === 'rtms' ? `국토부 ${D.history_from}~ · 매주 자동 갱신` : (D.propx && D.propx.n ? `PropX ${D.propx.n}개 단지·평형 · ${D.propx.generated_at}` : '국토부 API 연결 전 · 2026.09.30 자료')}</span></div>`;
}

/* ---------- 지도 ---------- */
function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: { version: 8, sources: { carto: { type: 'raster', tiles: [TILE], tileSize: 256, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>' } }, layers: [{ id: 'bg', type: 'raster', source: 'carto' }] },
    center: [127.12, 37.46], zoom: 9.6, pitch: 0, antialias: true,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.on('load', () => { $('map-status').textContent = ''; if (!focus) fitAll(); setTimeout(() => map.resize(), 300); });
  map.on('moveend', scheduleLabels); map.on('zoomend', scheduleLabels); map.on('resize', scheduleLabels); map.on('idle', scheduleLabels); map.on('movestart', () => { if (labelLayer) { labelLayer.innerHTML = ''; labelSvg.innerHTML = ''; } });
  window.addEventListener('resize', () => { map.resize(); scheduleLabels(); });
  window.addEventListener('orientationchange', () => setTimeout(() => { map.resize(); scheduleLabels(); }, 400));
  if (!maplibregl.supported || maplibregl.supported({ failIfMajorPerformanceCaveat: false }) === false) $('map-status').textContent = '이 기기 브라우저가 지도를 그릴 수 없습니다(WebGL 꺼짐). 최신 크롬·사파리로 열어 주세요.';
  map.on('error', e => { if (!map.loaded()) $('map-status').textContent = '배경지도를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.'; });
  D.complexes.forEach(c => {
    const el = document.createElement('div');
    el.className = `marker ${complexState(c)}`;
    el.innerHTML = `<i></i>${hasNew(c) ? '<b></b>' : ''}<span>${esc(c.name)}</span>`;
    el.onclick = e => { e.stopPropagation(); select(c.id, false); };
    markers[c.id] = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([c.lng, c.lat]).addTo(map);
  });
  renderDiscMarkers();
  initInfra();
  $('fit').onclick = () => { clearFocus(); fitAll(); };
  // 휴대폰: 지도를 탭하면 전체 화면 ↔ 원위치
  const toggleFull = () => { if (innerWidth > 900) return; document.body.classList.toggle('map-full'); const on = document.body.classList.contains('map-full'); $('full').textContent = on ? '✕ 닫기' : '⤢ 크게'; setTimeout(() => { map.resize(); scheduleLabels(); }, 50); };
  map.on('click', e => { if (innerWidth > 900) return; if (e.originalEvent.target.closest('.marker, button, .chip, .focus-info')) return; toggleFull(); });
  $('full').onclick = e => { e.stopPropagation(); toggleFull(); };
  $('view').onclick = () => { const on = $('view').getAttribute('aria-pressed') !== 'true'; $('view').setAttribute('aria-pressed', String(on)); $('view').textContent = on ? '3D 켜짐' : '2D 보기'; map.easeTo({ pitch: on ? 50 : 0, bearing: on ? -15 : 0 }); };
}
function fitAll() {
  const vis = D.complexes.filter(visible);
  if (!vis.length) return;
  const b = new maplibregl.LngLatBounds();
  vis.forEach(c => b.extend([c.lng, c.lat]));
  map.fitBounds(b, { padding: { top: 90, bottom: 70, left: 80, right: 120 }, maxZoom: 13.5, duration: 700 });
}

/* ---------- 주변 인프라 레이어 (OSM) ---------- */
const INFRA_STYLE = { transit: ['교통', '#172126'], culture: ['문화', '#7a4fd1'], public: ['공공', '#1a9e6c'], education: ['교육', '#d9a21b'], medical: ['의료', '#c8322f'] };
const infraOn = { transit: true, culture: false, public: false, education: innerWidth > 900, medical: false };
let infraLoaded = false, infraFC = null, focus = null;
function distM(a, b) { const R = 6371000, p1 = a[1] * Math.PI / 180, p2 = b[1] * Math.PI / 180, dp = (b[1] - a[1]) * Math.PI / 180, dl = (b[0] - a[0]) * Math.PI / 180; const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
function circlePoly(center, r, n = 64) { const [lng, lat] = center; const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110574; const ring = []; for (let i = 0; i <= n; i++) { const t = i / n * 2 * Math.PI; ring.push([lng + r * Math.cos(t) / kx, lat + r * Math.sin(t) / ky]); } return { type: 'Feature', properties: { r }, geometry: { type: 'Polygon', coordinates: [ring] } }; }
/* 단지를 고르면 반경 500m·1km 안 시설만 보여주고, 라벨도 그 안에서만 */
function focusInfra(lng, lat, fit) {
  if (!infraLoaded) { focus = { lng, lat }; return; }
  focus = { lng, lat };
  Object.keys(INFRA_STYLE).forEach(k => { infraOn[k] = true; const b = document.querySelector(`#infra-chips .chip[data-k="${k}"]`); if (b) b.setAttribute('aria-pressed', 'true'); });
  const near = infraFC.features.filter(f => { const d = distM([lng, lat], f.geometry.coordinates); if (d > 1000) return false; f.properties.d = Math.round(d); return true; });
  map.getSource('infra-near').setData({ type: 'FeatureCollection', features: near });
  map.getSource('focus-ring').setData({ type: 'FeatureCollection', features: [circlePoly([lng, lat], 1000), circlePoly([lng, lat], 500)] });
  Object.keys(INFRA_STYLE).forEach(k => { map.setLayoutProperty('infra-' + k, 'visibility', 'none'); map.setLayoutProperty('infra-near-' + k, 'visibility', infraOn[k] ? 'visible' : 'none'); });
  if (fit) { const b = new maplibregl.LngLatBounds(); circlePoly([lng, lat], 1000, 16).geometry.coordinates[0].forEach(c => b.extend(c)); map.fitBounds(b, { padding: 30, duration: 600, maxZoom: 15.5 }); }
  const cnt = { r500: near.filter(f => f.properties.d <= 500).length, r1000: near.length };
  $('focus-info').innerHTML = `<b>반경 1km</b> 시설 ${cnt.r1000}개 · 500m 안 ${cnt.r500}개 <button class="mini" id="focus-clear">전체 보기</button>`;
  $('focus-clear').onclick = clearFocus;
  scheduleLabels();
}
function clearFocus() {
  focus = null;
  if (!infraLoaded) return;
  Object.keys(INFRA_STYLE).forEach(k => { infraOn[k] = (k === 'transit') || (k === 'education' && innerWidth > 900); const b = document.querySelector(`#infra-chips .chip[data-k="${k}"]`); if (b) b.setAttribute('aria-pressed', String(infraOn[k])); });
  map.getSource('infra-near').setData({ type: 'FeatureCollection', features: [] });
  map.getSource('focus-ring').setData({ type: 'FeatureCollection', features: [] });
  Object.keys(INFRA_STYLE).forEach(k => { map.setLayoutProperty('infra-' + k, 'visibility', infraOn[k] ? 'visible' : 'none'); map.setLayoutProperty('infra-near-' + k, 'visibility', 'none'); });
  $('focus-info').innerHTML = '';
  scheduleLabels();
}
function initInfra() {
  fetch('data/infra.json?v=' + Date.now()).then(r => r.ok ? r.json() : null).then(j => {
    if (!j || !j.points?.length) return;
    const fc = { type: 'FeatureCollection', features: j.points.map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { layer: p.layer, name: p.name, kind: p.kind || '' } })) };
    infraFC = fc;
    const add = () => {
      map.addSource('infra', { type: 'geojson', data: fc });
      map.addSource('infra-near', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('focus-ring', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'focus-fill', type: 'fill', source: 'focus-ring', paint: { 'fill-color': '#0064e0', 'fill-opacity': ['case', ['==', ['get', 'r'], 500], 0.10, 0.05] } });
      map.addLayer({ id: 'focus-line', type: 'line', source: 'focus-ring', paint: { 'line-color': '#0064e0', 'line-width': ['case', ['==', ['get', 'r'], 500], 1.5, 1], 'line-dasharray': [3, 2], 'line-opacity': 0.7 } });
      Object.entries(INFRA_STYLE).forEach(([k, [label, col]]) => {
        const paint = { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, k === 'transit' ? 7 : 5], 'circle-color': col, 'circle-opacity': 0.85, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 };
        map.addLayer({ id: 'infra-' + k, type: 'circle', source: 'infra', filter: ['==', ['get', 'layer'], k], layout: { visibility: infraOn[k] ? 'visible' : 'none' }, paint });
        map.addLayer({ id: 'infra-near-' + k, type: 'circle', source: 'infra-near', filter: ['==', ['get', 'layer'], k], layout: { visibility: 'none' }, paint: { ...paint, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 4, 15, k === 'transit' ? 9 : 7] } });
        ['infra-' + k, 'infra-near-' + k].forEach(id => {
          map.on('mouseenter', id, () => map.getCanvas().style.cursor = 'pointer');
          map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; tip.style.display = 'none'; });
          map.on('mousemove', id, e => { const p = e.features[0].properties; tip.style.display = 'block'; tip.textContent = `${label} · ${p.name}${p.d ? ' · ' + p.d + 'm' : ''}`; tip.style.left = e.originalEvent.clientX + 14 + 'px'; tip.style.top = e.originalEvent.clientY + 14 + 'px'; });
        });
      });
      infraLoaded = true;
      if (focus) focusInfra(focus.lng, focus.lat, true); else map.once('idle', scheduleLabels);
    };
    map.loaded() ? add() : map.on('load', add);
    $('infra-chips').innerHTML = Object.entries(INFRA_STYLE).map(([k, [label, col]]) => `<button class="chip" data-k="${k}" aria-pressed="${infraOn[k]}"><i style="background:${col}"></i>${label}</button>`).join('') + `<span class="chip-note">${j.points.length.toLocaleString()}개 시설 · OSM</span>`;
    $('infra-chips').querySelectorAll('.chip').forEach(b => b.onclick = () => { const k = b.dataset.k; infraOn[k] = !infraOn[k]; b.setAttribute('aria-pressed', infraOn[k]); if (infraLoaded) map.setLayoutProperty((focus ? 'infra-near-' : 'infra-') + k, 'visibility', infraOn[k] ? 'visible' : 'none'); setTimeout(scheduleLabels, 150); });
  }).catch(() => {});
}
function infraLine(inf) {
  if (!inf) return '';
  const r = inf.r1000 || {}, n = inf.nearest || {};
  const parts = Object.entries(INFRA_STYLE).map(([k, [label]]) => `<span class="tag"><i class="dot" style="background:${INFRA_STYLE[k][1]}"></i>${label} ${r[k] || 0}${n[k] ? ` · ${esc(n[k].name)} ${n[k].d}m` : ''}</span>`);
  return `<div class="tags infra-tags"><span class="tag" style="background:#172126;color:#fff;border-color:#172126">반경 1km</span>${parts.join('')}</div>`;
}

/* ---------- 라벨 충돌 회피 (단지 라벨 + 시설 라벨·지시선) ---------- */
let labelTimer = null, labelLayer = null, labelSvg = null;
function ensureLabelLayer() {
  if (labelLayer) return;
  const c = map.getContainer();
  labelSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); labelSvg.setAttribute('class', 'infra-lines');
  labelLayer = document.createElement('div'); labelLayer.className = 'infra-labels';
  c.appendChild(labelSvg); c.appendChild(labelLayer);
}
const LAYER_PRI = { transit: 0, education: 1, medical: 2, culture: 3, public: 4 };
function placeLabels() {
  if (!map) return;
  ensureLabelLayer();
  const W = map.getContainer().clientWidth, H = map.getContainer().clientHeight;
  const placed = [];
  // 지도 위 UI(칩·범례·버튼·요약 상자)가 차지한 영역은 라벨 금지
  const cr = map.getContainer().getBoundingClientRect();
  ['.map-top', '.infra-chips', '.map-legend', '.focus-info', '.maplibregl-ctrl-top-right'].forEach(sel => { const el = map.getContainer().parentElement.querySelector(sel) || document.querySelector(sel); if (!el || !el.offsetParent) return; const r = el.getBoundingClientRect(); placed.push({ x1: r.left - cr.left - 4, y1: r.top - cr.top - 4, x2: r.right - cr.left + 4, y2: r.bottom - cr.top + 4 }); });
  const overlaps = box => placed.some(b => !(box.x2 < b.x1 || box.x1 > b.x2 || box.y2 < b.y1 || box.y1 > b.y2));
  // 1) 단지 라벨 (DOM span)
  const items = [];
  D.complexes.forEach(c => { const m = markers[c.id]; if (!m || m.getElement().style.display === 'none') return; items.push({ el: m.getElement(), lngLat: [c.lng, c.lat], pri: c.id === state.sel ? 0 : 1, text: c.name }); });
  discMarkers.forEach((m, i) => items.push({ el: m.getElement(), lngLat: m.getLngLat().toArray(), pri: 2 + i / 1000, text: m.getElement().querySelector('span').textContent }));
  const fs = 13;
  items.sort((a, b) => a.pri - b.pri).forEach(it => {
    const p = map.project(it.lngLat), span = it.el.querySelector('span');
    if (!span) return;
    if (p.x < -40 || p.y < -40 || p.x > W + 40 || p.y > H + 40) { span.style.display = 'none'; return; }
    const w = Math.min(220, it.text.length * fs * 0.95 + 14), h = fs + 10;
    const box = { x1: p.x + 14, y1: p.y - h / 2, x2: p.x + 14 + w, y2: p.y + h / 2 };
    if (overlaps(box) && it.pri >= 1) { span.style.display = 'none'; return; }
    span.style.display = ''; placed.push(box);
    placed.push({ x1: p.x - 10, y1: p.y - 10, x2: p.x + 10, y2: p.y + 10 }); // 마커 자체도 점유
  });
  // 2) 시설 라벨: 보이는 레이어의 화면 안 점 중 우선순위대로, 화면이 붐비지 않을 만큼만
  labelLayer.innerHTML = ''; labelSvg.innerHTML = '';
  if (!infraLoaded || !focus || map.getZoom() < 12) return;
  const vis = Object.keys(INFRA_STYLE).filter(k => infraOn[k] && map.getLayer('infra-near-' + k));
  if (!vis.length) return;
  let feats = [];
  try { feats = map.queryRenderedFeatures({ layers: vis.map(k => 'infra-near-' + k) }); } catch (e) { return; }
  const seen = new Set();
  const pts = feats.map(f => ({ layer: f.properties.layer, name: f.properties.name, d: f.properties.d || 0, lngLat: f.geometry.coordinates })).filter(f => { const k = f.layer + f.name; if (seen.has(k)) return false; seen.add(k); return true; });
  const maxN = W < 600 ? 14 : 40;   // 반경 안에서 겹치지 않는 만큼만
  pts.sort((a, b) => ((a.d <= 500) === (b.d <= 500) ? (LAYER_PRI[a.layer] - LAYER_PRI[b.layer]) || a.d - b.d : a.d <= 500 ? -1 : 1));
  const sfs = Math.round(fs * 0.7); // 아파트명의 0.7배
  let n = 0;
  for (const pt of pts) {
    if (n >= maxN) break;
    const p = map.project(pt.lngLat);
    if (p.x < 0 || p.y < 0 || p.x > W || p.y > H) continue;
    const text = pt.name.length > 14 ? pt.name.slice(0, 13) + '…' : pt.name;
    const w = text.length * sfs * 0.95 + 10, h = sfs + 6;
    // 후보 위치: 오른쪽 → 왼쪽 → 위 → 아래 → 대각선(지시선 길게)
    const cands = [[10, -h / 2], [-w - 10, -h / 2], [-w / 2, -h - 10], [-w / 2, 10], [22, -h - 18], [-w - 22, -h - 18], [22, 18], [-w - 22, 18]];
    let hit = null;
    for (const [dx, dy] of cands) {
      const box = { x1: p.x + dx, y1: p.y + dy, x2: p.x + dx + w, y2: p.y + dy + h };
      if (box.x1 < 2 || box.y1 < 2 || box.x2 > W - 2 || box.y2 > H - 2) continue;
      if (!overlaps(box)) { hit = box; break; }
    }
    if (!hit) continue;
    placed.push(hit); n++;
    const col = INFRA_STYLE[pt.layer][1];
    const el = document.createElement('div'); el.className = 'ilabel'; el.style.cssText = `left:${hit.x1}px;top:${hit.y1}px;font-size:${sfs}px;border-color:${col};color:${col}`; el.textContent = text;
    labelLayer.appendChild(el);
    // 지시선: 라벨이 점에서 떨어져 있으면 그림
    const cx = Math.max(hit.x1, Math.min(hit.x2, p.x)), cy = Math.max(hit.y1, Math.min(hit.y2, p.y));
    if (Math.hypot(cx - p.x, cy - p.y) > 6) {
      const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      ln.setAttribute('x1', p.x); ln.setAttribute('y1', p.y); ln.setAttribute('x2', cx); ln.setAttribute('y2', cy); ln.setAttribute('stroke', col);
      labelSvg.appendChild(ln);
    }
  }
}
function scheduleLabels() { clearTimeout(labelTimer); labelTimer = setTimeout(placeLabels, 80); }

/* ---------- 선택 · 상세 ---------- */
function select(id, fly) {
  state.sel = id; const c = D.complexes.find(x => x.id === id);
  if (!c.units.some(u => u.area === state.area)) state.area = (c.units.find(u => u.source === 'rtms' || u.sale_median) || c.units[0]).area;
  Object.entries(markers).forEach(([k, m]) => m.getElement().classList.toggle('selected', k === id));
  renderList();
  if (fly) map.flyTo({ center: [c.lng, c.lat], zoom: Math.max(map.getZoom(), 13.5), padding: { top: 60, bottom: 40 } });
  focusInfra(c.lng, c.lat, true);
  renderDetail(c);
  if (fly) requestAnimationFrame(() => $('detail-section').scrollIntoView({ behavior: 'smooth', block: 'start' }));
}
function renderDetail(c) {
  const u = c.units.find(x => x.area === state.area);
  $('detail-title').textContent = `${c.name} ${u.area}㎡`;
  $('unit-tabs').innerHTML = c.units.map(x => `<button aria-pressed="${x.area === u.area}" data-a="${x.area}">${x.area}㎡</button>`).join('');
  $('unit-tabs').querySelectorAll('button').forEach(b => b.onclick = () => { state.area = +b.dataset.a; renderDetail(c); });
  const st = budgetState(u);
  const asking = u.asking || null;
  const askReq = asking && u.jeonse_median ? asking.min - u.jeonse_median + asking.min * D.tax_rate : null;
  const tags = [...(c.tags || []), ...(u.flags || [])];
  $('detail').innerHTML = `
    <div class="tags"><span class="tag">${esc(c.region_label)} · ${esc(c.umd)}</span><span class="tag">${c.households.toLocaleString()}세대 · ${c.built}년</span><span class="tag">${esc(c.station)}</span>${tags.map(t => `<span class="tag ${/의심|확인|미확보|초과/.test(t) ? 'warn' : ''}">${esc(t)}</span>`).join('')}<span class="tag">${{ rtms: '국토부 실거래', propx: 'PropX 시세', seed: '보고서 값' }[u.source] || u.source}</span></div>
    <div class="metric-row">
      <div><strong>${fmt(u.sale_median)}억</strong><span>매매 중앙값 · ${u.sale_n ? u.sale_n + '건' : '표본 없음'}${u.sale_min ? ` · ${fmt(u.sale_min, 1)}~${fmt(u.sale_max, 1)}` : ''}</span></div>
      <div><strong>${fmt(u.jeonse_median)}억</strong><span>전세 중앙값${u.jeonse_n ? ` · ${u.jeonse_n}건` : ''}</span></div>
      <div><strong>${u.jeonse_ratio ? fmt(u.jeonse_ratio, 1) + '%' : '—'}</strong><span>전세가율 · ${u.jeonse_ratio ? (u.jeonse_ratio >= D.budget.safe_jeonse_ratio ? '70% 안전선 위' : '안전선 아래') : '확인 필요'}</span></div>
      <div><strong style="color:${st === 'in' ? 'var(--blue)' : st === 'under' ? 'var(--green)' : '#172126'}">${fmt(u.required)}억</strong><span>필요자금 · ${stateLabel[st]}${u.gap ? ` · 갭 ${fmt(u.gap)}` : ''}</span></div>
      <div><strong>${pct(u.change_1y)}</strong><span>1년 매매 변동${u.change_3y != null ? ` · 3년 ${pct(u.change_3y)}` : ''}</span></div>
    </div>
    ${infraLine(c.infra)}
    ${u.note ? `<p class="muted" style="font-size:15px;margin:0 0 12px">${esc(u.note)}</p>` : ''}
    <div class="detail-grid">
      <div class="card"><h4>분기별 매매 중앙값</h4><p class="sub">막대 = 중앙값 · 아래 숫자 = 거래 건수 · 전세 중앙값은 점선</p>${quarterChart(u)}</div>
      <div class="card"><h4>개별 실거래 분포 · 호가 위치</h4><p class="sub">속 빈 점 = 5층 이하 · 주황 선 = 현재 호가 · 테두리 = 새 신고</p>${tradeChart(u, asking)}</div>
      <div class="card"><h4>현재 호가 ${asking ? `<span class="badge">협상 시작선 ${fmt(asking.negotiation_start, 1)}억 미만</span>` : ''}</h4>
        ${asking ? `<p class="sub">${esc(asking.note || '')}</p><div class="metric-row" style="grid-template-columns:1fr 1fr;margin:8px 0"><div><strong>${fmt(asking.min, 2)}${asking.max > asking.min ? '~' + fmt(asking.max, 2) : ''}억</strong><span>호가 범위 · 중앙값 대비 ${pct(asking.min / u.sale_median * 100 - 100)}</span></div><div><strong>${askReq ? fmt(askReq) + '억' : '—'}</strong><span>호가로 사면 필요자금</span></div></div>` : ''}
        ${listingTable(u.listings || [], true)}</div>
      <div class="card"><h4>PropX 시세 ${u.propx ? `<span class="badge gray">${esc(u.propx.file || '')}</span>` : ''}</h4>
        ${u.propx ? `<p class="sub">부동산114 단지 시세 · 세대수 가중 평균 · ${u.propx.sedae ?? '—'}세대${u.propx.subway ? ' · ' + esc(u.propx.subway) : ''}</p><div class="metric-row" style="grid-template-columns:1fr 1fr 1fr;margin:8px 0"><div><strong>${fmt(u.propx.mm)}억</strong><span>매매 평균 · ${fmt(u.propx.mm_l, 1)}~${fmt(u.propx.mm_h, 1)}</span></div><div><strong>${fmt(u.propx.js)}억</strong><span>전세 평균</span></div><div><strong>${pct(u.propx.mm_chg)}</strong><span>매매 1년 · 전세 ${pct(u.propx.js_chg)}</span></div></div>${u.source === 'rtms' && u.propx.mm && u.sale_median ? `<p class="sub">실거래 중앙값 대비 시세 ${pct(u.propx.mm / u.sale_median * 100 - 100)}</p>` : ''}` : '<p class="muted" style="font-size:15px">propx/ 폴더에 PropX 단지정보 엑셀을 올리면 표시됩니다.</p>'}</div>
      <div class="card"><h4>최근 전세 계약</h4><p class="sub">신규/갱신 구분 · 종전 보증금 = 승계 보증금의 실체</p>${rentTable(u)}</div>
    </div>`;
  bindTips($('detail'));
}

/* ---------- 차트 (inline SVG) ---------- */
function quarterChart(u) {
  const qs = (u.quarters || []).filter(q => q.sale_median || q.chg != null);
  if (!qs.length) return '<p class="muted" style="font-size:14px">분기 자료가 없습니다.</p>';
  const W = 560, H = 210, pl = 40, pr = 10, pt = 14, pb = 40, iw = W - pl - pr, ih = H - pt - pb;
  const vals = qs.flatMap(q => [q.sale_median, q.jeonse_median]).filter(Boolean);
  const hasVals = vals.length > 0;
  const lo = hasVals ? Math.min(...vals) * 0.85 : 0, hi = hasVals ? Math.max(...vals) * 1.05 : 10;
  const y = v => pt + ih - (v - lo) / (hi - lo) * ih;
  const bw = iw / qs.length;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}">`;
  [0, .5, 1].forEach(f => { const v = lo + (hi - lo) * f; s += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="#e3e8ec"/><text x="${pl - 6}" y="${y(v) + 4}" font-size="10" fill="#7b878e" text-anchor="end">${fmt(v, 1)}</text>`; });
  qs.forEach((q, i) => {
    const x = pl + i * bw + bw * .2, w = bw * .6;
    if (q.sale_median) s += `<rect x="${x}" y="${y(q.sale_median)}" width="${w}" height="${pt + ih - y(q.sale_median)}" rx="4" fill="${i === qs.length - 1 ? '#0064e0' : '#9cbdf2'}" data-tip="${q.q} 매매 중앙값 ${fmt(q.sale_median)}억 · ${q.sale_n || 0}건${q.chg != null ? ' · 전분기 대비 ' + pct(q.chg) : ''}"/>`;
    else if (q.chg != null) s += `<text x="${x + w / 2}" y="${pt + ih - 6}" font-size="10.5" fill="#57676f" text-anchor="middle">${pct(q.chg)}</text>`;
    if (q.jeonse_median) s += `<line x1="${x}" x2="${x + w}" y1="${y(q.jeonse_median)}" y2="${y(q.jeonse_median)}" stroke="#172126" stroke-width="2" stroke-dasharray="3 2" data-tip="${q.q} 전세 중앙값 ${fmt(q.jeonse_median)}억 · ${q.jeonse_n}건"/>`;
    s += `<text x="${x + w / 2}" y="${H - 22}" font-size="10.5" fill="#57676f" text-anchor="middle">${q.q}</text><text x="${x + w / 2}" y="${H - 8}" font-size="10" fill="#9aa6ad" text-anchor="middle">${q.sale_n != null ? 'n=' + q.sale_n : ''}</text>`;
  });
  return s + '</svg>';
}
function tradeChart(u, asking) {
  const ts = u.trades || [];
  if (!ts.length) return `<p class="muted" style="font-size:14px">${u.source === 'seed' ? '국토부 API가 연결되면 개별 거래가 표시됩니다.' : '해당 평형 거래가 없습니다.'}${u.sale_min ? `<br>보고서 범위 ${fmt(u.sale_min, 1)}~${fmt(u.sale_max, 1)}억 · ${u.sale_n}건` : ''}</p>`;
  const W = 560, H = 210, pl = 40, pr = 10, pt = 14, pb = 26, iw = W - pl - pr, ih = H - pt - pb;
  const t0 = Date.parse(ts[0].date), t1 = Math.max(Date.parse(ts[ts.length - 1].date), t0 + 86400e3 * 30);
  const prices = ts.map(t => t.price).concat(asking ? [asking.min, asking.max] : []).concat((u.listings || []).map(l => l.price).filter(Boolean));
  const lo = Math.min(...prices) * 0.96, hi = Math.max(...prices) * 1.04;
  const x = d => pl + (Date.parse(d) - t0) / (t1 - t0) * iw, y = v => pt + ih - (v - lo) / (hi - lo) * ih;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}">`;
  [0, .5, 1].forEach(f => { const v = lo + (hi - lo) * f; s += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="#e3e8ec"/><text x="${pl - 6}" y="${y(v) + 4}" font-size="10" fill="#7b878e" text-anchor="end">${fmt(v, 1)}</text>`; });
  if (u.sale_median) s += `<line x1="${pl}" x2="${W - pr}" y1="${y(u.sale_median)}" y2="${y(u.sale_median)}" stroke="#0064e0" stroke-dasharray="4 3"/><text x="${W - pr}" y="${y(u.sale_median) - 4}" font-size="10" fill="#0064e0" text-anchor="end">중앙 ${fmt(u.sale_median)}</text>`;
  (asking ? [asking.min, asking.max].filter((v, i, a) => a.indexOf(v) === i) : []).concat((u.listings || []).map(l => l.price).filter(Boolean)).forEach(v => { s += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="#d9641e" stroke-width="1.5"/><text x="${pl + 4}" y="${y(v) - 4}" font-size="10" fill="#d9641e">호가 ${fmt(v, 2)}</text>`; });
  ts.forEach(t => { s += `<circle cx="${x(t.date)}" cy="${y(t.price)}" r="${t.is_new ? 6 : 4.5}" fill="${t.low_floor ? '#fff' : '#0064e0'}" stroke="${t.is_new ? '#d9641e' : '#0064e0'}" stroke-width="${t.is_new ? 2.5 : 1.5}" data-tip="${t.date} · ${fmt(t.price)}억 · ${t.floor}층${t.dong ? ' · ' + esc(t.dong) + '동' : ''}${t.low_floor ? ' · 저층' : ''}${t.is_new ? ' · 새 신고' : ''}${t.dealing ? ' · ' + esc(t.dealing) : ''}"/>`; });
  const months = []; for (let d = new Date(t0); d <= new Date(t1); d.setMonth(d.getMonth() + 1)) months.push(new Date(d));
  months.filter((d, i) => months.length <= 8 || i % Math.ceil(months.length / 8) === 0).forEach(d => s += `<text x="${x(d.toISOString().slice(0, 10))}" y="${H - 8}" font-size="10" fill="#9aa6ad" text-anchor="middle">${d.getFullYear().toString().slice(2)}.${d.getMonth() + 1}</text>`);
  return s + '</svg>';
}
function rentTable(u) {
  const rs = (u.rents || []).slice(-8).reverse();
  if (!rs.length) return `<p class="muted" style="font-size:14px">${u.jeonse_median ? `보고서 전세 중앙값 ${fmt(u.jeonse_median)}억` : '전세 자료 없음 · 현장 확인 필요'}</p>`;
  return `<table><tr><th>계약일</th><th>보증금</th><th>층</th><th>구분</th><th>종전</th></tr>${rs.map(r => `<tr class="${r.is_new ? 'new' : ''}"><td>${r.date}${r.is_new ? '<span class="badge new">NEW</span>' : ''}</td><td>${fmt(r.deposit)}억</td><td>${r.floor}${r.low_floor ? ' <span class="badge gray">저층</span>' : ''}</td><td>${esc(r.contract_type || '—')}${r.use_rrr && r.use_rrr !== '-' ? ' · 갱신권' : ''}</td><td>${r.pre_deposit ? fmt(r.pre_deposit) + '억' : '—'}</td></tr>`).join('')}</table>`;
}
function listingTable(items, compact) {
  if (!items.length) return `<p class="muted" style="font-size:14px">${compact ? '등록된 매물 파일이 없습니다. listings/ 에 올리면 여기에 표시됩니다.' : 'listings/ 폴더에 매물 파일이 없습니다. _template.csv 형식으로 올려 주세요.'}</p>`;
  const badge = s => ({ new: '<span class="badge new">신규</span>', reduced: '<span class="badge green">인하</span>', removed: '<span class="badge gray">사라짐</span>' }[s] || '');
  return `<table><tr>${compact ? '' : '<th>단지</th><th>㎡</th>'}<th>동·층</th><th>유형</th><th>호가</th><th>전세</th><th>출처</th><th>비고</th></tr>${items.map(l => `<tr class="${l.status}">${compact ? '' : `<td>${esc(l.complex_raw)}</td><td>${l.area ?? ''}</td>`}<td>${l.dong ? esc(l.dong) + '동 ' : ''}${l.floor ?? '?'}층${l.floor && l.floor <= 5 ? ' <span class="badge gray">저층</span>' : ''}</td><td>${l.type}</td><td>${l.price ? fmt(l.price) + '억' : '—'}${l.prev_price ? `<small style="color:#8a969d"> ← ${fmt(l.prev_price)}</small>` : ''} ${badge(l.status)}</td><td>${l.jeonse ? fmt(l.jeonse) + '억' : '—'}</td><td>${esc(l.source || '')}</td><td style="font-size:13px;color:#596971">${esc(l.note || '')}</td></tr>`).join('')}</table>`;
}

/* ---------- 비교 산점도 ---------- */
function renderScatter() {
  const pts = D.complexes.flatMap(c => c.units.filter(u => u.required != null && u.jeonse_ratio).map(u => ({ c, u })));
  const W = 1100, H = 380, pl = 50, pr = 30, pt = 24, pb = 44, iw = W - pl - pr, ih = H - pt - pb;
  const xs = pts.map(p => p.u.jeonse_ratio), ys = pts.map(p => p.u.required);
  const x0 = Math.min(55, ...xs) - 2, x1 = Math.max(72, ...xs) + 2, y0 = Math.min(1.4, ...ys) - .2, y1 = Math.max(4.3, ...ys) + .2;
  const x = v => pl + (v - x0) / (x1 - x0) * iw, y = v => pt + ih - (v - y0) / (y1 - y0) * ih;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}">`;
  s += `<rect x="${pl}" y="${y(D.budget.max)}" width="${iw}" height="${y(D.budget.min) - y(D.budget.max)}" fill="#0064e014"/><text x="${pl + 8}" y="${y(D.budget.max) + 14}" font-size="11" fill="#0064e0" font-weight="700">예산 ${D.budget.min}~${D.budget.max}억</text>`;
  s += `<line x1="${x(70)}" x2="${x(70)}" y1="${pt}" y2="${pt + ih}" stroke="#172126" stroke-dasharray="4 3"/><text x="${x(70) + 5}" y="${pt + 12}" font-size="11" fill="#172126">70% 안전선</text>`;
  for (let v = Math.ceil(y0 * 2) / 2; v <= y1; v += .5) s += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="#e3e8ec"/><text x="${pl - 8}" y="${y(v) + 4}" font-size="10.5" fill="#7b878e" text-anchor="end">${v.toFixed(1)}</text>`;
  for (let v = Math.ceil(x0 / 5) * 5; v <= x1; v += 5) s += `<text x="${x(v)}" y="${H - 20}" font-size="10.5" fill="#7b878e" text-anchor="middle">${v}%</text>`;
  s += `<text x="${W / 2}" y="${H - 4}" font-size="11" fill="#57676f" text-anchor="middle">전세가율 (%)</text><text transform="translate(12 ${H / 2}) rotate(-90)" font-size="11" fill="#57676f" text-anchor="middle">필요자금 (억)</text>`;
  pts.forEach(({ c, u }) => {
    const st = budgetState(u), col = st === 'in' ? '#0064e0' : st === 'under' ? '#1a9e6c' : '#8a969d';
    s += `<g style="cursor:pointer" data-sel="${c.id}" data-area="${u.area}"><circle cx="${x(u.jeonse_ratio)}" cy="${y(u.required)}" r="${c.group === 'after_1231' ? 7 : 9}" fill="${c.group === 'after_1231' ? '#fff' : col}" stroke="${col}" stroke-width="2.5" data-tip="${esc(c.name)} ${u.area}㎡ · 전세가율 ${fmt(u.jeonse_ratio, 1)}% · 필요자금 ${fmt(u.required)}억${c.group === 'after_1231' ? ' · 12.31 해제 시' : ''}"/><text x="${x(u.jeonse_ratio) + 12}" y="${y(u.required) + 4}" font-size="11.5" fill="#172126" font-weight="600">${esc(c.name)} ${u.area}</text></g>`;
  });
  $('scatter').innerHTML = s + '</svg>';
  $('scatter').querySelectorAll('[data-sel]').forEach(g => g.onclick = () => { state.area = +g.dataset.area; select(g.dataset.sel, true); });
  bindTips($('scatter'));
}

/* ---------- 매물 전체 ---------- */
function renderListings() {
  const L = D.listings;
  $('listing-meta').textContent = L && L.file ? `${L.date} · ${L.file}${L.prev_file ? ` ↔ ${L.prev_file}` : ''}` : '';
  const all = D.complexes.flatMap(c => c.units.flatMap(u => u.listings || [])).concat(L?.removed || []);
  $('listings').innerHTML = listingTable(all, false);
}

/* ---------- 발굴 단지 마커 (작은 점) ---------- */
function discFiltered() {
  const all = D.discovered || [];
  return all.filter(d => (d.danji || d.sedae || 0) >= dstate.minDanji && (+d.built || 0) >= dstate.minBuilt && (d.jeonse_ratio || 0) >= dstate.minRatio && (dstate.region === 'all' || d.region === dstate.region));
}
function renderDiscMarkers() {
  discMarkers.forEach(m => m.remove()); discMarkers = [];
  if (!map || !$('show-disc')?.checked) return;
  discFiltered().forEach(d => {
    if (d.lat == null) return;
    const st = d.required < D.budget.min ? 'under' : 'in';
    const el = document.createElement('div');
    el.className = `marker disc ${st}`;
    el.innerHTML = `<i></i><span>${esc(d.name)} ${d.area}</span>`;
    el.title = `${d.name} ${d.area}㎡ · 필요자금 ${fmt(d.required)}억`;
    el.onclick = e => { e.stopPropagation(); showDisc(d); };
    discMarkers.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([d.lng, d.lat]).addTo(map));
  });
  scheduleLabels();
}
function showDisc(d) {
  focusInfra(d.lng, d.lat, true);
  $('map-status').innerHTML = `<b>${esc(d.name)} ${d.area}㎡</b> · ${esc(d.region)} ${esc(d.umd)} · 매매 ${fmt(d.sale_median)}억 · 전세 ${fmt(d.jeonse_median)}억 · 전세가율 ${fmt(d.jeonse_ratio, 1)}% · <b style="color:var(--blue)">필요자금 ${fmt(d.required)}억</b>${d.sedae ? ` · ${d.sedae}세대` : ''}${d.built ? ` · ${d.built}년` : ''}${d.subway ? ` · ${esc(d.subway)}` : ''}${d.infra?.nearest?.transit ? ` · 🚇 ${esc(d.infra.nearest.transit.name)} ${d.infra.nearest.transit.d}m` : ''}${d.infra?.nearest?.education ? ` · 🏫 ${d.infra.nearest.education.d}m` : ''} <button class="mini" id="disc-add">후보에 추가 요청</button>`;
  $('disc-add').onclick = () => { navigator.clipboard?.writeText(`${d.name} ${d.area}㎡ (${d.region} ${d.umd}) 후보 추가`); $('disc-add').textContent = '복사됨 · 채팅에 붙여넣기'; };
  const row = [...document.querySelectorAll('.disc-row')].find(r => r.dataset.name === d.name && r.dataset.area == d.area);
  if (row) { document.querySelectorAll('.disc-row.hl').forEach(r => r.classList.remove('hl')); row.classList.add('hl'); row.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}

/* ---------- 자동 발굴 ---------- */
function flyToUmd(umd, name) {
  const c = D.complexes.find(x => x.umd === umd);
  $('map-status').textContent = `${name} · ${umd} — 단지 좌표 미등록. 같은 동의 후보 단지 위치로 이동했습니다.`;
  setTimeout(() => { if ($('map-status').textContent.startsWith(name)) $('map-status').textContent = ''; }, 4000);
  if (c) map.flyTo({ center: [c.lng, c.lat], zoom: 14 });
}
const dstate = { minDanji: 300, minBuilt: 2010, minRatio: 0, sort: 'score', region: 'all', showOnMap: true };
/* 매력도 점수: 예산 3.5억에 가까울수록(돈을 최대한 활용) + 전세가율 높을수록 + 1년 상승 + 세대수 */
function score(d) {
  const B = D.budget;
  const fit = d.required <= B.max ? Math.max(0, 1 - (B.max - d.required) / (B.max - B.min)) : 0; // 2.8~3.5 안에서 3.5에 가까울수록 1
  const ratio = Math.min(1, Math.max(0, ((d.jeonse_ratio || 0) - 55) / 20));                      // 55%→0, 75%→1
  const chg = Math.min(1, Math.max(0, ((d.mm_chg ?? 0) + 5) / 20));                                // -5%→0, +15%→1
  const size = Math.min(1, Math.log10(Math.max(100, d.danji || d.sedae || 100)) - 2) / 1;          // 100세대→0, 1000세대→1
  const built = Math.min(1, Math.max(0, ((+d.built || 2000) - 2005) / 20));
  return Math.round(100 * (0.4 * fit + 0.25 * ratio + 0.15 * chg + 0.1 * size + 0.1 * built));
}
function renderDiscover() {
  const all = D.discovered || [], rule = D.discovery || {};
  $('discover-meta').textContent = rule.note || '';
  const regions = [...new Set(all.map(d => d.region))];
  const ds = all.filter(d => (d.danji || d.sedae || 0) >= dstate.minDanji && (+d.built || 0) >= dstate.minBuilt && (d.jeonse_ratio || 0) >= dstate.minRatio && (dstate.region === 'all' || d.region === dstate.region))
    .map(d => ({ ...d, score: score(d) })).sort((a, b) => dstate.sort === 'score' ? b.score - a.score : dstate.sort === 'ratio' ? (b.jeonse_ratio || 0) - (a.jeonse_ratio || 0) : dstate.sort === 'chg' ? (b.mm_chg || 0) - (a.mm_chg || 0) : dstate.sort === 'danji' ? (b.danji || 0) - (a.danji || 0) : a.required - b.required);
  const ctl = `<div class="disc-filters"><label>지역 <select id="df-region"><option value="all">전체</option>${regions.map(r => `<option ${dstate.region === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label><label>세대수 <select id="df-danji">${[0, 200, 300, 500, 1000].map(v => `<option value="${v}" ${dstate.minDanji === v ? 'selected' : ''}>${v ? v + '세대↑' : '전체'}</option>`).join('')}</select></label><label>입주 <select id="df-built">${[0, 2000, 2010, 2015, 2020].map(v => `<option value="${v}" ${dstate.minBuilt === v ? 'selected' : ''}>${v ? v + '년↑' : '전체'}</option>`).join('')}</select></label><label>전세가율 <select id="df-ratio">${[0, 60, 65, 70].map(v => `<option value="${v}" ${dstate.minRatio === v ? 'selected' : ''}>${v ? v + '%↑' : '전체'}</option>`).join('')}</select></label><label>정렬 <select id="df-sort">${[['score', '추천순 (예산 활용·전세가율·상승·규모)'], ['required', '필요자금 낮은 순'], ['ratio', '전세가율 높은 순'], ['chg', '1년 상승 순'], ['danji', '세대수 순']].map(([v, l]) => `<option value="${v}" ${dstate.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label><label class="check" style="margin:0"><input type="checkbox" id="show-disc" ${dstate.showOnMap ? 'checked' : ''}> 지도에 표시</label><span class="muted-s">${ds.length} / ${all.length}개</span></div>`;
  if (!all.length) { $('discover').innerHTML = `<p class="muted" style="font-size:15px">propx/ 폴더에 PropX 단지정보 엑셀을 올리거나 국토부 실거래가 연결되면 조건에 맞는 단지를 자동으로 찾아 여기에 올립니다.</p>`; return; }
  $('discover').innerHTML = ctl + (ds.length ? `<table class="disc"><tr><th>추천</th><th>지역</th><th>단지</th><th>㎡</th><th>입주</th><th>매매</th><th>표본</th><th>전세</th><th>전세가율</th><th>필요자금</th><th>1년 변동</th><th>출처</th></tr>${ds.map((d, i) => `<tr class="disc-row" data-name="${esc(d.name)}" data-umd="${esc(d.umd)}" data-area="${d.area}" data-i="${i}" style="cursor:pointer"><td><b style="color:${d.score >= 70 ? 'var(--blue)' : '#596971'}">${d.score}</b>${i < 3 ? ' <span class="badge">TOP</span>' : ''}</td><td>${esc(d.region)} · ${esc(d.umd)}</td><td><b>${esc(d.name)}</b></td><td>${d.area}</td><td>${d.built || '—'}${d.sedae ? `<small style="color:#8a969d"> · ${d.sedae}세대</small>` : ''}</td><td>${fmt(d.sale_median)}억<small style="color:#8a969d"> ${d.sale_min ? fmt(d.sale_min, 1) + '~' + fmt(d.sale_max, 1) : ''}</small></td><td>${d.sale_n != null ? d.sale_n + '건' : '시세'}</td><td>${fmt(d.jeonse_median)}억${d.jeonse_n != null ? ` <small style="color:#8a969d">${d.jeonse_n}건</small>` : ''}</td><td>${fmt(d.jeonse_ratio, 1)}%${d.jeonse_ratio >= 70 ? ' <span class="badge">안전선 위</span>' : ''}</td><td><b style="color:${d.required < D.budget.min ? 'var(--green)' : 'var(--blue)'}">${fmt(d.required)}억</b></td><td>${d.mm_chg != null ? pct(d.mm_chg) : (d.low_floor_share != null ? '저층 ' + d.low_floor_share + '%' : '—')}</td><td><span class="badge ${d.source === 'propx' ? 'gray' : ''}">${d.source === 'propx' ? 'PropX 시세' : '실거래'}</span></td></tr>`).join('')}</table><p class="chart-caption" style="margin-top:12px"><span>추천 점수 = 예산 3.5억 활용도 40% · 전세가율 25% · 1년 상승 15% · 세대수 10% · 연식 10%. 행을 누르면 지도에서 그 단지로 이동합니다.</span><span>${ds.length}개 단지</span></p>` : '<p class="muted" style="font-size:15px;margin-top:12px">조건에 맞는 단지가 없습니다. 필터를 풀어 보세요.</p>');
  const sd = $('show-disc'); if (sd) sd.onchange = () => { dstate.showOnMap = sd.checked; renderDiscMarkers(); };
  ['region', 'danji', 'built', 'ratio', 'sort'].forEach(k => { const el = $('df-' + k); if (el) el.onchange = () => { const v = el.value; dstate[{ region: 'region', danji: 'minDanji', built: 'minBuilt', ratio: 'minRatio', sort: 'sort' }[k]] = (k === 'region' || k === 'sort') ? v : +v; renderDiscover(); }; });
  $('discover').querySelectorAll('.disc-row').forEach(r => r.onclick = () => { const d = ds[+r.dataset.i]; d.lat != null ? showDisc(d) : flyToUmd(d.umd, d.name); });
  renderDiscMarkers();
}

/* ---------- 차트 전체 화면 토글 (PC·휴대폰) ---------- */
function toggleZoom(el) {
  const on = el.classList.toggle('zoomed');
  document.body.classList.toggle('has-zoom', on);
  let x = el.querySelector('.zoom-close');
  if (on && !x) { x = document.createElement('button'); x.className = 'zoom-close'; x.textContent = '✕ 닫기'; x.onclick = e => { e.stopPropagation(); toggleZoom(el); }; el.appendChild(x); }
  if (!on && x) x.remove();
}
document.addEventListener('click', e => {
  const svg = e.target.closest('svg.chart'); if (!svg) return;
  if (e.target.closest('[data-sel], [data-tip]') && !svg.closest('.zoomed')) return;   // 점·막대 클릭은 원래 동작
  const box = svg.closest('.card, .panel'); if (box) toggleZoom(box);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.zoomed').forEach(el => toggleZoom(el)); });

/* ---------- 툴팁 · 필터 ---------- */
function bindTips(root) {
  root.querySelectorAll('[data-tip]').forEach(el => {
    el.addEventListener('mousemove', e => { tip.style.display = 'block'; tip.textContent = el.dataset.tip; tip.style.left = Math.min(e.clientX + 14, innerWidth - 270) + 'px'; tip.style.top = e.clientY + 14 + 'px'; });
    el.addEventListener('mouseleave', () => tip.style.display = 'none');
  });
}
function bindFilters() {
  $('group-seg').querySelectorAll('button').forEach(b => b.onclick = () => { state.group = b.dataset.g; $('group-seg').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); renderList(); fitAll(); });
  $('only-budget').onchange = e => { state.onlyBudget = e.target.checked; renderList(); };
  $('only-new').onchange = e => { state.onlyNew = e.target.checked; renderList(); };
  $('info').onclick = () => $('data-dialog').showModal(); $('close-info').onclick = () => $('data-dialog').close();
}

fetch('data/dashboard.json?v=' + Date.now()).then(r => r.json()).then(d => {
  D = d; tip = document.createElement('div'); tip.className = 'tip'; document.body.appendChild(tip);
  $('updated').textContent = `갱신 ${D.generated_at} · ${D.source === 'rtms' ? '국토부 실거래' : '보고서 seed'}`;
  const nT = D.complexes.flatMap(c => c.units).reduce((a, u) => a + (u.trades || []).length, 0);
  $('data-stats').textContent = `단지 ${D.complexes.length} · 평형 ${D.complexes.flatMap(c => c.units).length} · 보유 매매 거래 ${nT}건 · 생성 ${D.generated_at}${D.seed_note ? ' · ' + D.seed_note : ''}`;
  renderKpis(); initMap(); renderList(); renderScatter(); renderDiscover(); renderListings(); bindFilters();
  select('dasan-natural3', false);
}).catch(e => { $('map-status').textContent = 'data/dashboard.json 을 읽지 못했습니다. ' + e; });
