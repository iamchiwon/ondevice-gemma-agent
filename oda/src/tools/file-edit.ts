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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
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
