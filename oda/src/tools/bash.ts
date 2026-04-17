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

import { spawn } from "node:child_process";
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
