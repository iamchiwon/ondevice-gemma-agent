// src/tools/file-read.ts
//
// FileRead 도구 — 파일 내용을 읽어서 반환한다
//
// Claude Code 참고:
// FileRead는 가장 기본적인 읽기 전용 도구다.
// 경로를 받아 파일 내용을 반환한다.
// isConcurrencySafe = true라서 다른 도구와 병렬 실행 가능.

import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
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
