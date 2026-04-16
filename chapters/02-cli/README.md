# Chapter 02. CLI 만들기 — 한 줄 프롬프트 실행기

> **목표**: `oda "프롬프트"` 형태로 터미널에서 바로 실행할 수 있는 CLI 도구를 만든다.

## 이 챕터에서 만드는 것

```bash
# 기본 사용
oda "자바스크립트의 클로저를 설명해줘"

# 모델 지정
oda -m gemma3:12b "이 코드 리뷰해줘"

# 시스템 프롬프트
oda -s "너는 시니어 TypeScript 개발자야" "이 함수를 개선해줘"

# 파이프 입력
cat error.log | oda "이 로그에서 문제를 찾아줘"

# 스트리밍 끄기 (스크립트 연동용)
oda --no-stream "현재 날짜를 알려줘"
```

Chapter 01에서는 프롬프트가 코드에 박혀있었다. 이제 진짜 도구로 만든다.

## Claude Code에서 배우는 것

Claude Code는 `main.tsx`에서 CLI 인수를 가장 먼저 파싱한다. 인수에 따라 실행 모드가 결정된다:

```
claude "이 버그 고쳐줘"       → 헤드리스 모드 (--print 플래그)
claude                         → REPL 대화형 모드
claude -p "프롬프트" --json    → JSON 출력 모드 (파이프라인용)
```

우리도 같은 분기를 만든다:

```
oda "프롬프트"                 → 단발 실행 (이번 챕터)
oda                            → 대화형 TUI (Chapter 03에서)
```

이 분기가 중요한 이유는, **같은 핵심 엔진(Ollama 호출)을 서로 다른 인터페이스로 감싸는 패턴**이기 때문이다. Claude Code의 모든 모드(REPL, headless, bridge, coordinator)가 내부적으로는 동일한 `query.ts`를 사용하는 것과 같다.

## 디렉토리 구조

```
02-cli/
├── package.json          # + commander 의존성, + bin 필드
├── tsconfig.json         # Chapter 01과 동일
├── src/
│   ├── cli.ts            # ✨ 새 파일: CLI 인수 파싱
│   ├── index.ts          # 변경: CLI 진입점으로 리팩토링
│   └── ollama.ts         # Chapter 01에서 그대로 가져옴
└── docs/
    └── claude-code-ref.md
```

## Step 1: 의존성 추가

Chapter 01의 파일들을 복사해온 뒤, [commander](https://www.npmjs.com/package/commander)를 추가한다.

```bash
pnpm add commander
```

**왜 commander인가?** 가장 널리 쓰이는 Node.js CLI 프레임워크다. 인수 파싱, 도움말 자동 생성, 서브커맨드를 지원한다. Claude Code는 자체 파서를 쓰지만, 우리는 바퀴를 재발명하지 않는다.

## Step 2: `package.json` 수정

두 가지를 추가한다:

```jsonc
{
  "name": "oda",
  "version": "0.2.0",
  "description": "On-Device AI Agent — Chapter 02",
  "type": "module",
  "bin": {
    "oda": "./dist/index.js",
  },
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
  },
  "dependencies": {
    "commander": "^13.0.0",
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.7.0",
  },
}
```

핵심 변경:

- `bin` 필드: `pnpm link --global` 후 어디서든 `oda` 명령으로 실행 가능
- `commander`: CLI 인수 파싱 라이브러리

## Step 3: `src/cli.ts` — CLI 인수 파싱

새 파일을 만든다. 이 파일의 역할은 **터미널 입력을 구조화된 옵션 객체로 변환하는 것**이다.

```typescript
// src/cli.ts

import { Command } from "commander";

export interface CliOptions {
  model: string;
  system?: string;
  stream: boolean;
  prompt?: string;
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
      process.env.ODA_MODEL ?? "gemma3:4b",
    )
    .option("-s, --system <prompt>", "시스템 프롬프트 (AI의 역할 설정)")
    .option("--no-stream", "스트리밍 비활성화 (응답을 모아서 한 번에 출력)")
    .parse();

  const options = program.opts();
  const args = program.args;

  return {
    model: options.model,
    system: options.system,
    stream: options.stream,
    prompt: args[0],
  };
}
```

포인트:

- `argument("[prompt]")`: 대괄호는 선택적이라는 뜻. 프롬프트 없이 실행하면 Chapter 03의 대화형 모드로 진입할 자리를 남겨둔다.
- `process.env.ODA_MODEL`: 환경변수가 있으면 기본 모델로 사용. Chapter 01과의 호환성 유지.
- `--no-stream`: commander는 `--no-` 접두사를 자동으로 boolean false로 처리한다.

## Step 4: `src/index.ts` — 진입점 리팩토링

Chapter 01의 하드코딩된 로직을 CLI 옵션 기반으로 바꾼다.

```typescript
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
```

Chapter 01 대비 바뀐 점:

- `parseCli()`로 옵션을 받음
- `readStdin()`으로 파이프 입력 지원
- `runStreaming()` / `runBuffered()` 분리
- 프롬프트 없으면 안내 메시지 (Chapter 03 자리 확보)
- 종료 코드 분리 (1: 연결 실패, 2: 모델 없음)

## Step 5: `ollama.ts`

Chapter 01에서 그대로 복사한다. 변경 없음.

## Step 6: 빌드 및 글로벌 등록

```bash
# 빌드
pnpm build

# dist/index.js 맨 위에 shebang 추가
# (tsc가 자동으로 넣어주지 않으므로 수동으로 추가)
```

`dist/index.js`의 맨 첫 줄에 shebang을 추가해야 한다:

```javascript
#!/usr/bin/env node
```

이걸 자동화하려면 `package.json`의 build 스크립트를 수정한다:

```jsonc
{
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc && echo '#!/usr/bin/env node' | cat - dist/index.js > temp && mv temp dist/index.js",
    "start": "node dist/index.js",
  },
}
```

> **팁**: 위 build 스크립트가 번거롭다면, `tsup`을 빌드 도구로 쓰는 방법도 있다. tsup은 shebang 삽입을 옵션으로 지원한다. 관심 있으면 `tsup --format esm --banner.js '#!/usr/bin/env node'`을 시도해보자.

그 다음 글로벌 등록:

```bash
# 글로벌 링크
pnpm link --global

# 이제 어디서든 사용 가능
oda "hello"
```

## Step 7: 테스트

모든 사용 패턴을 테스트한다:

```bash
# 1. 기본 실행
oda "TypeScript의 장점을 세 가지만 말해줘"

# 2. 모델 지정
oda -m gemma3:4b "안녕"

# 3. 시스템 프롬프트
oda -s "모든 답변을 영어로 해줘" "한국의 수도는?"

# 4. 파이프 입력
echo "const x = null; console.log(x.name);" | oda "이 코드의 문제점은?"

# 5. 비스트리밍
oda --no-stream "1+1은?"

# 6. 도움말
oda --help

# 7. 에러 케이스: Ollama 꺼진 상태에서 실행
# (ollama serve를 중지한 뒤)
oda "test"  # → 종료 코드 1

# 8. 에러 케이스: 없는 모델
oda -m nonexistent "test"  # → 종료 코드 2
```

## 체크리스트

- [ ] `oda "프롬프트"`로 응답을 받을 수 있다
- [ ] `-m` 플래그로 모델을 바꿀 수 있다
- [ ] `-s` 플래그로 시스템 프롬프트를 설정할 수 있다
- [ ] 파이프 입력 (`echo "..." | oda "..."`)이 동작한다
- [ ] `--no-stream`으로 응답을 한 번에 받을 수 있다
- [ ] `--help`가 도움말을 보여준다
- [ ] Ollama 꺼진 상태에서 적절한 에러 메시지가 나온다
- [ ] 없는 모델을 지정하면 적절한 에러 메시지가 나온다
- [ ] 프롬프트 없이 `oda`만 실행하면 안내 메시지가 나온다

## 이 챕터에서 만든 것의 위치 (전체 아키텍처에서)

```
+---------------------+
| CLI (commander.js)  | ← ✨ 새로 만든 것: cli.ts
| oda "prompt" -m -s  |
+---------+-----------+
          |
          v
+---------------------+
| index.ts            | ← 리팩토링: CLI 옵션 기반으로
| stdin + 메시지 조립  |
+---------+-----------+
          |
          v
+---------------------+
| Ollama API Client   | ← Chapter 01에서 가져옴 (변경 없음)
| (chat, streaming)   |
+---------+-----------+
          |
          v
+---------------------+
| Ollama Server       |
| (Gemma 4 E2B)       |
+---------------------+
```

이 구조에서 중요한 것은 **ollama.ts가 변경 없이 재사용된다**는 점이다. CLI 레이어(cli.ts)와 실행 레이어(index.ts)가 분리되어 있기 때문에, Chapter 03에서 TUI를 추가할 때도 ollama.ts는 그대로 쓴다. Claude Code가 "입출력 레이어를 분리한 덕분에 하나의 코드베이스로 다양한 환경을 지원할 수 있다"고 한 것과 같은 원리다.

## 다음 챕터

→ [Chapter 03. TUI 셸 만들기](../03-tui/) — React + Ink로 대화형 터미널 인터페이스를 만든다. `oda`를 인수 없이 실행하면 진입하는 REPL 모드다.
