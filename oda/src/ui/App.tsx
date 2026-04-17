// src/ui/App.tsx

import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useState } from "react";
import { chat, type OllamaMessage } from "../ollama.js";
import type { Message, SessionStats } from "../types.js";
import { Input } from "./Input.js";
import { MessageList } from "./MessageList.js";
import { StatusBar } from "./StatusBar.js";

interface Props {
  model: string;
  system?: string;
}

export function App({ model, system }: Props) {
  const { exit } = useApp();

  // ── 상태 ──────────────────────────────────────────────
  // Claude Code는 Zustand로 글로벌 상태를 관리한다.
  // 우리는 아직 간단하므로 useState로 시작한다.
  // 상태가 복잡해지면 나중에 마이그레이션한다.

  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [stats, setStats] = useState<SessionStats>({
    totalTokens: 0,
    lastResponseTime: 0,
  });

  // Ctrl+C로 종료
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
    }
  });

  // ── 메시지 전송 ───────────────────────────────────────
  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || isLoading) return;

      // 1. 사용자 메시지 추가
      const userMessage: Message = { role: "user", content: trimmed };
      setMessages((prev) => [...prev, userMessage]);
      setInputValue("");
      setIsLoading(true);
      setStreamingText("");

      // 2. Ollama API 호출을 위한 메시지 배열 조립
      //    이전 대화 내용을 모두 포함해야 맥락을 유지한다.
      const apiMessages: OllamaMessage[] = [];

      if (system) {
        apiMessages.push({ role: "system", content: system });
      }

      // 기존 대화 + 새 메시지
      for (const msg of [...messages, userMessage]) {
        apiMessages.push({ role: msg.role, content: msg.content });
      }

      // 3. 스트리밍 호출
      let fullResponse = "";
      const startTime = Date.now();
      let tokenCount = 0;

      try {
        await chat({ model, messages: apiMessages }, (chunk) => {
          if (!chunk.done) {
            fullResponse += chunk.message.content;
            setStreamingText(fullResponse);
          } else {
            tokenCount = chunk.eval_count ?? 0;
          }
        });

        // 4. 완성된 응답을 메시지 목록에 추가
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: fullResponse },
        ]);

        // 5. 통계 갱신
        const elapsed = (Date.now() - startTime) / 1000;
        setStats((prev) => ({
          totalTokens: prev.totalTokens + tokenCount,
          lastResponseTime: elapsed,
        }));
      } catch (error) {
        // 에러를 어시스턴트 메시지로 표시
        const errorMessage =
          error instanceof Error ? error.message : "알 수 없는 에러";
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `❌ 에러: ${errorMessage}` },
        ]);
      } finally {
        setIsLoading(false);
        setStreamingText("");
      }
    },
    [messages, isLoading, model, system],
  );

  // ── 렌더링 ────────────────────────────────────────────
  return (
    <Box flexDirection="column" width="100%">
      {/* 헤더 */}
      <Box paddingX={1} marginBottom={1}>
        <Text bold>🤖 oda</Text>
        <Text dimColor> v0.3.0 | {model}</Text>
      </Box>

      {/* 구분선 */}
      <Box paddingX={1}>
        <Text dimColor>{"─".repeat(50)}</Text>
      </Box>

      {/* 메시지 목록 */}
      <MessageList
        messages={messages}
        streamingText={streamingText}
        isLoading={isLoading}
      />

      {/* 구분선 */}
      <Box paddingX={1}>
        <Text dimColor>{"─".repeat(50)}</Text>
      </Box>

      {/* 입력창 */}
      <Input
        value={inputValue}
        onChange={setInputValue}
        onSubmit={handleSubmit}
        isLoading={isLoading}
      />

      {/* 상태바 */}
      <StatusBar model={model} stats={stats} />
    </Box>
  );
}
