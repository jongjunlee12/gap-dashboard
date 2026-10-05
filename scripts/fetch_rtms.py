#!/usr/bin/env python3
"""국토교통부 아파트 실거래가(매매 상세 · 전월세) 수집. v1.1

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
        try:
            root = ET.fromstring(body)
        except ET.ParseError:
            raise RuntimeError(f"{kind} {lawd} {ym}: XML 아님 → {body[:300]!r}")
        code = (root.findtext(".//resultCode") or root.findtext(".//returnReasonCode") or "").strip()
        if code not in ("00", "000"):
            msg = root.findtext(".//resultMsg") or root.findtext(".//returnAuthMsg") or body[:300]
            raise RuntimeError(f"{kind} {lawd} {ym}: API 오류 code={code} msg={msg}")
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
    # Encoding 키(%2B, %3D 포함)를 넣은 경우 Decoding 키로 되돌림
    if "%" in key:
        key = urllib.parse.unquote(key)

    cfg = json.loads((ROOT / "config" / "targets.json").read_text(encoding="utf-8"))

    # 키 점검: 한 달치 1건만 조회
    try:
        probe = fetch("trade", key, cfg["regions"][0]["code"], date.today().strftime("%Y%m"), rows=1)
        print(f"키 확인 OK · 남양주 이번 달 매매 표본 {len(probe)}건")
    except RuntimeError as e:
        print(f"::error::{e}", file=sys.stderr)
        print("※ 흔한 원인: (1) 활용신청 직후라 키가 아직 활성화 전(최대 1시간) (2) 매매 '상세' 자료가 아닌 다른 API 신청 (3) 일일 한도 초과", file=sys.stderr)
        sys.exit(3)
    today = date.today()
    months = months_between(cfg["history_from"], today)
    if args.months:
        months = months[-args.months:]
    refresh = set(months[-3:])  # 신고 지연 구간은 매번 갱신

    calls, errors, skipped = 0, [], 0
    # '지금 가능' 지역을 먼저, 최근 달부터 받아서 한도에 걸려도 중요한 데이터가 먼저 남게 함
    regions = sorted(cfg["regions"], key=lambda r: r["group"] != "now")
    for region in regions:
        lawd = region["code"]
        for kind in ("trade", "rent"):
            d = RAW / kind / lawd
            d.mkdir(parents=True, exist_ok=True)
            for ym in reversed(months):
                f = d / f"{ym}.json"
                if f.exists() and ym not in refresh:
                    skipped += 1
                    continue
                if len(errors) >= 5:
                    continue  # 연속 오류(한도 초과 등)면 나머지는 다음 실행으로
                try:
                    items = fetch(kind, key, lawd, ym)
                except Exception as e:  # noqa: BLE001
                    errors.append(str(e))
                    print(f"::warning::{e}", file=sys.stderr)
                    continue
                f.write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
                calls += 1
                print(f"{kind} {region['name']} {ym}: {len(items)}건")
                time.sleep(0.2)
    print(f"완료 · API 호출 {calls}회 · 건너뜀 {skipped} · 오류 {len(errors)}")
    if errors:
        print("::warning::일부 달을 받지 못했습니다. 다음 실행에서 이어서 받습니다. 첫 오류: " + errors[0][:200], file=sys.stderr)


if __name__ == "__main__":
    main()
