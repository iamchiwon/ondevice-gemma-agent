# Chapter 11. 도구 확장 — FileEdit, Grep, Glob

> **목표**: 파일 수정, 텍스트 검색, 파일 패턴 검색 도구를 추가한다. 이 챕터가 끝나면 AI가 "코드를 찾고, 읽고, 수정하고, 테스트하는" 완전한 개발 워크플로우를 수행할 수 있다.

## 왜 이 세 개를 함께 만드는가

이 세 도구가 합쳐지면 코딩 에이전트의 핵심 루프가 완성된다:

```
"auth.ts에서 null 체크 빠진 곳 찾아서 고쳐줘"

Turn 1: AI → Grep(pattern: "user.name", path: "src/")
         → 3개 파일에서 발견
Turn 2: AI → FileRead(path: "src/auth.ts")
         → 코드 확인
Turn 3: AI → FileEdit(path: "src/auth.ts", old: "user.name", new: "user?.name")
         → 수정 완료
Turn 4: AI → Bash(command: "npm test")
         → 테스트 통과 확인
Turn 5: AI → "수정 완료했습니다. line 42에서..."
```

이전까지: 파일을 읽고(FileRead) 명령을 실행(Bash)할 수 있었다.
이번에 추가: 코드를 **검색**(Grep, Glob)하고 **수정**(FileEdit)할 수 있게 된다.

## Claude Code에서 배우는 것

**FileEditTool** — 파일 전체를 덮어쓰는 대신 **문자열 치환 방식**을 사용한다. `old_str`을 `new_str`로 교체. 이 방식이 안전한 이유는, AI가 파일 전체를 정확히 재생성할 필요 없이 수정할 부분만 정확히 지정하면 되기 때문이다. 퍼지 매칭으로 의도한 위치를 찾고, 인코딩과 줄바꿈을 보존한다.

**GrepTool** — ripgrep 기반. 세 가지 출력 모드(content, files_with_matches, count)와 기본 250개 결과 제한.

동시성 모델에서 중요한 점:

```
FileRead, Grep, Glob → isReadOnly: true  → 병렬 실행 가능
FileEdit             → isReadOnly: false → 순차 실행
```

## 변경 요약

```
새 파일:
  oda/src/tools/file-edit.ts   → FileEdit 도구
  oda/src/tools/grep.ts        → Grep 도구
  oda/src/tools/glob.ts        → Glob 도구

수정 파일:
  oda/src/tools/setup.ts       → 3개 도구 등록 추가
```

## Step 1: `oda/src/tools/file-edit.ts` — 새 파일

```typescript
// src/tools/file-edit.ts
//
// FileEditTool — 문자열 치환 방식으로 파일을 수정한다
//
// Claude Code 참고 (7.4절):
// "파일의 특정 문자열을 교체한다. 퍼지 매칭으로 의도한 위치를 찾고,
//  인코딩과 줄바꿈을 보존하며, Git diff를 생성한다."
//
// 왜 전체 덮어쓰기가 아니라 문자열 치환인가?
// - AI가 파일 전체를 정확히 기억하고 재생성하는 것은 어렵다 (특히 작은 모델)
// - 수정할 부분만 명시하면 실수가 줄어든다
// - diff가 명확해서 무엇이 바뀌었는지 알기 쉽다

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "./types.js";

const inputSchema = z.object({
  path: z.string().describe("수정할 파일 경로"),
  oldStr: z.string().describe("교체할 기존 문자열 (정확히 일치해야 함)"),
  newStr: z.string().describe("새 문자열"),
});

export const fileEditTool: Tool = {
  name: "FileEdit",
  description: [
    "Edit a file by replacing a specific string with a new string.",
    "The oldStr must match exactly (including whitespace and indentation).",
    "Use FileRead first to see the exact content before editing.",
    "To delete text, set newStr to an empty string.",
    "To create a new file, set oldStr to empty and newStr to the full content.",
  ].join(" "),

  inputSchema,
  isReadOnly: false, // ← 변경 도구: 순차 실행

  async call(input: Record<string, unknown>): Promise<ToolResult> {
    const parsed = inputSchema.parse(input);
    const filePath = resolve(parsed.path);
    const relativePath = relative(process.cwd(), filePath);

    // ── 새 파일 생성 모드 ─────────────────────────────
    if (parsed.oldStr === "") {
      if (existsSync(filePath)) {
        return {
          content: `File already exists: ${relativePath}. To edit, provide the exact oldStr to replace.`,
          isError: true,
        };
      }

      try {
        writeFileSync(filePath, parsed.newStr, "utf-8");
        const lineCount = parsed.newStr.split("\n").length;
        return {
          content: `Created new file: ${relativePath} (${lineCount} lines)`,
        };
      } catch (error) {
        return {
          content: `Failed to create file: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    }

    // ── 기존 파일 수정 모드 ───────────────────────────
    if (!existsSync(filePath)) {
      return {
        content: `File not found: ${relativePath}`,
        isError: true,
      };
    }

    try {
      const original = readFileSync(filePath, "utf-8");

      // 정확한 매칭 확인
      const matchCount = countOccurrences(original, parsed.oldStr);

      if (matchCount === 0) {
        // 퍼지 매칭 시도: 공백 차이를 무시
        const fuzzyResult = fuzzyMatch(original, parsed.oldStr);
        if (fuzzyResult) {
          return {
            content: [
              `Exact match not found in ${relativePath}.`,
              `Did you mean this? (whitespace differs):`,
              ``,
              `--- found in file ---`,
              fuzzyResult.found,
              `--- your oldStr ---`,
              parsed.oldStr,
              ``,
              `Use the exact text from the file (use FileRead to check).`,
            ].join("\n"),
            isError: true,
          };
        }

        return {
          content: `oldStr not found in ${relativePath}. Use FileRead to check the exact content.`,
          isError: true,
        };
      }

      if (matchCount > 1) {
        return {
          content: `oldStr found ${matchCount} times in ${relativePath}. Please provide a more specific (longer) oldStr to match exactly once.`,
          isError: true,
        };
      }

      // 치환 실행
      const modified = original.replace(parsed.oldStr, parsed.newStr);
      writeFileSync(filePath, modified, "utf-8");

      // diff 생성
      const diff = generateSimpleDiff(parsed.oldStr, parsed.newStr);

      return {
        content: [`Edited ${relativePath}:`, ``, diff].join("\n"),
      };
    } catch (error) {
      return {
        content: `Edit failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};

// ── 유틸 함수 ───────────────────────────────────────────

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(search, pos)) !== -1) {
    count++;
    pos += search.length;
  }
  return count;
}

/**
 * 공백 차이를 무시하고 매칭을 시도한다.
 * 탭 vs 스페이스, trailing whitespace 등의 차이를 잡아낸다.
 */
function fuzzyMatch(content: string, search: string): { found: string } | null {
  // 검색 문자열의 각 줄에서 공백을 정규화
  const searchLines = search.split("\n").map((l) => l.trim());
  const contentLines = content.split("\n");

  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    let match = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (contentLines[i + j].trim() !== searchLines[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      const found = contentLines.slice(i, i + searchLines.length).join("\n");
      return { found };
    }
  }

  return null;
}

/**
 * 간단한 diff를 생성한다.
 */
function generateSimpleDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  const parts: string[] = [];

  for (const line of oldLines) {
    parts.push(`- ${line}`);
  }
  for (const line of newLines) {
    parts.push(`+ ${line}`);
  }

  return parts.join("\n");
}
```

핵심 설계:

**단일 매칭 강제** — `oldStr`이 파일에 정확히 1번만 나타나야 한다. 2번 이상이면 거부하고 더 구체적인 문자열을 요구한다. 잘못된 곳을 수정하는 사고를 방지.

**퍼지 매칭 힌트** — 정확한 매칭이 실패하면 공백 차이를 무시하고 유사한 곳을 찾아서 알려준다. AI가 들여쓰기를 잘못 기억하는 경우가 많기 때문.

**새 파일 생성** — `oldStr`이 빈 문자열이면 새 파일 생성 모드. AI가 "이 내용으로 새 파일을 만들어줘"라고 할 때 사용.

## Step 2: `oda/src/tools/grep.ts` — 새 파일

```typescript
// src/tools/grep.ts
//
// GrepTool — 텍스트 패턴 검색
//
// Claude Code 참고 (7.4절):
// "ripgrep 기반 텍스트 검색. 세 가지 출력 모드
//  (content, files_with_matches, count)와 기본 250개 결과 제한."
//
// 우리는 Node.js 내장으로 구현한다.
// ripgrep이 설치되어 있으면 그걸 쓰고, 없으면 기본 구현.

import { execSync } from "node:child_process";
import { resolve, relative } from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "./types.js";

const MAX_RESULTS = 250;

const inputSchema = z.object({
  pattern: z.string().describe("검색할 텍스트 또는 정규표현식 패턴"),
  path: z
    .string()
    .optional()
    .describe("검색할 디렉토리 또는 파일 (기본: 현재 디렉토리)"),
  include: z.string().optional().describe("포함할 파일 패턴 (예: '*.ts')"),
  ignoreCase: z.boolean().optional().describe("대소문자 무시 (기본: false)"),
});

export const grepTool: Tool = {
  name: "Grep",
  description: [
    "Search for a text pattern in files using regex.",
    "Returns matching lines with file paths and line numbers.",
    "Searches recursively from the given path (default: current directory).",
    "Respects .gitignore by default.",
    "Use 'include' to filter by file type, e.g. include: '*.ts'.",
  ].join(" "),

  inputSchema,
  isReadOnly: true, // ← 읽기 전용: 병렬 실행 가능

  async call(input: Record<string, unknown>): Promise<ToolResult> {
    const parsed = inputSchema.parse(input);
    const searchPath = resolve(parsed.path ?? ".");

    // ripgrep이 있으면 사용 (빠르고 .gitignore 자동 존중)
    if (hasRipgrep()) {
      return runRipgrep(
        parsed.pattern,
        searchPath,
        parsed.include,
        parsed.ignoreCase,
      );
    }

    // 없으면 기본 grep
    return runBasicGrep(
      parsed.pattern,
      searchPath,
      parsed.include,
      parsed.ignoreCase,
    );
  },
};

// ── ripgrep ─────────────────────────────────────────────

let _hasRipgrep: boolean | null = null;

function hasRipgrep(): boolean {
  if (_hasRipgrep === null) {
    try {
      execSync("rg --version", { stdio: "pipe" });
      _hasRipgrep = true;
    } catch {
      _hasRipgrep = false;
    }
  }
  return _hasRipgrep;
}

function runRipgrep(
  pattern: string,
  searchPath: string,
  include?: string,
  ignoreCase?: boolean,
): ToolResult {
  const args = ["rg", "--line-number", "--no-heading", "--color=never"];

  if (ignoreCase) args.push("--ignore-case");
  if (include) args.push("--glob", include);

  args.push(`--max-count=${MAX_RESULTS}`);
  args.push("--", pattern, searchPath);

  try {
    const output = execSync(args.join(" "), {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });

    const lines = output.trim().split("\n").filter(Boolean);
    return formatGrepResult(lines, pattern, searchPath);
  } catch (error: unknown) {
    // ripgrep은 매칭이 없으면 exit code 1을 반환
    const execError = error as { status?: number; stdout?: string };
    if (execError.status === 1) {
      return { content: `No matches found for pattern: ${pattern}` };
    }
    return {
      content: `Grep error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

// ── 기본 grep (ripgrep 없을 때) ────────────────────────

function runBasicGrep(
  pattern: string,
  searchPath: string,
  include?: string,
  ignoreCase?: boolean,
): ToolResult {
  // grep -rn 사용 (재귀 + 줄번호)
  const args = ["grep", "-rn", "--color=never"];

  if (ignoreCase) args.push("-i");
  if (include) args.push("--include", include);

  args.push("--", pattern, searchPath);

  try {
    const output = execSync(args.join(" "), {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });

    const lines = output.trim().split("\n").filter(Boolean);
    return formatGrepResult(lines.slice(0, MAX_RESULTS), pattern, searchPath);
  } catch (error: unknown) {
    const execError = error as { status?: number };
    if (execError.status === 1) {
      return { content: `No matches found for pattern: ${pattern}` };
    }
    return {
      content: `Grep error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

// ── 결과 포맷팅 ─────────────────────────────────────────

function formatGrepResult(
  lines: string[],
  pattern: string,
  searchPath: string,
): ToolResult {
  if (lines.length === 0) {
    return { content: `No matches found for pattern: ${pattern}` };
  }

  // 경로를 상대 경로로 변환
  const cwd = process.cwd();
  const relativized = lines.map((line) => {
    if (line.startsWith(searchPath)) {
      return (
        relative(cwd, line.substring(0, line.indexOf(":"))) +
        line.substring(line.indexOf(":"))
      );
    }
    return line;
  });

  const truncated =
    lines.length >= MAX_RESULTS
      ? `\n\n(showing first ${MAX_RESULTS} results)`
      : "";

  return {
    content: `Found ${lines.length} matches for "${pattern}":

${relativized.join("\n")}${truncated}`,
  };
}
```

## Step 3: `oda/src/tools/glob.ts` — 새 파일

```typescript
// src/tools/glob.ts
//
// GlobTool — 파일 패턴 검색
//
// 프로젝트에서 특정 패턴의 파일을 찾는다.
// "모든 TypeScript 파일", "test가 포함된 파일" 등.
// Grep이 파일 내용을 검색한다면, Glob은 파일 이름을 검색한다.

import { execSync } from "node:child_process";
import { resolve, relative } from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "./types.js";

const MAX_RESULTS = 500;

const inputSchema = z.object({
  pattern: z
    .string()
    .describe("파일 패턴 (예: '**/*.ts', 'src/**/*.test.*', '*.json')"),
  path: z
    .string()
    .optional()
    .describe("검색 시작 디렉토리 (기본: 현재 디렉토리)"),
});

export const globTool: Tool = {
  name: "Glob",
  description: [
    "Find files matching a glob pattern.",
    "Use this to discover project structure or find specific file types.",
    "Examples: '**/*.ts' for all TypeScript files,",
    "'src/**/*.test.*' for test files, '*.json' for JSON files in root.",
    "Respects .gitignore by default.",
  ].join(" "),

  inputSchema,
  isReadOnly: true, // ← 읽기 전용: 병렬 실행 가능

  async call(input: Record<string, unknown>): Promise<ToolResult> {
    const parsed = inputSchema.parse(input);
    const searchPath = resolve(parsed.path ?? ".");

    try {
      // git ls-files는 .gitignore를 자동으로 존중한다
      // git 레포가 아니면 find로 폴백
      const files = isGitRepo(searchPath)
        ? gitGlob(parsed.pattern, searchPath)
        : findGlob(parsed.pattern, searchPath);

      if (files.length === 0) {
        return { content: `No files found matching: ${parsed.pattern}` };
      }

      // 상대 경로로 변환
      const cwd = process.cwd();
      const relativePaths = files
        .slice(0, MAX_RESULTS)
        .map((f) => relative(cwd, f))
        .sort();

      const truncated =
        files.length > MAX_RESULTS
          ? `\n\n(showing first ${MAX_RESULTS} of ${files.length} files)`
          : "";

      return {
        content: `Found ${Math.min(files.length, MAX_RESULTS)} files matching "${parsed.pattern}":

${relativePaths.join("\n")}${truncated}`,
      };
    } catch (error) {
      return {
        content: `Glob error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};

function isGitRepo(path: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd: path,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function gitGlob(pattern: string, searchPath: string): string[] {
  try {
    const output = execSync(
      `git ls-files --cached --others --exclude-standard "${pattern}"`,
      {
        cwd: searchPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((f) => resolve(searchPath, f));
  } catch {
    return [];
  }
}

function findGlob(pattern: string, searchPath: string): string[] {
  try {
    // find + -name으로 단순 패턴만 지원
    // **/ 패턴은 find가 처리 못하므로 제거
    const namePattern = pattern.replace(/\*\*\//g, "");

    const output = execSync(
      `find "${searchPath}" -name "${namePattern}" -not -path "*/node_modules/*" -not -path "*/.git/*"`,
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
```

## Step 4: `oda/src/tools/setup.ts` — 수정

세 줄 추가:

```diff
  import { toolRegistry } from "./registry.js";
  import { fileReadTool } from "./file-read.js";
  import { bashTool } from "./bash.js";
+ import { fileEditTool } from "./file-edit.js";
+ import { grepTool } from "./grep.js";
+ import { globTool } from "./glob.js";

  export function registerTools(): void {
    toolRegistry.register(fileReadTool);
    toolRegistry.register(bashTool);
+   toolRegistry.register(fileEditTool);
+   toolRegistry.register(grepTool);
+   toolRegistry.register(globTool);
  }
```

## 도구 전체 현황

```
도구 이름     | isReadOnly | 용도
─────────────┼───────────┼──────────────────────
FileRead     | true       | 파일 내용 읽기
Grep         | true       | 텍스트 패턴 검색
Glob         | true       | 파일 이름 패턴 검색
FileEdit     | false      | 문자열 치환으로 파일 수정
Bash         | false      | 셸 명령 실행
```

파이프라인의 배치 파티셔닝이 의미를 가지는 시점이다:

```
AI가 요청: [Grep, Glob, FileRead, FileEdit, Bash]

배치 실행:
  Batch 1: [Grep, Glob, FileRead]  → Promise.all (병렬)
  Batch 2: [FileEdit]              → 단독 실행
  Batch 3: [Bash]                  → 단독 실행
```

## 테스트

```bash
# 1. Grep 테스트
pnpm dev
# "이 프로젝트에서 'import'를 사용하는 파일을 찾아줘"
# 기대: Grep(pattern: "import", path: "src/") → 매칭 결과

# "query.ts에서 'yield'가 몇 번 나오는지 찾아줘"
# 기대: Grep(pattern: "yield", path: "src/query.ts") → 매칭 줄

# 2. Glob 테스트
# "이 프로젝트의 TypeScript 파일 목록을 보여줘"
# 기대: Glob(pattern: "**/*.ts") → 파일 목록

# "테스트 파일이 있어?"
# 기대: Glob(pattern: "**/*.test.*") → 있으면 목록, 없으면 없다고

# 3. FileEdit 테스트
# 먼저 임시 파일 생성
echo 'const greeting = "hello";' > /tmp/test-edit.txt

# "greeting 변수의 값을 world로 바꿔줘" (파일 경로 지정)
# 기대: FileEdit(path: "/tmp/test-edit.txt", oldStr: '"hello"', newStr: '"world"')
# → diff 표시: - "hello" / + "world"

# 4. FileEdit 에러 케이스
# "존재하지않는텍스트를 바꿔줘"
# 기대: "oldStr not found" 에러 + FileRead 사용 안내

# 5. 복합 워크플로우 (핵심 테스트)
# "src/ollama.ts에서 OLLAMA_BASE_URL 상수 값을 찾아서 알려줘"
# 기대: Grep 또는 FileRead → 값 설명

# 6. 전체 파이프라인 테스트
# "이 프로젝트의 구조를 파악하고, package.json의 name을 'my-agent'로 바꿔줘"
# 기대: Glob → FileRead → FileEdit 순서로 실행
# ⚠️ 실제 파일이 수정되므로 git으로 되돌릴 수 있는 상태에서 테스트

# 7. 타입 체크
pnpm typecheck
```

## 체크리스트

- [ ] `tools/file-edit.ts` — FileEdit 도구 (문자열 치환 + 퍼지 매칭 + 새 파일 생성)
- [ ] `tools/grep.ts` — Grep 도구 (ripgrep 우선, 기본 grep 폴백)
- [ ] `tools/glob.ts` — Glob 도구 (git ls-files 우선, find 폴백)
- [ ] `tools/setup.ts` — 3개 도구 등록
- [ ] Grep: 패턴 검색 결과가 줄번호와 함께 나온다
- [ ] Glob: 파일 목록이 나온다
- [ ] FileEdit: 문자열 치환이 동작하고 diff가 표시된다
- [ ] FileEdit: 매칭이 0개이면 에러, 2개 이상이면 에러
- [ ] FileEdit: 퍼지 매칭 힌트가 동작한다
- [ ] 병렬 실행: Grep + Glob + FileRead가 같은 배치에서 실행
- [ ] `pnpm typecheck` 통과

## 이 챕터의 위치

```
+────────────────────────────────────────────+
| Tool Registry — 5개 도구 완성              |
| ┌─ 읽기 전용 (병렬 가능) ─────────────┐    |
| │ FileRead  — 파일 내용 읽기           │    |
| │ Grep      — 텍스트 검색     ← ✨     │    |
| │ Glob      — 파일 검색       ← ✨     │    |
| └──────────────────────────────────────┘    |
| ┌─ 변경 도구 (순차 실행) ─────────────┐    |
| │ FileEdit  — 문자열 치환     ← ✨     │    |
| │ Bash      — 셸 명령 실행            │    |
| └──────────────────────────────────────┘    |
+────────────────────────────────────────────+
```

이 5개 도구가 코딩 에이전트의 기본 도구 세트다. Claude Code는 45개 이상의 도구를 가지고 있지만, 핵심 동작의 대부분은 이 5개로 커버된다.

다음은 안전장치다. FileEdit와 Bash는 시스템을 변경할 수 있는 위험한 도구다. 지금은 AI가 요청하면 무조건 실행하지만, Chapter 12에서 **실행 전에 사용자에게 확인을 요청**하는 권한 시스템을 만든다.

## 다음 챕터

→ [Chapter 12. 권한 시스템](../12-permissions/) — 변경 도구 실행 전 "이 명령을 실행할까요?" 확인을 추가한다. default/auto/bypass 세 가지 모드를 구현한다.
