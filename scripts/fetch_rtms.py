#!/usr/bin/env python3
"""국토교통부 아파트 실거래가(매매 상세 · 전월세) 수집.

- config/targets.json 의 regions × 월 단위로 조회
- data/raw/{trade|rent}/{lawd}/{YYYYMM}.json 에 저장 (이미 받은 과거 달은 건너뜀)
- 최근 3개월은 신고 지연(계약 후 30일)이 있어 매번 다시 받음
- 환경변수 DATA_GO_KR_KEY (Decoding 키) 필요

사용: python scripts/fetch_rtms.py [--months 6]
"""
import json, os, sys, time, argparse, urllib.parse, urllib.request
import xml.etree.ElementTree as ET
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
ENDPOINTS = {
    "trade": "https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade",
    "rent": "https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent",
}


def months_between(start: str, end: date):
    y, m = map(int, start.split("-"))
    out = []
    while (y, m) <= (end.year, end.month):
        out.append(f"{y}{m:02d}")
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


def fetch(kind, key, lawd, ym, rows=1000):
    items, page = [], 1
    while True:
        q = urllib.parse.urlencode({
            "serviceKey": key, "LAWD_CD": lawd, "DEAL_YMD": ym,
            "pageNo": page, "numOfRows": rows,
        }, safe="=+/")
        url = f"{ENDPOINTS[kind]}?{q}"
        for attempt in range(4):
            try:
                with urllib.request.urlopen(url, timeout=60) as r:
                    body = r.read()
                break
            except Exception as e:  # noqa: BLE001
                if attempt == 3:
                    raise
                time.sleep(2 * (attempt + 1))
        root = ET.fromstring(body)
        code = root.findtext(".//resultCode")
        if code not in ("00", "000"):
            msg = root.findtext(".//resultMsg")
            raise RuntimeError(f"{kind} {lawd} {ym}: API 오류 {code} {msg}")
        page_items = [{c.tag: (c.text or "").strip() for c in it} for it in root.iter("item")]
        items += page_items
        total = int(root.findtext(".//totalCount") or 0)
        if page * rows >= total or not page_items:
            break
        page += 1
    return items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--months", type=int, default=0, help="최근 N개월만 (0=history_from부터)")
    args = ap.parse_args()

    key = os.environ.get("DATA_GO_KR_KEY", "").strip()
    if not key:
        print("DATA_GO_KR_KEY 가 없습니다. 저장소 Secrets 에 등록하세요.", file=sys.stderr)
        sys.exit(2)

    cfg = json.loads((ROOT / "config" / "targets.json").read_text(encoding="utf-8"))
    today = date.today()
    months = months_between(cfg["history_from"], today)
    if args.months:
        months = months[-args.months:]
    refresh = set(months[-3:])  # 신고 지연 구간은 매번 갱신

    calls = 0
    for region in cfg["regions"]:
        lawd = region["code"]
        for kind in ("trade", "rent"):
            d = RAW / kind / lawd
            d.mkdir(parents=True, exist_ok=True)
            for ym in months:
                f = d / f"{ym}.json"
                if f.exists() and ym not in refresh:
                    continue
                items = fetch(kind, key, lawd, ym)
                f.write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
                calls += 1
                print(f"{kind} {region['name']} {ym}: {len(items)}건")
                time.sleep(0.2)
    print(f"완료 · API 호출 {calls}회")


if __name__ == "__main__":
    main()
