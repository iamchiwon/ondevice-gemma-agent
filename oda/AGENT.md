# AGENT.md

이 프로젝트는 On-Device AI Agent입니다.

## 규칙

- TypeScript를 사용합니다
- 패키지 매니저는 pnpm입니다
- 테스트는 vitest로 실행합니다: `pnpm test`
- 커밋 메시지는 Conventional Commits를 따릅니다

## 구조

- `src/query.ts` — 쿼리 루프 (핵심 엔진)
- `src/ui/` — React + Ink TUI 컴포넌트
- `src/ollama.ts` — Ollama API 클라이언트
