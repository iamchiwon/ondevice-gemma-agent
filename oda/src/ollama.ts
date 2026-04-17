const OLLAMA_BASE_URL = "http://localhost:11434";

// Ollama /api/chat 의 메시지 형식
export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// Ollama /api/chat 스트리밍 응답의 각 청크
export interface OllamaChatChunk {
  model: string;
  message: OllamaMessage;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
}

// chat 함수의 옵션
export interface ChatOptions {
  model: string;
  messages: OllamaMessage[];
  stream?: boolean;
}

/**
 * Ollama /api/chat 엔드포인트를 호출한다.
 * 스트리밍 모드로 동작하며, 응답이 도착하는 대로 콜백을 호출한다.
 *
 * Claude Code 참고:
 * - query.ts의 API 호출도 스트리밍으로 동작한다.
 * - 토큰이 도착할 때마다 즉시 화면에 표시하여 사용자가 "AI가 타이핑하는 것"을 볼 수 있다.
 */
export async function chat(
  options: ChatOptions,
  onChunk: (chunk: OllamaChatChunk) => void,
): Promise<void> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      stream: options.stream ?? true,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama API error (${response.status}): ${errorText}`);
  }

  if (!response.body) {
    throw new Error("No response body");
  }

  // NDJSON 스트리밍 파싱
  // Ollama는 각 줄에 하나의 JSON 객체를 보낸다 (newline-delimited JSON)
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // 버퍼에서 완성된 줄을 하나씩 꺼내서 파싱
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // 마지막 미완성 줄은 버퍼에 남김

    for (const line of lines) {
      if (line.trim() === "") continue;
      const chunk: OllamaChatChunk = JSON.parse(line);
      onChunk(chunk);
    }
  }

  // 버퍼에 남은 마지막 줄 처리
  if (buffer.trim() !== "") {
    const chunk: OllamaChatChunk = JSON.parse(buffer);
    onChunk(chunk);
  }
}

/**
 * Ollama 서버가 실행 중인지 확인한다.
 */
export async function checkConnection(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 설치된 모델 목록을 가져온다.
 */
export async function listModels(): Promise<string[]> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
  if (!response.ok) return [];
  const data = await response.json();
  return data.models?.map((m: { name: string }) => m.name) ?? [];
}
