/* 갭 대시보드 · data/dashboard.json 을 읽어 지도·카드·차트를 그립니다 */
const $ = id => document.getElementById(id);
const fmt = (x, d = 2) => x == null ? '—' : (Math.round(x * 10 ** d) / 10 ** d).toLocaleString('ko-KR', { maximumFractionDigits: d });
const pct = x => x == null ? '—' : (x > 0 ? '+' : '') + fmt(x, 1) + '%';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TILE = 'https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png?key=cb1_2jst_1_f20036d2498b9af9e4827f69';

let D, map, markers = {}, tip;
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
  $('complex-list').querySelectorAll('.row').forEach(b => b.onclick = () => select(b.dataset.id, true));
  Object.entries(markers).forEach(([id, m]) => m.getElement().style.display = visible(D.complexes.find(c => c.id === id)) ? '' : 'none');
}
function renderKpis() {
  const units = D.complexes.flatMap(c => c.units);
  const inB = units.filter(u => budgetState(u) === 'in').length;
  const ls = D.listings?.summary;
  $('kpis').innerHTML = `
    <div class="kpi dark"><strong>${inB}<small style="font-size:16px"> / ${units.length}</small></strong><span>예산 2.8~3.5억 안쪽 평형 (실거래 중앙값 기준)</span></div>
    <div class="kpi"><strong>${D.totals.new_trades + D.totals.new_rents}</strong><span>지난 갱신 이후 새로 신고된 매매·전세</span></div>
    <div class="kpi"><strong>${ls ? ls.total : '—'}</strong><span>현재 호가 매물 ${ls ? `· 신규 ${ls.new} · 인하 ${ls.reduced} · 사라짐 ${ls.removed}` : '(listings/ 파일 없음)'}</span></div>
    <div class="kpi"><strong>${D.source === 'rtms' ? '실거래 API' : '보고서 값'}</strong><span>${D.source === 'rtms' ? `국토부 ${D.history_from}~ · 매주 자동 갱신` : '국토부 API 연결 전 · 2026.09.30 자료'}</span></div>`;
}

/* ---------- 지도 ---------- */
function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: { version: 8, sources: { carto: { type: 'raster', tiles: [TILE], tileSize: 256, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>' } }, layers: [{ id: 'bg', type: 'raster', source: 'carto' }] },
    center: [127.12, 37.46], zoom: 9.6, pitch: 0, antialias: true,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.on('load', () => { $('map-status').textContent = ''; fitAll(); });
  map.on('error', e => { if (!map.loaded()) $('map-status').textContent = '배경지도를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.'; });
  D.complexes.forEach(c => {
    const el = document.createElement('div');
    el.className = `marker ${complexState(c)}`;
    el.innerHTML = `<i></i>${hasNew(c) ? '<b></b>' : ''}<span>${esc(c.name)}</span>`;
    el.onclick = e => { e.stopPropagation(); select(c.id, false); };
    markers[c.id] = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([c.lng, c.lat]).addTo(map);
  });
  $('fit').onclick = fitAll;
  $('view').onclick = () => { const on = $('view').getAttribute('aria-pressed') !== 'true'; $('view').setAttribute('aria-pressed', String(on)); $('view').textContent = on ? '3D 켜짐' : '2D 보기'; map.easeTo({ pitch: on ? 50 : 0, bearing: on ? -15 : 0 }); };
}
function fitAll() {
  const vis = D.complexes.filter(visible);
  if (!vis.length) return;
  const b = new maplibregl.LngLatBounds();
  vis.forEach(c => b.extend([c.lng, c.lat]));
  map.fitBounds(b, { padding: { top: 90, bottom: 70, left: 80, right: 120 }, maxZoom: 13.5, duration: 700 });
}

/* ---------- 선택 · 상세 ---------- */
function select(id, fly) {
  state.sel = id; const c = D.complexes.find(x => x.id === id);
  if (!c.units.some(u => u.area === state.area)) state.area = (c.units.find(u => u.source === 'rtms' || u.sale_median) || c.units[0]).area;
  Object.entries(markers).forEach(([k, m]) => m.getElement().classList.toggle('selected', k === id));
  renderList();
  if (fly) map.flyTo({ center: [c.lng, c.lat], zoom: Math.max(map.getZoom(), 13.5) });
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
    <div class="tags"><span class="tag">${esc(c.region_label)} · ${esc(c.umd)}</span><span class="tag">${c.households.toLocaleString()}세대 · ${c.built}년</span><span class="tag">${esc(c.station)}</span>${tags.map(t => `<span class="tag ${/의심|확인|미확보|초과/.test(t) ? 'warn' : ''}">${esc(t)}</span>`).join('')}<span class="tag">${u.source === 'rtms' ? '국토부 실거래' : '보고서 값'}</span></div>
    <div class="metric-row">
      <div><strong>${fmt(u.sale_median)}억</strong><span>매매 중앙값 · ${u.sale_n ? u.sale_n + '건' : '표본 없음'}${u.sale_min ? ` · ${fmt(u.sale_min, 1)}~${fmt(u.sale_max, 1)}` : ''}</span></div>
      <div><strong>${fmt(u.jeonse_median)}억</strong><span>전세 중앙값${u.jeonse_n ? ` · ${u.jeonse_n}건` : ''}</span></div>
      <div><strong>${u.jeonse_ratio ? fmt(u.jeonse_ratio, 1) + '%' : '—'}</strong><span>전세가율 · ${u.jeonse_ratio ? (u.jeonse_ratio >= D.budget.safe_jeonse_ratio ? '70% 안전선 위' : '안전선 아래') : '확인 필요'}</span></div>
      <div><strong style="color:${st === 'in' ? 'var(--blue)' : st === 'under' ? 'var(--green)' : '#172126'}">${fmt(u.required)}억</strong><span>필요자금 · ${stateLabel[st]}${u.gap ? ` · 갭 ${fmt(u.gap)}` : ''}</span></div>
      <div><strong>${pct(u.change_1y)}</strong><span>1년 매매 변동${u.change_3y != null ? ` · 3년 ${pct(u.change_3y)}` : ''}</span></div>
    </div>
    ${u.note ? `<p class="muted" style="font-size:15px;margin:0 0 12px">${esc(u.note)}</p>` : ''}
    <div class="detail-grid">
      <div class="card"><h4>분기별 매매 중앙값</h4><p class="sub">막대 = 중앙값 · 아래 숫자 = 거래 건수 · 전세 중앙값은 점선</p>${quarterChart(u)}</div>
      <div class="card"><h4>개별 실거래 분포 · 호가 위치</h4><p class="sub">속 빈 점 = 5층 이하 · 주황 선 = 현재 호가 · 테두리 = 새 신고</p>${tradeChart(u, asking)}</div>
      <div class="card"><h4>현재 호가 ${asking ? `<span class="badge">협상 시작선 ${fmt(asking.negotiation_start, 1)}억 미만</span>` : ''}</h4>
        ${asking ? `<p class="sub">${esc(asking.note || '')}</p><div class="metric-row" style="grid-template-columns:1fr 1fr;margin:8px 0"><div><strong>${fmt(asking.min, 2)}${asking.max > asking.min ? '~' + fmt(asking.max, 2) : ''}억</strong><span>호가 범위 · 중앙값 대비 ${pct(asking.min / u.sale_median * 100 - 100)}</span></div><div><strong>${askReq ? fmt(askReq) + '억' : '—'}</strong><span>호가로 사면 필요자금</span></div></div>` : ''}
        ${listingTable(u.listings || [], true)}</div>
      <div class="card"><h4>최근 전세 계약</h4><p class="sub">신규/갱신 구분 · 종전 보증금 = 승계 보증금의 실체</p>${rentTable(u)}</div>
    </div>`;
  bindTips($('detail'));
}

/* ---------- 차트 (inline SVG) ---------- */
function quarterChart(u) {
  const qs = (u.quarters || []).filter(q => q.sale_median || q.chg != null);
  if (!qs.length) return '<p class="muted" style="font-size:14px">분기 자료가 없습니다.</p>';
  const W = 560, H = 190, pl = 40, pr = 10, pt = 14, pb = 40, iw = W - pl - pr, ih = H - pt - pb;
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
  const W = 560, H = 190, pl = 40, pr = 10, pt = 14, pb = 26, iw = W - pl - pr, ih = H - pt - pb;
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

/* ---------- 자동 발굴 ---------- */
function renderDiscover() {
  const ds = D.discovered || [], rule = D.discovery || {};
  $('discover-meta').textContent = rule.note || '';
  if (!ds.length) { $('discover').innerHTML = `<p class="muted" style="font-size:15px">${D.source === 'rtms' ? '조건에 맞는 단지가 아직 없습니다.' : '국토부 실거래가 연결되면 수원·성남·남양주·광주 전체에서 조건에 맞는 단지를 자동으로 찾아 여기에 올립니다.'}</p>`; return; }
  $('discover').innerHTML = `<table><tr><th>지역</th><th>단지</th><th>㎡</th><th>준공</th><th>매매 중앙값</th><th>6개월 거래</th><th>전세 중앙값</th><th>전세가율</th><th>필요자금</th><th>저층 비중</th></tr>${ds.map(d => `<tr><td>${esc(d.region)} · ${esc(d.umd)}</td><td><b>${esc(d.name)}</b></td><td>${d.area}</td><td>${d.built || '—'}</td><td>${fmt(d.sale_median)}억<small style="color:#8a969d"> ${fmt(d.sale_min, 1)}~${fmt(d.sale_max, 1)}</small></td><td>${d.sale_n}건</td><td>${fmt(d.jeonse_median)}억 <small style="color:#8a969d">${d.jeonse_n}건</small></td><td>${fmt(d.jeonse_ratio, 1)}%${d.jeonse_ratio >= 70 ? ' <span class="badge">안전선 위</span>' : ''}</td><td><b style="color:var(--blue)">${fmt(d.required)}억</b></td><td>${d.low_floor_share}%</td></tr>`).join('')}</table><p class="chart-caption" style="margin-top:12px"><span>지도에 올리려면 config/targets.json 에 단지와 좌표를 추가하세요.</span><span>${ds.length}개 단지</span></p>`;
}

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
