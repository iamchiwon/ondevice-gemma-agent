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
