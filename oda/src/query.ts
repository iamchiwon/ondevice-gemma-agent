// src/query.ts
//
// 쿼리 루프 — 에이전트의 핵심 엔진
//
// Claude Code 참고:
// query.ts(약 68KB)는 비동기 제너레이터로 구현되어 있다.
// 매 턴마다: API 호출 → 응답 파싱 → 도구 실행 → 다음 턴 결정
// 을 반복한다. 도구 사용이 없으면 루프를 종료한다.
//
// 우리도 같은 구조를 따르되, 지금은 도구 실행 없이
// "API 호출 → 스트리밍 응답 → 완료" 만 구현한다.
// Chapter 07에서 도구 실행을 끼워넣는다.

import type { Conversation } from "./conversation.js";
import type { QueryEvent } from "./events.js";
import { chat } from "./ollama.js";
import { ToolCall } from "./schemas.js";
import {
  executeToolBatch,
  PipelineOptions,
  Tool,
  toolRegistry,
} from "./tools/index.js";

/** query() 함수의 옵션 */
export interface QueryOptions {
  model: string;
  conversation: Conversation;
  maxTurns?: number; // 무한 루프 방지 (기본: 10)
  tools?: Tool[];
}

/**
 * AI 응답 텍스트에서 도구 호출을 추출한다.
 * Ollama 네이티브 tool calling이 안 되는 모델을 위한 폴백.
 */
function parseToolCallsFromText(
  text: string,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> =
    [];
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name && parsed.arguments) {
        toolCalls.push({
          name: parsed.name,
          arguments: parsed.arguments,
        });
      }
    } catch {
      // 파싱 실패 → 무시
    }
  }

  return toolCalls;
}

/**
 * 쿼리 루프 — 비동기 제너레이터
 *
 * 사용법:
 * ```
 * for await (const event of query(options)) {
 *   switch (event.type) {
 *     case "text_delta":    // 스트리밍 텍스트 표시
 *     case "turn_complete": // 통계 갱신
 *     case "error":         // 에러 표시
 *   }
 * }
 * ```
 *
 * 왜 제너레이터인가?
 * - 이벤트가 발생할 때마다 yield로 즉시 내보낸다
 * - UI는 for-await-of로 소비하면서 실시간 렌더링
 * - 콜백 지옥 없이 순차적 코드로 복잡한 흐름을 표현
 * - Claude Code가 동일한 패턴을 사용하는 이유이기도 하다
 */
export async function* query(
  options: QueryOptions,
): AsyncGenerator<QueryEvent> {
  const { model, conversation, maxTurns = 10 } = options;
  const tools = options.tools ?? toolRegistry.getAll();

  // Ollama에 전달할 도구 정의
  const ollamaTools =
    tools.length > 0 ? toolRegistry.toOllamaTools() : undefined;

  for (let turn = 0; turn < maxTurns; turn++) {
    // ── API 호출 ────────────────────────────────────────
    const messages = conversation.toOllamaMessages();
    let fullResponse = "";
    let tokenCount = 0;
    let toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> =
      [];
    const startTime = Date.now();

    try {
      const events: QueryEvent[] = [];
      let resolveWait: (() => void) | null = null;

      const chatPromise = chat(
        { model, messages, tools: ollamaTools },
        (chunk) => {
          if (!chunk.done) {
            // 텍스트 응답
            if (chunk.message.content) {
              fullResponse += chunk.message.content;
              events.push({
                type: "text_delta",
                content: chunk.message.content,
              });
            }
            // 도구 호출 감지
            if (chunk.message.tool_calls) {
              toolCalls = chunk.message.tool_calls.map((tc) => ({
                name: tc.function.name,
                arguments: tc.function.arguments,
              }));
            }
          } else {
            tokenCount = chunk.eval_count ?? 0;
          }
          resolveWait?.();
        },
      );

      // 이벤트 소비 루프 (Chapter 05와 동일)
      let chatDone = false;
      chatPromise
        .then(() => {
          chatDone = true;
          resolveWait?.();
        })
        .catch((error) => {
          events.push({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          chatDone = true;
          resolveWait?.();
        });

      while (!chatDone || events.length > 0) {
        if (events.length > 0) {
          const event = events.shift()!;
          yield event;
          if (event.type === "error") return;
        } else {
          await new Promise<void>((resolve) => {
            resolveWait = resolve;
          });
        }
      }
    } catch (error) {
      yield {
        type: "error" as const,
        message: error instanceof Error ? error.message : String(error),
      };
      return;
    }

    const elapsed = (Date.now() - startTime) / 1000;

    // ── 도구 실행 판단 ──────────────────────────────────

    // 1차: Ollama 네이티브 tool_calls 확인
    // 2차: 응답 텍스트에서 <tool_call> 태그 파싱 (폴백)
    if (toolCalls.length === 0) {
      toolCalls = parseToolCallsFromText(fullResponse);
      // 텍스트에서 tool_call 부분을 제거 (사용자에게 보여줄 필요 없음)
      if (toolCalls.length > 0) {
        fullResponse = fullResponse
          .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
          .trim();
      }
    }
    const hasToolUse = toolCalls.length > 0;

    if (!hasToolUse) {
      // 도구 사용 없음 → 최종 응답
      conversation.addAssistant(fullResponse);
      conversation.updateStats(tokenCount, elapsed);
      yield { type: "response_complete", content: fullResponse };
      yield { type: "turn_complete", tokens: tokenCount, elapsed };
      break;
    }

    // ── 도구 실행 ───────────────────────────────────────
    // Claude Code 참고 (8.1절):
    // 10단계 파이프라인: lookup → validate → hooks → permissions → execute → ...
    // 우리는 단순화: lookup → validate → execute

    const toolCallSchemas: ToolCall[] = toolCalls.map((tc, i) => ({
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

    // 도구 호출 이벤트 방출
    for (const tc of toolCallSchemas) {
      yield {
        type: "tool_call" as const,
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      };
    }

    // 배치 실행
    const pipelineOptions: PipelineOptions = { tools };
    const results: Array<{
      id: string;
      name: string;
      content: string;
      isError: boolean;
    }> = [];

    await executeToolBatch(
      toolCallSchemas,
      pipelineOptions,
      (id, name, result) => {
        conversation.addToolResult(id, result.content, result.isError);
        results.push({
          id,
          name,
          content: result.content,
          isError: result.isError,
        });
      },
    );

    // 도구 결과 이벤트 방출
    for (const r of results) {
      yield {
        type: "tool_result" as const,
        toolCallId: r.id,
        name: r.name,
        content: r.content,
        isError: r.isError,
      };
    }

    yield { type: "turn_complete" as const, tokens: tokenCount, elapsed };

    // 다음 턴으로 (for 루프 계속)
  }
}
