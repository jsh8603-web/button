# Gemini API 비용 최적화 — 최종 적용 계획

> 분석일: 2026-04-08
> 과금 현황: AI Studio 프로모션 ₩40만 소진 → 4/7 ₩100,000 청구

## 1. 텍스트 모델 — 통일 8단 폴백 체인

모든 프로젝트 공통. 429 발생 시 다음 모델로 자동 전환.

| 순서 | 계정 | 모델 ID | RPD |
|------|------|---------|-----|
| 1 | 본인 | `gemini-3.1-flash-lite-preview` | 500 |
| 2 | 와이프 | `gemini-3.1-flash-lite-preview` | 500 |
| 3 | 본인 | `gemini-2.5-flash` | 20 |
| 4 | 와이프 | `gemini-2.5-flash` | 20 |
| 5 | 본인 | `gemini-3-flash-preview` | 20 |
| 6 | 와이프 | `gemini-3-flash-preview` | 20 |
| 7 | 본인 | `gemini-2.5-flash-lite` | 20 |
| 8 | 와이프 | `gemini-2.5-flash-lite` | 20 |
| | | **합계** | **1,120** |

> Babyplace만 순서 반전: 와이프(1차) → 본인(2차). 사용량이 가장 많아서.

적용 대상: Babyplace, VaultVoice(Flash), GCP Gmail, Gemini CLI, Slides-Grab(VQA)

## 2. 리서치 — Pro 품질 우선

| 순서 | 계정 | 모델 ID | 비고 |
|------|------|---------|------|
| 1 | 와이프 프로모션 | `gemini-2.5-pro` | 크레딧 소모, 일 50회 카운터 |
| 2 | 본인 무료 | `gemini-3.1-flash-lite-preview` | 500 RPD |

## 3. VaultVoice Pro — 기능별 분리

| 기능 | 모델 | 비고 |
|------|------|------|
| 대용량 STT (>10MB) | `gemini-2.5-pro` (와이프 프로모션) | Flash 타임아웃 → Pro 필수 |
| Vault Q&A, Jarvis, 이미지 분석, 영상 OCR, URL 요약, 노트 요약 | 통일 8단 체인 (Flash) | Pro→Flash 전환 (크레딧 절약) |

## 4. 이미지 생성 (Slides-Grab) — 카운터 + 4단 폴백

Imagen 4는 유료 계정 전용 (결제 수단 등록 필수). 무료 키 불가.
각 모델 25 RPD = 총 75회 무료, 초과 시 Nano Banana (크레딧).
**429가 안 뜨므로 카운터 필수** (유료 계정은 초과해도 크레딧 차감).

| 순서 | 모델 ID | 카운터 한도 |
|------|---------|-----------|
| 1 | `imagen-4.0-generate-001` | 25/일 |
| 2 | `imagen-4.0-ultra-generate-001` | 25/일 |
| 3 | `imagen-4.0-fast-generate-001` | 25/일 |
| 4 | `gemini-2.5-flash-image` (Nano Banana) | 크레딧 |

## 5. 프로젝트별 키 매핑

| 프로젝트 | 환경변수 | 계정 | 키 |
|----------|---------|------|-----|
| **Babyplace** | `GEMINI_API_KEY` | 와이프 무료 | `AIzaSyB_BNzE3KuPDF80vf5xGNuzazRq_26TvHg` |
| | `GEMINI_FALLBACK_KEY` | 본인 무료 | `AIzaSyDZIy5ddIUkls9C5tUTc9gkLyFnprlnTFE` |
| **VaultVoice** | `GEMINI_API_KEY` | 본인 무료 | `AIzaSyBeYVHqxzVEdr0jw-CaPmr1f2HX4fNKKf0` |
| | `GEMINI_FALLBACK_KEY` | 와이프 무료 | `AIzaSyDZdzaE86QM7OcPPDO_Y8eeMeCUDw6NQRA` |
| | `GEMINI_PRO_KEY` | 와이프 프로모션 | `AIzaSyAMv0PStxr9pECS4wrCkq2i9IHr4uDWATg` |
| **Gemini CLI** | `GEMINI_API_KEY` | 본인 무료 | `AIzaSyCO8YhexKHpl0pjZY_x9vZ7DSyS8krDWGc` |
| | `GEMINI_FALLBACK_KEY` | 와이프 무료 | `AIzaSyBlMxqNdmMiNx8lEKJVG8DzoKyWHf-N6s4` |
| **리서치** | `GEMINI_RESEARCH_KEY` | 와이프 프로모션 | `AIzaSyClnOOC4TRZaaEvHbnfnDRZYIZJJrUXstg` |
| | `GEMINI_RESEARCH_FREE_KEY` | 본인 무료 | `AIzaSyB3FFMimv4dURSddXM2leA01aAyBAWBAGk` |
| **Slides-Grab** | `GEMINI_API_KEY` | 본인 무료 | `AIzaSyD5RI9yywIXUKArYLYNImzVI64jTRZmIaw` |
| | `SLIDES_GEMINI_FREE_KEY` | 와이프 무료 | `AIzaSyBLdPul7EHGplHSxeR4bhJtHVQvJg-xJ4Y` |
| | `SLIDES_GEMINI_PRO_KEY` | 와이프 프로모션 | `AIzaSyCyf4-hVH21EGIfSAd8bOQJH3LlgFI2if4` |
| **GCP Gmail** | `GEMINI_API_KEY` | 본인 무료 | `AIzaSyBwbI3ckS0eGGfAjyp1kgmjtA5Rb-L4L3I` |

## 6. 모델 변경 요약

| 프로젝트 | 현재 | 변경 후 |
|----------|------|---------|
| Babyplace 분류 | `gemini-2.5-flash-lite` | `gemini-3.1-flash-lite-preview` |
| Babyplace 추출/비전 | `gemini-2.5-flash` | `gemini-3.1-flash-lite-preview` |
| VaultVoice NER | `gemini-2.5-flash` | `gemini-3.1-flash-lite-preview` |
| VaultVoice Pro (Q&A/Jarvis/STT) | `gemini-2.5-pro` | 유지 |
| VaultVoice (요약/OCR) | `gemini-2.5-pro` | `gemini-3.1-flash-lite-preview` (Flash 전환) |
| Gemini CLI | `gemini-2.5-flash` | `gemini-3.1-flash-lite-preview` |
| 리서치 Pro | `gemini-2.5-pro` | 유지 |
| GCP Gmail | `gemini-2.5-flash` | `gemini-3.1-flash-lite-preview` |
| Slides VQA | `gemini-2.5-flash` | `gemini-3.1-flash-lite-preview` |
| Slides 이미지 | `gemini-2.5-flash-image` | Imagen 4 (카운터) → Nano Banana |

## 7. 카운터가 필요한 곳

유료/프로모션 키는 429가 안 뜨므로 코드에서 일일 카운터로 제한.

| 대상 | 카운터 한도 | 초과 시 |
|------|-----------|---------|
| 리서치 Pro | 50회/일 | 3.1-flash-lite 폴백 (이미 구현됨) |
| Slides Imagen 4 Generate | 25회/일 | → Ultra로 전환 |
| Slides Imagen 4 Ultra | 25회/일 | → Fast로 전환 |
| Slides Imagen 4 Fast | 25회/일 | → Nano Banana로 전환 |

---

## 부록: 판단 경위

### 모델 품질 테스트 (2026-04-08, 본인 무료 키)

3개 태스크 × 5개 모델 직접 API 호출 비교.

**태스크:** (1) 영유아 행사 분류 (2) 블로그 노이즈 필터 (3) 한국어 NER

| 모델 | 분류 | 노이즈필터 | NER entities | NER cross_links | 속도 |
|------|------|-----------|-------------|----------------|------|
| `gemini-2.5-flash-lite` | 정답 | 4번 오답 | 완벽 | 3/3 | ~1초 |
| `gemini-2.5-flash` | 정답 | 4번 오답 | 완벽 | 3/3 | ~5-10초 |
| `gemini-3.1-flash-lite-preview` | **정답** | **전부 정답** | **완벽** | 2/3 (1개 누락) | ~1-13초 |
| `gemini-3-flash-preview` | 503 | 전부 정답 | 완벽 | 3/3 | ~21-25초 |
| `gemma-4-31b-it` | **실패** | **실패** | **실패** | **실패** | ~23-30초 |

**결론:**
- `gemini-3.1-flash-lite-preview`: 품질 동등 이상 + 500 RPD (25배) → **메인 모델 확정**
- `gemma-4-31b-it`: JSON 지시 불이행 (프롬프트 재설명만) → **탈락**
- `gemini-2.5-pro` vs `gemini-3.1-pro`: 3.1이 20% 비싸고 추론 약간 우수하나, 프로모션 크레딧 절약 위해 **2.5-pro 유지**

### Imagen 4 무료 사용 조건

대시보드에 25 RPD 표시되나, API 호출 시 "paid plans only" 에러.
→ 결제 수단 등록된 프로젝트 전용 (2026-03-23 정책 변경)
→ 와이프 프로모션 계정에서만 사용 가능, 본인 무료 계정 불가
→ 유료 계정은 25회 초과해도 429 안 뜨고 크레딧 차감 → 카운터 필수
