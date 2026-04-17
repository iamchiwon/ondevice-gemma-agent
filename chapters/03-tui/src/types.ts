// src/types.ts

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface SessionStats {
  totalTokens: number;
  lastResponseTime: number; // 초 단위
}
