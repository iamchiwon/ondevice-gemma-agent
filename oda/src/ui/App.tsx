// src/ui/App.tsx

import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useState } from "react";
import { Conversation } from "../conversation.js";
import { query } from "../query.js";
import type { Message, SessionStats } from "../schemas.js";
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

  const [conversation] = useState(() => new Conversation(system));
  const [messages, setMessages] = useState<readonly Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [stats, setStats] = useState<SessionStats>({
    totalTokens: 0,
    lastResponseTime: 0,
    turnCount: 0,
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
      conversation.addUser(trimmed);
      setMessages(conversation.getMessages());
      setInputValue("");
      setIsLoading(true);
      setStreamingText("");

      // 2. 쿼리 루프 실행
      // 이전: chat()을 직접 호출하고 콜백으로 상태 관리
      // 이후: query() 제너레이터를 for-await-of로 소비
      try {
        for await (const event of query({ model, conversation })) {
          switch (event.type) {
            case "text_delta":
              setStreamingText((prev) => prev + event.content);
              break;

            case "response_complete":
              setMessages(conversation.getMessages());
              setStreamingText("");
              break;

            case "turn_complete":
              setStats(conversation.getStats());
              break;

            case "error":
              conversation.addAssistant(`❌ 에러: ${event.message}`);
              setMessages(conversation.getMessages());
              break;
          }
        }
      } finally {
        setIsLoading(false);
        setStreamingText("");
      }
    },
    [messages, isLoading, model],
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
