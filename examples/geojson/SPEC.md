# GeoJSON 뷰어

`.geojson` 파일을 외부 네트워크나 추가 라이브러리 없이 SVG 지도로 표시한다.
형식 기준은 [RFC 7946](https://www.rfc-editor.org/rfc/rfc7946)이다.

## 공개 API와 감지

- `parsers/geojson`: `parseGeoJson(input, options)`와 문서·도형 타입.
- `viewers/geojson`: `mountGeoJsonViewer(input, container, context, options)`,
  `GEOJSON_VIEWER_META`, `geoJsonViewerCss`, 파서 재노출.
- `registry`: `GEOJSON_VIEWER_DESCRIPTOR`, `looksLikeGeoJson`.
- `styles/geojson.css`: scoped 모드용 정적 스타일.

대소문자를 구분하지 않고 `.geojson`을 등록한다. 알려진 확장자가 없는 입력은
최상위 구조를 검사하여 일반 JSON보다 먼저 감지한다. `.json`은 기존 JSON
뷰어로 연다. 호스트 어댑터는 다른 뷰어와 동일하게 명시적 import map에 신규
뷰어를 등록해야 한다.

## 지원 범위와 상호작용

Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon,
GeometryCollection과 Feature, FeatureCollection을 처리한다. 중첩된
GeometryCollection과 다각형 구멍을 지원하며, 도형이 null인 피처도 선택
목록에서 속성을 조회할 수 있다. 고도 등 추가 좌표는 모델에 보존하고 지도는
경도·위도 두 축으로 표시한다. 좌표는 유한한 숫자이고 경도 ±180°, 위도 ±90°
범위에 있어야 한다. LineString은 2개 이상의 위치, 다각형 링은 시작과 끝이
같은 4개 이상의 위치가 필요하다. 빈 좌표 배열은 null 도형으로 해석한다.

지도 클릭 또는 피처 선택 목록으로 속성을 조회한다. GeometryCollection의
구성 도형은 함께 선택된다. 확대·축소·전체 보기 버튼, 휠 확대·축소,
드래그 이동을 제공한다. 지도에 포커스가 있을 때 `+`/`-`로 확대·축소하고,
방향키로 이동하며, `0` 또는 `Home`으로 전체 보기를 복구한다.

지도는 경도·위도를 그대로 표시한다. 배경 지도, 구면 투영, 날짜 변경선
주변 좌표의 자동 분리·래핑은 제공하지 않는다. 이전 형식의 `crs`는 경고와
함께 무시하며 WGS84로 해석한다. 파일의 `bbox`는 신뢰하지 않고 실제 보존한
도형에서 표시 영역을 계산한다.

## 파서 계약과 한도

`parseGeoJson`은 `ParseOutcome<GeoJsonDocument>`를 반환한다. 입력 기인 실패는
throw하지 않는다. 표준 코어 JSON 파서를 재사용하고 속성은 원본 `JsonNode`로
유지하여 중복 키, 중첩 값, 큰 숫자의 원래 토큰을 보존한다. 숫자 피처 ID도
원본 토큰의 문자열로 제공한다. 속성 값의 span은 문서의 `text`를 가리킨다.

| 옵션 | 기본값 | 결과 |
| --- | --- | --- |
| `limits.maxInputBytes` | 128 MiB | 초과 시 failed |
| `maxFeatures` | 10,000 | 완성된 피처까지 partial |
| `limits.maxEntries` | 10,000 | maxFeatures와 더 작은 한도를 적용 |
| `maxVertices` | 200,000 | 피처 단위로 되돌리고 partial |
| `maxNodes` | 1,000,000 | JSON 노드 한도 초과 시 failed |
| `maxDepth` | 64 | JSON 깊이 초과 시 failed |
| `limits.maxParseMillis` | 30초 | JSON 파싱의 협조적 제한 |
| `limits.maxPreviewBytes` | 64 KiB | 선택한 피처 속성의 표시 예산 |

잘못된 개별 피처는 건너뛰고 partial과 진단을 반환하며, 실제 피처가 전부
잘못되었으면 failed가 된다. 피처 오류 진단과 중복 키 진단은 각각 최대 20개다.
중복 키 진단을 제한하더라도 속성의 모든 중복 항목은 원본 모델에 보존한다. 문법이 잘못되었거나
잘린 JSON을 지도 도형으로 복구하지 않는다. 취소된 파싱은 aborted 실패이며,
mount는 `MountAbortedError`로 알린다. 파싱·렌더링은 동기 실행이므로 강제 실행
기한이 필요한 호스트는 Worker 경계를 제공해야 한다.

속성 패널은 최대 500행을 표시한다. 표시 예산은 실제 UTF-8 바이트 수와 생략
기호를 포함하여 적용한다. 경고 전체에도 같은 예산을 별도로 적용하고 경고
인자는 1 KiB, 피처 선택 목록의 레이블은 항목당 1 KiB로 제한한다. 텍스트를
자르더라도 서로게이트 쌍을 나누지 않는다. 이는 모델의 원본 속성·ID 보존에
영향을 주지 않는다.

## 격리와 수명 주기

기본 Shadow DOM 모드는 스타일을 주입한다. scoped 모드는 호스트가 CSS를
로드하며 `.omni-viewer.omni-viewer--geojson.omni-geojson` 내부에서 렌더링한다.
파일명과 모든 속성은 textContent로만 삽입한다. 파일의 URL·HTML·스크립트는
실행하거나 가져오지 않는다. `dispose()`는 도형, 속성, 스타일, 문서의 이동
리스너를 제거하며 여러 번 호출해도 안전하다.

## 검증

파서 테스트는 모든 도형, 링·구멍, null·빈 컬렉션, 손상된 피처, 원본 숫자,
깊이·노드·피처·정점 한도와 취소를 검증한다. 감지 테스트는 대소문자,
확장자 없는 파일, 잘린 샘플, JSON/JSONL 우선순위를 검증한다. mount 테스트는
선택·속성 안전성, 확대·이동, SVG 여백 보정, 키보드, 스타일 격리, 정리와
재마운트를 검증한다. 예제는 `examples/geojson/map.geojson`에 있다.
