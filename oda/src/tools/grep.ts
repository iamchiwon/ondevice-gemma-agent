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
  path: z.string().optional().describe("검색할 디렉토리 또는 파일 (기본: 현재 디렉토리)"),
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
      return runRipgrep(parsed.pattern, searchPath, parsed.include, parsed.ignoreCase);
    }

    // 없으면 기본 grep
    return runBasicGrep(parsed.pattern, searchPath, parsed.include, parsed.ignoreCase);
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
      return relative(cwd, line.substring(0, line.indexOf(":"))) +
        line.substring(line.indexOf(":"));
    }
    return line;
  });

  const truncated = lines.length >= MAX_RESULTS
    ? `\n\n(showing first ${MAX_RESULTS} results)`
    : "";

  return {
    content: `Found ${lines.length} matches for "${pattern}":

${relativized.join("\n")}${truncated}`,
  };
}