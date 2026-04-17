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
    result = await tool.call(parsed.data as Record<string, unknown>);
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
