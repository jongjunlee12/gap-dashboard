#!/usr/bin/env python3
"""data/raw(실거래) + data/seed.json + data/listings.json → data/dashboard.json

- 대상 단지(config/targets.json)만 추려 평형(areas)별로 묶음
- 해제(취소) 거래 제외, 저층(≤5층) 표시
- 분기별 매매 중앙값·건수·범위, 전세 중앙값, 전세가율, 갭, 필요자금(갭+취득세)
- 지난 빌드 이후 새로 신고된 거래는 is_new
- 실거래가 없는 평형은 seed 값으로 채움 (source="seed")
"""
import json, re, statistics
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "dashboard.json"
SEEN = ROOT / "data" / "seen.json"   # 이미 본 거래 키 목록 (NEW 판정용)

cfg = json.loads((ROOT / "config" / "targets.json").read_text(encoding="utf-8"))
seed = json.loads((ROOT / "data" / "seed.json").read_text(encoding="utf-8"))
listings = {}
lp = ROOT / "data" / "listings.json"
if lp.exists():
    listings = json.loads(lp.read_text(encoding="utf-8"))

TAX = cfg["acquisition_tax_rate"]
propx = {"complexes": []}
pp = ROOT / "data" / "propx.json"
if pp.exists():
    propx = json.loads(pp.read_text(encoding="utf-8"))
propx_rows = propx.get("complexes", [])
LOW_FLOOR = 5
region_label = {r["code"]: r["label"] for r in cfg["regions"]}


def norm(s):
    return re.sub(r"[\s\-_()·.]", "", str(s or "")).lower().replace("이편한", "e편한")


def area_bucket(x, areas):
    """전용면적 → 가장 가까운 대표 평형 (±4㎡)"""
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    best = min(areas, key=lambda a: abs(a - x))
    return best if abs(best - x) <= 4 else None


def quarter(y, m):
    return f"{str(y)[2:]}Q{(int(m) - 1) // 3 + 1}"


def load_raw(kind, lawd):
    d = RAW / kind / lawd
    if not d.exists():
        return []
    items = []
    for f in sorted(d.glob("*.json")):
        items += json.loads(f.read_text(encoding="utf-8"))
    return items


def match_complex(item, comps):
    n = norm(item.get("aptNm"))
    for c in comps:
        if any(norm(a) in n or n in norm(a) for a in c["aliases"]):
            if not c.get("umd") or norm(c["umd"]) == norm(item.get("umdNm")) or not item.get("umdNm"):
                return c
    return None


def eok(won_man):
    try:
        return round(float(str(won_man).replace(",", "")) / 10000, 3)
    except (TypeError, ValueError):
        return None


def median(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 3) if xs else None


seen = set(json.loads(SEEN.read_text(encoding="utf-8"))) if SEEN.exists() else set()
first_run = not seen
new_seen = set()
has_raw = RAW.exists() and any(RAW.rglob("*.json"))

complexes = []
for c in cfg["complexes"]:
    units = {a: {"area": a, "trades": [], "rents": []} for a in c["areas"]}
    for it in load_raw("trade", c["region"]):
        if match_complex(it, [c]) is None:
            continue
        a = area_bucket(it.get("excluUseAr"), c["areas"])
        if a is None:
            continue
        canceled = (it.get("cdealType") or "").strip() in ("O", "Y") or bool((it.get("cdealDay") or "").strip())
        y, m, d = it.get("dealYear"), it.get("dealMonth"), it.get("dealDay")
        floor = int(it.get("floor") or 0)
        k = f"T|{c['id']}|{a}|{y}-{m}-{d}|{it.get('dealAmount')}|{floor}|{it.get('aptDong','')}"
        new_seen.add(k)
        units[a]["trades"].append({
            "date": f"{y}-{int(m):02d}-{int(d):02d}", "q": quarter(y, m),
            "price": eok(it.get("dealAmount")), "floor": floor, "low_floor": 0 < floor <= LOW_FLOOR,
            "dong": it.get("aptDong") or None, "area_exact": it.get("excluUseAr"),
            "canceled": canceled, "registered": it.get("rgstDate") or None,
            "dealing": it.get("dealingGbn") or None,
            "is_new": (k not in seen) and not first_run,
        })
    for it in load_raw("rent", c["region"]):
        if match_complex(it, [c]) is None:
            continue
        a = area_bucket(it.get("excluUseAr"), c["areas"])
        if a is None:
            continue
        monthly = float(str(it.get("monthlyRent") or "0").replace(",", "") or 0)
        y, m, d = it.get("dealYear"), it.get("dealMonth"), it.get("dealDay")
        floor = int(it.get("floor") or 0)
        k = f"R|{c['id']}|{a}|{y}-{m}-{d}|{it.get('deposit')}|{monthly}|{floor}"
        new_seen.add(k)
        units[a]["rents"].append({
            "date": f"{y}-{int(m):02d}-{int(d):02d}", "q": quarter(y, m),
            "deposit": eok(it.get("deposit")), "monthly": monthly, "floor": floor,
            "low_floor": 0 < floor <= LOW_FLOOR,
            "contract_type": it.get("contractType") or None,   # 신규/갱신
            "pre_deposit": eok(it.get("preDeposit")) if it.get("preDeposit") else None,
            "use_rrr": it.get("useRRRight") or None,
            "is_new": (k not in seen) and not first_run,
        })

    out_units = []
    for a, u in units.items():
        trades = sorted([t for t in u["trades"] if not t["canceled"]], key=lambda t: t["date"])
        rents = sorted([r for r in u["rents"] if r["monthly"] == 0], key=lambda r: r["date"])  # 순수 전세만
        qs = sorted({t["q"] for t in trades} | {r["q"] for r in rents})
        quarters = []
        for q in qs:
            tq = [t["price"] for t in trades if t["q"] == q]
            rq = [r["deposit"] for r in rents if r["q"] == q]
            quarters.append({
                "q": q, "sale_median": median(tq), "sale_n": len(tq),
                "sale_min": min(tq) if tq else None, "sale_max": max(tq) if tq else None,
                "jeonse_median": median(rq), "jeonse_n": len(rq),
            })
        for i in range(1, len(quarters)):
            p, c0 = quarters[i - 1]["sale_median"], quarters[i]["sale_median"]
            quarters[i]["chg"] = round((c0 / p - 1) * 100, 1) if p and c0 else None

        unit = {"area": a, "source": "rtms" if trades else "seed"}
        sd = next((s for s in seed["units"] if s["complex"] == c["id"] and s["area"] == a), {})
        if trades:
            latest_q = [q for q in quarters if q["sale_n"]][-1]
            # 최근 분기 표본이 적으면(<5) 최근 6개월로 보강
            recent = [t["price"] for t in trades if t["q"] == latest_q["q"]]
            if len(recent) < 5:
                cutoff = (datetime.strptime(trades[-1]["date"], "%Y-%m-%d").toordinal() - 183)
                recent = [t["price"] for t in trades if datetime.strptime(t["date"], "%Y-%m-%d").toordinal() >= cutoff]
            rr = [r["deposit"] for r in rents[-20:]] if rents else []
            unit.update({
                "sale_median": median(recent), "sale_n": len(recent),
                "sale_min": min(recent), "sale_max": max(recent),
                "jeonse_median": median(rr), "jeonse_n": len(rr),
                "quarters": quarters, "trades": trades[-80:], "rents": rents[-40:],
                "new_trades": sum(t["is_new"] for t in trades), "new_rents": sum(r["is_new"] for r in rents),
                "low_floor_share": round(100 * sum(t["low_floor"] for t in trades) / len(trades)) if trades else None,
            })
            # 1년·3년 변동 (분기 중앙값 기준)
            qm = {q["q"]: q["sale_median"] for q in quarters if q["sale_median"]}
            lq = latest_q["q"]
            def back(n):
                y, qq = int(lq[:2]), int(lq[3])
                qq -= n
                while qq <= 0:
                    qq += 4; y -= 1
                return f"{y:02d}Q{qq}"
            for lbl, n in (("change_1y", 4), ("change_3y", 12)):
                b = qm.get(back(n))
                unit[lbl] = round((qm[lq] / b - 1) * 100, 1) if b and qm.get(lq) else None
            for k in ("asking", "flags", "note"):
                if k in sd:
                    unit[k] = sd[k]
        else:
            unit.update({k: v for k, v in sd.items() if k not in ("complex", "area")})
            unit.setdefault("quarters", [])
            unit.setdefault("trades", [])
            unit.setdefault("rents", [])
        # PropX 시세 붙이기 (단지명 유사 + 같은 평형)
        px = [r for r in propx_rows if r["area"] == a and any(norm(al) in norm(r["name"]) or norm(r["name"]) in norm(al) for al in c["aliases"])]
        if px:
            px = sorted(px, key=lambda r: -(r.get("sedae") or 0))[0]
            unit["propx"] = {k: px.get(k) for k in ("mm", "mm_l", "mm_h", "js", "mm_chg", "js_chg", "sedae", "danji", "ibju", "subway", "file")}
            if not unit.get("sale_median") and px.get("mm"):
                unit.update({"sale_median": px["mm"], "sale_min": px.get("mm_l"), "sale_max": px.get("mm_h"), "source": "propx"})
            if not unit.get("jeonse_median") and px.get("js"):
                unit["jeonse_median"] = px["js"]
            if unit.get("change_1y") is None and px.get("mm_chg") is not None:
                unit["change_1y"] = px["mm_chg"]
        # 파생 지표
        sm, jm = unit.get("sale_median"), unit.get("jeonse_median")
        if sm and jm:
            unit["jeonse_ratio"] = round(100 * jm / sm, 1)
            unit["gap"] = round(sm - jm, 2)
            unit["required"] = round(sm - jm + sm * TAX, 2)
        elif unit.get("required") and sm and unit.get("jeonse_ratio"):
            unit.setdefault("gap", round(unit["required"] - sm * TAX, 2))
        # 매물(호가) 붙이기
        unit["listings"] = [
            l for l in listings.get("items", [])
            if l.get("area") == a and any(norm(al) in norm(l["complex_raw"]) or norm(l["complex_raw"]) in norm(al) for al in c["aliases"])
        ]
        out_units.append(unit)

    complexes.append({
        **{k: c[k] for k in ("id", "name", "group", "lat", "lng", "approx", "households", "built", "station", "tags", "umd")},
        "region_label": region_label[c["region"]],
        "units": out_units,
    })

# ---------- 좌표 사전 (PropX GIS) ----------
GEO = []
gp = ROOT / "data" / "geo" / "propx_gis.json"
if gp.exists():
    GEO = json.loads(gp.read_text(encoding="utf-8"))["rows"]
def _gn(s):
    s = re.sub(r"\(.*?\)", "", str(s or ""))          # 괄호 꼬리 제거
    return norm(s)
GEO_IDX = {}
for g in GEO:
    GEO_IDX.setdefault(_gn(g["name"]), []).append(g)
def geo_lookup(name, danji=None, bbox=None):
    """단지명으로 좌표 찾기: 정규화 일치 → 포함 → 세대수 근접 순"""
    n = _gn(name)
    cands = GEO_IDX.get(n) or [g for k, gs in GEO_IDX.items() if (n and (n in k or k in n) and min(len(n), len(k)) >= 4) for g in gs]
    if bbox:
        cands = [g for g in cands if bbox[0] <= g["lng"] <= bbox[2] and bbox[1] <= g["lat"] <= bbox[3]] or cands
    if not cands:
        return None
    if danji:
        cands = sorted(cands, key=lambda g: abs((g.get("qty") or 0) - danji))
    return cands[0]
SGG_BBOX = {"남양주시": (127.08, 37.55, 127.36, 37.80), "광주시": (127.15, 37.28, 127.47, 37.52),
            "수원": (126.92, 37.22, 127.11, 37.34), "성남": (127.06, 37.33, 127.21, 37.48)}
def sgg_bbox(sgg):
    for k, b in SGG_BBOX.items():
        if k in str(sgg or ""):
            return b
    return None

# ---------- 자동 발굴: 조건에 맞는 단지를 실거래 전체에서 찾기 ----------
discovered = []
disc = cfg.get("discovery", {})
if disc.get("enabled") and has_raw:
    from collections import defaultdict
    known = {norm(a) for c in cfg["complexes"] for a in c["aliases"]}
    today_ord = date.today().toordinal()
    def bucket(x):
        try:
            x = float(x)
        except (TypeError, ValueError):
            return None
        if not (disc["exclu_min"] <= x <= disc["exclu_max"]):
            return None
        return min(disc["area_buckets"], key=lambda b: abs(b - x))
    for lawd in disc["regions"]:
        T, R = defaultdict(list), defaultdict(list)
        for it in load_raw("trade", lawd):
            b = bucket(it.get("excluUseAr"))
            if b is None or (it.get("cdealType") or "").strip() in ("O", "Y") or (it.get("cdealDay") or "").strip():
                continue
            d0 = date(int(it["dealYear"]), int(it["dealMonth"]), int(it["dealDay"])).toordinal()
            T[(it.get("umdNm"), it.get("aptNm"), b)].append((d0, eok(it.get("dealAmount")), int(it.get("floor") or 0), it.get("buildYear")))
        for it in load_raw("rent", lawd):
            b = bucket(it.get("excluUseAr"))
            if b is None or float(str(it.get("monthlyRent") or 0).replace(",", "") or 0) > 0:
                continue
            d0 = date(int(it["dealYear"]), int(it["dealMonth"]), int(it["dealDay"])).toordinal()
            R[(it.get("umdNm"), it.get("aptNm"), b)].append((d0, eok(it.get("deposit"))))
        for k, ts in T.items():
            umd, apt, b = k
            if any(norm(apt) in a or a in norm(apt) for a in known):
                continue
            rec = [p for d0, p, *_ in ts if d0 >= today_ord - 183 and p]
            if len(rec) < disc["min_trades_6m"]:
                continue
            sm = median(rec)
            if sm is None or sm >= disc["max_sale_median"]:
                continue
            rr = [p for d0, p in R.get(k, []) if d0 >= today_ord - 365 and p]
            if len(rr) < disc["min_rents_12m"]:
                continue
            jm = median(rr)
            req = round(sm - jm + sm * TAX, 2)
            if disc.get("require_budget") and req > cfg["budget"]["max"]:
                continue
            yr = [t[3] for t in ts if t[3]]
            discovered.append({
                "region": region_label.get(lawd, lawd), "lawd": lawd, "umd": umd, "name": apt, "area": b,
                "sale_median": sm, "sale_n": len(rec), "sale_min": min(rec), "sale_max": max(rec),
                "jeonse_median": jm, "jeonse_n": len(rr), "jeonse_ratio": round(100 * jm / sm, 1),
                "gap": round(sm - jm, 2), "required": req, "built": yr[0] if yr else None,
                "low_floor_share": round(100 * sum(1 for t in ts if 0 < t[2] <= LOW_FLOOR) / len(ts)),
            })
    discovered.sort(key=lambda x: (x["required"], -x["jeonse_ratio"]))

if disc.get("enabled") and propx_rows:
    known = {norm(a) for c in cfg["complexes"] for a in c["aliases"]}
    have = {(d["name"], d["area"]) for d in discovered}
    for r in propx_rows:
        if not r.get("mm") or not r.get("js") or r["mm"] >= disc["max_sale_median"]:
            continue
        if any(norm(r["name"]) in a or a in norm(r["name"]) for a in known):
            continue
        if disc.get("require_budget") and r["required"] > cfg["budget"]["max"]:
            continue
        if (r["name"], r["area"]) in have:
            continue
        if (r.get("danji") or 0) < disc.get("min_danji", 0):
            continue
        try:
            if int(str(r.get("ibju") or "0")[:4]) < disc.get("min_built", 0):
                continue
        except ValueError:
            pass
        discovered.append({
            "region": r["sgg"], "umd": r["umd"], "name": r["name"], "area": r["area"], "source": "propx",
            "sale_median": r["mm"], "sale_n": None, "sale_min": r.get("mm_l"), "sale_max": r.get("mm_h"),
            "jeonse_median": r["js"], "jeonse_n": None, "jeonse_ratio": r["jeonse_ratio"], "gap": r["gap"], "required": r["required"],
            "built": (str(r.get("ibju") or "")[:4] or None), "sedae": r.get("sedae"), "danji": r.get("danji"), "subway": r.get("subway"),
            "mm_chg": r.get("mm_chg"), "low_floor_share": None,
        })
    discovered.sort(key=lambda x: (x["required"], -(x.get("jeonse_ratio") or 0)))

for d in discovered:
    g = geo_lookup(d["name"], d.get("danji"), sgg_bbox(d.get("region")))
    if g:
        d["lat"], d["lng"], d["geo_name"] = g["lat"], g["lng"], g["name"]
        if not d.get("subway") and g.get("subway"):
            d["subway"] = g["subway"]

# ---------- 주변 인프라 (OSM) : 반경 집계 · 최근접 역 ----------
import math
INFRA = []
ip = ROOT / "data" / "infra.json"
if ip.exists():
    INFRA = json.loads(ip.read_text(encoding="utf-8")).get("points", [])
def _dist_m(lat1, lng1, lat2, lng2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))
def nearby(lat, lng):
    if not INFRA or lat is None:
        return None
    out = {"r500": {}, "r1000": {}, "nearest": {}}
    for pt in INFRA:
        if abs(pt["lat"] - lat) > 0.02 or abs(pt["lng"] - lng) > 0.025:
            continue
        d = _dist_m(lat, lng, pt["lat"], pt["lng"])
        L = pt["layer"]
        if d <= 500:
            out["r500"][L] = out["r500"].get(L, 0) + 1
        if d <= 1000:
            out["r1000"][L] = out["r1000"].get(L, 0) + 1
        if d <= 2500 and (L not in out["nearest"] or d < out["nearest"][L]["d"]):
            out["nearest"][L] = {"name": pt["name"], "d": int(d), "kind": pt.get("kind")}
    return out
for c in complexes:
    c["infra"] = nearby(c["lat"], c["lng"])
for d in discovered:
    if d.get("lat") is not None:
        d["infra"] = nearby(d["lat"], d["lng"])

dash = {
    "generated_at": date.today().isoformat(),
    "source": "rtms" if has_raw else "seed",
    "seed_note": seed.get("note"),
    "budget": cfg["budget"],
    "tax_rate": TAX,
    "history_from": cfg["history_from"],
    "complexes": complexes,
    "discovered": discovered,
    "propx": {"generated_at": propx.get("generated_at"), "files": propx.get("files", []), "n": len(propx_rows)},
    "infra": {"n": len(INFRA), "fetched": (json.loads(ip.read_text(encoding="utf-8")).get("fetched") if ip.exists() else None)},
    "discovery": disc,
    "listings": {k: listings.get(k) for k in ("date", "file", "prev_file", "summary", "removed")} if listings else None,
    "totals": {
        "new_trades": sum(u.get("new_trades", 0) for c in complexes for u in c["units"]),
        "new_rents": sum(u.get("new_rents", 0) for c in complexes for u in c["units"]),
    },
}
OUT.write_text(json.dumps(dash, ensure_ascii=False, indent=1), encoding="utf-8")
if has_raw:
    SEEN.write_text(json.dumps(sorted(seen | new_seen)), encoding="utf-8")
print(f"dashboard.json 생성 · source={dash['source']} · 단지 {len(complexes)} · 신규 거래 {dash['totals']['new_trades']}")
