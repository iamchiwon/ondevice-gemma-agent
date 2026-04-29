// src/tools/glob.ts
//
// GlobTool — 파일 패턴 검색
//
// 프로젝트에서 특정 패턴의 파일을 찾는다.
// "모든 TypeScript 파일", "test가 포함된 파일" 등.
// Grep이 파일 내용을 검색한다면, Glob은 파일 이름을 검색한다.

import { execSync } from "node:child_process";
import { relative, resolve } from "node:path";
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
