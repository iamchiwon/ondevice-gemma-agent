# Chapter 12. 권한 시스템

> **목표**: 변경 도구(FileEdit, Bash) 실행 전에 사용자 확인을 요청하는 권한 시스템을 만든다. default/bypass 두 가지 모드를 구현하고, 허용/차단 규칙을 설정할 수 있게 한다.

## 왜 지금 이걸 하는가

Chapter 11까지 AI는 도구를 요청하면 **무조건 실행**했다. FileEdit로 코드를 수정하든, Bash로 `git push`를 하든 확인 없이 바로 실행된다. 이것은 위험하다.

```
# 지금 (Chapter 11)
👤 "이 함수 이름을 바꿔줘"
🤖 → FileEdit 실행 (즉시, 확인 없음)

# Chapter 12 이후
👤 "이 함수 이름을 바꿔줘"
🤖 → FileEdit 요청
   ┌─────────────────────────────────────┐
   │ 🔒 FileEdit를 실행할까요?            │
   │                                     │
   │ path: src/auth.ts                   │
   │ old: "function login("              │
   │ new: "function authenticate("       │
   │                                     │
   │ [y] 허용  [n] 거부  [a] 항상 허용    │
   └─────────────────────────────────────┘
```

## Claude Code에서 배우는 것

Claude Code의 권한 모드:

- **Default**: 읽기 전용은 자동 승인, 위험한 작업은 사용자 확인
- **Auto**: AI 분류기가 2단계로 위험도 평가, 안전하면 자동 실행
- **Plan**: 읽기 전용만 허용, 코드 변경 불가
- **Bypass**: 모든 것 자동 승인 (개발용)

권한 확인 파이프라인:

```
[1] validateInput()
[2] checkPermissions() — 도구별 규칙
[3] PreToolUse hooks
[4] 규칙 매칭: alwaysAllow → 승인 / alwaysDeny → 거부 / alwaysAsk → 질문
[5] 모드별 처리: Default → 사용자 질문 / Auto → AI 분류 / Bypass → 승인
```

규칙 소스 우선순위: Local > Project > User > Flags > Policy

우리는 두 가지 모드(default, bypass)와 허용/차단 규칙을 구현한다. Auto 모드(AI 분류기)는 복잡하므로 생략한다.

## 변경 요약

```
새 파일:
  oda/src/permissions.ts       → 권한 판단 엔진
  oda/src/ui/PermissionPrompt.tsx → 사용자 확인 UI 컴포넌트

수정 파일:
  oda/src/tools/pipeline.ts    → [2]와 [3] 사이에 권한 확인 단계 삽입
  oda/src/tools/types.ts       → PipelineOptions에 권한 옵션 추가
  oda/src/cli.ts               → --bypass 플래그 추가
  oda/src/ui/App.tsx            → 권한 요청 이벤트 처리
  oda/src/events.ts            → PermissionRequest/Response 이벤트 추가
  oda/src/query.ts             → 권한 옵션 전달
```

## Step 1: `oda/src/permissions.ts` — 새 파일

```typescript
// src/permissions.ts
//
// 권한 판단 엔진
//
// Claude Code 참고 (13절):
// "어떤 도구를, 어떤 입력으로, 실행해도 되는가"를 판단하는 게이트키퍼.
//
// 우리의 단순화 버전:
// - default 모드: 읽기 전용 → 자동 승인, 변경 도구 → 사용자 확인
// - bypass 모드: 모든 것 자동 승인
// - 규칙: alwaysAllow / alwaysDeny 패턴 매칭

import type { Tool } from "./tools/types.js";

// ── 타입 ────────────────────────────────────────────────

export type PermissionMode = "default" | "bypass";

export type PermissionDecision =
  | { type: "allow"; reason: string }
  | { type: "deny"; reason: string }
  | { type: "ask"; reason: string };

/** 허용/차단 규칙 */
export interface PermissionRule {
  /** 매칭할 도구 이름 (정확히 일치 또는 "*" 와일드카드) */
  tool: string;
  /** 매칭할 입력 패턴 (선택, 정규식 문자열) */
  inputPattern?: string;
  /** allow 또는 deny */
  action: "allow" | "deny";
}

export interface PermissionConfig {
  mode: PermissionMode;
  rules: PermissionRule[];
}

// ── 기본 설정 ───────────────────────────────────────────

export const DEFAULT_PERMISSION_CONFIG: PermissionConfig = {
  mode: "default",
  rules: [],
};

// ── 판단 함수 ───────────────────────────────────────────

/**
 * 도구 실행 권한을 판단한다.
 *
 * Claude Code의 권한 파이프라인 (13.2절):
 * [1] 도구별 규칙 확인
 * [2] alwaysAllow/alwaysDeny 매칭
 * [3] 모드별 처리
 *
 * 우리의 단순화:
 * [1] bypass 모드 → 무조건 allow
 * [2] 규칙 매칭 (allow/deny)
 * [3] 읽기 전용 → allow, 변경 도구 → ask
 */
export function checkPermission(
  tool: Tool,
  input: Record<string, unknown>,
  config: PermissionConfig,
): PermissionDecision {
  // ── [1] Bypass 모드 ─────────────────────────────────
  if (config.mode === "bypass") {
    return { type: "allow", reason: "bypass mode" };
  }

  // ── [2] 규칙 매칭 ──────────────────────────────────
  for (const rule of config.rules) {
    if (matchesRule(rule, tool, input)) {
      if (rule.action === "allow") {
        return { type: "allow", reason: `rule: allow ${rule.tool}` };
      } else {
        return { type: "deny", reason: `rule: deny ${rule.tool}` };
      }
    }
  }

  // ── [3] 기본 판단 ──────────────────────────────────
  if (tool.isReadOnly) {
    return { type: "allow", reason: "read-only tool" };
  }

  // 변경 도구 → 사용자에게 물어본다
  return {
    type: "ask",
    reason: `${tool.name} can modify files or system`,
  };
}

function matchesRule(
  rule: PermissionRule,
  tool: Tool,
  input: Record<string, unknown>,
): boolean {
  // 도구 이름 매칭
  if (rule.tool !== "*" && rule.tool !== tool.name) {
    return false;
  }

  // 입력 패턴 매칭 (있으면)
  if (rule.inputPattern) {
    const inputStr = JSON.stringify(input);
    try {
      const regex = new RegExp(rule.inputPattern);
      if (!regex.test(inputStr)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

// ── 세션 중 동적 규칙 추가 ──────────────────────────────

/**
 * 사용자가 "항상 허용"을 선택했을 때 규칙을 추가한다.
 */
export function addSessionRule(
  config: PermissionConfig,
  tool: string,
  action: "allow" | "deny",
  inputPattern?: string,
): void {
  config.rules.push({ tool, action, inputPattern });
}
```

## Step 2: `oda/src/events.ts` — 수정

권한 관련 이벤트를 추가한다.

```diff
+ /** 권한 확인이 필요하다 (UI가 사용자에게 물어봐야 함) */
+ export interface PermissionRequestEvent {
+   type: "permission_request";
+   toolName: string;
+   input: Record<string, unknown>;
+   reason: string;
+ }
+
+ /** 권한 결과가 결정되었다 */
+ export interface PermissionResultEvent {
+   type: "permission_result";
+   toolName: string;
+   allowed: boolean;
+ }

  export type QueryEvent =
    | TextDeltaEvent
    | ResponseCompleteEvent
    | TurnCompleteEvent
    | ToolCallEvent
    | ToolResultEvent
+   | PermissionRequestEvent
+   | PermissionResultEvent
    | ErrorEvent;
```

## Step 3: `oda/src/tools/pipeline.ts` — 수정

[2] validate와 [3] execute 사이에 권한 확인 단계를 삽입한다.

import 추가:

```diff
+ import { checkPermission, type PermissionConfig, type PermissionDecision } from "../permissions.js";
```

`PipelineOptions`에 권한 관련 옵션 추가:

```diff
  export interface PipelineOptions {
    tools: Tool[];
    maxResultChars?: number;
+   permissionConfig?: PermissionConfig;
+   onPermissionRequest?: (
+     tool: Tool,
+     input: Record<string, unknown>,
+     reason: string,
+   ) => Promise<"allow" | "deny" | "always_allow">;
  }
```

`PipelineResult`의 stage에 permission 추가:

```diff
- stage: "lookup" | "validate" | "execute" | "truncate" | "format";
+ stage: "lookup" | "validate" | "permission" | "execute" | "truncate" | "format";
```

`executeTool()` 함수에서 [2] validate 다음, [3] execute 전에 삽입:

```diff
    // ── [2] Validate ────────────────────────────────────
    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) { ... }

+   // ── [2.5] Permission Check ──────────────────────────
+   if (options.permissionConfig) {
+     const decision = checkPermission(tool, parsed.data, options.permissionConfig);
+
+     if (decision.type === "deny") {
+       return {
+         content: `Permission denied for ${name}: ${decision.reason}`,
+         isError: true,
+         duration: Date.now() - startTime,
+         stage: "permission",
+       };
+     }
+
+     if (decision.type === "ask" && options.onPermissionRequest) {
+       const response = await options.onPermissionRequest(tool, parsed.data, decision.reason);
+
+       if (response === "deny") {
+         return {
+           content: `Permission denied by user for ${name}`,
+           isError: true,
+           duration: Date.now() - startTime,
+           stage: "permission",
+         };
+       }
+
+       // "always_allow"는 호출자(query.ts)가 규칙에 추가하도록 처리
+     }
+   }

    // ── [3] Execute ─────────────────────────────────────
```

## Step 4: `oda/src/ui/PermissionPrompt.tsx` — 새 파일

```tsx
// src/ui/PermissionPrompt.tsx
//
// 도구 실행 권한 확인 UI

import React from "react";
import { Box, Text, useInput } from "ink";

interface Props {
  toolName: string;
  input: Record<string, unknown>;
  reason: string;
  onDecision: (decision: "allow" | "deny" | "always_allow") => void;
}

export function PermissionPrompt({
  toolName,
  input,
  reason,
  onDecision,
}: Props) {
  useInput((char, key) => {
    if (char === "y" || key.return) {
      onDecision("allow");
    } else if (char === "n" || key.escape) {
      onDecision("deny");
    } else if (char === "a") {
      onDecision("always_allow");
    }
  });

  // 입력 파라미터를 보기 좋게 표시
  const inputLines = Object.entries(input).map(
    ([k, v]) => `  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginY={1}
    >
      <Text bold color="yellow">
        🔒 {toolName}을 실행할까요?
      </Text>
      <Text dimColor>{reason}</Text>
      <Box marginY={1} flexDirection="column">
        {inputLines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
      <Box gap={2}>
        <Text>[y] 허용</Text>
        <Text>[n] 거부</Text>
        <Text>[a] 항상 허용</Text>
      </Box>
    </Box>
  );
}
```

## Step 5: `oda/src/query.ts` — 수정

`QueryOptions`에 권한 설정을 추가하고 파이프라인에 전달한다.

```diff
+ import { type PermissionConfig, addSessionRule, DEFAULT_PERMISSION_CONFIG } from "./permissions.js";

  export interface QueryOptions {
    model: string;
    conversation: Conversation;
    maxTurns?: number;
    tools?: Tool[];
+   permissionConfig?: PermissionConfig;
+   onPermissionRequest?: (
+     toolName: string,
+     input: Record<string, unknown>,
+     reason: string,
+   ) => Promise<"allow" | "deny" | "always_allow">;
  }
```

도구 실행 부분에서 `pipelineOptions`에 권한 설정 추가:

```diff
-   const pipelineOptions: PipelineOptions = { tools };
+   const permissionConfig = options.permissionConfig ?? DEFAULT_PERMISSION_CONFIG;
+
+   const pipelineOptions: PipelineOptions = {
+     tools,
+     permissionConfig,
+     onPermissionRequest: options.onPermissionRequest
+       ? async (tool, input, reason) => {
+           // 이벤트로 UI에 알린다
+           pendingEvents.push({
+             type: "permission_request" as const,
+             toolName: tool.name,
+             input,
+             reason,
+           });
+           resolveWait?.();
+
+           // UI에서 응답을 받을 때까지 대기
+           const decision = await options.onPermissionRequest!(tool.name, input, reason);
+
+           pendingEvents.push({
+             type: "permission_result" as const,
+             toolName: tool.name,
+             allowed: decision !== "deny",
+           });
+           resolveWait?.();
+
+           // "항상 허용"이면 세션 규칙에 추가
+           if (decision === "always_allow") {
+             addSessionRule(permissionConfig, tool.name, "allow");
+           }
+
+           return decision;
+         }
+       : undefined,
+   };
```

> **참고**: 이벤트 버퍼와 `resolveWait` 패턴은 Chapter 05에서 만든 구조를 활용한다. 권한 요청 이벤트도 같은 채널로 UI에 전달된다. 다만 `onPermissionRequest`가 `Promise`를 반환하므로, UI에서 사용자 입력을 받을 때까지 파이프라인 실행이 일시 중단된다.

## Step 6: `oda/src/ui/App.tsx` — 수정

권한 요청/응답 상태를 관리하고, PermissionPrompt를 렌더링한다.

import 추가:

```diff
+ import { PermissionPrompt } from "./PermissionPrompt.js";
+ import { type PermissionConfig, DEFAULT_PERMISSION_CONFIG } from "../permissions.js";
```

Props에 권한 모드 추가:

```diff
  interface Props {
    model: string;
    system?: string;
+   permissionMode?: "default" | "bypass";
  }
```

상태 추가:

```diff
+ const [permissionRequest, setPermissionRequest] = useState<{
+   toolName: string;
+   input: Record<string, unknown>;
+   reason: string;
+   resolve: (decision: "allow" | "deny" | "always_allow") => void;
+ } | null>(null);
+
+ const [permissionConfig] = useState<PermissionConfig>(() => ({
+   ...DEFAULT_PERMISSION_CONFIG,
+   mode: permissionMode ?? "default",
+ }));
```

`handleSubmit`의 query 호출에 권한 옵션 추가:

```diff
        for await (const event of query({
          model,
          conversation,
+         permissionConfig,
+         onPermissionRequest: (toolName, input, reason) => {
+           return new Promise((resolve) => {
+             setPermissionRequest({ toolName, input, reason, resolve });
+           });
+         },
        })) {
```

이벤트 핸들링에 권한 이벤트 추가:

```diff
              case "tool_result":
                setToolStatus({ ... });
                setTimeout(() => setToolStatus(null), 1000);
                break;

+             case "permission_request":
+               // PermissionPrompt가 렌더링된다
+               // (상태는 onPermissionRequest 콜백에서 이미 설정됨)
+               break;
+
+             case "permission_result":
+               setPermissionRequest(null);
+               break;
```

렌더링에 PermissionPrompt 추가 (Input 컴포넌트 위에):

```diff
+     {/* 권한 확인 프롬프트 */}
+     {permissionRequest && (
+       <PermissionPrompt
+         toolName={permissionRequest.toolName}
+         input={permissionRequest.input}
+         reason={permissionRequest.reason}
+         onDecision={(decision) => {
+           permissionRequest.resolve(decision);
+           setPermissionRequest(null);
+         }}
+       />
+     )}

      {/* 입력창 */}
      <Input ... />
```

## Step 7: `oda/src/cli.ts` — 수정

`--bypass` 플래그를 추가한다.

```diff
  export interface CliOptions {
    model: string;
    system?: string;
    stream: boolean;
    prompt?: string;
+   bypass: boolean;
  }

    program
      .name("oda")
      ...
      .option("--no-stream", "스트리밍 비활성화")
+     .option("--bypass", "권한 확인 없이 모든 도구 자동 실행 (주의!)", false)
      .parse();

    return {
      ...
+     bypass: options.bypass,
    };
```

## Step 8: `oda/src/index.ts` — 수정

bypass 옵션을 TUI와 CLI 양쪽에 전달한다.

TUI 모드:

```diff
  async function runTui(model: string, system?: string, bypass?: boolean) {
    const { render } = await import("ink");
    const { createElement } = await import("react");
    const { App } = await import("./ui/App.js");
-   render(createElement(App, { model, system }));
+   render(createElement(App, { model, system, permissionMode: bypass ? "bypass" : "default" }));
  }
```

호출 부분:

```diff
    if (options.prompt) {
-     await runCli(options);
+     await runCli({ ...options, prompt: options.prompt });
    } else {
-     await runTui(options.model, options.system);
+     await runTui(options.model, options.system, options.bypass);
    }
```

CLI 모드에서도 권한을 적용하려면 `runCli()`에서 query 호출 시 permissionConfig를 전달한다. CLI에서는 사용자 확인 UI가 없으므로, bypass가 아니면 변경 도구를 자동 거부하거나 간단한 readline으로 처리한다:

```diff
+   import { DEFAULT_PERMISSION_CONFIG, type PermissionConfig } from "./permissions.js";

    const conversation = new Conversation(systemPrompt);
    conversation.addUser(prompt);

+   const permissionConfig: PermissionConfig = {
+     ...DEFAULT_PERMISSION_CONFIG,
+     mode: options.bypass ? "bypass" : "default",
+   };

    for await (const event of query({
      model: options.model,
      conversation,
+     permissionConfig,
+     // CLI에서는 변경 도구 자동 거부 (bypass 아닌 경우)
+     onPermissionRequest: async (toolName) => {
+       console.error(`⚠️  ${toolName} 실행이 차단되었습니다. --bypass 플래그로 허용할 수 있습니다.`);
+       return "deny";
+     },
    })) {
```

## 테스트

```bash
# 1. 기본 모드 — 읽기 전용은 자동, 변경은 확인
pnpm dev
# "package.json 읽어줘" → 확인 없이 바로 실행 (FileRead, 읽기 전용)
# "package.json의 name을 바꿔줘" → 🔒 확인 프롬프트 → [y] → 실행

# 2. 거부 테스트
# "rm -rf node_modules 실행해줘" → 🔒 확인 → [n] → "Permission denied"

# 3. 항상 허용
# "이 파일 수정해줘" → 🔒 확인 → [a] → 실행
# "이 파일도 수정해줘" → 확인 없이 바로 실행 (세션 규칙 추가됨)

# 4. Bypass 모드
oda --bypass
# "파일 수정해줘" → 확인 없이 바로 실행

# 5. CLI 모드 — 변경 도구 차단
npx tsx src/index.ts "package.json의 version을 2.0.0으로 바꿔줘"
# → "⚠️ FileEdit 실행이 차단되었습니다. --bypass 플래그로 허용할 수 있습니다."

# 6. CLI bypass 모드
npx tsx src/index.ts --bypass "package.json의 version을 2.0.0으로 바꿔줘"
# → 바로 실행

# 7. 타입 체크
pnpm typecheck
```

## 체크리스트

- [ ] `permissions.ts` — 권한 판단 엔진 (checkPermission, 규칙 매칭)
- [ ] `ui/PermissionPrompt.tsx` — 사용자 확인 UI
- [ ] `events.ts` — PermissionRequest/Result 이벤트
- [ ] `tools/pipeline.ts` — [2.5] 권한 확인 단계 삽입
- [ ] `query.ts` — 권한 옵션 전달
- [ ] `cli.ts` — `--bypass` 플래그
- [ ] `App.tsx` — 권한 프롬프트 렌더링
- [ ] `index.ts` — bypass 옵션 전달
- [ ] 읽기 전용 도구는 확인 없이 실행
- [ ] 변경 도구는 확인 후 실행
- [ ] "항상 허용" 선택 시 이후 같은 도구 자동 실행
- [ ] bypass 모드에서 모든 도구 자동 실행
- [ ] `pnpm typecheck` 통과

## 이 챕터의 위치

```
+────────────────────────────────────────────+
| UI Layer                                   |
| ├── PermissionPrompt  ← ✨ 새 컴포넌트     |
| │   🔒 FileEdit를 실행할까요?              |
| │   [y] 허용  [n] 거부  [a] 항상 허용       |
| └── 이벤트: permission_request/result      |
+───────────────────┬────────────────────────+
                    |
                    v
+────────────────────────────────────────────+
| Pipeline                                   |
| [1] lookup                                 |
| [2] validate                               |
| [2.5] permission check  ← ✨ 새 단계       |
|       ├── bypass mode → allow              |
|       ├── rule match → allow/deny          |
|       ├── readOnly → allow                 |
|       └── else → ask user                  |
| [3] execute                                |
| [4] truncate                               |
| [5] format                                 |
+───────────────────┬────────────────────────+
                    |
                    v
+────────────────────────────────────────────+
| permissions.ts  ← ✨ 새 파일               |
| ├── checkPermission()                      |
| ├── PermissionRule (allow/deny 패턴)       |
| └── addSessionRule() (동적 규칙 추가)       |
+────────────────────────────────────────────+
```

Chapter 09에서 예고한 대로, `pipeline.ts`에 단계를 삽입하는 것만으로 권한 시스템이 추가되었다. `query.ts`는 옵션을 전달하는 역할만 하고, 실제 판단 로직은 `permissions.ts`에, UI는 `PermissionPrompt.tsx`에 분리되어 있다.

## 다음 챕터

→ [Chapter 13. 훅 시스템](../13-hooks/) — PreToolUse/PostToolUse 훅을 구현한다. 도구 실행 전에 커스텀 검증을, 실행 후에 자동 린팅을 수행하는 등 사용자 정의 동작을 추가할 수 있게 된다.
