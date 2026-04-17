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
import { Tool, toolRegistry } from "./tools/index.js";

/** query() 함수의 옵션 */
export interface QueryOptions {
  model: string;
  conversation: Conversation;
  maxTurns?: number; // 무한 루프 방지 (기본: 10)
  tools?: Tool[];
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

    conversation.addAssistantWithToolCalls(fullResponse, toolCallSchemas);

    for (const tc of toolCallSchemas) {
      // 1. 도구 찾기
      const tool = tools.find((t) => t.name === tc.name);

      yield {
        type: "tool_call",
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      };

      let result: { content: string; isError: boolean };

      if (!tool) {
        result = { content: `Unknown tool: ${tc.name}`, isError: true };
      } else {
        try {
          // 2. 입력 검증
          const parsed = tool.inputSchema.safeParse(tc.arguments);
          if (!parsed.success) {
            result = {
              content: `Invalid input: ${parsed.error.message}`,
              isError: true,
            };
          } else {
            // 3. 실행
            const toolResult = await tool.call(
              parsed.data as Record<string, unknown>,
            );
            result = {
              content: toolResult.content,
              isError: toolResult.isError ?? false,
            };
          }
        } catch (error) {
          result = {
            content: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          };
        }
      }

      // 결과를 대화에 추가
      conversation.addToolResult(tc.id, result.content, result.isError);

      yield {
        type: "tool_result",
        toolCallId: tc.id,
        name: tc.name,
        content: result.content,
        isError: result.isError,
      };
    }

    yield { type: "turn_complete", tokens: tokenCount, elapsed };

    // 다음 턴으로 → for 루프 처음으로 돌아감
    // 도구 결과가 대화에 추가된 상태로 다시 API 호출
  }
}
