# Patch: USE_TOOL 파서 보강 — END_TOOL 누락 + 따옴표 처리

> Chapter 08 보충 패치 #2. Gemma가 `END_TOOL`을 빼먹거나 파라미터 값에 따옴표를 붙이는 문제를 해결한다.

## 문제 상황

Gemma의 실제 출력:

```
USE_TOOL: Grep
pattern: import
include: '*.ts'
path: .
```

기대한 형식:

```
USE_TOOL: Grep
pattern: import
include: *.ts
path: .
END_TOOL
```

두 가지 문제:

1. **`END_TOOL`이 없다** — 파서의 정규식 `USE_TOOL:...([\s\S]*?)END_TOOL`이 매칭 실패
2. **값에 따옴표** — `'*.ts'`를 그대로 넘기면 `glob`이나 `grep`에서 패턴이 안 맞음

## 수정 파일

```
oda/src/system-prompt.ts  → END_TOOL 사용을 더 강하게 안내
oda/src/query.ts          → parseUseToolFormat() 보강 + parseKeyValueBody() 분리
```

## 수정 1: `oda/src/system-prompt.ts`

도구 사용 규칙에 END_TOOL 강조를 추가한다.

```diff
      sections.push("Rules:");
      sections.push("- Write USE_TOOL and END_TOOL on their own lines");
+     sections.push("- You MUST always write END_TOOL after the parameters");
+     sections.push("- Every USE_TOOL block must be closed with END_TOOL");
      sections.push("- One parameter per line in key: value format");
-     sections.push("- Do NOT wrap in code blocks or quotes");
+     sections.push("- Do NOT wrap values in quotes or code blocks");
      sections.push("- After you receive the tool result, continue your response");
```

## 수정 2: `oda/src/query.ts`

### 2-1. `parseKeyValueBody()` 함수 추가

기존에 `parseUseToolFormat()` 안에 인라인으로 있던 key-value 파싱 로직을 별도 함수로 분리하고, 따옴표 처리를 추가한다.

이 함수를 `parseUseToolFormat()` **앞에** 추가한다:

```typescript
/**
 * key: value 줄들을 파싱한다.
 * - 값의 따옴표를 벗긴다: '*.ts' → *.ts, "value" → value
 * - 숫자는 number로 변환한다
 * - 빈 줄, key가 없는 줄은 무시한다
 */
function parseKeyValueBody(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  for (const line of body.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.substring(0, colonIdx).trim();
    let value = line.substring(colonIdx + 1).trim();
    if (!key) continue;

    // 따옴표 벗기기: 'value' → value, "value" → value
    value = value.replace(/^['"](.*)['"]$/, "$1");

    // 숫자면 number로 변환
    const num = Number(value);
    if (!isNaN(num) && value !== "") {
      args[key] = num;
    } else {
      args[key] = value;
    }
  }

  return args;
}
```

### 2-2. `parseUseToolFormat()` 교체

기존 함수 전체를 아래로 교체한다:

```typescript
/**
 * 1차: USE_TOOL/END_TOOL 포맷
 *
 * 정상 케이스:
 *   USE_TOOL: FileRead
 *   path: package.json
 *   END_TOOL
 *
 * Gemma 변형 (END_TOOL 누락):
 *   USE_TOOL: Grep
 *   pattern: import
 *   include: '*.ts'
 *   path: .
 *   (빈 줄 또는 일반 텍스트로 끝남)
 */
function parseUseToolFormat(
  text: string,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  const results: Array<{ name: string; arguments: Record<string, unknown> }> =
    [];

  // 1차: END_TOOL이 있는 정상 케이스
  const strictRegex = /USE_TOOL:\s*(\w+)\s*\n([\s\S]*?)END_TOOL/g;
  let match;
  while ((match = strictRegex.exec(text)) !== null) {
    results.push({
      name: match[1].trim(),
      arguments: parseKeyValueBody(match[2]),
    });
  }
  if (results.length > 0) return results;

  // 2차: END_TOOL이 없는 경우 (Gemma가 빼먹을 때)
  // USE_TOOL: 이후 key: value 줄이 연속되다가
  // 빈 줄이나 일반 텍스트(콜론 없는 줄)가 나오면 거기서 끊는다
  const looseRegex = /USE_TOOL:\s*(\w+)\s*\n((?:\s*\w+:\s*.+\n?)+)/g;
  while ((match = looseRegex.exec(text)) !== null) {
    results.push({
      name: match[1].trim(),
      arguments: parseKeyValueBody(match[2]),
    });
  }

  return results;
}
```

### 2-3. `stripToolCallsFromText()` 교체

도구 호출 부분을 응답 텍스트에서 제거하는 함수도 END_TOOL 누락을 처리해야 한다:

```typescript
/**
 * 응답 텍스트에서 도구 호출 부분을 제거한다.
 */
function stripToolCallsFromText(text: string): string {
  return (
    text
      // END_TOOL이 있는 정상 케이스
      .replace(/USE_TOOL:\s*\w+\s*\n[\s\S]*?END_TOOL/g, "")
      // END_TOOL이 없는 케이스 (key: value 줄이 연속된 블록)
      .replace(/USE_TOOL:\s*\w+\s*\n(?:\s*\w+:\s*.+\n?)+/g, "")
      // <tool_call> 포맷
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
      .trim()
  );
}
```

## 확인 방법

패치 적용 후 다음을 테스트한다:

```bash
pnpm dev

# 테스트 1: END_TOOL 없는 Grep
👤 "이 프로젝트에서 'import'를 사용하는 파일을 찾아줘"
# 기대: 🔧 실행 중: Grep → 검색 결과 표시

# 테스트 2: 따옴표가 붙은 파라미터
👤 "모든 TypeScript 파일을 찾아줘"
# 기대: Glob(pattern: **/*.ts) → 따옴표 없이 전달됨

# 테스트 3: END_TOOL이 있는 정상 케이스도 여전히 동작
# (정상 케이스가 깨지지 않았는지 확인)

# 테스트 4: 복합 시나리오
👤 "query.ts에서 'yield'가 몇 번 나오는지 찾아줘"
# 기대: Grep 실행 → 결과 기반으로 답변
```

## 패턴 정리

Gemma E2B에서 확인된 도구 호출 변형과 대응 현황:

```
변형                                 | 파서          | 상태
────────────────────────────────────┼──────────────┼──────
USE_TOOL + END_TOOL (정상)           | strict regex | ✅
USE_TOOL + END_TOOL 누락             | loose regex  | ✅ (이 패치)
값에 따옴표: '*.ts'                  | strip quotes | ✅ (이 패치)
<tool_call> + JSON                  | json parser  | ✅ (Ch.08 보충)
<tool_call> + 느슨한 포맷            | loose parser | ✅ (Ch.08 보충)
FileRead{path:<|"|>...}             | kv regex     | ✅ (Ch.08 보충)
```

앞으로 새로운 변형이 발견되면 이 표에 추가하고 파서를 보강한다.
