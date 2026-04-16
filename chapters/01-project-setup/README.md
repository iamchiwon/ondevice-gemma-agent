# Chapter 01. 프로젝트 셋업

> **목표**: TypeScript 프로젝트를 초기화하고, Ollama를 통해 Gemma 4 E2B 모델에 첫 번째 API 호출을 보낸다.

## 이 챕터에서 만드는 것

```
"Hello, Gemma!" → Ollama API → 스트리밍 응답 → 터미널 출력
```

아직 CLI도, TUI도, 도구 시스템도 없다. 순수하게 "TypeScript에서 Ollama로 메시지를 보내고 응답을 받는 것"만 확인한다. 이것이 앞으로 만들 모든 것의 기초가 된다.

## Claude Code에서 배우는 것

Claude Code의 `main.tsx`는 약 800KB짜리 거대한 단일 파일이지만, 가장 먼저 하는 일은 단순하다 — **AI 모델과 통신할 수 있는 상태를 만드는 것**이다. 인증, 모델 해석, 설정 로딩이 끝나면 비로소 첫 번째 API 호출이 가능해진다.

우리도 같은 순서를 따른다. 다만 Claude Code는 Anthropic API + OAuth 인증이 필요하지만, 우리는 Ollama가 로컬에서 돌고 있으므로 인증이 필요 없다. 이것이 on-device의 첫 번째 장점이다.

## 사전 준비

### 1. Node.js 확인

```bash
node --version  # v20 이상
```

### 2. pnpm 설치

```bash
npm install -g pnpm
```

### 3. Ollama 설치 및 모델 다운로드

```bash
# macOS
brew install ollama

# 또는 https://ollama.com/ 에서 직접 다운로드

# Ollama 서버 실행 (별도 터미널에서)
ollama serve

# Gemma 4 E2B 모델 다운로드
ollama pull gemma4:e2b
```

### 4. Ollama 동작 확인

```bash
# 서버가 돌고 있는지 확인
curl http://localhost:11434/api/tags
```

응답에 설치한 모델 이름이 보이면 준비 완료.

## 프로젝트 생성

### 디렉토리 구조

```
01-project-setup/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts        # 진입점 — 첫 번째 API 호출
    └── ollama.ts       # Ollama API 클라이언트
```

### 초기화

```bash
pnpm init
pnpm add -D typescript @types/node tsx
```

- **typescript**: 타입 체크와 컴파일
- **@types/node**: Node.js 내장 API 타입 (fetch, process 등)
- **tsx**: TypeScript를 빌드 없이 바로 실행 (개발 중 사용)

## 코드 작성

### `tsconfig.json`

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
  },
  "include": ["src/**/*"],
}
```

왜 ES2022인가? `top-level await`, `structuredClone` 같은 최신 기능을 쓸 수 있고, Node.js 20+에서 네이티브로 지원한다.

### `src/ollama.ts` — Ollama API 클라이언트

이 파일이 Ollama와 통신하는 모든 로직을 담는다. Claude Code에서 API 클라이언트(`약 3,000줄`)가 Anthropic API와의 모든 통신을 담당하는 것과 같은 역할이다. 물론 우리 것은 훨씬 단순하다.

```typescript
// src/ollama.ts

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
```

핵심은 `chat()` 함수의 NDJSON 스트리밍 파싱이다. Ollama는 응답을 한 번에 보내지 않고, 토큰이 생성될 때마다 JSON 한 줄씩 보낸다. 우리는 이것을 읽어서 실시간으로 처리한다. 이것이 Claude Code에서 "비동기 제너레이터"로 구현한 스트리밍 패턴의 가장 기본적인 형태다.

### `src/index.ts` — 진입점

```typescript
// src/index.ts

import { chat, checkConnection, listModels } from "./ollama.js";

const MODEL = process.env.ODA_MODEL ?? "gemma4:e2b";

async function main() {
  // 1. Ollama 연결 확인
  console.log("🔌 Ollama 서버 연결 확인 중...");
  const connected = await checkConnection();
  if (!connected) {
    console.error("❌ Ollama 서버에 연결할 수 없습니다.");
    console.error("   `ollama serve` 를 먼저 실행해주세요.");
    process.exit(1);
  }
  console.log("✅ Ollama 서버 연결 성공\n");

  // 2. 모델 확인
  const models = await listModels();
  if (!models.some((m) => m.startsWith(MODEL))) {
    console.error(`❌ 모델 '${MODEL}'을 찾을 수 없습니다.`);
    console.error(`   설치된 모델: ${models.join(", ") || "(없음)"}`);
    console.error(`   \`ollama pull ${MODEL}\` 로 설치해주세요.`);
    process.exit(1);
  }
  console.log(`🤖 모델: ${MODEL}\n`);

  // 3. 첫 번째 메시지 전송
  const userMessage = "안녕! 너는 누구야? 한 문장으로 답해줘.";
  console.log(`👤 User: ${userMessage}`);
  process.stdout.write("🤖 Assistant: ");

  // 4. 스트리밍 응답 수신
  let totalTokens = 0;
  const startTime = Date.now();

  await chat(
    {
      model: MODEL,
      messages: [{ role: "user", content: userMessage }],
    },
    (chunk) => {
      // 토큰이 도착할 때마다 즉시 출력 (스트리밍)
      if (!chunk.done) {
        process.stdout.write(chunk.message.content);
      } else {
        // 완료 — 통계 출력
        totalTokens = chunk.eval_count ?? 0;
      }
    },
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n📊 ${totalTokens} tokens | ${elapsed}s`);
}

main().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});
```

### `package.json`

```json
{
  "name": "oda",
  "version": "0.1.0",
  "description": "On-Device AI Agent — Chapter 01",
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.7.0"
  }
}
```

## 실행

```bash
# 의존성 설치
pnpm install

# 실행
pnpm dev
```

예상 출력:

```
🔌 Ollama 서버 연결 확인 중...
✅ Ollama 서버 연결 성공

🤖 모델: gemma4:e2b

👤 User: 안녕! 너는 누구야? 한 문장으로 답해줘.
🤖 Assistant: 저는 Google DeepMind에서 개발한 대규모 언어 모델인 Gemma 4입니다.

📊 223 tokens | 8.0s
```

응답이 글자 단위로 하나씩 나타나는 것을 확인하자. 이것이 스트리밍이다.

## 다른 모델로 실행하기

환경변수로 모델을 바꿀 수 있다:

```bash
ODA_MODEL=gemma4:e4b pnpm dev
```

## 체크리스트

이 챕터를 완료했으면 다음을 확인하자:

- [ ] `pnpm dev`로 실행하면 Ollama에서 응답이 온다
- [ ] 응답이 스트리밍으로 한 글자씩 나타난다
- [ ] Ollama가 꺼져있으면 에러 메시지가 나온다
- [ ] 모델이 없으면 에러 메시지가 나온다

## 이 챕터에서 만든 것의 위치 (전체 아키텍처에서)

```
+---------------------+
| User runs program | ← 우리가 만든 것: index.ts
+---------+-----------+
          |
          v
+---------------------+
| Ollama API Client | ← 우리가 만든 것: ollama.ts
| (chat, streaming) |
+---------+-----------+
          |
          v
+---------------------+
| Ollama Server       | ← 로컬에서 실행 중
| (Gemma 4 E2B)       |
+---------------------+
```

전체 아키텍처에서 보면, 지금은 맨 아래 통신 계층만 만든 것이다. 다음 챕터에서 여기에 CLI 인터페이스를 얹는다.

## 다음 챕터

→ [Chapter 02. CLI 만들기](../02-cli/) — `oda "프롬프트"` 형태로 터미널에서 바로 실행하는 CLI를 만든다.
