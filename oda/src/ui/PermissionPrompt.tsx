// src/ui/PermissionPrompt.tsx
//
// 도구 실행 권한 확인 UI

import { Box, Text, useInput } from "ink";

interface Props {
  toolName: string;
  input: Record<string, unknown>;
  reason: string;
  onDecision: (decision: "allow" | "deny" | "always_allow") => void;
}

export function PermissionPrompt({
  toolName,
  input,
  reason,
  onDecision,
}: Props) {
  useInput((char, key) => {
    if (char === "y" || key.return) {
      onDecision("allow");
    } else if (char === "n" || key.escape) {
      onDecision("deny");
    } else if (char === "a") {
      onDecision("always_allow");
    }
  });

  // 입력 파라미터를 보기 좋게 표시
  const inputLines = Object.entries(input).map(
    ([k, v]) => `  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginY={1}
    >
      <Text bold color="yellow">
        🔒 {toolName}을 실행할까요?
      </Text>
      <Text dimColor>{reason}</Text>
      <Box marginY={1} flexDirection="column">
        {inputLines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
      <Box gap={2}>
        <Text>[y] 허용</Text>
        <Text>[n] 거부</Text>
        <Text>[a] 항상 허용</Text>
      </Box>
    </Box>
  );
}
