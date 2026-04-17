// src/ui/StatusBar.tsx

import { Box, Text } from "ink";
import type { SessionStats } from "../types.js";

interface Props {
  model: string;
  stats: SessionStats;
}

export function StatusBar({ model, stats }: Props) {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text dimColor>
        {model}
        {stats.totalTokens > 0 && ` | ${stats.totalTokens} tokens`}
        {stats.lastResponseTime > 0 &&
          ` | ${stats.lastResponseTime.toFixed(1)}s`}
      </Text>
      <Text dimColor>Ctrl+C 종료</Text>
    </Box>
  );
}
