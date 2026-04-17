// src/tools/setup.ts
//
// 도구 초기 등록
//
// Claude Code 참고 (7.3절):
// 모든 도구는 tools.ts에 등록된다.
// 이후 피처 게이트, 거부 규칙, 모드 필터를 거친다.
// 우리는 단순히 등록만 한다.

import { bashTool } from "./bash.js";
import { fileReadTool } from "./file-read.js";
import { toolRegistry } from "./registry.js";

export function registerTools(): void {
  toolRegistry.register(fileReadTool);
  toolRegistry.register(bashTool);

  // 다음 챕터에서 추가:
  // toolRegistry.register(fileEditTool);   // Chapter 11
  // toolRegistry.register(grepTool);       // Chapter 11
  // toolRegistry.register(globTool);       // Chapter 11
}
