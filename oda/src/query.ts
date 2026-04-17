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

/** query() 함수의 옵션 */
export interface QueryOptions {
  model: string;
  conversation: Conversation;
  maxTurns?: number; // 무한 루프 방지 (기본: 10)
  // Chapter 07에서 추가:
  // tools?: Tool[];
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

  for (let turn = 0; turn < maxTurns; turn++) {
    // ── API 호출 ────────────────────────────────────────
    const messages = conversation.toOllamaMessages();
    let fullResponse = "";
    let tokenCount = 0;
    const startTime = Date.now();

    try {
      // Ollama 스트리밍 호출
      // chat()은 콜백 기반이므로, Promise로 감싸서 제너레이터와 연결한다.
      // 이벤트를 버퍼에 모아뒀다가 하나씩 yield하는 패턴을 쓴다.
      const events: QueryEvent[] = [];
      let resolveWait: (() => void) | null = null;

      const chatPromise = chat({ model, messages }, (chunk) => {
        if (!chunk.done) {
          const content = chunk.message.content;
          fullResponse += content;
          events.push({ type: "text_delta", content });
          // 대기 중인 yield를 깨운다
          resolveWait?.();
        } else {
          tokenCount = chunk.eval_count ?? 0;
        }
      });

      // 이벤트가 도착할 때마다 yield
      // chat()이 완료될 때까지 반복
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
          // 이벤트가 없으면 다음 이벤트가 올 때까지 대기
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

    // ── 응답 완료 처리 ──────────────────────────────────
    const elapsed = (Date.now() - startTime) / 1000;

    // 어시스턴트 응답을 대화 기록에 추가
    conversation.addAssistant(fullResponse);
    conversation.updateStats(tokenCount, elapsed);

    yield { type: "response_complete", content: fullResponse };
    yield { type: "turn_complete", tokens: tokenCount, elapsed };

    // ── 다음 턴 결정 ────────────────────────────────────
    // 지금은 항상 1턴만 실행하고 종료한다.
    // Chapter 07에서 도구 실행이 추가되면:
    //   - 응답에 tool_use가 있으면 → 도구 실행 → 다음 턴
    //   - tool_use가 없으면 → 루프 종료
    //
    // Claude Code의 query.ts:
    //   "tool_use in response?
    //    YES --> build new State, go back to step 1
    //    NO  --> exit loop, return to user"

    const hasToolUse = false; // Chapter 07에서 실제 판단 로직으로 교체
    if (!hasToolUse) {
      break;
    }
  }
}
