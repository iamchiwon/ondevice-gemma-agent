// src/ui/MessageList.tsx

import { Box, Text } from "ink";
import type { Message } from "../types.js";

interface Props {
  messages: Message[];
  streamingText: string; // AI가 현재 생성 중인 텍스트
  isLoading: boolean;
}

export function MessageList({ messages, streamingText, isLoading }: Props) {
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
