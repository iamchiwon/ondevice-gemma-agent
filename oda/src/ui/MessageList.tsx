// src/ui/MessageList.tsx

import { Box, Text } from "ink";
import type { Message } from "../schemas.js";

interface Props {
  messages: readonly Message[];
  streamingText: string; // AI가 현재 생성 중인 텍스트
  isLoading: boolean;
  toolStatus?: { name: string; status: "running" | "done" | "error" } | null;
}

export function MessageList({
  messages,
  streamingText,
  isLoading,
  toolStatus,
}: Props) {
  return (
    <Box flexDirection="column" paddingX={1}>
      {messages.map((msg, i) => (
        <Box key={i} marginBottom={1}>
          <Text>
            {msg.role === "user" ? "👤 " : "🤖 "}
            {msg.content}
          </Text>
        </Box>
      ))}

      {/* 도구 실행 상태 */}
      {toolStatus && (
        <Box marginBottom={1}>
          <Text color={toolStatus.status === "error" ? "red" : "yellow"}>
            {"🔧 "}
            {toolStatus.status === "running"
              ? "실행 중"
              : toolStatus.status === "error"
                ? "에러"
                : "완료"}
            {`: ${toolStatus.name}`}
          </Text>
        </Box>
      )}

      {/* 스트리밍 중인 응답 */}
      {isLoading && (
        <Box marginBottom={1}>
          <Text>
            {"🤖 "}
            {streamingText || "생각 중..."}
          </Text>
        </Box>
      )}
    </Box>
  );
}
