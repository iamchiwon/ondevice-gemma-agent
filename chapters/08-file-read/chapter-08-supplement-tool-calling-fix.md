# 보충: Gemma Tool Calling 호환성 튜닝

> Chapter 08 보충 자료. 작은 모델이 안정적으로 도구를 호출할 수 있도록 프롬프트를 단순화하고 파서를 유연하게 만든다.

## 문제 상황

Gemma E2B가 도구 호출 시 우리가 지정한 JSON 포맷을 따르지 않는다:

```
# 기대한 형식
<tool_call>
{"name": "FileRead", "arguments": {"path": "package.json"}}
</tool_call>

# 실제 출력 (변형 1)
<tool_call>
FileRead{path:"package.json"}
</tool_call>

# 예상되는 다른 변형들
<tool_call>FileRead(path="package.json")</tool_call>
<tool_call>FileRead {"path": "package.json"}</tool_call>
<tool_call>{"name":"FileRead","arguments":{"path":"package.json"}}</tool_call>
```

작은 모델은 복잡한 JSON을 정확히 생성하기 어렵다. **프롬프트를 단순화**하고 **파서를 유연하게** 만들어야 한다.

## 수정 1: `oda/src/system-prompt.ts` — 프롬프트 단순화

도구 사용 안내를 모델이 따르기 쉬운 형태로 바꾼다. 핵심은 **JSON을 요구하지 않는 것**.

기존의 도구 목록 섹션을 아래로 교체한다:

```typescript
    // ── 도구 목록 ─────────────────────────────────────
    const tools = toolRegistry.getAll();
    if (tools.length > 0) {
      sections.push("\n## Tools");
      sections.push("You have access to tools. To use a tool, write EXACTLY this format:\n");
      sections.push("USE_TOOL: ToolName");
      sections.push("param1: value1");
      sections.push("param2: value2");
      sections.push("END_TOOL\n");
      sections.push("Example:");
      sections.push("USE_TOOL: FileRead");
      sections.push("path: src/index.ts");
      sections.push("END_TOOL\n");
      sections.push("Rules:");
      sections.push("- Write USE_TOOL and END_TOOL on their own lines");
      sections.push("- One parameter per line in key: value format");
      sections.push("- Do NOT wrap in code blocks or quotes");
      sections.push("- After you receive the tool result, continue your response\n");
      sections.push("Available tools:");

      for (const tool of tools) {
        sections.push(`\n### ${tool.name}`);
        sections.push(tool.description);

        // 파라미터 설명을 사람이 읽기 쉬운 형태로
        const schema = tool.inputSchema as z.ZodObject<Record<string, z.ZodType>>;
        if (schema.shape) {
          sections.push("Parameters:");
          for (const [key, value] of Object.entries(schema.shape)) {
            const zodType = value as z.ZodType;
            const isOptional = zodType.isOptional();
            const desc = zodType.description ?? "";
            sections.push(`- ${key}${isOptional ? " (optional)" : " (required)"}: ${desc}`);
          }
        }
      }
    }
```

import 추가 (파일 상단):

```diff
+ import { z } from "zod";
```

**왜 이 포맷인가?**

```
USE_TOOL: FileRead
path: package.json
END_TOOL
```

- JSON 괄호/따옴표가 없다 — 작은 모델이 따르기 쉽다
- `USE_TOOL`/`END_TOOL`이 명확한 경계 — 파싱이 확실하다
- YAML과 비슷한 `key: value` — 모델이 익숙한 패턴
- 예시가 하나 들어있어서 few-shot 학습 효과

## 수정 2: `oda/src/query.ts` — 유연한 파서

기존의 `parseToolCallsFromText()`를 여러 포맷을 처리하는 버전으로 교체한다.

```typescript
/**
 * AI 응답 텍스트에서 도구 호출을 추출한다.
 *
 * 여러 포맷을 시도한다 (우선순위 순):
 * 1. USE_TOOL/END_TOOL 포맷 (우리가 지정한 메인 포맷)
 * 2. <tool_call> JSON 포맷
 * 3. <tool_call> 느슨한 포맷 (Gemma 변형들)
 */
function parseToolCallsFromText(
  text: string
): Array<{ name: string; arguments: Record<string, unknown> }> {
  let results: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  // ── 1차: USE_TOOL/END_TOOL 포맷 ─────────────────────
  results = parseUseToolFormat(text);
  if (results.length > 0) return results;

  // ── 2차: <tool_call> JSON 포맷 ──────────────────────
  results = parseToolCallJsonFormat(text);
  if (results.length > 0) return results;

  // ── 3차: <tool_call> 느슨한 포맷 ────────────────────
  results = parseToolCallLooseFormat(text);
  if (results.length > 0) return results;

  return [];
}

/**
 * 1차: USE_TOOL/END_TOOL 포맷
 *
 * USE_TOOL: FileRead
 * path: package.json
 * startLine: 1
 * END_TOOL
 */
function parseUseToolFormat(
  text: string
): Array<{ name: string; arguments: Record<string, unknown> }> {
  const results: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const regex = /USE_TOOL:\s*(\w+)\s*\n([\s\S]*?)END_TOOL/g;

  let match;
  while ((match = regex.exec(text)) !== null) {
    const name = match[1].trim();
    const body = match[2].trim();
    const args: Record<string, unknown> = {};

    // key: value 쌍 파싱
    for (const line of body.split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;

      const key = line.substring(0, colonIdx).trim();
      const value = line.substring(colonIdx + 1).trim();
      if (!key) continue;

      // 숫자면 number로 변환
      const num = Number(value);
      if (!isNaN(num) && value !== "") {
        args[key] = num;
      } else {
        args[key] = value;
      }
    }

    if (name) {
      results.push({ name, arguments: args });
    }
  }

  return results;
}

/**
 * 2차: <tool_call> JSON 포맷
 *
 * <tool_call>
 * {"name": "FileRead", "arguments": {"path": "package.json"}}
 * </tool_call>
 */
function parseToolCallJsonFormat(
  text: string
): Array<{ name: string; arguments: Record<string, unknown> }> {
  const results: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name && typeof parsed.arguments === "object") {
        results.push({ name: parsed.name, arguments: parsed.arguments });
      }
    } catch {
      // JSON 파싱 실패 → 3차에서 시도
    }
  }

  return results;
}

/**
 * 3차: <tool_call> 느슨한 포맷 (Gemma가 뱉는 다양한 변형 처리)
 *
 * 지원하는 변형:
 * - FileRead{path:"package.json"}
 * - FileRead(path="package.json")
 * - FileRead {"path": "package.json"}
 * - FileRead path=package.json
 * - FileRead path: package.json
 */
function parseToolCallLooseFormat(
  text: string
): Array<{ name: string; arguments: Record<string, unknown> }> {
  const results: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

  let match;
  while ((match = regex.exec(text)) !== null) {
    const content = match[1].trim();
    const parsed = parseLooseToolCall(content);
    if (parsed) {
      results.push(parsed);
    }
  }

  return results;
}

function parseLooseToolCall(
  content: string
): { name: string; arguments: Record<string, unknown> } | null {
  // 도구 이름 추출: 첫 번째 단어 (알파벳으로만 구성)
  const nameMatch = content.match(/^(\w+)/);
  if (!nameMatch) return null;

  const name = nameMatch[1];
  const rest = content.substring(name.length).trim();
  const args: Record<string, unknown> = {};

  if (!rest) return { name, arguments: args };

  // 중괄호/괄호 안의 내용 추출
  const bracketMatch = rest.match(/[{(]([\s\S]*)[})]/) ;
  const body = bracketMatch ? bracketMatch[1] : rest;

  // key-value 쌍 추출 (다양한 구분자 지원)
  // key:"value"  key='value'  key=value  key: value
  const kvRegex = /(\w+)\s*[:=]\s*(?:<\|"\|>([^<]*)<\|"\|>|"([^"]*)"|'([^']*)'|(\S+))/g;

  let kvMatch;
  while ((kvMatch = kvRegex.exec(body)) !== null) {
    const key = kvMatch[1];
    // 여러 캡처 그룹 중 매칭된 것 사용
    const value = kvMatch[2] ?? kvMatch[3] ?? kvMatch[4] ?? kvMatch[5] ?? "";

    const num = Number(value);
    if (!isNaN(num) && value !== "") {
      args[key] = num;
    } else {
      args[key] = value;
    }
  }

  // key-value를 못 찾았으면 전체를 첫 번째 파라미터의 값으로 시도
  if (Object.keys(args).length === 0 && rest) {
    // "package.json" 같은 단일 값 → path로 추정
    const cleaned = rest.replace(/[{()}'"<|>]/g, "").trim();
    if (cleaned) {
      args["path"] = cleaned;
    }
  }

  return Object.keys(args).length > 0 ? { name, arguments: args } : null;
}

/**
 * 응답 텍스트에서 도구 호출 부분을 제거한다.
 * 사용자에게 보여줄 텍스트에서 도구 호출 마크업을 빼기 위해.
 */
function stripToolCallsFromText(text: string): string {
  return text
    .replace(/USE_TOOL:\s*\w+\s*\n[\s\S]*?END_TOOL/g, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .trim();
}
```

그리고 `query()` 함수에서 도구 호출 감지 부분을 수정한다:

```diff
      // 도구 호출 감지
      if (toolCalls.length === 0) {
        toolCalls = parseToolCallsFromText(fullResponse);
        if (toolCalls.length > 0) {
-         fullResponse = fullResponse.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
+         fullResponse = stripToolCallsFromText(fullResponse);
        }
      }
      const hasToolUse = toolCalls.length > 0;
```

## 수정 3: 파서 테스트

파서가 제대로 동작하는지 확인하기 위해 간단한 테스트 스크립트를 만든다. 파서가 안정되면 삭제해도 된다.

```typescript
// src/tools/__test__/parser-test.ts
// 실행: npx tsx src/tools/__test__/parser-test.ts

// parseUseToolFormat, parseToolCallJsonFormat, parseToolCallLooseFormat을
// query.ts에서 export하거나, 여기에 복사해서 테스트한다.

const testCases = [
  // 1차: USE_TOOL 포맷
  {
    name: "USE_TOOL format",
    input: `Let me read that file for you.

USE_TOOL: FileRead
path: package.json
END_TOOL`,
    expected: { name: "FileRead", path: "package.json" },
  },

  // USE_TOOL with multiple params
  {
    name: "USE_TOOL with range",
    input: `USE_TOOL: FileRead
path: src/index.ts
startLine: 1
endLine: 20
END_TOOL`,
    expected: { name: "FileRead", path: "src/index.ts", startLine: 1, endLine: 20 },
  },

  // 2차: JSON 포맷
  {
    name: "JSON format",
    input: `<tool_call>
{"name": "FileRead", "arguments": {"path": "package.json"}}
</tool_call>`,
    expected: { name: "FileRead", path: "package.json" },
  },

  // 3차: Gemma 변형 - 중괄호 + 특수 따옴표
  {
    name: "Gemma variant - curly braces with special quotes",
    input: `<tool_call>
FileRead{path:<|"|>package.json<|"|>}
</tool_call>`,
    expected: { name: "FileRead", path: "package.json" },
  },

  // 3차: Gemma 변형 - 괄호
  {
    name: "Gemma variant - parentheses",
    input: `<tool_call>
FileRead(path="package.json")
</tool_call>`,
    expected: { name: "FileRead", path: "package.json" },
  },

  // 3차: Gemma 변형 - 공백 구분
  {
    name: "Gemma variant - space separated",
    input: `<tool_call>
FileRead path=package.json
</tool_call>`,
    expected: { name: "FileRead", path: "package.json" },
  },

  // 3차: Gemma 변형 - JSON 공백
  {
    name: "Gemma variant - name then JSON",
    input: `<tool_call>
FileRead {"path": "package.json"}
</tool_call>`,
    expected: { name: "FileRead", path: "package.json" },
  },
];

console.log("Parser Test Results:");
console.log("=".repeat(50));

// 여기에 파서 함수를 import하거나 복사하여 테스트
// 각 testCase.input을 parseToolCallsFromText()에 넣고
// 결과가 expected와 일치하는지 확인

for (const tc of testCases) {
  console.log(`\n📋 ${tc.name}`);
  console.log(`   Input: ${tc.input.substring(0, 60).replace(/\n/g, "\\n")}...`);
  console.log(`   Expected: ${JSON.stringify(tc.expected)}`);
  // const result = parseToolCallsFromText(tc.input);
  // console.log(`   Got: ${JSON.stringify(result)}`);
  // console.log(`   ${result.length > 0 ? "✅ PASS" : "❌ FAIL"}`);
}
```

## 수정 4: 동작 확인 순서

```bash
# 1. 프롬프트 변경 확인
# TUI를 열고 아무 질문이나 했을 때, AI가 도구를 사용하지 않는 일반 대화가 정상인지 확인
pnpm dev
# "안녕하세요" → 도구 없이 일반 답변

# 2. 도구 호출 테스트
# "package.json 파일을 읽어줘"
# 기대 출력:
#   🔧 실행 중: FileRead
#   🔧 완료: FileRead
#   🤖 (파일 내용 기반 설명)

# 3. AI가 USE_TOOL 포맷을 따르지 않으면
# 시스템 프롬프트의 예시를 늘리거나 포맷을 더 단순화한다.
# 어떤 형태로 출력하든 파서가 잡아낸다면 OK.

# 4. 다양한 요청 테스트
# "tsconfig.json의 target 값이 뭐야?"
# "src/ollama.ts의 첫 10줄 보여줘"
# "README.md 읽어줘"
```

## 정리

변경 파일 요약:

| 파일 | 변경 내용 |
|------|----------|
| `system-prompt.ts` | 도구 사용 안내를 `USE_TOOL/END_TOOL` 포맷으로 단순화 |
| `query.ts` | `parseToolCallsFromText()`를 3단계 폴백 파서로 교체 |
| `query.ts` | `stripToolCallsFromText()` 추가 |

핵심 원칙: **모델을 바꿀 수 없으니 우리가 맞춘다.** 프롬프트는 모델이 따르기 쉽게, 파서는 모델이 뱉는 변형을 최대한 수용하게. 이 조합이 작은 on-device 모델에서 tool calling을 안정적으로 만드는 방법이다.

모델을 바꾸거나 더 큰 모델로 업그레이드하면 네이티브 tool calling이 동작할 수 있고, 그때는 이 파서가 폴백으로만 남게 된다.
