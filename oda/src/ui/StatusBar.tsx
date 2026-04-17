// src/ui/StatusBar.tsx

import { Box, Text } from "ink";
import type { SessionStats } from "../schemas.js";

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
        {stats.turnCount > 0 && ` | ${stats.turnCount} turns`}
      </Text>
      <Text dimColor>Ctrl+C 종료</Text>
    </Box>
  );
}
