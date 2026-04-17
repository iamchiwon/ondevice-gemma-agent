# Chapter 09. 도구 실행 파이프라인

> **목표**: `query.ts`에 인라인으로 들어있던 도구 실행 로직을 별도의 파이프라인으로 추출한다. 검증 → 실행 → 결과 변환 → 크기 제한을 체계화하고, 향후 권한 시스템과 훅을 끼워넣을 자리를 만든다.

## 왜 지금 이걸 하는가

Chapter 08에서 `query.ts`의 도구 실행 부분을 보면, 한 곳에 모든 로직이 섞여있다:

```typescript
// Chapter 08의 query.ts (간략화)
for (const tc of toolCallSchemas) {
  const tool = tools.find(...);        // 1. 찾기
  const parsed = tool.inputSchema...;  // 2. 검증
  const result = await tool.call(...); // 3. 실행
  conversation.addToolResult(...);      // 4. 결과 저장
}
```

Chapter 10에서 Bash 도구, Chapter 11에서 FileEdit/Grep/Glob을 추가하면 여기에 더 많은 로직이 쌓인다:

- 위험한 도구는 사용자 확인 (Chapter 12)
- 실행 전 훅 (Chapter 13)
- 결과가 너무 크면 잘라내기
- 동시 실행 가능한 도구는 병렬로

지금 파이프라인을 분리해두면, 이후 챕터에서 단계를 추가할 때 `query.ts`를 건드리지 않아도 된다.

## Claude Code에서 배우는 것

Claude Code의 도구 실행 파이프라인은 10단계다:

```
[1]  도구 이름으로 lookup
[2]  abort 시그널 확인 (Ctrl+C)
[3]  입력 검증 (Zod)
[4]  PreToolUse 훅 실행
[5]  권한 확인
[6]  tool.call() 실행
[7]  결과를 API 포맷으로 변환
[8]  결과가 너무 크면 디스크 저장 + 참조 반환
[9]  PostToolUse 훅 실행
[10] 텔레메트리 로그
```

우리는 5단계로 단순화한다. 나머지는 해당 챕터에서 추가한다:

```
[1] 도구 찾기
[2] 입력 검증 (Zod)
[3] 실행
[4] 결과 크기 제한
[5] 결과 포맷팅
```

## 변경 요약

```
새 파일:
  oda/src/tools/pipeline.ts    → 도구 실행 파이프라인

수정 파일:
  oda/src/query.ts             → 도구 실행 로직을 pipeline으로 위임
  oda/src/tools/index.ts       → pipeline export 추가
```

## Step 1: `oda/src/tools/pipeline.ts` — 새 파일

```typescript
// src/tools/pipeline.ts
//
// 도구 실행 파이프라인
//
// Claude Code 참고 (8.1절):
// 10단계 파이프라인으로 도구를 실행한다.
// 각 단계가 서로 다른 관점에서 "이 작업을 실행해도 괜찮은가?"를 확인한다.
//
// 우리의 파이프라인 (5단계):
// [1] lookup   → 도구를 이름으로 찾기
// [2] validate → Zod로 입력 검증
// [3] execute  → tool.call() 실행
// [4] truncate → 결과 크기 제한
// [5] format   → 최종 결과 포맷팅
//
// 향후 추가될 단계:
// [2.5] Chapter 12: 권한 확인 (permission check)
// [1.5] Chapter 13: PreToolUse 훅
// [3.5] Chapter 13: PostToolUse 훅

import type { Tool, ToolResult } from "./types.js";

// ── 설정 ────────────────────────────────────────────────

const MAX_RESULT_CHARS = 100_000;
const TRUNCATION_NOTICE = "\n\n... (result truncated)";

// ── 파이프라인 결과 ─────────────────────────────────────

export interface PipelineResult {
  content: string;
  isError: boolean;
  /** 실행에 걸린 시간 (ms) */
  duration: number;
  /** 어떤 단계에서 끝났는지 */
  stage: "lookup" | "validate" | "execute" | "truncate" | "format";
}

// ── 파이프라인 옵션 ─────────────────────────────────────

export interface PipelineOptions {
  /** 사용 가능한 도구 목록 */
  tools: Tool[];
  /** 결과 최대 문자 수 (기본: 100,000) */
  maxResultChars?: number;

  // Chapter 12에서 추가:
  // permissionMode?: "default" | "auto" | "bypass";
  // onPermissionRequest?: (tool: string, input: unknown) => Promise<boolean>;

  // Chapter 13에서 추가:
  // hooks?: { preToolUse?: Hook[]; postToolUse?: Hook[] };
}

// ── 실행 함수 ───────────────────────────────────────────

/**
 * 단일 도구 호출을 파이프라인으로 실행한다.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  options: PipelineOptions,
): Promise<PipelineResult> {
  const startTime = Date.now();
  const maxChars = options.maxResultChars ?? MAX_RESULT_CHARS;

  // ── [1] Lookup ──────────────────────────────────────
  const tool = options.tools.find((t) => t.name === name);
  if (!tool) {
    return {
      content: `Unknown tool: ${name}`,
      isError: true,
      duration: Date.now() - startTime,
      stage: "lookup",
    };
  }

  // ── [2] Validate ────────────────────────────────────
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    const errors = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    return {
      content: `Invalid input for ${name}:\n${errors}`,
      isError: true,
      duration: Date.now() - startTime,
      stage: "validate",
    };
  }

  // ── [3] Execute ─────────────────────────────────────
  let result: ToolResult;
  try {
    result = await tool.call(parsed.data);
  } catch (error) {
    return {
      content: `Tool '${name}' crashed: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
      duration: Date.now() - startTime,
      stage: "execute",
    };
  }

  // ── [4] Truncate ────────────────────────────────────
  let content = result.content;
  if (content.length > maxChars) {
    content = content.substring(0, maxChars) + TRUNCATION_NOTICE;
  }

  // ── [5] Format ──────────────────────────────────────
  return {
    content,
    isError: result.isError ?? false,
    duration: Date.now() - startTime,
    stage: "format",
  };
}

/**
 * 여러 도구 호출을 실행한다.
 * 읽기 전용 도구는 병렬로, 변경 도구는 순차로 실행한다.
 *
 * Claude Code 참고 (8.2절):
 * "연속된 동시성 안전 도구들은 하나의 배치로 묶여 최대 10개까지 병렬 실행.
 *  비안전 도구를 만나면 새 배치가 시작되고, 해당 도구만 단독 실행."
 */
export async function executeToolBatch(
  calls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>,
  options: PipelineOptions,
  onResult: (id: string, name: string, result: PipelineResult) => void,
): Promise<void> {
  // 배치 파티셔닝
  const batches = partitionIntoBatches(calls, options.tools);

  for (const batch of batches) {
    if (batch.parallel) {
      // 병렬 실행 (읽기 전용 도구들)
      const promises = batch.calls.map(async (call) => {
        const result = await executeTool(call.name, call.arguments, options);
        onResult(call.id, call.name, result);
      });
      await Promise.all(promises);
    } else {
      // 순차 실행 (변경 도구)
      for (const call of batch.calls) {
        const result = await executeTool(call.name, call.arguments, options);
        onResult(call.id, call.name, result);
      }
    }
  }
}

// ── 배치 파티셔닝 ───────────────────────────────────────

interface Batch {
  parallel: boolean;
  calls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

/**
 * 도구 호출들을 배치로 나눈다.
 *
 * Claude Code의 파티셔닝 알고리즘:
 * Input:  [Read] [Grep] [Glob] [Edit] [Read] [Read] [Bash]
 *          safe   safe   safe  UNSAFE  safe   safe  UNSAFE
 *
 * Batch 1: [Read, Grep, Glob]  → parallel
 * Batch 2: [Edit]              → serial
 * Batch 3: [Read, Read]        → parallel
 * Batch 4: [Bash]              → serial
 */
function partitionIntoBatches(
  calls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>,
  tools: Tool[],
): Batch[] {
  if (calls.length === 0) return [];

  const batches: Batch[] = [];
  let currentBatch: Batch | null = null;

  for (const call of calls) {
    const tool = tools.find((t) => t.name === call.name);
    const isReadOnly = tool?.isReadOnly ?? false;

    if (!currentBatch) {
      // 첫 번째 배치
      currentBatch = { parallel: isReadOnly, calls: [call] };
    } else if (isReadOnly && currentBatch.parallel) {
      // 연속된 읽기 전용 → 같은 배치에 추가
      currentBatch.calls.push(call);
    } else {
      // 배치 전환: 이전 배치 저장, 새 배치 시작
      batches.push(currentBatch);
      currentBatch = { parallel: isReadOnly, calls: [call] };
    }
  }

  if (currentBatch) {
    batches.push(currentBatch);
  }

  return batches;
}
```

핵심 설계:

**`executeTool()`** — 단일 도구 실행. 5단계를 순서대로 거치며, 각 단계에서 실패하면 어디서 실패했는지(`stage`)를 알려준다. 디버깅에 유용하다.

**`executeToolBatch()`** — 여러 도구를 배치로 실행. Claude Code의 파티셔닝 알고리즘을 구현한다. 읽기 전용 도구가 연속이면 `Promise.all`로 병렬, 변경 도구를 만나면 배치를 끊고 단독 실행.

**`onResult` 콜백** — 배치 실행 중에 결과가 나올 때마다 호출. query.ts가 실시간으로 이벤트를 yield할 수 있게 해준다.

## Step 2: `oda/src/tools/index.ts` — 수정

```diff
  export { toolRegistry } from "./registry.js";
  export type { Tool, ToolResult, OllamaToolDefinition } from "./types.js";
  export { toolToOllamaDefinition } from "./types.js";
  export { registerTools } from "./setup.js";
+ export { executeTool, executeToolBatch, type PipelineResult, type PipelineOptions } from "./pipeline.js";
```

## Step 3: `oda/src/query.ts` — 수정

도구 실행 부분을 `executeToolBatch()`로 교체한다.

import 변경:

```diff
- import { toolRegistry, type Tool, type ToolResult } from "./tools/index.js";
+ import { toolRegistry, type Tool, executeToolBatch, type PipelineOptions } from "./tools/index.js";
```

`query()` 함수에서 도구 실행 블록(Chapter 08에서 만든 `for (const tc of toolCallSchemas)` 부분)을 통째로 교체한다:

```typescript
// ── 도구 실행 ───────────────────────────────────────
const toolCallSchemas = toolCalls.map((tc, i) => ({
  id: `call_${turn}_${i}`,
  name: tc.name,
  arguments: tc.arguments,
}));

conversation.addAssistantWithToolCalls(
  fullResponse,
  toolCallSchemas.map((tc) => ({
    id: tc.id,
    name: tc.name,
    arguments: tc.arguments,
  })),
);

const pipelineOptions: PipelineOptions = { tools };

await executeToolBatch(toolCallSchemas, pipelineOptions, (id, name, result) => {
  // 결과를 대화에 추가
  conversation.addToolResult(id, result.content, result.isError);

  // 이벤트 방출을 위해 버퍼에 추가
  // (yield는 콜백 안에서 직접 할 수 없으므로)
  pendingEvents.push({
    type: "tool_result" as const,
    toolCallId: id,
    name,
    content: result.content,
    isError: result.isError,
  });
  resolveWait?.();
});
```

이렇게 하려면, 도구 실행 구간에서도 이벤트 버퍼 패턴을 써야 한다. 기존의 API 스트리밍 이벤트 소비 루프 이후에 도구 실행 구간을 분리하는 방식으로 구조를 정리한다.

더 간단한 접근은, 배치 실행을 await한 뒤 결과를 모아서 yield하는 것이다:

```typescript
    // ── 도구 실행 (간단한 버전) ─────────────────────────
    const toolCallSchemas = toolCalls.map((tc, i) => ({
      id: `call_${turn}_${i}`,
      name: tc.name,
      arguments: tc.arguments,
    }));

    conversation.addAssistantWithToolCalls(fullResponse, toolCallSchemas.map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    })));

    // 도구 호출 이벤트 방출
    for (const tc of toolCallSchemas) {
      yield { type: "tool_call" as const, id: tc.id, name: tc.name, arguments: tc.arguments };
    }

    // 배치 실행
    const pipelineOptions: PipelineOptions = { tools };
    const results: Array<{ id: string; name: string; content: string; isError: boolean }> = [];

    await executeToolBatch(
      toolCallSchemas,
      pipelineOptions,
      (id, name, result) => {
        conversation.addToolResult(id, result.content, result.isError);
        results.push({ id, name, content: result.content, isError: result.isError });
      },
    );

    // 도구 결과 이벤트 방출
    for (const r of results) {
      yield { type: "tool_result" as const, toolCallId: r.id, name: r.name, content: r.content, isError: r.isError };
    }

    yield { type: "turn_complete" as const, tokens: tokenCount, elapsed };

    // 다음 턴으로 (for 루프 계속)
```

이 버전이 더 읽기 쉽다. 실시간 이벤트 방출은 나중에 필요하면 추가한다.

기존의 Chapter 08 도구 실행 로직(`for (const tc of toolCallSchemas) { ... const tool = tools.find(...) ... }` 전체)을 위 코드로 교체한다.

## 테스트

기능적으로 Chapter 08과 동일하게 동작해야 한다.

```bash
# 타입 체크
pnpm typecheck

# 기존 테스트 반복
pnpm dev
# "package.json 읽어줘" → 이전과 동일하게 동작

# 파이프라인 에러 케이스
# "존재하지않는도구 실행해줘" → "Unknown tool" 에러
# (AI가 등록되지 않은 도구를 호출하려 할 때)
```

## 체크리스트

- [ ] `tools/pipeline.ts` — `executeTool()` + `executeToolBatch()` 구현
- [ ] `tools/index.ts` — pipeline export 추가
- [ ] `query.ts` — 도구 실행 로직을 pipeline으로 교체
- [ ] 배치 파티셔닝 로직 동작 (읽기 전용: 병렬, 변경: 순차)
- [ ] FileRead가 이전과 동일하게 동작
- [ ] `pnpm typecheck` 통과

## 이 챕터의 위치

```
+────────────────────────────────────────────+
| query() 쿼리 루프                           |
| ├── API 호출                               |
| ├── tool_calls 감지                        |
| └── executeToolBatch() 호출 ──┐            |
+───────────────────────────────┼────────────+
                                |
                                v
+────────────────────────────────────────────+
| Pipeline  ← ✨ 새 파일                      |
| ┌─ partitionIntoBatches()                  |
| │  [Read,Grep] → parallel | [Edit] → solo |
| └─ executeTool() × N                      |
|    [1] lookup                              |
|    [2] validate (Zod)                      |
|    [3] execute (tool.call)                 |
|    [4] truncate (100K chars)               |
|    [5] format                              |
|    ┌─────────────────────────────┐         |
|    │ Chapter 12: [2.5] 권한 확인  │         |
|    │ Chapter 13: [1.5] PreHook   │         |
|    │ Chapter 13: [3.5] PostHook  │         |
|    └─────────────────────────────┘         |
+────────────────────────────────────────────+
```

`query.ts`에서 도구 실행의 "어떻게"가 분리되었다. `query.ts`는 "언제 도구를 실행할지"만 결정하고, "어떻게 실행할지"는 파이프라인이 담당한다.

이 분리의 가치는 다음 챕터들에서 드러난다:

- **Chapter 10**: BashTool 추가 → `setup.ts`에 한 줄, `pipeline.ts` 변경 없음
- **Chapter 12**: 권한 확인 추가 → `pipeline.ts`의 [2]와 [3] 사이에 단계 삽입, `query.ts` 변경 없음
- **Chapter 13**: 훅 추가 → `pipeline.ts`에 단계 삽입, `query.ts` 변경 없음

## 다음 챕터

→ [Chapter 10. Bash 도구](../10-bash-tool/) — 셸 명령을 실행하는 도구를 만든다. `ls`, `cat`, `npm test` 같은 명령을 AI가 직접 실행한다. 가장 강력하지만 가장 위험한 도구이므로, 기본적인 차단 목록과 타임아웃을 함께 구현한다.
