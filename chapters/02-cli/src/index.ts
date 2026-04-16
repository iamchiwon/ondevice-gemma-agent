// src/index.ts

import { parseCli } from "./cli.js";
import {
  chat,
  checkConnection,
  listModels,
  type OllamaMessage,
} from "./ollama.js";

async function main() {
  const options = parseCli();

  // 프롬프트가 없으면 → 나중에 대화형 모드로 (Chapter 03)
  // 지금은 도움말을 보여주고 종료
  if (!options.prompt) {
    console.log('프롬프트를 입력해주세요. 예: oda "안녕하세요"');
    console.log("도움말: oda --help");
    process.exit(0);
  }

  // ── stdin 파이프 처리 ──────────────────────────────────
  // cat file.txt | oda "이거 분석해줘" 형태를 지원한다.
  // stdin에 데이터가 있으면 프롬프트 앞에 붙인다.
  let prompt = options.prompt;
  const stdinData = await readStdin();
  if (stdinData) {
    prompt = `${stdinData}\n\n---\n\n${prompt}`;
  }

  // ── Ollama 연결 확인 ──────────────────────────────────
  const connected = await checkConnection();
  if (!connected) {
    console.error(
      "❌ Ollama 서버에 연결할 수 없습니다. `ollama serve`를 먼저 실행해주세요.",
    );
    process.exit(1);
  }

  // ── 모델 확인 ─────────────────────────────────────────
  const models = await listModels();
  if (!models.some((m) => m.startsWith(options.model))) {
    console.error(`❌ 모델 '${options.model}'을 찾을 수 없습니다.`);
    console.error(`   설치된 모델: ${models.join(", ") || "(없음)"}`);
    process.exit(2);
  }

  // ── 메시지 조립 ───────────────────────────────────────
  const messages: OllamaMessage[] = [];

  if (options.system) {
    messages.push({ role: "system", content: options.system });
  }

  messages.push({ role: "user", content: prompt });

  // ── 실행 ──────────────────────────────────────────────
  if (options.stream) {
    await runStreaming(options.model, messages);
  } else {
    await runBuffered(options.model, messages);
  }
}

/**
 * 스트리밍 모드: 토큰이 도착할 때마다 즉시 출력
 */
async function runStreaming(model: string, messages: OllamaMessage[]) {
  await chat({ model, messages }, (chunk) => {
    if (!chunk.done) {
      process.stdout.write(chunk.message.content);
    }
  });
  // 마지막에 줄바꿈 하나 추가 (프롬프트 깨짐 방지)
  process.stdout.write("\n");
}

/**
 * 비스트리밍 모드: 응답을 모아서 한 번에 출력
 * 다른 스크립트에서 oda의 출력을 파싱할 때 유용하다.
 */
async function runBuffered(model: string, messages: OllamaMessage[]) {
  let result = "";
  await chat({ model, messages }, (chunk) => {
    if (!chunk.done) {
      result += chunk.message.content;
    }
  });
  console.log(result);
}

/**
 * stdin에서 파이프된 데이터를 읽는다.
 * 터미널 직접 입력(TTY)이면 빈 문자열을 반환한다.
 */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    // TTY면 파이프가 아님 → 빈 문자열
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

main().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});
