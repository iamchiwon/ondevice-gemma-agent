// src/tools/types.ts
//
// 도구 인터페이스 정의
//
// Claude Code 참고 (7.2절):
// 모든 도구는 동일한 인터페이스를 따른다:
// name, inputSchema, call(), description(),
// isReadOnly(), isConcurrencySafe() 등
//
// 우리도 같은 구조를 따르되, 지금 필요한 것만 정의한다.

import { z } from "zod";

/** 도구 실행 결과 */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** 모든 도구가 구현해야 하는 인터페이스 */
export interface Tool {
  /** 도구 이름 (AI가 호출할 때 사용) */
  name: string;

  /** AI에게 보여줄 설명 — 이 설명을 보고 AI가 어떤 도구를 쓸지 결정한다 */
  description: string;

  /** 입력 파라미터의 Zod 스키마 */
  inputSchema: z.ZodType;

  /** 도구를 실행한다 */
  call(input: Record<string, unknown>): Promise<ToolResult>;

  /** 읽기 전용인가? (true면 동시 실행 가능) */
  isReadOnly: boolean;
}

/**
 * Ollama API에 전달하는 도구 정의 형식
 * https://github.com/ollama/ollama/blob/main/docs/api.md#chat-request-with-tools
 */
export interface OllamaToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/**
 * Zod 스키마를 Ollama가 이해하는 JSON Schema로 변환한다.
 *
 * 왜 직접 변환하는가?
 * Ollama의 function calling은 JSON Schema 형식을 기대한다.
 * Zod의 .describe()나 zod-to-json-schema 라이브러리를 쓸 수도 있지만,
 * 우리 도구의 스키마는 단순하므로 직접 변환이 더 명확하다.
 */
export function toolToOllamaDefinition(tool: Tool): OllamaToolDefinition {
  // Zod 스키마에서 shape를 추출
  // 우리 도구들은 모두 z.object()를 쓰므로 이 방식이 동작한다
  const schema = tool.inputSchema as z.ZodObject<Record<string, z.ZodType>>;
  const shape = schema.shape;

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const zodType = value as z.ZodType;

    // 기본적인 타입 매핑
    properties[key] = zodTypeToJsonSchema(zodType);

    // optional이 아니면 required
    if (!zodType.isOptional()) {
      required.push(key);
    }
  }

  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
    },
  };
}

function zodTypeToJsonSchema(zodType: z.ZodType): Record<string, unknown> {
  // optional 래퍼를 벗긴다
  const unwrapped =
    zodType instanceof z.ZodOptional ? zodType.unwrap() : zodType;

  if (unwrapped instanceof z.ZodString) {
    return { type: "string", description: unwrapped.description ?? "" };
  }
  if (unwrapped instanceof z.ZodNumber) {
    return { type: "number", description: unwrapped.description ?? "" };
  }
  if (unwrapped instanceof z.ZodBoolean) {
    return { type: "boolean", description: unwrapped.description ?? "" };
  }

  // 기본값: string으로 처리
  return { type: "string" };
}
