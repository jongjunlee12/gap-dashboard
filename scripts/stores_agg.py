#!/usr/bin/env python3
"""오픈업(MyBIZMAP) 점포 월매출 CSV → 점포별 집계 data/raw/stores.json.gz

사용: python scripts/stores_agg.py <매출 CSV ...>   (여러 번 실행하면 누적·갱신)

- 최근 12개월(자료의 마지막 달 기준) 월평균 매출(만원)·거래건수, 업종, 좌표
- 상권 분석 무관 계정 제외 (PG·할부·렌탈·보험·온라인·본사·조합 등). 병원·약국·음식·편의점은 상호로 제외하지 않음.
- 제외 내역은 data/raw/stores_excluded.csv 에 기록
"""
import csv, gzip, json, re, sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "raw" / "stores.json.gz"
EXC = ROOT / "data" / "raw" / "stores_excluded.csv"
csv.field_size_limit(1 << 30)

PG = ["한국정보통신", "KICC", "KSNET", "갤럭시아", "이니시스", "KCP", "다날", "모빌리언스", "헥토", "세틀뱅크", "스마트로", "토스페이먼츠", "나이스페이", "페이먼츠"]
FIN = ["할부", "캐피탈", "손해보험", "생명보험", "보증보험", "화재보험", "렌탈", "렌터카", "무이자", "저축은행", "대부업", "리스금융"]
ORG = ["본사", "관리부", "사무소", "영업소", "조합", "연합회", "협회", "재단", "공단", "위원회", "(주)관리"]
KEEP_CAT = re.compile(r"음식|카페|커피|편의점|미용|헬스|사진|숙박|병원|의원|약국|한의|치과|슈퍼|마트|제과|분식|주점|호프|학원|세탁|문구|서점|안경|꽃|정육|반찬|노래|PC|당구|스크린|키즈|피부|네일")
ONLINE_CAT = re.compile(r"인터넷쇼핑|홈쇼핑|통신판매|온라인|전자상거래")
WHOLESALE_CAT = re.compile(r"도매|의약품판매|의료용품|자동차판매|자동차신차|중고차")


def num(x):
    try:
        return float(str(x).replace(",", ""))
    except ValueError:
        return 0.0


def main():
    files = [Path(a) for a in sys.argv[1:]]
    if not files:
        print("매출 CSV 경로를 주세요"); return
    stores = {}
    if OUT.exists():
        with gzip.open(OUT, "rt", encoding="utf-8") as f:
            for s in json.load(f)["stores"]:
                stores[s["id"]] = s
    for fp in files:
        acc = defaultdict(lambda: {"m": {}, "meta": None})
        last = "000000"
        with open(fp, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                sid = r["점포ID"]; ym = r["기준월"]
                if ym > last:
                    last = ym
                a = acc[sid]
                if a["meta"] is None:
                    a["meta"] = {"id": sid, "name": r["매장명"], "cat1": r["업종대분류"], "cat2": r["업종중분류"], "cat3": r["업종소분류"], "brand": r.get("브랜드") or "",
                                 "lng": num(r["경도"]), "lat": num(r["위도"]), "umd": r["행정동"], "addr": r["주소"], "file": fp.name}
                a["m"][ym] = (num(r["매출액_만원"]), num(r["거래건수"]), num(r["재방문고객"]), num(r["신규고객"]))
        # 최근 12개월 창
        y, m = int(last[:4]), int(last[4:])
        win = set()
        for i in range(12):
            win.add(f"{y}{m:02d}")
            m -= 1
            if m == 0:
                y, m = y - 1, 12
        n_in, n_ex = 0, 0
        with open(EXC, "a", encoding="utf-8", newline="") as ef:
            w = csv.writer(ef)
            if ef.tell() == 0:
                w.writerow(["점포ID", "매장명", "업종", "월평균매출_만원", "사유", "파일"])
            for sid, a in acc.items():
                meta = a["meta"]
                months = [v for k, v in a["m"].items() if k in win]
                if not months:
                    continue
                sales = sum(v[0] for v in months) / 12
                cnt = sum(v[1] for v in months) / 12
                name, cat = meta["name"], f'{meta["cat1"]}/{meta["cat2"]}/{meta["cat3"]}'
                reason = None
                face = KEEP_CAT.search(cat)
                if ONLINE_CAT.search(cat) or (not face and "온라인" in name):
                    reason = "온라인·통신판매"
                elif not face and sales >= 3000 and any(k in name for k in PG):
                    reason = "PG·VAN"
                elif not face and sales >= 3000 and any(k in name for k in FIN):
                    reason = "할부·렌탈·보험"
                elif not face and sales >= 10000 and any(k in name for k in ORG):
                    reason = "본사·단체"
                elif WHOLESALE_CAT.search(cat) and sales >= 10000:
                    reason = "도매·차량판매"
                elif not face and sales >= 10000 and cnt > 0 and sales / cnt >= 100 and not re.search(r"자동차|가구|병원|의원|학원|예식|여행|항공|주유", cat):
                    reason = "건당 100만원 이상 · B2B 의심"
                if reason:
                    n_ex += 1
                    w.writerow([sid, name, cat, round(sales), reason, fp.name])
                    continue
                n_in += 1
                stores[sid] = {**meta, "sales": round(sales), "cnt": round(cnt), "months": len(months), "last": last,
                               "revisit": round(sum(v[2] for v in months) / max(1, len(months)), 1)}
        print(f"{fp.name}: 점포 {len(acc)} → 반영 {n_in} · 제외 {n_ex} · 최근월 {last}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(OUT, "wt", encoding="utf-8") as f:
        json.dump({"stores": list(stores.values())}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"stores.json.gz: {len(stores)} 점포")


if __name__ == "__main__":
    main()
