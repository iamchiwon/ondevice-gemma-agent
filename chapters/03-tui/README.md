# Chapter 03. TUI 셸 만들기 — 대화형 인터페이스

> **목표**: React + Ink로 터미널에서 AI와 대화할 수 있는 REPL 인터페이스를 만든다.

## 이 챕터에서 만드는 것

```
┌─────────────────────────────────────────────┐
│  🤖 oda v0.3.0 | gemma3:4b                  │
│─────────────────────────────────────────────│
│                                             │
│  👤 TypeScript의 장점을 알려줘               │
│                                             │
│  🤖 TypeScript는 정적 타입 시스템을 통해     │
│     코드의 안전성을 높이고, IDE 자동완성을    │
│     강화하며, 대규모 프로젝트의 유지보수를    │
│     용이하게 합니다.                         │
│                                             │
│  👤 그중 가장 중요한 건?                     │
│                                             │
│  🤖 정적 타입 시스템입니다. 런타임 에러를     │
│     컴파일 타임에 잡아내어...                 │
│                                             │
│─────────────────────────────────────────────│
│  > █                                        │
│  gemma3:4b | 127 tokens | 2.3s              │
└─────────────────────────────────────────────┘
```

Chapter 02까지는 한 번 물어보고 끝이었다. 이제 **연속 대화**가 가능해진다. 이전 대화 맥락을 기억하고, "그중"이라고 했을 때 앞에서 뭘 말했는지 안다.

## Claude Code에서 배우는 것

Claude Code의 TUI는 React + Ink 기반이다. 왜 터미널 UI에 React를 썼을까?

> "React의 컴포넌트 모델(UI를 작은 조각으로 나누어 조합하는 방식)이 복잡한 터미널 UI에 매우 적합하기 때문이다. 메시지 목록, 도구 진행률, 파일 변경 미리보기 같은 복잡한 UI를 선언적으로 작성할 수 있다."

Claude Code의 REPL 화면 구성:

```
+──────────────────────────────────────+
| Logo Header                          |  ← 모델명, 버전
+──────────────────────────────────────+
| Message List (virtualized)           |  ← 대화 내용
|   User: ...                          |
|   Assistant: ...                     |
|   [Tool] FileRead auth.ts           |
+──────────────────────────────────────+
| Prompt Input                         |  ← 사용자 입력
| > [type here...]                     |
| status bar: model, tokens, cost      |  ← 상태바
+──────────────────────────────────────+
```

우리도 이 구조를 따르되, 도구 표시는 아직 빼고 **메시지 목록 + 입력창 + 상태바**만 구현한다.

핵심은 **상태 관리**다. Claude Code는 Zustand를 쓰지만, 우리는 React의 `useState`로 시작한다. 상태가 복잡해지면 나중에 Zustand로 마이그레이션할 수 있다.

## 디렉토리 구조

```
03-tui/
├── package.json          # + ink, react 의존성
├── tsconfig.json         # + jsx 설정
├── src/
│   ├── cli.ts            # 변경: 프롬프트 없으면 TUI 모드로 분기
│   ├── index.ts          # 변경: TUI 진입점 추가
│   ├── ollama.ts         # 변경 없음
│   └── ui/
│       ├── App.tsx        # ✨ 루트 컴포넌트 — 전체 레이아웃
│       ├── MessageList.tsx # ✨ 대화 메시지 표시
│       ├── Input.tsx      # ✨ 프롬프트 입력창
│       └── StatusBar.tsx  # ✨ 하단 상태바
└── docs/
    └── claude-code-ref.md
```

## Step 1: 의존성 추가

```bash
# React + Ink (터미널 React 렌더러)
pnpm add ink ink-text-input react

# 타입 정의
pnpm add -D @types/react
```

- **ink**: React 컴포넌트를 터미널 문자로 렌더링하는 프레임워크
- **ink-text-input**: Ink용 텍스트 입력 컴포넌트
- **react**: Ink가 내부적으로 React를 사용

## Step 2: `tsconfig.json` 수정

JSX를 사용하므로 설정을 추가한다:

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "jsx": "react-jsx",
  },
  "include": ["src/**/*"],
}
```

변경점은 `"jsx": "react-jsx"` 한 줄이다.

## Step 3: 메시지 타입 정의

대화 상태를 관리하기 위한 최소한의 타입을 만든다. Chapter 04에서 Zod로 본격적인 타입 시스템을 만들겠지만, 지금은 간단하게 시작한다.

```typescript
// src/types.ts

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface SessionStats {
  totalTokens: number;
  lastResponseTime: number; // 초 단위
}
```

## Step 4: `src/ui/MessageList.tsx` — 대화 메시지 표시

```tsx
// src/ui/MessageList.tsx

import React from "react";
import { Box, Text } from "ink";
import type { Message } from "../types.js";

interface Props {
  messages: Message[];
  streamingText: string; // AI가 현재 생성 중인 텍스트
  isLoading: boolean;
}

export function MessageList({ messages, streamingText, isLoading }: Props) {
  return (
    <Box flexDirection="column" paddingX={1}>
      {messages.map((msg, i) => (
        <Box key={i} marginBottom={1}>
          <Text>
            {msg.role === "user" ? "👤 " : "🤖 "}
            {msg.content}
          </Text>
        </Box>
      ))}

      {/* 스트리밍 중인 응답 */}
      {isLoading && (
        <Box marginBottom={1}>
          <Text>
            {"🤖 "}
            {streamingText || "생각 중..."}
          </Text>
        </Box>
      )}
    </Box>
  );
}
```

포인트:

- `streamingText`는 아직 완성되지 않은 응답이다. AI가 토큰을 생성할 때마다 이 값이 갱신되면서 실시간으로 "타이핑"하는 효과를 만든다.
- 완성된 메시지는 `messages` 배열에, 생성 중인 메시지는 `streamingText`에 분리한다.

## Step 5: `src/ui/Input.tsx` — 프롬프트 입력창

```tsx
// src/ui/Input.tsx

import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  isLoading: boolean;
}

export function Input({ value, onChange, onSubmit, isLoading }: Props) {
  if (isLoading) {
    return (
      <Box paddingX={1}>
        <Text dimColor> 응답 대기 중...</Text>
      </Box>
    );
  }

  return (
    <Box paddingX={1}>
      <Text bold color="green">
        {"> "}
      </Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder="메시지를 입력하세요..."
      />
    </Box>
  );
}
```

포인트:

- AI가 응답 중일 때(`isLoading`)는 입력을 비활성화한다. Claude Code도 AI가 응답 중일 때는 입력을 받지 않는다.
- 녹색 `>` 프롬프트는 터미널 느낌을 살린다.

## Step 6: `src/ui/StatusBar.tsx` — 상태바

```tsx
// src/ui/StatusBar.tsx

import React from "react";
import { Box, Text } from "ink";
import type { SessionStats } from "../types.js";

interface Props {
  model: string;
  stats: SessionStats;
}

export function StatusBar({ model, stats }: Props) {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text dimColor>
        {model}
        {stats.totalTokens > 0 && ` | ${stats.totalTokens} tokens`}
        {stats.lastResponseTime > 0 &&
          ` | ${stats.lastResponseTime.toFixed(1)}s`}
      </Text>
      <Text dimColor>Ctrl+C 종료</Text>
    </Box>
  );
}
```

## Step 7: `src/ui/App.tsx` — 루트 컴포넌트

모든 것을 조합하는 핵심 컴포넌트다. 여기에 **대화 상태 관리**와 **Ollama 호출 로직**이 들어간다.

```tsx
// src/ui/App.tsx

import React, { useState, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { MessageList } from "./MessageList.js";
import { Input } from "./Input.js";
import { StatusBar } from "./StatusBar.js";
import { chat, type OllamaMessage } from "../ollama.js";
import type { Message, SessionStats } from "../types.js";

interface Props {
  model: string;
  system?: string;
}

export function App({ model, system }: Props) {
  const { exit } = useApp();

  // ── 상태 ──────────────────────────────────────────────
  // Claude Code는 Zustand로 글로벌 상태를 관리한다.
  // 우리는 아직 간단하므로 useState로 시작한다.
  // 상태가 복잡해지면 나중에 마이그레이션한다.

  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [stats, setStats] = useState<SessionStats>({
    totalTokens: 0,
    lastResponseTime: 0,
  });

  // Ctrl+C로 종료
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
    }
  });

  // ── 메시지 전송 ───────────────────────────────────────
  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || isLoading) return;

      // 1. 사용자 메시지 추가
      const userMessage: Message = { role: "user", content: trimmed };
      setMessages((prev) => [...prev, userMessage]);
      setInputValue("");
      setIsLoading(true);
      setStreamingText("");

      // 2. Ollama API 호출을 위한 메시지 배열 조립
      //    이전 대화 내용을 모두 포함해야 맥락을 유지한다.
      const apiMessages: OllamaMessage[] = [];

      if (system) {
        apiMessages.push({ role: "system", content: system });
      }

      // 기존 대화 + 새 메시지
      for (const msg of [...messages, userMessage]) {
        apiMessages.push({ role: msg.role, content: msg.content });
      }

      // 3. 스트리밍 호출
      let fullResponse = "";
      const startTime = Date.now();
      let tokenCount = 0;

      try {
        await chat({ model, messages: apiMessages }, (chunk) => {
          if (!chunk.done) {
            fullResponse += chunk.message.content;
            setStreamingText(fullResponse);
          } else {
            tokenCount = chunk.eval_count ?? 0;
          }
        });

        // 4. 완성된 응답을 메시지 목록에 추가
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: fullResponse },
        ]);

        // 5. 통계 갱신
        const elapsed = (Date.now() - startTime) / 1000;
        setStats((prev) => ({
          totalTokens: prev.totalTokens + tokenCount,
          lastResponseTime: elapsed,
        }));
      } catch (error) {
        // 에러를 어시스턴트 메시지로 표시
        const errorMessage =
          error instanceof Error ? error.message : "알 수 없는 에러";
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `❌ 에러: ${errorMessage}` },
        ]);
      } finally {
        setIsLoading(false);
        setStreamingText("");
      }
    },
    [messages, isLoading, model, system],
  );

  // ── 렌더링 ────────────────────────────────────────────
  return (
    <Box flexDirection="column" width="100%">
      {/* 헤더 */}
      <Box paddingX={1} marginBottom={1}>
        <Text bold>🤖 oda</Text>
        <Text dimColor> v0.3.0 | {model}</Text>
      </Box>

      {/* 구분선 */}
      <Box paddingX={1}>
        <Text dimColor>{"─".repeat(50)}</Text>
      </Box>

      {/* 메시지 목록 */}
      <MessageList
        messages={messages}
        streamingText={streamingText}
        isLoading={isLoading}
      />

      {/* 구분선 */}
      <Box paddingX={1}>
        <Text dimColor>{"─".repeat(50)}</Text>
      </Box>

      {/* 입력창 */}
      <Input
        value={inputValue}
        onChange={setInputValue}
        onSubmit={handleSubmit}
        isLoading={isLoading}
      />

      {/* 상태바 */}
      <StatusBar model={model} stats={stats} />
    </Box>
  );
}
```

이 컴포넌트에서 이해해야 할 핵심:

**대화 맥락 유지**: `handleSubmit`에서 API를 호출할 때, `messages` 배열의 모든 이전 대화를 함께 보낸다. "그중"이라고 했을 때 "아까 말한 것 중에서"라는 맥락을 AI가 이해할 수 있는 이유다. Claude Code의 쿼리 루프도 동일 — 매 턴마다 전체 대화 기록을 API에 보낸다.

**스트리밍 텍스트 분리**: `streamingText`는 생성 중인 응답, `messages`는 완성된 응답. 생성이 끝나면 `streamingText`를 비우고 `messages`에 추가한다. 이 분리가 없으면 화면이 깜빡인다.

## Step 8: `src/index.ts` — 진입점 수정

CLI 모드와 TUI 모드를 분기한다.

```typescript
// src/index.ts

import { parseCli } from "./cli.js";
import {
  chat,
  checkConnection,
  listModels,
  type OllamaMessage,
} from "./ollama.js";

async function main() {
  const options = parseCli();

  // ── Ollama 연결 확인 ──────────────────────────────────
  const connected = await checkConnection();
  if (!connected) {
    console.error(
      "❌ Ollama 서버에 연결할 수 없습니다. `ollama serve`를 먼저 실행해주세요.",
    );
    process.exit(1);
  }

  // ── 모델 확인 ─────────────────────────────────────────
  const models = await listModels();
  if (!models.some((m) => m.startsWith(options.model))) {
    console.error(`❌ 모델 '${options.model}'을 찾을 수 없습니다.`);
    console.error(`   설치된 모델: ${models.join(", ") || "(없음)"}`);
    process.exit(2);
  }

  // ── 모드 분기 ─────────────────────────────────────────
  // Claude Code 참고:
  // main.tsx에서 --print 플래그가 있으면 헤드리스, 없으면 REPL로 분기한다.
  // 우리도 같은 패턴: 프롬프트가 있으면 CLI, 없으면 TUI.

  if (options.prompt) {
    // CLI 모드 (Chapter 02)
    await runCli(options);
  } else {
    // TUI 모드 (이번 챕터)
    await runTui(options.model, options.system);
  }
}

// ── CLI 모드 ──────────────────────────────────────────────
// Chapter 02에서 만든 로직을 그대로 가져온다.

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

  const messages: OllamaMessage[] = [];
  if (options.system) {
    messages.push({ role: "system", content: options.system });
  }
  messages.push({ role: "user", content: prompt });

  if (options.stream) {
    await chat({ model: options.model, messages }, (chunk) => {
      if (!chunk.done) process.stdout.write(chunk.message.content);
    });
    process.stdout.write("\n");
  } else {
    let result = "";
    await chat({ model: options.model, messages }, (chunk) => {
      if (!chunk.done) result += chunk.message.content;
    });
    console.log(result);
  }
}

// ── TUI 모드 ──────────────────────────────────────────────

async function runTui(model: string, system?: string) {
  // ink와 App을 동적 import한다.
  // 이유: CLI 모드에서는 React/Ink가 필요 없다.
  // 불필요한 모듈 로딩을 피하는 것은 Claude Code의 "조건부 모듈 로딩" 패턴과 같다.
  const { render } = await import("ink");
  const { createElement } = await import("react");
  const { App } = await import("./ui/App.js");

  render(createElement(App, { model, system }));
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

main().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});
```

핵심 포인트: **TUI 의존성을 동적 import한다.** `oda "프롬프트"` 형태의 CLI 실행에서는 React와 Ink가 전혀 필요 없다. 동적 import로 필요할 때만 불러오면 CLI 모드의 시작 시간이 빨라진다. Claude Code도 코디네이터 모드, 어시스턴트 모드 같은 선택적 기능을 "조건부 모듈 로딩"으로 처리한다.

## Step 9: `src/cli.ts` — 변경 없음

Chapter 02에서 만든 것을 그대로 쓴다. `prompt`가 선택적(`[prompt]`)으로 정의되어 있으므로, 인수 없이 `oda`만 실행하면 `options.prompt`가 `undefined`가 되어 TUI 모드로 들어간다.

이미 Chapter 02에서 이 분기를 위한 자리를 만들어뒀다는 점에 주목하자.

## Step 10: 테스트

```bash
# TUI 모드 (프롬프트 없이 실행)
pnpm dev

# 또는 tsx로 직접
npx tsx src/index.ts

# CLI 모드도 여전히 동작해야 한다
npx tsx src/index.ts "안녕하세요"
```

TUI에서 테스트할 것:

```
1. 메시지 입력 → Enter → 스트리밍 응답 확인
2. 이어서 두 번째 질문 → 이전 맥락을 기억하는지 확인
   예: "TypeScript 장점 알려줘" → "그중 가장 중요한 건?"
3. AI 응답 중에는 입력이 비활성화되는지 확인
4. Ctrl+C로 종료되는지 확인
5. 상태바에 모델명, 토큰 수, 응답 시간이 표시되는지 확인
```

## 트러블슈팅

### `ink-text-input`을 못 찾는 경우

ink-text-input의 버전에 따라 import 경로가 다를 수 있다. 안 되면 이렇게 시도:

```typescript
// 방법 1: default import
import TextInput from "ink-text-input";

// 방법 2: 안 되면 named import
import { TextInput } from "ink-text-input";

// 방법 3: 그래도 안 되면 require
const { default: TextInput } = await import("ink-text-input");
```

### 화면이 깨지는 경우

Ink는 터미널 크기를 감지해서 렌더링한다. 터미널 창이 너무 작으면 레이아웃이 깨질 수 있다. 최소 80x24 크기를 권장한다.

### 한글 입력 문제

일부 터미널 + IME 조합에서 한글 입력이 제대로 안 될 수 있다. iTerm2 또는 Warp 터미널을 추천한다.

## 체크리스트

- [ ] `oda` (인수 없이) 실행하면 TUI가 뜬다
- [ ] `oda "프롬프트"` 실행하면 여전히 CLI 모드로 동작한다
- [ ] TUI에서 메시지를 입력하면 스트리밍 응답이 온다
- [ ] 연속 대화에서 이전 맥락을 기억한다
- [ ] AI 응답 중에는 입력이 비활성화된다
- [ ] Ctrl+C로 종료된다
- [ ] 상태바에 모델명, 토큰 수, 응답 시간이 표시된다

## 이 챕터에서 만든 것의 위치 (전체 아키텍처에서)

```
+---------------------+     +---------------------+
| CLI Mode            |     | TUI Mode            | ← ✨ 새로 만든 것
| oda "프롬프트"       |     | oda (대화형)          |
| (Chapter 02)        |     | App.tsx              |
+----------+----------+     | ├── MessageList.tsx  |
           |                 | ├── Input.tsx        |
           |                 | └── StatusBar.tsx    |
           |                 +----------+----------+
           |                            |
           +------------+---------------+
                        |
                        v
              +---------------------+
              | Ollama API Client   | ← 변경 없음
              | (chat, streaming)   |
              +---------+-----------+
                        |
                        v
              +---------------------+
              | Ollama Server       |
              | (Gemma 4 E2B)       |
              +---------------------+
```

**CLI와 TUI가 같은 `ollama.ts`를 공유한다.** 이것이 계층 분리의 핵심이다. Claude Code에서 REPL, headless, bridge, coordinator 모드가 모두 같은 `query.ts`를 공유하는 것과 동일한 패턴이다. 입출력 레이어만 다르고, 핵심 엔진은 하나다.

다음 챕터(04, 05)에서 이 핵심 엔진을 본격적으로 만든다 — 메시지 타입 시스템과 쿼리 루프. 그러면 `handleSubmit`에 직접 들어있는 Ollama 호출 로직이 쿼리 엔진으로 분리되고, TUI는 순수한 "표시 레이어"가 된다.

## 다음 챕터

→ [Chapter 04. 메시지 타입 시스템](../04-message-types/) — Zod로 메시지 스키마를 정의하고, 런타임 검증을 추가한다. 쿼리 루프의 토대를 만드는 작업이다.
