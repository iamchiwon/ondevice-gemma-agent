// src/system-prompt.ts
//
// 시스템 프롬프트 조립
//
// Claude Code 참고:
// 시스템 프롬프트에 Git 컨텍스트와 사용자 컨텍스트를 주입하여
// AI가 현재 프로젝트 상황을 파악할 수 있게 한다.

import z from "zod";
import type { Context } from "./context.js";
import { toolRegistry } from "./tools/index.js";

/**
 * 시스템 프롬프트를 조립한다.
 *
 * 구조:
 * 1. 에이전트 기본 역할
 * 2. 오늘 날짜
 * 3. Git 상태 (있으면)
 * 4. AGENT.md (있으면)
 * 5. 사용자 지정 시스템 프롬프트 (있으면)
 */
export function buildSystemPrompt(
  context: Context,
  userSystem?: string,
): string {
  const sections: string[] = [];

  // ── 기본 역할 ─────────────────────────────────────────
  sections.push(
    "You are an AI coding assistant running locally on the user's machine.",
    "You help with reading, writing, and understanding code.",
    "Be concise and direct. When you're not sure, say so.",
  );

  // ── 도구 목록 ─────────────────────────────────────
  const tools = toolRegistry.getAll();
  if (tools.length > 0) {
    sections.push("\n## Tools");
    sections.push(
      "You have access to tools. To use a tool, write EXACTLY this format:\n",
    );
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
    sections.push(
      "- After you receive the tool result, continue your response\n",
    );
    sections.push(
      "- For Bash commands, prefer safe read-only commands (ls, cat, grep, git status)",
    );
    sections.push("- Avoid destructive commands (rm -rf, chmod 777, etc.)");
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
          sections.push(
            `- ${key}${isOptional ? " (optional)" : " (required)"}: ${desc}`,
          );
        }
      }
    }
  }

  // ── 날짜 ──────────────────────────────────────────────
  sections.push(`\nToday: ${context.project.today}`);
  sections.push(`Working directory: ${context.project.cwd}`);

  // ── Git 상태 ──────────────────────────────────────────
  if (context.git) {
    const g = context.git;
    const gitLines = [
      "\n## Git Context",
      `Branch: ${g.branch}`,
      `Default branch: ${g.defaultBranch}`,
    ];

    if (g.userName) {
      gitLines.push(`User: ${g.userName}`);
    }

    if (g.status) {
      gitLines.push(`\nChanged files:\n${g.status}`);
    }

    if (g.recentCommits) {
      gitLines.push(`\nRecent commits:\n${g.recentCommits}`);
    }

    sections.push(gitLines.join("\n"));
  }

  // ── AGENT.md ──────────────────────────────────────────
  if (context.project.agentMd) {
    sections.push(
      "\n## Project Instructions (from AGENT.md)",
      context.project.agentMd,
    );
  }

  // ── 사용자 지정 시스템 프롬프트 ────────────────────────
  if (userSystem) {
    sections.push("\n## Additional Instructions", userSystem);
  }

  return sections.join("\n");
}
