// src/conversation.ts
//
// 대화 기록 관리
//
// Claude Code 참고:
// - query.ts에서 mutableMessages[] 배열로 대화 기록을 관리한다
// - QueryEngine은 이 배열을 턴마다 갱신하고 디스크에 저장한다
// - 우리도 같은 패턴: 대화 기록을 하나의 객체로 캡슐화한다
// - Chapter 16에서 디스크 저장을 추가한다

import type { OllamaMessage } from "./ollama.js";
import type {
  AssistantMessage,
  Message,
  SessionStats,
  ToolCall,
  UserMessage,
} from "./schemas.js";

export class Conversation {
  private messages: Message[] = [];
  private systemPrompt: string;
  private stats: SessionStats = {
    totalTokens: 0,
    lastResponseTime: 0,
    turnCount: 0,
  };

  constructor(systemPrompt: string) {
    this.systemPrompt = systemPrompt;
  }

  /** 사용자 메시지를 추가한다 */
  addUser(content: string): UserMessage {
    const msg: UserMessage = { role: "user", content };
    this.messages.push(msg);
    return msg;
  }

  /** 어시스턴트 응답을 추가한다 */
  addAssistant(content: string): AssistantMessage {
    const msg: AssistantMessage = { role: "assistant", content };
    this.messages.push(msg);
    this.stats.turnCount++;
    return msg;
  }

  /** 통계를 갱신한다 */
  updateStats(tokens: number, responseTime: number) {
    this.stats.totalTokens += tokens;
    this.stats.lastResponseTime = responseTime;
  }

  /** 도구 호출을 포함한 어시스턴트 응답을 추가한다 */
  addAssistantWithToolCalls(content: string, toolCalls: ToolCall[]): void {
    // 텍스트 응답이 있으면 추가
    if (content) {
      this.messages.push({ role: "assistant", content });
    }
    // 도구 호출 정보는 Ollama 메시지 변환 시 처리
    this._pendingToolCalls = toolCalls;
    this.stats.turnCount++;
  }

  /** 도구 실행 결과를 추가한다 */
  addToolResult(toolCallId: string, content: string, isError = false): void {
    this._toolResults.push({ toolCallId, content, isError });
  }

  private _pendingToolCalls: ToolCall[] = [];
  private _toolResults: Array<{
    toolCallId: string;
    content: string;
    isError: boolean;
  }> = [];

  /** Ollama API에 보낼 메시지 배열을 반환한다 */
  toOllamaMessages(): OllamaMessage[] {
    const result: OllamaMessage[] = [];

    result.push({ role: "system", content: this.systemPrompt });

    for (const msg of this.messages) {
      result.push({ role: msg.role, content: msg.content });
    }

    // 펜딩 중인 도구 호출이 있으면 assistant 메시지에 tool_calls 포함
    if (this._pendingToolCalls.length > 0) {
      result.push({
        role: "assistant",
        content: "",
        tool_calls: this._pendingToolCalls.map((tc) => ({
          function: { name: tc.name, arguments: tc.arguments },
        })),
      } as OllamaMessage);

      // 도구 결과를 tool role 메시지로 추가
      for (const tr of this._toolResults) {
        result.push({ role: "tool", content: tr.content } as OllamaMessage);
      }

      // 클리어
      this._pendingToolCalls = [];
      this._toolResults = [];
    }

    return result;
  }

  /** 현재 대화 기록을 반환한다 (읽기 전용) */
  getMessages(): readonly Message[] {
    return this.messages;
  }

  /** 현재 통계를 반환한다 */
  getStats(): SessionStats {
    return { ...this.stats };
  }

  /** 대화 기록의 대략적인 토큰 수를 추정한다 */
  estimateTokenCount(): number {
    // 러프한 추정: 한국어 1글자 ≈ 2토큰, 영어 4글자 ≈ 1토큰
    // 정확한 계산은 Chapter 14(자동 압축)에서 한다
    const totalChars = this.messages.reduce(
      (sum, m) => sum + m.content.length,
      0,
    );
    return Math.ceil(totalChars * 1.5);
  }

  /** 메시지 수를 반환한다 */
  get length(): number {
    return this.messages.length;
  }
}
