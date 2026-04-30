// src/events.ts
//
// 쿼리 루프가 방출하는 이벤트 타입
//
// Claude Code 참고:
// query.ts의 제너레이터는 다양한 이벤트를 yield한다:
// - 텍스트 조각 (스트리밍)
// - 도구 사용 요청
// - 도구 실행 결과
// - 에러
// - 턴 완료
//
// 우리도 같은 구조를 따른다.
// 지금은 텍스트와 턴 관련 이벤트만 만들고,
// Chapter 07에서 도구 이벤트를 추가한다.

/** 텍스트 조각이 도착했다 (스트리밍) */
export interface TextDeltaEvent {
  type: "text_delta";
  content: string;
}

/** 어시스턴트의 전체 응답이 완성되었다 */
export interface ResponseCompleteEvent {
  type: "response_complete";
  content: string;
}

/** 하나의 턴이 완료되었다 */
export interface TurnCompleteEvent {
  type: "turn_complete";
  tokens: number;
  elapsed: number; // 초 단위
}

/** AI가 도구 사용을 요청했다 */
export interface ToolCallEvent {
  type: "tool_call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 도구 실행 결과가 나왔다 */
export interface ToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
}

/** 권한 확인이 필요하다 (UI가 사용자에게 물어봐야 함) */
export interface PermissionRequestEvent {
  type: "permission_request";
  toolName: string;
  input: Record<string, unknown>;
  reason: string;
}

/** 권한 결과가 결정되었다 */
export interface PermissionResultEvent {
  type: "permission_result";
  toolName: string;
  allowed: boolean;
}

/** 에러가 발생했다 */
export interface ErrorEvent {
  type: "error";
  message: string;
}

/** 쿼리 루프에서 발생하는 모든 이벤트 */
export type QueryEvent =
  | TextDeltaEvent
  | ResponseCompleteEvent
  | TurnCompleteEvent
  | ToolCallEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | PermissionResultEvent
  | ErrorEvent;
