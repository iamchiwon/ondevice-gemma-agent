// src/tools/registry.ts
//
// 도구 레지스트리
//
// Claude Code 참고 (7.3절):
// 모든 도구는 tools.ts에 특정 순서로 등록된다.
// "순서가 중요한 이유는 API의 프롬프트 캐싱 안정성 때문이다."
// 우리는 Ollama라서 캐싱 걱정은 없지만, 이름순 정렬은 유지한다.

import type { OllamaToolDefinition, Tool } from "./types.js";
import { toolToOllamaDefinition } from "./types.js";

class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  /** 도구를 등록한다 */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  /** 이름으로 도구를 찾는다 */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 등록된 모든 도구를 이름순으로 반환한다 */
  getAll(): Tool[] {
    return Array.from(this.tools.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /** Ollama API에 전달할 도구 정의 배열을 반환한다 */
  toOllamaTools(): OllamaToolDefinition[] {
    return this.getAll().map(toolToOllamaDefinition);
  }

  /** 등록된 도구 수 */
  get size(): number {
    return this.tools.size;
  }
}

// 싱글턴 레지스트리
export const toolRegistry = new ToolRegistry();
