// src/query.ts
//
// 쿼리 루프 — 에이전트의 핵심 엔진
//
// Claude Code 참고:
// query.ts(약 68KB)는 비동기 제너레이터로 구현되어 있다.
// 매 턴마다: API 호출 → 응답 파싱 → 도구 실행 → 다음 턴 결정
// 을 반복한다. 도구 사용이 없으면 루프를 종료한다.
//
// 우리도 같은 구조를 따르되, 지금은 도구 실행 없이
// "API 호출 → 스트리밍 응답 → 완료" 만 구현한다.
// Chapter 07에서 도구 실행을 끼워넣는다.

import type { Conversation } from "./conversation.js";
import type { QueryEvent } from "./events.js";
import { chat } from "./ollama.js";
import {
  addSessionRule,
  DEFAULT_PERMISSION_CONFIG,
  type PermissionConfig,
} from "./permissions.js";
import { ToolCall } from "./schemas.js";
import {
  executeToolBatch,
  PipelineOptions,
  Tool,
  toolRegistry,
} from "./tools/index.js";

/** query() 함수의 옵션 */
export interface QueryOptions {
  model: string;
  conversation: Conversation;
  maxTurns?: number; // 무한 루프 방지 (기본: 10)
  tools?: Tool[];
  permissionConfig?: PermissionConfig;
  onPermissionRequest?: (
    toolName: string,
    input: Record<string, unknown>,
    reason: string,
  ) => Promise<"allow" | "deny" | "always_allow">;
}

/**
 * AI 응답 텍스트에서 도구 호출을 추출한다.
 *
 * 여러 포맷을 시도한다 (우선순위 순):
 * 1. USE_TOOL/END_TOOL 포맷 (우리가 지정한 메인 포맷)
 * 2. <tool_call> JSON 포맷
 * 3. <tool_call> 느슨한 포맷 (Gemma 변형들)
 */
function parseToolCallsFromText(
  text: string,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  let results: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  // ── 1차: USE_TOOL/END_TOOL 포맷 ─────────────────────
  results = parseUseToolFormat(text);
  if (results.length > 0) return results;

  // ── 2차: <tool_call> JSON 포맷 ──────────────────────
  results = parseToolCallJsonFormat(text);
  if (results.length > 0) return results;

  // ── 3차: <tool_call> 느슨한 포맷 ────────────────────
  results = parseToolCallLooseFormat(text);
  if (results.length > 0) return results;

  return [];
}

/**
 * 1차: USE_TOOL/END_TOOL 포맷
 *
 * USE_TOOL: FileRead
 * path: package.json
 * startLine: 1
 * END_TOOL
 */
function parseUseToolFormat(
  text: string,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  const results: Array<{ name: string; arguments: Record<string, unknown> }> =
    [];

  // 1차: END_TOOL이 있는 정상 케이스
  const strictRegex = /USE_TOOL:\s*(\w+)\s*\n([\s\S]*?)END_TOOL/g;
  let match;
  while ((match = strictRegex.exec(text)) !== null) {
    results.push({
      name: match[1].trim(),
      arguments: parseKeyValueBody(match[2]),
    });
  }
  if (results.length > 0) return results;

  // 2차: END_TOOL이 없는 경우 (Gemma가 빼먹을 때)
  // USE_TOOL: 이후 key: value 줄이 연속되다가
  // 빈 줄이나 일반 텍스트가 나오면 거기서 끊는다
  const looseRegex = /USE_TOOL:\s*(\w+)\s*\n((?:\s*\w+:\s*.+\n?)+)/g;
  while ((match = looseRegex.exec(text)) !== null) {
    results.push({
      name: match[1].trim(),
      arguments: parseKeyValueBody(match[2]),
    });
  }

  return results;
}

/**
 * key: value 줄들을 파싱한다.
 * 값에서 따옴표를 벗기고, 숫자는 number로 변환한다.
 */
function parseKeyValueBody(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  for (const line of body.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.substring(0, colonIdx).trim();
    let value = line.substring(colonIdx + 1).trim();
    if (!key) continue;

    // 따옴표 벗기기: 'value' → value, "value" → value
    value = value.replace(/^['"](.*)['"]$/, "$1");

    // 숫자면 number로 변환
    const num = Number(value);
    if (!isNaN(num) && value !== "") {
      args[key] = num;
    } else {
      args[key] = value;
    }
  }

  return args;
}

/**
 * 2차: <tool_call> JSON 포맷
 *
 * <tool_call>
 * {"name": "FileRead", "arguments": {"path": "package.json"}}
 * </tool_call>
 */
function parseToolCallJsonFormat(
  text: string,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  const results: Array<{ name: string; arguments: Record<string, unknown> }> =
    [];
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name && typeof parsed.arguments === "object") {
        results.push({ name: parsed.name, arguments: parsed.arguments });
      }
    } catch {
      // JSON 파싱 실패 → 3차에서 시도
    }
  }

  return results;
}

/**
 * 3차: <tool_call> 느슨한 포맷 (Gemma가 뱉는 다양한 변형 처리)
 *
 * 지원하는 변형:
 * - FileRead{path:"package.json"}
 * - FileRead(path="package.json")
 * - FileRead {"path": "package.json"}
 * - FileRead path=package.json
 * - FileRead path: package.json
 */
function parseToolCallLooseFormat(
  text: string,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  const results: Array<{ name: string; arguments: Record<string, unknown> }> =
    [];
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

  let match;
  while ((match = regex.exec(text)) !== null) {
    const content = match[1].trim();
    const parsed = parseLooseToolCall(content);
    if (parsed) {
      results.push(parsed);
    }
  }

  return results;
}

function parseLooseToolCall(
  content: string,
): { name: string; arguments: Record<string, unknown> } | null {
  // 도구 이름 추출: 첫 번째 단어 (알파벳으로만 구성)
  const nameMatch = content.match(/^(\w+)/);
  if (!nameMatch) return null;

  const name = nameMatch[1];
  const rest = content.substring(name.length).trim();
  const args: Record<string, unknown> = {};

  if (!rest) return { name, arguments: args };

  // 중괄호/괄호 안의 내용 추출
  const bracketMatch = rest.match(/[{(]([\s\S]*)[})]/);
  const body = bracketMatch ? bracketMatch[1] : rest;

  // key-value 쌍 추출 (다양한 구분자 지원)
  // key:"value"  key='value'  key=value  key: value
  const kvRegex =
    /(\w+)\s*[:=]\s*(?:<\|"\|>([^<]*)<\|"\|>|"([^"]*)"|'([^']*)'|(\S+))/g;

  let kvMatch;
  while ((kvMatch = kvRegex.exec(body)) !== null) {
    const key = kvMatch[1];
    // 여러 캡처 그룹 중 매칭된 것 사용
    const value = kvMatch[2] ?? kvMatch[3] ?? kvMatch[4] ?? kvMatch[5] ?? "";

    const num = Number(value);
    if (!isNaN(num) && value !== "") {
      args[key] = num;
    } else {
      args[key] = value;
    }
  }

  // key-value를 못 찾았으면 전체를 첫 번째 파라미터의 값으로 시도
  if (Object.keys(args).length === 0 && rest) {
    // "package.json" 같은 단일 값 → path로 추정
    const cleaned = rest.replace(/[{()}'"<|>]/g, "").trim();
    if (cleaned) {
      args["path"] = cleaned;
    }
  }

  return Object.keys(args).length > 0 ? { name, arguments: args } : null;
}

/**
 * 응답 텍스트에서 도구 호출 부분을 제거한다.
 * 사용자에게 보여줄 텍스트에서 도구 호출 마크업을 빼기 위해.
 */
function stripToolCallsFromText(text: string): string {
  return text
    .replace(/USE_TOOL:\s*\w+\s*\n[\s\S]*?END_TOOL/g, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .trim();
}

/**
 * 쿼리 루프 — 비동기 제너레이터
 *
 * 사용법:
 * ```
 * for await (const event of query(options)) {
 *   switch (event.type) {
 *     case "text_delta":    // 스트리밍 텍스트 표시
 *     case "turn_complete": // 통계 갱신
 *     case "error":         // 에러 표시
 *   }
 * }
 * ```
 *
 * 왜 제너레이터인가?
 * - 이벤트가 발생할 때마다 yield로 즉시 내보낸다
 * - UI는 for-await-of로 소비하면서 실시간 렌더링
 * - 콜백 지옥 없이 순차적 코드로 복잡한 흐름을 표현
 * - Claude Code가 동일한 패턴을 사용하는 이유이기도 하다
 */
export async function* query(
  options: QueryOptions,
): AsyncGenerator<QueryEvent> {
  const { model, conversation, maxTurns = 10 } = options;
  const tools = options.tools ?? toolRegistry.getAll();

  // Ollama에 전달할 도구 정의
  const ollamaTools =
    tools.length > 0 ? toolRegistry.toOllamaTools() : undefined;

  for (let turn = 0; turn < maxTurns; turn++) {
    // ── API 호출 ────────────────────────────────────────
    const messages = conversation.toOllamaMessages();
    let fullResponse = "";
    let tokenCount = 0;
    let toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> =
      [];
    const startTime = Date.now();

    // 이벤트 큐와 대기 메커니즘을 턴 레벨에서 정의
    const events: QueryEvent[] = [];
    let resolveWait: (() => void) | null = null;

    try {
      const chatPromise = chat(
        { model, messages, tools: ollamaTools },
        (chunk) => {
          if (!chunk.done) {
            // 텍스트 응답
            if (chunk.message.content) {
              fullResponse += chunk.message.content;
              events.push({
                type: "text_delta",
                content: chunk.message.content,
              });
            }
            // 도구 호출 감지
            if (chunk.message.tool_calls) {
              toolCalls = chunk.message.tool_calls.map((tc) => ({
                name: tc.function.name,
                arguments: tc.function.arguments,
              }));
            }
          } else {
            tokenCount = chunk.eval_count ?? 0;
          }
          resolveWait?.();
        },
      );

      // 이벤트 소비 루프 (Chapter 05와 동일)
      let chatDone = false;
      chatPromise
        .then(() => {
          chatDone = true;
          resolveWait?.();
        })
        .catch((error) => {
          events.push({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          chatDone = true;
          resolveWait?.();
        });

      while (!chatDone || events.length > 0) {
        if (events.length > 0) {
          const event = events.shift()!;
          yield event;
          if (event.type === "error") return;
        } else {
          await new Promise<void>((resolve) => {
            resolveWait = resolve;
          });
        }
      }
    } catch (error) {
      yield {
        type: "error" as const,
        message: error instanceof Error ? error.message : String(error),
      };
      return;
    }

    const elapsed = (Date.now() - startTime) / 1000;

    // ── 도구 실행 판단 ──────────────────────────────────

    // 1차: Ollama 네이티브 tool_calls 확인
    // 2차: 응답 텍스트에서 <tool_call> 태그 파싱 (폴백)
    if (toolCalls.length === 0) {
      toolCalls = parseToolCallsFromText(fullResponse);
      // 텍스트에서 tool_call 부분을 제거 (사용자에게 보여줄 필요 없음)
      if (toolCalls.length > 0) {
        fullResponse = stripToolCallsFromText(fullResponse);
      }
    }
    const hasToolUse = toolCalls.length > 0;

    if (!hasToolUse) {
      // 도구 사용 없음 → 최종 응답
      conversation.addAssistant(fullResponse);
      conversation.updateStats(tokenCount, elapsed);
      yield { type: "response_complete", content: fullResponse };
      yield { type: "turn_complete", tokens: tokenCount, elapsed };
      break;
    }

    // ── 도구 실행 ───────────────────────────────────────
    // Claude Code 참고 (8.1절):
    // 10단계 파이프라인: lookup → validate → hooks → permissions → execute → ...
    // 우리는 단순화: lookup → validate → execute

    const toolCallSchemas: ToolCall[] = toolCalls.map((tc, i) => ({
      id: `call_${turn}_${i}`,
      name: tc.name,
      arguments: tc.arguments,
    }));

    conversation.addAssistantWithToolCalls(
      fullResponse,
      toolCallSchemas.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      })),
    );

    // 도구 호출 이벤트 방출
    for (const tc of toolCallSchemas) {
      yield {
        type: "tool_call" as const,
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      };
    }

    // 배치 실행
    const permissionConfig =
      options.permissionConfig ?? DEFAULT_PERMISSION_CONFIG;

    const pipelineOptions: PipelineOptions = {
      tools,
      permissionConfig,
      onPermissionRequest: options.onPermissionRequest
        ? async (tool, input, reason) => {
            // 이벤트로 UI에 알린다
            events.push({
              type: "permission_request" as const,
              toolName: tool.name,
              input,
              reason,
            });
            resolveWait?.();

            // UI에서 응답을 받을 때까지 대기
            const decision = await options.onPermissionRequest!(
              tool.name,
              input,
              reason,
            );

            events.push({
              type: "permission_result" as const,
              toolName: tool.name,
              allowed: decision !== "deny",
            });
            resolveWait?.();

            // "항상 허용"이면 세션 규칙에 추가
            if (decision === "always_allow") {
              addSessionRule(permissionConfig, tool.name, "allow");
            }

            return decision;
          }
        : undefined,
    };
    const results: Array<{
      id: string;
      name: string;
      content: string;
      isError: boolean;
    }> = [];

    await executeToolBatch(
      toolCallSchemas,
      pipelineOptions,
      (id, name, result) => {
        conversation.addToolResult(id, result.content, result.isError);
        results.push({
          id,
          name,
          content: result.content,
          isError: result.isError,
        });
      },
    );

    // 도구 실행 중 생성된 권한 요청 이벤트 처리
    while (events.length > 0) {
      const event = events.shift()!;
      yield event;
    }

    // 도구 결과 이벤트 방출
    for (const r of results) {
      yield {
        type: "tool_result" as const,
        toolCallId: r.id,
        name: r.name,
        content: r.content,
        isError: r.isError,
      };
    }

    yield { type: "turn_complete" as const, tokens: tokenCount, elapsed };

    // 다음 턴으로 (for 루프 계속)
  }
}
