#!/usr/bin/env python3
"""주변 인프라 수집 (OpenStreetMap · Overpass API) → data/infra.json

- 대상 영역: config/targets.json 의 복합 bbox (남양주·광주·수원·성남)
- 5개 레이어: 교통(지하철·전철역) · 문화(도서관·공연장·박물관·영화관) · 공공(시청·구청·주민센터·경찰·소방·우체국) · 교육(초중고·대학) · 의료(병원·종합병원)
- 30일 안에 받은 파일이 있으면 건너뜀 (--force 로 강제)
"""
import json, sys, time, urllib.request, urllib.parse
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "infra.json"
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]

# 영역: (south, west, north, east)
BBOXES = {
    "남양주": (37.55, 127.08, 37.80, 127.36),
    "광주": (37.28, 127.15, 37.52, 127.47),
    "수원": (37.22, 126.92, 37.34, 127.11),
    "성남": (37.33, 127.06, 37.48, 127.21),
}
LAYERS = {
    "transit": {"label": "교통", "q": ['node["railway"="station"]', 'node["public_transport"="station"]["station"!="bus"]', 'node["railway"="halt"]']},
    "culture": {"label": "문화", "q": ['nwr["amenity"~"^(library|theatre|arts_centre|cinema|community_centre)$"]', 'nwr["tourism"~"^(museum|gallery)$"]']},
    "public": {"label": "공공", "q": ['nwr["amenity"~"^(townhall|police|fire_station|post_office|courthouse)$"]', 'nwr["office"="government"]']},
    "education": {"label": "교육", "q": ['nwr["amenity"~"^(school|university|college)$"]']},
    "medical": {"label": "의료", "q": ['nwr["amenity"~"^(hospital|clinic)$"]', 'nwr["healthcare"="hospital"]']},
}


def query(bbox, layer):
    s, w, n, e = bbox
    body = "".join(f'{q}({s},{w},{n},{e});' for q in LAYERS[layer]["q"])
    ql = f'[out:json][timeout:120];({body});out center tags;'
    data = urllib.parse.urlencode({"data": ql}).encode()
    last = None
    for url in OVERPASS:
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, data=data, headers={"User-Agent": "gap-dashboard/1.0"})
                with urllib.request.urlopen(req, timeout=180) as r:
                    return json.loads(r.read())
            except Exception as e:  # noqa: BLE001
                last = e
                print(f"::warning::{url} {layer} 시도 {attempt + 1}: {type(e).__name__} {str(e)[:120]}", file=sys.stderr)
                time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"Overpass 실패: {last}")


def main():
    force = "--force" in sys.argv
    if OUT.exists() and not force:
        meta = json.loads(OUT.read_text(encoding="utf-8"))
        if (date.today() - date.fromisoformat(meta.get("fetched", "2000-01-01"))).days < 30:
            print(f"infra.json 최근({meta['fetched']}) · 건너뜀")
            return
    pts, seen, failed = [], set(), []
    for region, bbox in BBOXES.items():
        for layer in LAYERS:
            try:
                j = query(bbox, layer)
            except RuntimeError as e:
                failed.append(f"{region}/{layer}")
                print(f"::warning::{region} {layer} 건너뜀: {e}", file=sys.stderr)
                continue
            for el in j.get("elements", []):
                lat = el.get("lat") or (el.get("center") or {}).get("lat")
                lon = el.get("lon") or (el.get("center") or {}).get("lon")
                if lat is None:
                    continue
                t = el.get("tags", {})
                name = t.get("name:ko") or t.get("name")
                if not name:
                    continue
                key = (layer, round(lat, 5), round(lon, 5))
                if key in seen:
                    continue
                seen.add(key)
                kind = t.get("railway") or t.get("amenity") or t.get("tourism") or t.get("office") or t.get("healthcare") or ""
                # 학교 세분
                if layer == "education":
                    kind = "university" if t.get("amenity") in ("university", "college") else ("elementary" if "초등" in name else "middle" if "중학" in name else "high" if "고등" in name else "school")
                if layer == "medical" and t.get("amenity") == "clinic":
                    continue  # 의원은 너무 많아 제외, 병원급만
                pts.append({"layer": layer, "kind": kind, "name": name, "lat": round(lat, 6), "lng": round(lon, 6), "region": region,
                            **({"line": t["line"]} if t.get("line") else {}), **({"operator": t["operator"]} if t.get("operator") else {})})
            print(f"{region} {LAYERS[layer]['label']}: 누적 {len(pts)}")
            time.sleep(2)
    if not pts:
        print("::error::인프라를 하나도 받지 못했습니다. 기존 파일 유지.", file=sys.stderr)
        sys.exit(1)
    OUT.write_text(json.dumps({"fetched": date.today().isoformat(), "failed": failed, "source": "OpenStreetMap contributors (ODbL) · Overpass API",
                               "layers": {k: v["label"] for k, v in LAYERS.items()}, "points": pts}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"infra.json: {len(pts)}개 시설 · 실패 {failed}")


if __name__ == "__main__":
    main()
