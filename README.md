# ondevice-gemma-agent

Claude Code의 아키텍처를 따라 만들어보는 On-Device AI Agent.

Gemma 4 E2B + TypeScript + React Ink로 단계별로 AI Agent를 만들면서, 에이전트가 내부에서 어떻게 동작하는지를 이해합니다. 각 챕터는 독립적으로 실행 가능한 결과물을 포함합니다.

## 왜 이 프로젝트를 만드는가

Claude Code는 단순한 챗봇이 아니라, 파일을 읽고 수정하고 명령을 실행하는 "AI 소프트웨어 엔지니어"입니다. 2026년 3월 소스 코드가 공개되면서 그 내부 구조를 들여다볼 수 있게 되었습니다.

이 프로젝트는 그 아키텍처를 참고하되, **Gemma 4 E2B라는 작은 모델로 로컬에서 동작하는 단순화 버전**을 직접 만들어봅니다. 클라우드 API 없이, 내 컴퓨터에서 돌아가는 AI Agent를 처음부터 한 줄씩 만들어가는 과정입니다.

## 기술 스택

| 항목 | 선택 | 이유 |
|------|------|------|
| AI 모델 | Gemma 4 E2B (Ollama) | On-device 추론, 가볍고 빠름 |
| 언어 | TypeScript | 타입 안전성, Claude Code와 동일 |
| TUI | React + Ink | 선언적 터미널 UI, Claude Code와 동일한 접근 |
| 패키지 매니저 | pnpm | 빠른 설치, 모노레포 친화 |
| CLI 이름 | `oda` | **O**n-**D**evice **A**gent |

## 목차

### Part 1. 기초 — 첫 번째 동작하는 코드

| 챕터 | 주제 | 만드는 것 |
|------|------|----------|
| 01 | [프로젝트 셋업](./chapters/01-project-setup/) | TypeScript + Ollama 환경 구성 |
| 02 | [CLI 만들기](./chapters/02-cli/) | `oda "프롬프트"` → 스트리밍 응답 출력 |
| 03 | [TUI 셸 만들기](./chapters/03-tui/) | React + Ink 대화형 인터페이스 |

### Part 2. 핵심 엔진 — 쿼리 루프

| 챕터 | 주제 | 만드는 것 |
|------|------|----------|
| 04 | [메시지 타입 시스템](./chapters/04-message-types/) | Zod 기반 메시지 스키마 |
| 05 | [쿼리 루프](./chapters/05-query-loop/) | 비동기 제너레이터 기반 핵심 엔진 |
| 06 | [컨텍스트 수집](./chapters/06-context/) | Git 상태 + AGENT.md + 시스템 프롬프트 |

### Part 3. 도구 시스템 — AI에게 손과 발을

| 챕터 | 주제 | 만드는 것 |
|------|------|----------|
| 07 | [도구 인터페이스](./chapters/07-tool-interface/) | Tool 타입 정의 + 레지스트리 |
| 08 | [첫 번째 도구 — FileRead](./chapters/08-file-read/) | 파일 읽기 도구 + 쿼리 루프 연결 |
| 09 | [도구 실행 파이프라인](./chapters/09-tool-pipeline/) | 검증 → 실행 → 변환 파이프라인 |
| 10 | [Bash 도구](./chapters/10-bash-tool/) | 셸 명령 실행 + 위험 명령 차단 |
| 11 | [FileEdit, Grep, Glob](./chapters/11-more-tools/) | 파일 수정 + 검색 도구 + 병렬 실행 |

### Part 4. 안전장치 — 권한과 검증

| 챕터 | 주제 | 만드는 것 |
|------|------|----------|
| 12 | [권한 시스템](./chapters/12-permissions/) | 도구별 위험도 분류 + 사용자 확인 |
| 13 | [훅 시스템](./chapters/13-hooks/) | PreToolUse / PostToolUse 이벤트 훅 |

### Part 5. 기억과 지속성

| 챕터 | 주제 | 만드는 것 |
|------|------|----------|
| 14 | [자동 압축](./chapters/14-auto-compact/) | 작은 컨텍스트 윈도우에 맞춘 대화 요약 |
| 15 | [메모리 시스템](./chapters/15-memory/) | 세션 간 영속 저장소 |
| 16 | [트랜스크립트](./chapters/16-transcript/) | 대화 기록 저장 + 세션 복구 |

### Part 6. 확장 — 더 큰 세계로

| 챕터 | 주제 | 만드는 것 |
|------|------|----------|
| 17 | [명령어 시스템](./chapters/17-commands/) | 슬래시 커맨드 (`/help`, `/model` 등) |
| 18 | [스킬 시스템](./chapters/18-skills/) | 마크다운 기반 프롬프트 템플릿 |
| 19 | [MCP 연동](./chapters/19-mcp/) | 외부 도구 서버 연결 |
| 20 | [서브에이전트](./chapters/20-sub-agent/) | 작업 위임 + 결과 수집 |

### Part 7. 마무리

| 챕터 | 주제 | 만드는 것 |
|------|------|----------|
| 21 | [설정 시스템](./chapters/21-settings/) | 설정 우선순위 체계 |
| 22 | [사용량 추적](./chapters/22-usage-tracking/) | 토큰 사용량 리포트 |
| 23 | [아키텍처 리뷰](./chapters/23-review/) | 전체 흐름 다이어그램 + Claude Code 비교 |

## 각 챕터의 구조

```
chapters/XX-topic-name/
├── README.md              # 이 챕터에서 배울 것, 아키텍처 설명
├── src/                   # 이 챕터까지의 누적 소스 코드
└── docs/
    ├── architecture.md    # 아키텍처 다이어그램
    └── claude-code-ref.md # Claude Code에서 참고한 부분 해설
```

## 시작하기

### 사전 요구사항

- Node.js 20+
- pnpm
- [Ollama](https://ollama.com/) 설치 완료
- Git

### 설치

```bash
# 레포 클론
git clone https://github.com/your-username/ondevice-gemma-agent.git
cd ondevice-gemma-agent

# Ollama에 Gemma 4 E2B 모델 설치
ollama pull gemma4:e2b

# Chapter 01부터 시작
cd chapters/01-project-setup
pnpm install
```

## 참고 자료

- [Claude Code 소스 코드 분석서](https://wikidocs.net/338204) — 본 프로젝트의 아키텍처 참고 원본
- [Ollama API 문서](https://github.com/ollama/ollama/blob/main/docs/api.md)
- [Ink (React for CLI)](https://github.com/vadimdemedes/ink)
- [Gemma 모델 페이지](https://ai.google.dev/gemma)

## 라이선스

MIT
