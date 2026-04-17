// src/schemas.ts
//
// 메시지 타입 시스템
//
// Claude Code 참고:
// - types/ 디렉토리에 메시지 타입이 중앙 집중 정의
// - 메시지는 user/assistant/system/tool_result 등으로 구분
// - 우리도 같은 구분을 따르되, 지금 필요한 것만 정의한다
// - Chapter 07에서 도구 시스템을 만들 때 tool_use/tool_result를 활성화한다

import { z } from "zod";

// ── 메시지 스키마 ───────────────────────────────────────

export const SystemMessageSchema = z.object({
  role: z.literal("system"),
  content: z.string(),
});

export const UserMessageSchema = z.object({
  role: z.literal("user"),
  content: z.string(),
});

export const AssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.string(),
  // Chapter 07에서 추가될 필드:
  // toolCalls?: ToolCall[]
});

// 도구 관련 메시지는 Chapter 07에서 활성화한다.
// 지금은 스키마만 정의해두고 union에는 포함하지 않는다.

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});

export const ToolResultMessageSchema = z.object({
  role: z.literal("tool"),
  toolCallId: z.string(),
  content: z.string(),
  isError: z.boolean().optional(),
});

// ── 현재 사용하는 메시지 유니언 ──────────────────────────
// Chapter 07 이후: ToolResultMessageSchema도 추가

export const MessageSchema = z.discriminatedUnion("role", [
  SystemMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
]);

// ── 타입 추론 ───────────────────────────────────────────
// Zod 스키마에서 TypeScript 타입을 추론한다.
// 스키마를 수정하면 타입이 자동으로 바뀐다.

export type SystemMessage = z.infer<typeof SystemMessageSchema>;
export type UserMessage = z.infer<typeof UserMessageSchema>;
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ToolResultMessage = z.infer<typeof ToolResultMessageSchema>;
export type Message = z.infer<typeof MessageSchema>;

// ── 세션 통계 ───────────────────────────────────────────

export const SessionStatsSchema = z.object({
  totalTokens: z.number(),
  lastResponseTime: z.number(),
  turnCount: z.number(),
});

export type SessionStats = z.infer<typeof SessionStatsSchema>;

// ── 유틸리티 ────────────────────────────────────────────

/** 안전하게 메시지를 파싱한다. 실패하면 null을 반환한다. */
export function parseMessage(data: unknown): Message | null {
  const result = MessageSchema.safeParse(data);
  return result.success ? result.data : null;
}
