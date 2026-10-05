# 갭 대시보드 · 3억으로 사는 아파트

남양주 다산 · 경기 광주 · (12.31 토허 해제 시) 수원·성남 후보 단지의 **신고된 실거래**와 **현재 호가**를 지도 위에서 보는 대시보드입니다.

- 공개 주소: https://jongjunlee12.github.io/gap-dashboard/
- 배경지도: OpenStreetMap · CARTO light (MapLibre)

## 운영 절차 (평소에 할 일)

### 1. 매물(호가) 파일 올리기 — 수동, 원하는 주기로
1. 유료 매물 사이트에서 엑셀/CSV로 내려받습니다.
2. GitHub에서 `listings/` 폴더 → **Add file → Upload files** 로 올립니다. 파일명에 날짜를 넣어 주세요. 예: `2026-10-12.xlsx`
3. 몇 분 뒤 대시보드에 반영됩니다. 직전 파일과 비교해 **신규 · 인하 · 사라짐**이 자동 표시됩니다.

열 이름은 자동 인식합니다(단지명 / 전용면적 / 동 / 층 / 거래유형 / 호가 / 전세보증금 / 등록일 / 출처 / 비고). 형식 예시는 `listings/_template.csv` 를 보세요. 사이트별 변환이 필요하면 `scripts/listings.py` 의 `COLS` 를 수정합니다.

### 2. 실거래 — 자동 (매주 월요일 새벽)
국토교통부 실거래가 API에서 매매(상세)·전월세를 받아 옵니다. 지난 갱신 이후 새로 신고된 거래에는 **NEW** 가 붙습니다.
수동으로 돌리려면 **Actions → 데이터 갱신 → Run workflow**.

## 처음 한 번만

1. [data.go.kr](https://www.data.go.kr) 에서 아래 두 API 활용신청 (자동승인)
   - 국토교통부_아파트 매매 실거래가 상세 자료
   - 국토교통부_아파트 전월세 실거래가 자료
2. 마이페이지의 **일반 인증키(Decoding)** 를 복사
3. 이 저장소 **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `DATA_GO_KR_KEY` · Secret: 인증키
4. **Actions → 데이터 갱신 → Run workflow** 로 첫 수집 (2023-10 이후 전체, 10분 안팎)

키가 없을 때는 `data/seed.json`(2026.09.30 보고서 값)으로 화면을 만듭니다.

## 구조
```
index.html · style.css · app.js   화면
config/targets.json               대상 지역(법정동코드) · 단지 · 평형 · 좌표 · 예산
data/seed.json                    보고서 수치 (API 전 대체값, 호가 메모)
data/raw/{trade,rent}/{코드}/     실거래 원본 (자동)
data/dashboard.json               화면이 읽는 결과 (자동)
listings/                         매물 파일 올리는 곳
scripts/fetch_rtms.py             실거래 수집
scripts/listings.py               매물 파일 정규화·비교
scripts/build.py                  지표 계산 → dashboard.json
.github/workflows/update.yml      자동 실행
```

## 단지 추가·좌표 수정
`config/targets.json` 의 `complexes` 에 항목을 추가하고 `aliases`(실거래 단지명에 포함되는 문자열), `areas`, `lat/lng` 를 적습니다. `approx: true` 인 단지는 추정 좌표이므로 네이버지도 등에서 확인한 좌표로 바꾸면 ≈ 표시가 사라집니다.

## 지표 정의
- 매매 중앙값: 최근 분기 거래 중앙값 (표본 5건 미만이면 최근 6개월). 해제 거래 제외.
- 전세 중앙값: 월세 0원인 최근 계약 20건의 중앙값.
- 필요자금 = 매매 중앙값 − 전세 중앙값 + 매매 중앙값 × 1.1%(취득세). 중개비·등기비 별도.
- 저층: 5층 이하. 예산: 2.8~3.5억 · 안전선: 전세가율 70%.

판단 근거 자료이며 매수 권유가 아닙니다.

## PropX(부동산114) 단지 시세 올리기 — 수시로
1. PropX → 지역현황 → 주거형상품 → **지역별 단지정보** → 지역 선택(남양주시 / 광주시 / 수원 각 구 / 성남 각 구) → 조회 → **엑셀저장**
2. 받은 파일을 그대로 `propx/` 폴더에 올립니다 (GitHub → propx → Add file → Upload files). 파일명은 자유. 같은 지역의 새 파일을 올리면 새 것이 우선합니다.
3. 몇 분 뒤 대시보드에 단지별 매매·전세 평균, 상·하한, 1년 변동률이 반영되고, 조건(20~34평 · 12억 미만 · 필요자금 3.5억 이하)에 맞는 단지가 자동 발굴 표에 올라옵니다.
