// src/cli.ts

import { Command } from "commander";

export interface CliOptions {
  model: string;
  system?: string;
  stream: boolean;
  prompt?: string;
  bypass: boolean;
}

/**
 * CLI 인수를 파싱하여 옵션 객체를 반환한다.
 *
 * 사용 예:
 *   oda "프롬프트"              → { prompt: "프롬프트", model: "gemma3:4b", stream: true }
 *   oda -m gemma3:12b "질문"   → { prompt: "질문", model: "gemma3:12b", stream: true }
 *   oda -s "역할" "질문"       → { prompt: "질문", system: "역할", ... }
 *   oda --no-stream "질문"     → { prompt: "질문", stream: false, ... }
 *   echo "text" | oda "질문"   → stdin이 프롬프트 앞에 합쳐짐
 */
export function parseCli(): CliOptions {
  const program = new Command();

  program
    .name("oda")
    .description("On-Device AI Agent — Gemma 기반 로컬 AI 어시스턴트")
    .version("0.2.0")
    .argument("[prompt]", "실행할 프롬프트")
    .option(
      "-m, --model <model>",
      "사용할 모델",
      process.env.ODA_MODEL ?? "gemma4:e2b",
    )
    .option("-s, --system <prompt>", "시스템 프롬프트 (AI의 역할 설정)")
    .option("--no-stream", "스트리밍 비활성화 (응답을 모아서 한 번에 출력)")
    .option("--bypass", "권한 확인 없이 모든 도구 자동 실행 (주의!)", false)
    .parse();

  const options = program.opts();
  const args = program.args;

  return {
    model: options.model,
    system: options.system,
    stream: options.stream,
    prompt: args[0],
    bypass: options.bypass,
  };
}
