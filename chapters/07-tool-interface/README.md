# Chapter 07. 도구 인터페이스 설계 — 에이전트의 뼈대

> **목표**: Tool 인터페이스를 정의하고, 도구 레지스트리를 만들고, 쿼리 루프에 도구 실행을 끼워넣는다. 이 챕터가 끝나면 "챗봇"이 "에이전트"로 바뀐다.

## 왜 지금 이걸 하는가

Chapter 06까지의 AI는 **말만 할 수 있다.** "이 파일 읽어봐"라고 하면 "파일 내용을 알 수 없습니다"라고 답한다. 실제로 파일을 읽는 능력이 없기 때문이다.

이번 챕터에서 **도구 실행 인프라**를 만든다. 다음 챕터(08)에서 첫 번째 도구(FileRead)를 꽂으면 바로 동작한다.

```
Chapter 06까지: 사용자 → AI 대화 → 텍스트 응답
Chapter 07부터: 사용자 → AI 판단 → 도구 실행 → 결과로 다시 판단 → ... → 최종 응답
```

## Claude Code에서 배우는 것

> "도구는 Claude가 외부 세계와 상호작용하기 위한 수단이다. 이것은 Claude Code에서 가장 중요한 개념이다."

Claude Code의 모든 도구는 동일한 인터페이스를 따른다:

```
name            "BashTool", "FileReadTool", ...
inputSchema     Zod 스키마
call()          실제 실행 함수
description()   AI에게 보여줄 설명
isReadOnly()    읽기 전용 여부
```

도구 등록 후 여러 필터를 거친다: 피처 게이트 → 사용자 거부 규칙 → 모드 필터 → MCP 도구 병합. 우리는 단순화해서 레지스트리에 등록하면 바로 사용 가능하게 한다.

핵심은 **쿼리 루프의 턴 분기**다:

```
"tool_use in response?
 YES --> 도구 실행 → 결과를 메시지에 추가 → 다음 턴
 NO  --> 루프 종료, 사용자에게 응답"
```

Chapter 05에서 `hasToolUse = false`로 놔뒀던 그 한 줄이 드디어 바뀐다.

## 변경 요약

```
새 파일:
  oda/src/tools/types.ts       → Tool 인터페이스 정의
  oda/src/tools/registry.ts    → 도구 레지스트리
  oda/src/tools/index.ts       → 배럴 export

수정 파일:
  oda/src/schemas.ts           → ToolCall/ToolResult를 MessageSchema에 포함
  oda/src/conversation.ts      → 도구 메시지 처리 추가
  oda/src/events.ts            → ToolCall/ToolResult 이벤트 추가
  oda/src/query.ts             → 도구 실행 루프 구현 (핵심 변경)
  oda/src/ollama.ts            → tools 파라미터 지원 추가
  oda/src/ui/App.tsx            → 도구 이벤트 표시
  oda/src/ui/MessageList.tsx    → 도구 실행 상태 표시
```

## Step 1: `oda/src/tools/types.ts` — 새 파일

모든 도구가 따르는 인터페이스를 정의한다.

```typescript
// src/tools/types.ts
//
// 도구 인터페이스 정의
//
// Claude Code 참고 (7.2절):
// 모든 도구는 동일한 인터페이스를 따른다:
// name, inputSchema, call(), description(),
// isReadOnly(), isConcurrencySafe() 등
//
// 우리도 같은 구조를 따르되, 지금 필요한 것만 정의한다.

import { z } from "zod";

/** 도구 실행 결과 */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** 모든 도구가 구현해야 하는 인터페이스 */
export interface Tool {
  /** 도구 이름 (AI가 호출할 때 사용) */
  name: string;

  /** AI에게 보여줄 설명 — 이 설명을 보고 AI가 어떤 도구를 쓸지 결정한다 */
  description: string;

  /** 입력 파라미터의 Zod 스키마 */
  inputSchema: z.ZodType;

  /** 도구를 실행한다 */
  call(input: Record<string, unknown>): Promise<ToolResult>;

  /** 읽기 전용인가? (true면 동시 실행 가능) */
  isReadOnly: boolean;
}

/**
 * Ollama API에 전달하는 도구 정의 형식
 * https://github.com/ollama/ollama/blob/main/docs/api.md#chat-request-with-tools
 */
export interface OllamaToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/**
 * Zod 스키마를 Ollama가 이해하는 JSON Schema로 변환한다.
 *
 * 왜 직접 변환하는가?
 * Ollama의 function calling은 JSON Schema 형식을 기대한다.
 * Zod의 .describe()나 zod-to-json-schema 라이브러리를 쓸 수도 있지만,
 * 우리 도구의 스키마는 단순하므로 직접 변환이 더 명확하다.
 */
export function toolToOllamaDefinition(tool: Tool): OllamaToolDefinition {
  // Zod 스키마에서 shape를 추출
  // 우리 도구들은 모두 z.object()를 쓰므로 이 방식이 동작한다
  const schema = tool.inputSchema as z.ZodObject<Record<string, z.ZodType>>;
  const shape = schema.shape;

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const zodType = value as z.ZodType;

    // 기본적인 타입 매핑
    properties[key] = zodTypeToJsonSchema(zodType);

    // optional이 아니면 required
    if (!zodType.isOptional()) {
      required.push(key);
    }
  }

  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
    },
  };
}

function zodTypeToJsonSchema(zodType: z.ZodType): Record<string, unknown> {
  // optional 래퍼를 벗긴다
  const unwrapped =
    zodType instanceof z.ZodOptional ? zodType.unwrap() : zodType;

  if (unwrapped instanceof z.ZodString) {
    return { type: "string", description: unwrapped.description ?? "" };
  }
  if (unwrapped instanceof z.ZodNumber) {
    return { type: "number", description: unwrapped.description ?? "" };
  }
  if (unwrapped instanceof z.ZodBoolean) {
    return { type: "boolean", description: unwrapped.description ?? "" };
  }

  // 기본값: string으로 처리
  return { type: "string" };
}
```

핵심은 `toolToOllamaDefinition()`이다. Zod 스키마를 Ollama가 이해하는 JSON Schema로 변환한다. AI는 이 스키마를 보고 "FileRead에는 path 파라미터가 필요하다"는 것을 파악한다.

## Step 2: `oda/src/tools/registry.ts` — 새 파일

```typescript
// src/tools/registry.ts
//
// 도구 레지스트리
//
// Claude Code 참고 (7.3절):
// 모든 도구는 tools.ts에 특정 순서로 등록된다.
// "순서가 중요한 이유는 API의 프롬프트 캐싱 안정성 때문이다."
// 우리는 Ollama라서 캐싱 걱정은 없지만, 이름순 정렬은 유지한다.

import type { Tool, OllamaToolDefinition } from "./types.js";
import { toolToOllamaDefinition } from "./types.js";

class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  /** 도구를 등록한다 */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  /** 이름으로 도구를 찾는다 */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 등록된 모든 도구를 이름순으로 반환한다 */
  getAll(): Tool[] {
    return Array.from(this.tools.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /** Ollama API에 전달할 도구 정의 배열을 반환한다 */
  toOllamaTools(): OllamaToolDefinition[] {
    return this.getAll().map(toolToOllamaDefinition);
  }

  /** 등록된 도구 수 */
  get size(): number {
    return this.tools.size;
  }
}

// 싱글턴 레지스트리
export const toolRegistry = new ToolRegistry();
```

## Step 3: `oda/src/tools/index.ts` — 새 파일

```typescript
// src/tools/index.ts

export { toolRegistry } from "./registry.js";
export type { Tool, ToolResult, OllamaToolDefinition } from "./types.js";
export { toolToOllamaDefinition } from "./types.js";
```

## Step 4: `oda/src/schemas.ts` — 수정

Chapter 04에서 미리 정의해둔 도구 메시지를 `MessageSchema` union에 포함시킨다.

```diff
  // ── 현재 사용하는 메시지 유니언 ──────────────────────────

+ export const AssistantToolCallMessageSchema = z.object({
+   role: z.literal("assistant"),
+   content: z.string(),
+   toolCalls: z.array(ToolCallSchema),
+ });
+
+ export type AssistantToolCallMessage = z.infer<typeof AssistantToolCallMessageSchema>;

  export const MessageSchema = z.discriminatedUnion("role", [
    SystemMessageSchema,
    UserMessageSchema,
    AssistantMessageSchema,
+   ToolResultMessageSchema,
  ]);
```

그리고 주의: `AssistantToolCallMessage`는 `role: "assistant"`로 동일하므로 discriminatedUnion에는 넣을 수 없다. 별도 타입으로 관리한다.

## Step 5: `oda/src/ollama.ts` — 수정

`chat()` 함수에 `tools` 파라미터를 추가한다.

```diff
  export interface ChatOptions {
    model: string;
    messages: OllamaMessage[];
    stream?: boolean;
+   tools?: unknown[];  // Ollama tool definitions
  }
```

요청 body에도 추가:

```diff
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      stream: options.stream ?? true,
+     ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
    }),
```

응답 청크 타입에 tool_calls 추가:

```diff
  export interface OllamaChatChunk {
    model: string;
    message: OllamaMessage & {
+     tool_calls?: Array<{
+       function: {
+         name: string;
+         arguments: Record<string, unknown>;
+       };
+     }>;
    };
    done: boolean;
    total_duration?: number;
    eval_count?: number;
  }
```

## Step 6: `oda/src/events.ts` — 수정

도구 관련 이벤트를 활성화한다.

```diff
+ /** AI가 도구 사용을 요청했다 */
+ export interface ToolCallEvent {
+   type: "tool_call";
+   id: string;
+   name: string;
+   arguments: Record<string, unknown>;
+ }
+
+ /** 도구 실행 결과 */
+ export interface ToolResultEvent {
+   type: "tool_result";
+   toolCallId: string;
+   name: string;
+   content: string;
+   isError: boolean;
+ }

  export type QueryEvent =
    | TextDeltaEvent
    | ResponseCompleteEvent
    | TurnCompleteEvent
+   | ToolCallEvent
+   | ToolResultEvent
    | ErrorEvent;
```

## Step 7: `oda/src/conversation.ts` — 수정

도구 관련 메시지를 대화 기록에 추가하는 메서드를 만든다.

```diff
+ import type { ToolCall } from "./schemas.js";

  export class Conversation {
    ...

+   /** 도구 호출을 포함한 어시스턴트 응답을 추가한다 */
+   addAssistantWithToolCalls(content: string, toolCalls: ToolCall[]): void {
+     // 텍스트 응답이 있으면 추가
+     if (content) {
+       this.messages.push({ role: "assistant", content });
+     }
+     // 도구 호출 정보는 Ollama 메시지 변환 시 처리
+     this._pendingToolCalls = toolCalls;
+     this.stats.turnCount++;
+   }
+
+   /** 도구 실행 결과를 추가한다 */
+   addToolResult(toolCallId: string, content: string, isError = false): void {
+     this._toolResults.push({ toolCallId, content, isError });
+   }

+   private _pendingToolCalls: ToolCall[] = [];
+   private _toolResults: Array<{ toolCallId: string; content: string; isError: boolean }> = [];

    toOllamaMessages(): OllamaMessage[] {
      const result: OllamaMessage[] = [];
      result.push({ role: "system", content: this.systemPrompt });

      for (const msg of this.messages) {
        result.push({ role: msg.role, content: msg.content });
      }

+     // 펜딩 중인 도구 호출이 있으면 assistant 메시지에 tool_calls 포함
+     if (this._pendingToolCalls.length > 0) {
+       result.push({
+         role: "assistant",
+         content: "",
+         tool_calls: this._pendingToolCalls.map((tc) => ({
+           function: { name: tc.name, arguments: tc.arguments },
+         })),
+       } as OllamaMessage);
+
+       // 도구 결과를 tool role 메시지로 추가
+       for (const tr of this._toolResults) {
+         result.push({ role: "tool", content: tr.content } as OllamaMessage);
+       }
+
+       // 클리어
+       this._pendingToolCalls = [];
+       this._toolResults = [];
+     }

      return result;
    }
```

> **참고**: Ollama의 tool calling 메시지 포맷은 모델마다 다를 수 있다. Gemma 모델에서 tool calling이 제대로 동작하지 않으면, 시스템 프롬프트에 도구 사용 규칙을 텍스트로 넣고 응답을 파싱하는 방식(수동 파싱)으로 전환해야 할 수 있다. 이 부분은 뒤에서 다시 다룬다.

## Step 8: `oda/src/query.ts` — 핵심 변경

드디어 `hasToolUse = false`가 실제 로직으로 바뀐다.

import 추가:

```diff
+ import { toolRegistry, type Tool, type ToolResult } from "./tools/index.js";
+ import type { ToolCall } from "./schemas.js";
```

`QueryOptions` 변경:

```diff
  export interface QueryOptions {
    model: string;
    conversation: Conversation;
    maxTurns?: number;
+   tools?: Tool[];  // 사용할 도구 목록 (없으면 레지스트리에서 가져옴)
  }
```

`query()` 함수의 for 루프 내부를 교체한다. 핵심 변경만 표시:

```typescript
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
            const toolResult = await tool.call(parsed.data);
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
```

**이것이 에이전트의 심장이다.** 변경점을 정리하면:

1. `chat()` 호출 시 `tools` 파라미터 전달
2. 응답에서 `tool_calls` 감지
3. `hasToolUse`가 `true`면 → 도구 실행 → 결과를 대화에 추가 → **다음 턴으로 루프**
4. `hasToolUse`가 `false`면 → 최종 응답 → 루프 종료

## Step 9: `oda/src/ui/MessageList.tsx` — 수정

도구 실행 이벤트를 표시한다.

```diff
+ import type { QueryEvent } from "../events.js";

  interface Props {
    messages: readonly Message[];
    streamingText: string;
    isLoading: boolean;
+   toolStatus?: { name: string; status: "running" | "done" | "error" } | null;
  }

- export function MessageList({ messages, streamingText, isLoading }: Props) {
+ export function MessageList({ messages, streamingText, isLoading, toolStatus }: Props) {
    return (
      <Box flexDirection="column" paddingX={1}>
        ...

+       {/* 도구 실행 상태 */}
+       {toolStatus && (
+         <Box marginBottom={1}>
+           <Text color={toolStatus.status === "error" ? "red" : "yellow"}>
+             {"🔧 "}
+             {toolStatus.status === "running" ? "실행 중" : toolStatus.status === "error" ? "에러" : "완료"}
+             {`: ${toolStatus.name}`}
+           </Text>
+         </Box>
+       )}

        {/* 스트리밍 중인 응답 */}
        ...
      </Box>
    );
  }
```

## Step 10: `oda/src/ui/App.tsx` — 수정

이벤트 핸들링에 도구 이벤트를 추가한다.

상태 추가:

```diff
+ const [toolStatus, setToolStatus] = useState<{
+   name: string;
+   status: "running" | "done" | "error";
+ } | null>(null);
```

`handleSubmit`의 switch 문에 추가:

```diff
          for await (const event of query({ model, conversation })) {
            switch (event.type) {
              ...
+             case "tool_call":
+               setToolStatus({ name: event.name, status: "running" });
+               break;
+
+             case "tool_result":
+               setToolStatus({
+                 name: event.name,
+                 status: event.isError ? "error" : "done",
+               });
+               // 잠깐 보여준 뒤 클리어
+               setTimeout(() => setToolStatus(null), 1000);
+               break;
            }
          }
```

MessageList에 prop 전달:

```diff
        <MessageList
          messages={messages}
          streamingText={streamingText}
          isLoading={isLoading}
+         toolStatus={toolStatus}
        />
```

## Gemma 모델의 Tool Calling에 대한 참고

Ollama의 tool calling 지원은 모델마다 다르다. 만약 Gemma 모델에서 `tool_calls`가 응답에 포함되지 않는다면, **수동 파싱 방식**으로 전환해야 한다:

1. 시스템 프롬프트에 도구 목록과 사용 규칙을 텍스트로 넣는다
2. AI가 특정 포맷(예: `<tool>FileRead</tool><args>{"path":"auth.ts"}</args>`)으로 응답
3. 응답 텍스트를 파싱해서 도구 호출을 추출한다

이 방식은 다음 챕터(08)에서 실제 도구를 붙이면서 테스트한 뒤, 필요하면 구현한다. 지금은 Ollama 네이티브 tool calling 경로를 먼저 만들어두는 것이다.

## 테스트

아직 도구가 등록되지 않았으므로, Chapter 06과 동일하게 동작해야 한다. 도구가 없으면 `ollamaTools`가 `undefined`이고 AI는 텍스트만 응답한다.

```bash
# 타입 체크
pnpm typecheck

# TUI 모드 — 이전과 동일하게 동작
pnpm dev

# CLI 모드
npx tsx src/index.ts "안녕하세요"
```

도구 인프라가 정상인지 확인하려면 간단한 테스트 도구를 만들어볼 수 있다:

```typescript
// 임시 테스트 (src/index.ts 등에서)
import { toolRegistry } from "./tools/index.js";
import { z } from "zod";

toolRegistry.register({
  name: "echo",
  description: "Echoes back the input message",
  inputSchema: z.object({ message: z.string() }),
  isReadOnly: true,
  call: async (input) => ({
    content: `Echo: ${(input as { message: string }).message}`,
  }),
});

// 이 상태에서 TUI를 열고 "echo 도구를 써서 hello를 보내줘" 라고 요청
```

동작하면 다음 챕터에서 진짜 도구를 만든다. 테스트 후 임시 코드는 제거한다.

## 체크리스트

- [ ] `tools/types.ts` — Tool 인터페이스 + Zod→JSON Schema 변환
- [ ] `tools/registry.ts` — 도구 레지스트리
- [ ] `tools/index.ts` — 배럴 export
- [ ] `schemas.ts` — ToolResultMessage를 union에 포함
- [ ] `ollama.ts` — tools 파라미터 추가
- [ ] `events.ts` — ToolCall/ToolResult 이벤트 추가
- [ ] `conversation.ts` — 도구 메시지 처리
- [ ] `query.ts` — 도구 실행 루프 구현
- [ ] `MessageList.tsx` — 도구 상태 표시
- [ ] `App.tsx` — 도구 이벤트 핸들링
- [ ] `pnpm typecheck` 통과
- [ ] 도구 없는 상태에서 이전과 동일하게 동작

## 이 챕터의 위치

```
+────────────────────────────────────────────+
| UI Layer                                   |
| ├── tool_call → 🔧 실행 중: FileRead       |
| └── tool_result → 🔧 완료: FileRead        |
+───────────────────┬────────────────────────+
                    |
                    v
+────────────────────────────────────────────+
| query() 쿼리 루프                           |
| ┌─ API 호출                                |
| │   응답에 tool_calls 있으면:               |
| │   ├── lookup tool  ← ✨ 새 로직           |
| │   ├── validate input (Zod)               |
| │   ├── execute tool.call()                |
| │   └── 결과를 대화에 추가 → 다음 턴         |
| │   tool_calls 없으면:                      |
| │   └── 루프 종료                           |
| └─ 반복                                    |
+───────────────────┬────────────────────────+
                    |
                    v
+────────────────────────────────────────────+
| Tool Registry  ← ✨ 새 파일                 |
| ├── Tool 인터페이스                         |
| ├── 등록/조회                               |
| └── Zod → JSON Schema 변환                  |
+────────────────────────────────────────────+
```

도구 실행 **인프라**가 완성되었다. `query()`는 도구를 실행할 준비가 되어있고, `toolRegistry`에 도구를 등록하기만 하면 바로 동작한다. 다음 챕터에서 첫 번째 진짜 도구를 만든다.

## 다음 챕터

→ [Chapter 08. 첫 번째 도구 — FileRead](../08-file-read/) — 파일 읽기 도구를 만들고 레지스트리에 등록한다. "이 파일 내용을 설명해줘"라고 하면 AI가 실제로 파일을 읽고 답한다. 챗봇이 에이전트로 바뀌는 순간이다.
