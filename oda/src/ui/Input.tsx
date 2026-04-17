// src/ui/Input.tsx

import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  isLoading: boolean;
}

export function Input({ value, onChange, onSubmit, isLoading }: Props) {
  if (isLoading) {
    return (
      <Box paddingX={1}>
        <Text dimColor> 응답 대기 중...</Text>
      </Box>
    );
  }

  return (
    <Box paddingX={1}>
      <Text bold color="green">
        {"> "}
      </Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder="메시지를 입력하세요..."
      />
    </Box>
  );
}
