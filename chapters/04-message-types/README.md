# Chapter 04. 메시지 타입 시스템 설계

> **목표**: Zod로 메시지 스키마를 정의하고, 느슨했던 타입들을 런타임까지 검증 가능한 체계로 바꾼다.

## 왜 지금 이걸 하는가

Chapter 03까지의 메시지 타입은 이랬다:

```typescript
// src/types.ts (Chapter 03)
export interface Message {
  role: "user" | "assistant";
  content: string;
}
```

이것으로 대화는 되지만, 다음 챕터(05)에서 쿼리 루프를 만들려면 부족하다:

- **도구 사용 메시지**가 없다 — AI가 "FileRead를 실행해달라"고 요청하는 메시지
- **도구 결과 메시지**가 없다 — 도구 실행 결과를 AI에게 돌려주는 메시지
- **시스템 메시지**가 없다 — 컨텍스트 주입용
- **런타임 검증**이 없다 — Ollama에서 엉뚱한 형식이 오면 조용히 깨진다

Claude Code는 `types/` 디렉토리에 메시지, 권한, ID 등의 타입을 중앙 집중적으로 정의한다. 메시지 타입은 user/assistant/system/progress/attachment/tool_result로 구분되며, ID는 브랜딩 타입으로 혼용을 방지한다.

우리도 이 구조를 따르되, 지금 필요한 것만 만든다.

## 변경 요약

```
변경 파일:
  src/types.ts        → 삭제 (schemas.ts로 대체)

새 파일:
  src/schemas.ts      → Zod 스키마 + 추론 타입
  src/conversation.ts → 대화 기록 관리 클래스

수정 파일:
  src/ui/App.tsx      → schemas.ts 타입 사용으로 변경
  src/ui/MessageList.tsx → 도구 메시지 표시 준비
  package.json        → zod 의존성 추가
```

## Step 1: Zod 추가

```bash
pnpm add zod
```

## Step 2: `src/schemas.ts` — 새 파일

`types.ts`를 삭제하고 이 파일로 대체한다. Zod 스키마에서 TypeScript 타입을 추론하므로, 스키마와 타입이 항상 일치한다.

```typescript
// src/schemas.ts
//
// 메시지 타입 시스템
//
// Claude Code 참고:
// - types/ 디렉토리에 메시지 타입이 중앙 집중 정의
// - 메시지는 user/assistant/system/tool_result 등으로 구분
// - 우리도 같은 구분을 따르되, 지금 필요한 것만 정의한다
// - Chapter 07에서 도구 시스템을 만들 때 tool_use/tool_result를 활성화한다

import { z } from "zod";

// ── 메시지 스키마 ───────────────────────────────────────

export const SystemMessageSchema = z.object({
  role: z.literal("system"),
  content: z.string(),
});

export const UserMessageSchema = z.object({
  role: z.literal("user"),
  content: z.string(),
});

export const AssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.string(),
  // Chapter 07에서 추가될 필드:
  // toolCalls?: ToolCall[]
});

// 도구 관련 메시지는 Chapter 07에서 활성화한다.
// 지금은 스키마만 정의해두고 union에는 포함하지 않는다.

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});

export const ToolResultMessageSchema = z.object({
  role: z.literal("tool"),
  toolCallId: z.string(),
  content: z.string(),
  isError: z.boolean().optional(),
});

// ── 현재 사용하는 메시지 유니언 ──────────────────────────
// Chapter 07 이후: ToolResultMessageSchema도 추가

export const MessageSchema = z.discriminatedUnion("role", [
  SystemMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
]);

// ── 타입 추론 ───────────────────────────────────────────
// Zod 스키마에서 TypeScript 타입을 추론한다.
// 스키마를 수정하면 타입이 자동으로 바뀐다.

export type SystemMessage = z.infer<typeof SystemMessageSchema>;
export type UserMessage = z.infer<typeof UserMessageSchema>;
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ToolResultMessage = z.infer<typeof ToolResultMessageSchema>;
export type Message = z.infer<typeof MessageSchema>;

// ── 세션 통계 ───────────────────────────────────────────

export const SessionStatsSchema = z.object({
  totalTokens: z.number(),
  lastResponseTime: z.number(),
  turnCount: z.number(),
});

export type SessionStats = z.infer<typeof SessionStatsSchema>;

// ── 유틸리티 ────────────────────────────────────────────

/** 안전하게 메시지를 파싱한다. 실패하면 null을 반환한다. */
export function parseMessage(data: unknown): Message | null {
  const result = MessageSchema.safeParse(data);
  return result.success ? result.data : null;
}
```

핵심 설계 결정:

**`discriminatedUnion("role")`** — `role` 필드로 메시지 종류를 구분한다. `msg.role === "user"`로 체크하면 TypeScript가 자동으로 `UserMessage` 타입으로 좁혀준다 (discriminated union narrowing).

**도구 메시지 미리 정의** — `ToolCallSchema`와 `ToolResultMessageSchema`를 지금 정의해두지만, `MessageSchema` union에는 아직 포함하지 않는다. Chapter 07에서 도구 시스템을 만들 때 한 줄만 추가하면 된다.

**`parseMessage()` 유틸** — Ollama 응답이 예상과 다를 때 조용히 깨지는 대신 `null`을 반환한다. Claude Code의 Zod 입력 검증(도구 실행 파이프라인 3단계)과 같은 역할이다.

## Step 3: `src/conversation.ts` — 새 파일

대화 기록을 관리하는 클래스다. Chapter 03에서는 `App.tsx`의 `useState`에 메시지 배열이 직접 들어있었다. 이걸 분리하면 TUI와 CLI 양쪽에서 같은 대화 로직을 쓸 수 있다.

```typescript
// src/conversation.ts
//
// 대화 기록 관리
//
// Claude Code 참고:
// - query.ts에서 mutableMessages[] 배열로 대화 기록을 관리한다
// - QueryEngine은 이 배열을 턴마다 갱신하고 디스크에 저장한다
// - 우리도 같은 패턴: 대화 기록을 하나의 객체로 캡슐화한다
// - Chapter 16에서 디스크 저장을 추가한다

import type {
  Message,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  SessionStats,
} from "./schemas.js";
import type { OllamaMessage } from "./ollama.js";

export class Conversation {
  private messages: Message[] = [];
  private systemPrompt?: string;
  private stats: SessionStats = {
    totalTokens: 0,
    lastResponseTime: 0,
    turnCount: 0,
  };

  constructor(systemPrompt?: string) {
    this.systemPrompt = systemPrompt;
  }

  /** 사용자 메시지를 추가한다 */
  addUser(content: string): UserMessage {
    const msg: UserMessage = { role: "user", content };
    this.messages.push(msg);
    return msg;
  }

  /** 어시스턴트 응답을 추가한다 */
  addAssistant(content: string): AssistantMessage {
    const msg: AssistantMessage = { role: "assistant", content };
    this.messages.push(msg);
    this.stats.turnCount++;
    return msg;
  }

  /** 통계를 갱신한다 */
  updateStats(tokens: number, responseTime: number) {
    this.stats.totalTokens += tokens;
    this.stats.lastResponseTime = responseTime;
  }

  /** Ollama API에 보낼 메시지 배열을 반환한다 */
  toOllamaMessages(): OllamaMessage[] {
    const result: OllamaMessage[] = [];

    if (this.systemPrompt) {
      result.push({ role: "system", content: this.systemPrompt });
    }

    for (const msg of this.messages) {
      result.push({ role: msg.role, content: msg.content });
    }

    return result;
  }

  /** 현재 대화 기록을 반환한다 (읽기 전용) */
  getMessages(): readonly Message[] {
    return this.messages;
  }

  /** 현재 통계를 반환한다 */
  getStats(): SessionStats {
    return { ...this.stats };
  }

  /** 대화 기록의 대략적인 토큰 수를 추정한다 */
  estimateTokenCount(): number {
    // 러프한 추정: 한국어 1글자 ≈ 2토큰, 영어 4글자 ≈ 1토큰
    // 정확한 계산은 Chapter 14(자동 압축)에서 한다
    const totalChars = this.messages.reduce(
      (sum, m) => sum + m.content.length,
      0,
    );
    return Math.ceil(totalChars * 1.5);
  }

  /** 메시지 수를 반환한다 */
  get length(): number {
    return this.messages.length;
  }
}
```

**왜 클래스인가?** — 대화 기록, 시스템 프롬프트, 통계가 하나의 세션에 묶여있기 때문이다. Claude Code의 `QueryEngine`도 `mutableMessages[]`, `totalUsage`, `permissionDenials[]`를 하나의 클래스에 캡슐화한다.

**`toOllamaMessages()`가 핵심** — UI 레이어는 `Message` 타입을 쓰고, API 레이어는 `OllamaMessage` 타입을 쓴다. 이 메서드가 둘 사이를 변환한다. Chapter 07에서 도구 메시지가 추가되면 이 메서드의 변환 로직만 수정하면 된다.

## Step 4: `src/ui/App.tsx` — 변경

`useState`로 직접 관리하던 메시지 배열을 `Conversation` 클래스로 교체한다.

주요 변경:

```diff
- import type { Message, SessionStats } from "../types.js";
+ import type { Message, SessionStats } from "../schemas.js";
+ import { Conversation } from "../conversation.js";

  export function App({ model, system }: Props) {
    const { exit } = useApp();

-   const [messages, setMessages] = useState<Message[]>([]);
+   const [conversation] = useState(() => new Conversation(system));
+   const [messages, setMessages] = useState<readonly Message[]>([]);
    const [inputValue, setInputValue] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [streamingText, setStreamingText] = useState("");
-   const [stats, setStats] = useState<SessionStats>({
-     totalTokens: 0,
-     lastResponseTime: 0,
-   });
+   const [stats, setStats] = useState<SessionStats>({
+     totalTokens: 0,
+     lastResponseTime: 0,
+     turnCount: 0,
+   });
```

`handleSubmit` 내부:

```diff
      // 1. 사용자 메시지 추가
-     const userMessage: Message = { role: "user", content: trimmed };
-     setMessages((prev) => [...prev, userMessage]);
+     conversation.addUser(trimmed);
+     setMessages(conversation.getMessages());
      setInputValue("");
      setIsLoading(true);
      setStreamingText("");

      // 2. Ollama API 호출
-     const apiMessages: OllamaMessage[] = [];
-     if (system) {
-       apiMessages.push({ role: "system", content: system });
-     }
-     for (const msg of [...messages, userMessage]) {
-       apiMessages.push({ role: msg.role, content: msg.content });
-     }
+     const apiMessages = conversation.toOllamaMessages();

      // 3. 스트리밍 호출 (동일)
      ...

      // 4. 완성된 응답 추가
-     setMessages((prev) => [
-       ...prev,
-       { role: "assistant", content: fullResponse },
-     ]);
+     conversation.addAssistant(fullResponse);
+     conversation.updateStats(tokenCount, elapsed);
+     setMessages(conversation.getMessages());
+     setStats(conversation.getStats());

-     setStats((prev) => ({
-       totalTokens: prev.totalTokens + tokenCount,
-       lastResponseTime: elapsed,
-     }));
```

변경의 효과:

- 메시지 관리 로직이 `Conversation`으로 집중됨
- `App.tsx`는 UI 렌더링에만 집중
- CLI 모드에서도 같은 `Conversation`을 쓸 수 있음 (지금 당장은 안 하지만 준비됨)

## Step 5: `src/ui/StatusBar.tsx` — 변경

`turnCount` 표시를 추가한다:

```diff
  <Text dimColor>
    {model}
    {stats.totalTokens > 0 && ` | ${stats.totalTokens} tokens`}
    {stats.lastResponseTime > 0 && ` | ${stats.lastResponseTime.toFixed(1)}s`}
+   {stats.turnCount > 0 && ` | ${stats.turnCount} turns`}
  </Text>
```

## Step 6: `types.ts` 삭제

```bash
rm src/types.ts
```

이 파일의 역할은 `schemas.ts`가 완전히 대체했다.

## 테스트

기능적으로 Chapter 03과 동일하게 동작해야 한다. 타입 시스템 변경은 내부 리팩토링이므로 사용자가 보는 동작은 같다.

```bash
# TUI 모드 — 이전과 동일하게 동작하는지 확인
pnpm dev

# CLI 모드 — 이전과 동일하게 동작하는지 확인
npx tsx src/index.ts "안녕"

# 타입 체크 — 에러 없어야 함
pnpm typecheck
```

**`pnpm typecheck`가 특히 중요하다.** 스키마 변경 후 타입 에러가 없는지 반드시 확인한다.

## 체크리스트

- [ ] `types.ts` 삭제, `schemas.ts`로 대체
- [ ] `conversation.ts` 추가
- [ ] `App.tsx`가 `Conversation` 클래스를 사용
- [ ] TUI 모드가 이전과 동일하게 동작
- [ ] CLI 모드가 이전과 동일하게 동작
- [ ] `pnpm typecheck` 통과
- [ ] StatusBar에 turn count 표시

## 이 챕터의 위치

```
+─────────────────────────────────────+
| UI Layer (App, MessageList, ...)    |
+──────────────┬──────────────────────+
               |
               v
+─────────────────────────────────────+
| Conversation  ← ✨ 새 파일          |
| (메시지 관리, API 포맷 변환)          |
+──────────────┬──────────────────────+
               |
               v
+─────────────────────────────────────+
| schemas.ts  ← ✨ 새 파일            |
| (Zod 스키마, 타입 정의, 검증)         |
+──────────────┬──────────────────────+
               |
               v
+─────────────────────────────────────+
| Ollama API Client                   |
+─────────────────────────────────────+
```

UI → Conversation → schemas → Ollama 순으로 계층이 정리되었다. 다음 챕터에서 `Conversation`의 메시지 전송 로직을 **쿼리 루프**로 발전시킨다 — 비동기 제너레이터 패턴으로, 도구 실행까지 자동 반복하는 핵심 엔진이다.

## 다음 챕터

→ [Chapter 05. 쿼리 루프](../05-query-loop/) — `App.tsx`의 `handleSubmit` 안에 있는 Ollama 호출 로직을 `query()` 제너레이터로 추출한다. 도구 사용이 있으면 자동으로 다음 턴을 실행하는, 에이전트의 심장을 만든다.
