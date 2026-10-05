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
            if disc.get("require_budget") and not (cfg["budget"]["min"] <= req <= cfg["budget"]["max"]):
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

dash = {
    "generated_at": date.today().isoformat(),
    "source": "rtms" if has_raw else "seed",
    "seed_note": seed.get("note"),
    "budget": cfg["budget"],
    "tax_rate": TAX,
    "history_from": cfg["history_from"],
    "complexes": complexes,
    "discovered": discovered,
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
