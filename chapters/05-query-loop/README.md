# Chapter 05. 쿼리 루프 — 에이전트의 심장

> **목표**: `App.tsx`의 `handleSubmit`에 박혀있던 Ollama 호출 로직을 비동기 제너레이터 기반의 `query()` 함수로 추출한다. 도구 사용이 있으면 자동으로 다음 턴을 실행하는, 에이전트의 핵심 엔진이다.

## 왜 지금 이걸 하는가

Chapter 04까지의 흐름:

```
사용자 입력 → App.tsx handleSubmit에서 직접 Ollama 호출 → 응답 표시
```

이 구조의 문제:

1. **도구 실행을 끼워넣을 수 없다.** AI가 "파일을 읽어야겠다"고 판단하면, 도구를 실행하고 결과를 다시 AI에게 보내는 루프가 필요하다. `handleSubmit` 하나로는 이 반복을 처리할 수 없다.
2. **UI와 엔진이 얽혀있다.** Ollama 호출 로직이 React 컴포넌트 안에 있어서, CLI 모드에서 재사용할 수 없다.

Chapter 05 이후의 흐름:

```
사용자 입력 → query() 제너레이터 호출
                ├── yield TextDelta("안녕")
                ├── yield TextDelta("하세요")
                ├── yield ToolCall("FileRead", {path: "auth.ts"})  ← Chapter 07에서 활성화
                ├── yield ToolResult("파일 내용...")                 ← Chapter 07에서 활성화
                ├── yield TextDelta("이 파일은...")
                └── yield TurnComplete({tokens: 42, time: 1.2})
```

UI는 이 이벤트 스트림을 소비해서 화면에 그리기만 한다.

## Claude Code에서 배우는 것

Claude Code의 `query.ts`(약 68KB)는 비동기 제너레이터 패턴을 사용한다:

> "일반적인 방식은 레스토랑에서 모든 음식이 준비될 때까지 기다렸다가 한꺼번에 서빙하는 것과 같다. 제너레이터 방식은 준비되는 대로 하나씩 내오는 것과 같다."

매 턴의 흐름:

1. 메시지 전처리 (오래된 메시지 정리)
2. API 스트리밍 호출
3. 에러 복구
4. 도구 실행 (있으면)
5. 후처리 → tool_use가 있었으면 다음 턴으로, 없으면 종료

우리도 같은 구조를 따르되, 1(전처리)과 3(에러 복구)은 나중에 추가한다.

## 변경 요약

```
새 파일:
  oda/src/query.ts        → 쿼리 루프 (비동기 제너레이터)
  oda/src/events.ts       → 쿼리 이벤트 타입 정의

수정 파일:
  oda/src/ui/App.tsx      → query()를 소비하는 방식으로 변경
  oda/src/conversation.ts → addUser/addAssistant 외에 getOllamaMessages() 정리
```

## Step 1: `oda/src/events.ts` — 새 파일

쿼리 루프가 yield하는 이벤트 타입을 정의한다. UI는 이 이벤트만 보고 화면을 그린다.

```typescript
// src/events.ts
//
// 쿼리 루프가 방출하는 이벤트 타입
//
// Claude Code 참고:
// query.ts의 제너레이터는 다양한 이벤트를 yield한다:
// - 텍스트 조각 (스트리밍)
// - 도구 사용 요청
// - 도구 실행 결과
// - 에러
// - 턴 완료
//
// 우리도 같은 구조를 따른다.
// 지금은 텍스트와 턴 관련 이벤트만 만들고,
// Chapter 07에서 도구 이벤트를 추가한다.

/** 텍스트 조각이 도착했다 (스트리밍) */
export interface TextDeltaEvent {
  type: "text_delta";
  content: string;
}

/** 어시스턴트의 전체 응답이 완성되었다 */
export interface ResponseCompleteEvent {
  type: "response_complete";
  content: string;
}

/** 하나의 턴이 완료되었다 */
export interface TurnCompleteEvent {
  type: "turn_complete";
  tokens: number;
  elapsed: number; // 초 단위
}

// Chapter 07에서 추가될 이벤트:
// /** AI가 도구 사용을 요청했다 */
// export interface ToolCallEvent {
//   type: "tool_call";
//   id: string;
//   name: string;
//   arguments: Record<string, unknown>;
// }
//
// /** 도구 실행 결과가 나왔다 */
// export interface ToolResultEvent {
//   type: "tool_result";
//   toolCallId: string;
//   content: string;
//   isError: boolean;
// }

/** 에러가 발생했다 */
export interface ErrorEvent {
  type: "error";
  message: string;
}

/** 쿼리 루프에서 발생하는 모든 이벤트 */
export type QueryEvent =
  | TextDeltaEvent
  | ResponseCompleteEvent
  | TurnCompleteEvent
  | ErrorEvent;
// Chapter 07에서 추가:
// | ToolCallEvent
// | ToolResultEvent
```

## Step 2: `oda/src/query.ts` — 새 파일 (핵심)

이 파일이 이번 챕터의 심장이다.

````typescript
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

import { chat, type OllamaMessage } from "./ollama.js";
import type { Conversation } from "./conversation.js";
import type { QueryEvent } from "./events.js";

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
````

이해해야 할 핵심 두 가지:

**1) 콜백 → 제너레이터 브릿지**: `chat()` 함수는 콜백 기반인데, `query()`는 제너레이터다. 이 둘을 연결하기 위해 이벤트 버퍼 + Promise 대기 패턴을 쓴다. 콜백이 이벤트를 버퍼에 넣으면, 제너레이터 루프가 꺼내서 yield한다. 이벤트가 없으면 Promise로 대기한다.

**2) `hasToolUse` 분기**: 지금은 항상 `false`라서 1턴 후 종료된다. Chapter 07에서 Ollama 응답을 파싱해서 tool_use 블록이 있는지 확인하고, 있으면 도구를 실행한 뒤 다음 턴을 시작하게 된다. 이 한 줄이 바뀌는 것만으로 "챗봇"이 "에이전트"가 된다.

## Step 3: `oda/src/ui/App.tsx` — 수정

`handleSubmit`에서 직접 `chat()`을 호출하던 로직을 `query()` 소비로 교체한다.

기존 import에 추가:

```diff
+ import { query } from "../query.js";
```

`handleSubmit` 내부를 교체한다. 기존의 `chat()` 직접 호출 + 수동 상태 관리가 깔끔한 for-await 루프로 바뀐다:

```typescript
const handleSubmit = useCallback(
  async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) return;

    // 1. 사용자 메시지 추가
    conversation.addUser(trimmed);
    setMessages(conversation.getMessages());
    setInputValue("");
    setIsLoading(true);
    setStreamingText("");

    // 2. 쿼리 루프 실행
    // 이전: chat()을 직접 호출하고 콜백으로 상태 관리
    // 이후: query() 제너레이터를 for-await-of로 소비
    try {
      for await (const event of query({ model, conversation })) {
        switch (event.type) {
          case "text_delta":
            setStreamingText((prev) => prev + event.content);
            break;

          case "response_complete":
            setMessages(conversation.getMessages());
            setStreamingText("");
            break;

          case "turn_complete":
            setStats(conversation.getStats());
            break;

          case "error":
            conversation.addAssistant(`❌ 에러: ${event.message}`);
            setMessages(conversation.getMessages());
            break;
        }
      }
    } finally {
      setIsLoading(false);
      setStreamingText("");
    }
  },
  [conversation, isLoading, model],
);
```

**before vs after:**

```
Before (Chapter 04):
  handleSubmit → apiMessages 조립 → chat() 콜백 → 수동 setState 5개

After (Chapter 05):
  handleSubmit → for await (query()) → switch(event.type) → setState
```

`handleSubmit`이 하는 일이 "이벤트를 UI에 반영하기"로 단순화됐다. Ollama 호출, 응답 파싱, 대화 기록 관리는 전부 `query()`로 넘어갔다.

기존의 `try/catch` + `finally` 블록 전체를 위 코드로 교체한다. `chat`이나 `OllamaMessage`를 직접 import하던 부분도 제거할 수 있다:

```diff
- import { chat, type OllamaMessage } from "../ollama.js";
```

## Step 4: `oda/src/conversation.ts` — 변경 없음

Chapter 04에서 만든 것을 그대로 쓴다. `query.ts`가 `conversation.toOllamaMessages()`와 `conversation.addAssistant()`를 호출하는데, 이 메서드들은 이미 있다.

## Step 5: CLI 모드에서도 `query()` 사용 (선택)

`index.ts`의 `runCli()`도 `query()`를 사용하도록 바꿀 수 있다. 필수는 아니지만, 하면 CLI와 TUI가 같은 엔진을 공유하게 된다:

```typescript
async function runCli(options: {
  model: string;
  system?: string;
  stream: boolean;
  prompt: string;
}) {
  let prompt = options.prompt;
  const stdinData = await readStdin();
  if (stdinData) {
    prompt = `${stdinData}\n\n---\n\n${prompt}`;
  }

  const conversation = new Conversation(options.system);
  conversation.addUser(prompt);

  for await (const event of query({ model: options.model, conversation })) {
    switch (event.type) {
      case "text_delta":
        if (options.stream) {
          process.stdout.write(event.content);
        }
        break;

      case "response_complete":
        if (!options.stream) {
          console.log(event.content);
        }
        break;

      case "error":
        console.error(`❌ ${event.message}`);
        process.exit(1);
    }
  }

  if (options.stream) {
    process.stdout.write("\n");
  }
}
```

이렇게 하면 import도 정리된다:

```diff
- import { chat, checkConnection, listModels, type OllamaMessage } from "./ollama.js";
+ import { checkConnection, listModels } from "./ollama.js";
+ import { Conversation } from "./conversation.js";
+ import { query } from "./query.js";
```

## 테스트

기능적으로 Chapter 04와 동일하게 동작해야 한다. 내부 아키텍처가 바뀌었을 뿐이다.

```bash
# TUI 모드
pnpm dev

# CLI 모드
npx tsx src/index.ts "안녕하세요"

# 타입 체크
pnpm typecheck
```

확인할 것:

1. TUI에서 스트리밍 응답이 이전과 동일하게 나타나는가
2. 연속 대화에서 맥락을 기억하는가
3. CLI 모드에서도 정상 동작하는가
4. 에러 상황(Ollama 꺼짐 등)에서 적절한 메시지가 나오는가

## 체크리스트

- [ ] `events.ts` 새 파일 생성
- [ ] `query.ts` 새 파일 생성
- [ ] `App.tsx`의 `handleSubmit`이 `query()`를 소비하는 방식으로 변경
- [ ] (선택) `index.ts`의 `runCli()`도 `query()` 사용
- [ ] TUI 모드 정상 동작
- [ ] CLI 모드 정상 동작
- [ ] `pnpm typecheck` 통과

## 이 챕터의 위치

```
+─────────────────────────────────────+
| UI Layer (App.tsx)                  |
| for await (query()) → switch/case  |
+──────────────┬──────────────────────+
               |
               v
+─────────────────────────────────────+
| query()  ← ✨ 새 파일 (핵심 엔진)   |
| 비동기 제너레이터                     |
| 턴 루프: API 호출 → [도구 실행] → 반복 |
+──────────────┬──────────────────────+
               |
               v
+─────────────────────────────────────+
| Conversation (메시지 관리)           |
| schemas.ts (타입 정의)               |
+──────────────┬──────────────────────+
               |
               v
+─────────────────────────────────────+
| Ollama API Client                   |
+─────────────────────────────────────+
```

`query()`가 UI와 Ollama 사이에 끼어들었다. UI는 더 이상 Ollama를 직접 호출하지 않는다. 이 분리가 중요한 이유:

- **Chapter 07**: `query()` 안에 도구 실행을 끼워넣으면, UI는 코드 변경 없이 도구 실행 결과를 표시할 수 있다 (이벤트 타입만 추가).
- **Chapter 14**: `query()` 안에 자동 압축을 끼워넣으면, UI는 모른 채 동작한다.
- **Chapter 19**: `query()`에 MCP 도구를 추가해도 같은 이벤트 스트림으로 나온다.

이것이 Claude Code가 "어떤 모드를 사용하든 내부의 핵심 엔진은 동일하다"고 한 설계의 핵심이다.

## 다음 챕터

→ [Chapter 06. 컨텍스트 수집](../06-context/) — 시스템 프롬프트를 체계화하고, Git 상태와 프로젝트 설정(AGENT.md)을 자동 수집하여 AI에게 주입한다. "지금 어떤 프로젝트에서 작업 중인지"를 AI가 아는 상태로 만든다.
