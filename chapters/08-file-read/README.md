# Chapter 08. 첫 번째 도구 — FileRead

> **목표**: 파일 읽기 도구를 만들어 레지스트리에 등록한다. "이 파일 내용을 설명해줘"라고 하면 AI가 실제로 파일을 읽고 답한다. 챗봇이 에이전트가 되는 순간이다.

## 왜 FileRead가 첫 번째인가

Claude Code 분석서에서 도구를 두 종류로 나눈다:

- **읽기 전용 도구** (Read, Grep, Glob): 안전하다. 동시에 여러 개 실행해도 문제없다.
- **변경 도구** (Edit, Bash, Write): 위험하다. 하나씩 순차 실행해야 한다.

첫 번째 도구는 가장 안전한 읽기 전용으로 시작한다. 아무것도 변경하지 않으므로 권한 시스템 없이도 안심할 수 있다.

## 변경 요약

```
새 파일:
  oda/src/tools/file-read.ts   → FileRead 도구 구현
  oda/src/tools/setup.ts       → 도구 초기 등록

수정 파일:
  oda/src/index.ts             → 시작 시 도구 등록 호출
  oda/src/system-prompt.ts     → 도구 목록을 시스템 프롬프트에 포함
```

## Step 1: `oda/src/tools/file-read.ts` — 새 파일

```typescript
// src/tools/file-read.ts
//
// FileRead 도구 — 파일 내용을 읽어서 반환한다
//
// Claude Code 참고:
// FileRead는 가장 기본적인 읽기 전용 도구다.
// 경로를 받아 파일 내용을 반환한다.
// isConcurrencySafe = true라서 다른 도구와 병렬 실행 가능.

import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "./types.js";

const MAX_FILE_SIZE = 512 * 1024; // 512KB
const MAX_RESULT_CHARS = 100_000; // 약 100K 문자

const inputSchema = z.object({
  path: z.string().describe("읽을 파일의 경로 (상대 또는 절대)"),
  startLine: z.number().optional().describe("시작 줄 번호 (1부터 시작, 선택)"),
  endLine: z.number().optional().describe("끝 줄 번호 (포함, 선택)"),
});

export const fileReadTool: Tool = {
  name: "FileRead",
  description: [
    "Read the contents of a file.",
    "Use this tool when you need to see what's inside a file.",
    "You can optionally specify startLine and endLine to read a specific range.",
    "The file path can be relative (to the current working directory) or absolute.",
  ].join(" "),

  inputSchema,
  isReadOnly: true,

  async call(input: Record<string, unknown>): Promise<ToolResult> {
    const parsed = inputSchema.parse(input);
    const filePath = resolve(parsed.path);

    // ── 존재 확인 ─────────────────────────────────────
    if (!existsSync(filePath)) {
      return {
        content: `File not found: ${parsed.path}`,
        isError: true,
      };
    }

    // ── 크기 확인 ─────────────────────────────────────
    // Claude Code 참고: 큰 결과는 디스크에 저장하고 참조만 넘긴다.
    // 우리는 단순히 잘라낸다.
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return {
        content: `Not a file: ${parsed.path} (is it a directory?)`,
        isError: true,
      };
    }

    if (stat.size > MAX_FILE_SIZE) {
      return {
        content: `File too large: ${parsed.path} (${formatBytes(stat.size)}, max ${formatBytes(MAX_FILE_SIZE)}). Use startLine/endLine to read a portion.`,
        isError: true,
      };
    }

    // ── 읽기 ──────────────────────────────────────────
    try {
      const raw = readFileSync(filePath, "utf-8");
      const lines = raw.split("\n");

      // 줄 범위 지정이 있으면 해당 범위만 반환
      const start = parsed.startLine ? parsed.startLine - 1 : 0;
      const end = parsed.endLine ?? lines.length;
      const selected = lines.slice(start, end);

      // 줄 번호를 붙여서 반환 (AI가 "42번 줄의 버그"를 말할 수 있게)
      const numbered = selected
        .map((line, i) => `${(start + i + 1).toString().padStart(4)} | ${line}`)
        .join("\n");

      // 결과 크기 제한
      let result = numbered;
      if (result.length > MAX_RESULT_CHARS) {
        result = result.substring(0, MAX_RESULT_CHARS) + "\n... (truncated)";
      }

      const relativePath = relative(process.cwd(), filePath);
      const lineInfo = parsed.startLine
        ? ` (lines ${parsed.startLine}-${end})`
        : ` (${lines.length} lines)`;

      return {
        content: `File: ${relativePath}${lineInfo}\n\n${result}`,
      };
    } catch (error) {
      return {
        content: `Error reading file: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
```

설계 포인트:

**줄 번호 표시** — `   1 | const x = 1` 형태로 반환한다. AI가 "42번 줄을 수정해야 합니다"라고 구체적으로 말할 수 있게 된다. Chapter 11에서 FileEdit 도구를 만들 때 이 줄 번호를 참조한다.

**줄 범위 지정** — `startLine`/`endLine`으로 큰 파일의 일부만 읽을 수 있다. 컨텍스트 윈도우가 작은 Gemma에서 특히 중요하다.

**크기 제한** — 512KB 이상은 거부, 결과는 100K 문자로 잘라낸다. Claude Code는 큰 결과를 디스크에 저장하고 참조만 넘기는데, 우리는 단순히 잘라낸다.

## Step 2: `oda/src/tools/setup.ts` — 새 파일

도구를 레지스트리에 등록하는 진입점이다. 앞으로 도구가 추가될 때마다 여기에 한 줄씩 추가한다.

```typescript
// src/tools/setup.ts
//
// 도구 초기 등록
//
// Claude Code 참고 (7.3절):
// 모든 도구는 tools.ts에 등록된다.
// 이후 피처 게이트, 거부 규칙, 모드 필터를 거친다.
// 우리는 단순히 등록만 한다.

import { toolRegistry } from "./registry.js";
import { fileReadTool } from "./file-read.js";

export function registerTools(): void {
  toolRegistry.register(fileReadTool);

  // 다음 챕터에서 추가:
  // toolRegistry.register(bashTool);       // Chapter 10
  // toolRegistry.register(fileEditTool);   // Chapter 11
  // toolRegistry.register(grepTool);       // Chapter 11
  // toolRegistry.register(globTool);       // Chapter 11
}
```

## Step 3: `oda/src/tools/index.ts` — 수정

setup 함수를 export에 추가한다.

```diff
  export { toolRegistry } from "./registry.js";
  export type { Tool, ToolResult, OllamaToolDefinition } from "./types.js";
  export { toolToOllamaDefinition } from "./types.js";
+ export { registerTools } from "./setup.js";
```

## Step 4: `oda/src/index.ts` — 수정

앱 시작 시 도구를 등록한다. 연결 확인과 모델 확인 사이에 넣는다.

```diff
+ import { registerTools } from "./tools/index.js";

  async function main() {
    const options = parseCli();

    const connected = await checkConnection();
    if (!connected) { ... }

    const models = await listModels();
    if (!models.some(...)) { ... }

+   // 도구 등록
+   registerTools();

    if (options.prompt) {
      await runCli(options);
    } else {
      await runTui(options.model, options.system);
    }
  }
```

## Step 5: `oda/src/system-prompt.ts` — 수정

도구 목록을 시스템 프롬프트에 포함한다. Ollama 네이티브 tool calling이 잘 동작하면 이 부분은 선택적이지만, 작은 모델에서는 시스템 프롬프트에 도구 설명이 있는 것이 더 안정적이다.

```diff
  import type { Context } from "./context.js";
+ import { toolRegistry } from "./tools/index.js";

  export function buildSystemPrompt(context: Context, userSystem?: string): string {
    const sections: string[] = [];

    sections.push(
      "You are an AI coding assistant running locally on the user's machine.",
      "You help with reading, writing, and understanding code.",
      "Be concise and direct. When you're not sure, say so.",
    );

+   // ── 도구 목록 ─────────────────────────────────────
+   const tools = toolRegistry.getAll();
+   if (tools.length > 0) {
+     sections.push("\n## Available Tools");
+     sections.push("You can use the following tools to help answer questions:");
+     sections.push("");
+     for (const tool of tools) {
+       sections.push(`- **${tool.name}**: ${tool.description}`);
+     }
+   }

    // 날짜, Git, AGENT.md, 사용자 시스템 프롬프트 ... (기존 코드)
    ...
```

## Step 6: Gemma Tool Calling 호환성 대응

여기서 중요한 분기점이 있다. Gemma 모델에서 Ollama 네이티브 tool calling이 **잘 동작하는지 테스트**해야 한다.

```bash
# 먼저 확인: Ollama가 Gemma에서 tool calling을 지원하는지
curl http://localhost:11434/api/chat -d '{
  "model": "gemma4:e2b",
  "messages": [{"role": "user", "content": "Read the file package.json"}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "FileRead",
      "description": "Read file contents",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {"type": "string", "description": "file path"}
        },
        "required": ["path"]
      }
    }
  }],
  "stream": false
}'
```

응답의 `message.tool_calls`에 값이 있으면 네이티브 tool calling이 동작하는 것이다.

**만약 동작하지 않으면**, `query.ts`에 **수동 파싱 폴백**을 추가해야 한다. 시스템 프롬프트에 도구 사용 포맷을 명시하고, AI 응답 텍스트를 파싱하는 방식이다.

`oda/src/system-prompt.ts`에 추가할 도구 사용 안내:

````typescript
if (tools.length > 0) {
  sections.push("\n## Available Tools");
  sections.push("You can use the following tools to help answer questions.\n");
  sections.push("To use a tool, respond with this EXACT format:");
  sections.push("```");
  sections.push("<tool_call>");
  sections.push('{"name": "ToolName", "arguments": {"param": "value"}}');
  sections.push("</tool_call>");
  sections.push("```\n");
  sections.push("After the tool result is provided, continue your response.\n");
  sections.push("Available tools:");
  for (const tool of tools) {
    sections.push(`- **${tool.name}**: ${tool.description}`);
  }
}
````

`oda/src/query.ts`에 추가할 수동 파싱 함수:

```typescript
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
```

그리고 `query()` 함수에서 API 응답 처리 후:

```diff
      // 도구 호출 감지
-     const hasToolUse = toolCalls.length > 0;
+     // 1차: Ollama 네이티브 tool_calls 확인
+     // 2차: 응답 텍스트에서 <tool_call> 태그 파싱 (폴백)
+     if (toolCalls.length === 0) {
+       toolCalls = parseToolCallsFromText(fullResponse);
+       // 텍스트에서 tool_call 부분을 제거 (사용자에게 보여줄 필요 없음)
+       if (toolCalls.length > 0) {
+         fullResponse = fullResponse.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
+       }
+     }
+     const hasToolUse = toolCalls.length > 0;
```

이 이중 경로 덕분에 네이티브 tool calling이 되든 안 되든 동작한다.

## 테스트

이번에는 실제로 에이전트가 파일을 읽는 것을 확인한다.

```bash
# 1. TUI 모드에서 테스트
pnpm dev

# 프롬프트: "package.json 파일 읽어서 설명해줘"
# 기대: AI가 FileRead 도구를 호출 → 파일 내용을 읽고 → 설명

# 프롬프트: "src/query.ts의 처음 20줄을 보여줘"
# 기대: FileRead(path: "src/query.ts", startLine: 1, endLine: 20) 호출

# 프롬프트: "존재하지 않는 파일.txt를 읽어줘"
# 기대: FileRead 호출 → "File not found" 에러 → AI가 에러를 보고 대응

# 2. CLI 모드에서 테스트
npx tsx src/index.ts "tsconfig.json에서 target이 뭐야?"

# 3. 멀티턴 테스트 (TUI에서)
# "package.json 읽어봐" → (읽음) → "거기서 의존성 목록만 알려줘"
# 기대: 두 번째 질문에서 다시 파일을 읽지 않고 이전 결과로 답함

# 4. 타입 체크
pnpm typecheck
```

**핵심 확인**: 🔧 아이콘이 뜨면서 "실행 중: FileRead" → "완료: FileRead"가 표시되고, 그 다음 AI가 파일 내용을 기반으로 답변하는 것을 확인한다.

만약 AI가 도구를 호출하지 않고 "파일을 읽을 수 없습니다"라고 답한다면, Gemma의 tool calling이 동작하지 않는 것이다. 이 경우 위의 **수동 파싱 폴백**을 적용한다.

## 체크리스트

- [ ] `tools/file-read.ts` — FileRead 도구 구현
- [ ] `tools/setup.ts` — 도구 등록 진입점
- [ ] `tools/index.ts` — export 추가
- [ ] `index.ts` — `registerTools()` 호출
- [ ] `system-prompt.ts` — 도구 목록 포함
- [ ] (필요 시) 수동 파싱 폴백 구현
- [ ] "package.json 읽어줘" → 실제 파일을 읽고 답한다
- [ ] 존재하지 않는 파일 요청 시 에러를 보고 대응한다
- [ ] TUI에서 🔧 도구 실행 상태가 표시된다
- [ ] `pnpm typecheck` 통과

## 이 챕터의 위치

```
+────────────────────────────────────────────+
| UI: 🔧 실행 중: FileRead                   |
+───────────────────┬────────────────────────+
                    |
                    v
+────────────────────────────────────────────+
| query() 쿼리 루프                           |
| turn 1: "package.json 읽어줘"              |
|   → API 호출 → AI: FileRead 호출 결정      |
|   → FileRead 실행 → 결과를 대화에 추가      |
| turn 2: 도구 결과와 함께 다시 API 호출       |
|   → AI: "이 프로젝트는 oda라는..."          |
|   → tool_use 없음 → 루프 종료              |
+───────────────────┬────────────────────────+
                    |
                    v
+────────────────────────────────────────────+
| Tool Registry                              |
| └── FileRead  ← ✨ 첫 번째 도구             |
|     ├── path: string (필수)                |
|     ├── startLine: number (선택)           |
|     ├── endLine: number (선택)             |
|     └── isReadOnly: true                   |
+────────────────────────────────────────────+
```

이것이 에이전트 루프의 실제 동작이다:

```
Turn 1                           Turn 2
─────                            ─────
User: "package.json 읽어줘"      (자동, 사용자 입력 없음)

API에 보내는 것:                  API에 보내는 것:
├── system prompt                ├── system prompt
├── user: "읽어줘"               ├── user: "읽어줘"
└── (끝)                         ├── assistant: [FileRead 호출]
                                 ├── tool: {파일 내용}
                                 └── (끝)

AI 응답:                         AI 응답:
"FileRead를 실행하겠습니다"       "이 프로젝트는 oda이고..."
→ tool_use 있음 → 실행           → tool_use 없음 → 루프 종료
→ 다음 턴으로                    → 사용자에게 표시
```

사용자가 한 번 입력하면, 내부에서 2번의 API 호출과 1번의 도구 실행이 일어난다. 이것이 "에이전트"다.

## 다음 챕터

→ [Chapter 09. 도구 실행 파이프라인](../09-tool-pipeline/) — 지금은 도구 실행이 query.ts에 인라인으로 들어있다. 이것을 별도의 파이프라인으로 추출하고, 입력 검증 → 실행 → 결과 변환 → 크기 제한을 체계화한다. Claude Code의 10단계 파이프라인의 단순화 버전이다.
