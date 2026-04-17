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

  // ── 모드 분기 ─────────────────────────────────────────
  // Claude Code 참고:
  // main.tsx에서 --print 플래그가 있으면 헤드리스, 없으면 REPL로 분기한다.
  // 우리도 같은 패턴: 프롬프트가 있으면 CLI, 없으면 TUI.

  if (options.prompt) {
    // CLI 모드 (Chapter 02)
    await runCli(options);
  } else {
    // TUI 모드 (이번 챕터)
    await runTui(options.model, options.system);
  }
}

// ── CLI 모드 ──────────────────────────────────────────────
// Chapter 02에서 만든 로직을 그대로 가져온다.

async function runCli(options: {
  model: string;
  system?: string;
  stream: boolean;
  prompt: string;
}) {
  let prompt = options.prompt;
  const stdinData = await readStdin();
  if (stdinData) {
    prompt = `${stdinData}\n\n---\n\n${prompt}`;
  }

  const messages: OllamaMessage[] = [];
  if (options.system) {
    messages.push({ role: "system", content: options.system });
  }
  messages.push({ role: "user", content: prompt });

  if (options.stream) {
    await chat({ model: options.model, messages }, (chunk) => {
      if (!chunk.done) process.stdout.write(chunk.message.content);
    });
    process.stdout.write("\n");
  } else {
    let result = "";
    await chat({ model: options.model, messages }, (chunk) => {
      if (!chunk.done) result += chunk.message.content;
    });
    console.log(result);
  }
}

// ── TUI 모드 ──────────────────────────────────────────────

async function runTui(model: string, system?: string) {
  // ink와 App을 동적 import한다.
  // 이유: CLI 모드에서는 React/Ink가 필요 없다.
  // 불필요한 모듈 로딩을 피하는 것은 Claude Code의 "조건부 모듈 로딩" 패턴과 같다.
  const { render } = await import("ink");
  const { createElement } = await import("react");
  const { App } = await import("./ui/App.js");

  render(createElement(App, { model, system }));
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
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
