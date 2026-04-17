# Chapter 06. 컨텍스트 수집 — AI에게 현재 상황을 알려주기

> **목표**: Git 상태, 프로젝트 설정(AGENT.md), 날짜 등을 자동 수집하여 시스템 프롬프트로 주입한다. AI가 "지금 어떤 프로젝트에서 작업 중인지"를 아는 상태로 만든다.

## 왜 지금 이걸 하는가

Chapter 05까지의 AI는 "기억상실 상태"다. 매번 새로운 대화가 시작되는 것처럼 동작한다. 어떤 프로젝트에서 작업 중인지, Git 브랜치가 뭔지, 이 프로젝트의 규칙이 뭔지 전혀 모른다.

```bash
# Chapter 05까지의 대화
👤 "커밋 메시지 작성해줘"
🤖 "어떤 변경사항인지 알 수 없어서 도와드리기 어렵습니다."  # 아무 맥락이 없다

# Chapter 06 이후
👤 "커밋 메시지 작성해줘"
🤖 "feat(auth): add null check for user object in login handler"
#    ↑ Git diff를 보고 있으므로 구체적인 메시지를 만들 수 있다
```

## Claude Code에서 배우는 것

Claude Code는 두 가지 컨텍스트를 모든 대화에 주입한다:

**시스템 컨텍스트** — Git 브랜치, 기본 브랜치, Git 상태(max 2,000자), 최근 커밋, Git 사용자 이름. 병렬로 수집하며, 한 번 수집하면 세션 동안 캐시한다.

**사용자 컨텍스트** — CLAUDE.md 파일들과 오늘 날짜. CLAUDE.md는 프로젝트별 지침 파일로, "이 프로젝트에서는 테스트를 pytest로 실행한다" 같은 규칙을 담는다.

> "컨텍스트가 중요한 이유는, AI가 '지금 어떤 프로젝트에서 작업하고 있는지'를 알아야 적절한 도움을 줄 수 있기 때문이다."

우리도 같은 구조를 따른다. CLAUDE.md 대신 AGENT.md를 사용한다.

## 변경 요약

```
새 파일:
  oda/src/context.ts      → 컨텍스트 수집 (Git 상태 + AGENT.md + 날짜)
  oda/src/system-prompt.ts → 시스템 프롬프트 조립

수정 파일:
  oda/src/query.ts         → 시스템 프롬프트 자동 주입
  oda/src/conversation.ts  → 시스템 프롬프트를 context에서 받도록 변경
  oda/src/ui/App.tsx        → 시스템 프롬프트 조립을 context에 위임
  oda/src/index.ts          → CLI 모드에서도 컨텍스트 주입
```

## Step 1: `oda/src/context.ts` — 새 파일

Git 상태와 프로젝트 설정을 수집한다.

```typescript
// src/context.ts
//
// 컨텍스트 수집
//
// Claude Code 참고:
// - 시스템 컨텍스트: Git 브랜치, 상태, 최근 커밋, 사용자 이름
// - 사용자 컨텍스트: CLAUDE.md 파일들, 오늘 날짜
// - 병렬로 수집, 세션 동안 캐시 (메모이제이션)
//
// 우리도 같은 구조를 따른다.
// CLAUDE.md 대신 AGENT.md를 사용한다.

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── 타입 ────────────────────────────────────────────────

export interface GitContext {
  branch: string;
  defaultBranch: string;
  status: string; // git status --short (max 2000자)
  recentCommits: string; // 최근 5개 커밋 한 줄 요약
  userName: string;
}

export interface ProjectContext {
  agentMd: string | null; // AGENT.md 내용
  cwd: string; // 현재 작업 디렉토리
  today: string; // 오늘 날짜
}

export interface Context {
  git: GitContext | null; // Git 레포가 아니면 null
  project: ProjectContext;
}

// ── 캐시 ────────────────────────────────────────────────
// Claude Code 참고: "한 번 수집되면 세션이 끝날 때까지 캐시된다"

let cachedContext: Context | null = null;

// ── 수집 함수 ───────────────────────────────────────────

/**
 * 컨텍스트를 수집한다.
 * 세션 중 처음 호출 시에만 실제 수집을 하고, 이후에는 캐시를 반환한다.
 *
 * Claude Code 참고:
 * getSystemContext()와 getUserContext()가 메모이제이션 패턴을 사용하는 것과 동일.
 */
export function collectContext(forceRefresh = false): Context {
  if (cachedContext && !forceRefresh) {
    return cachedContext;
  }

  cachedContext = {
    git: collectGitContext(),
    project: collectProjectContext(),
  };

  return cachedContext;
}

function collectGitContext(): GitContext | null {
  try {
    // Git 레포인지 확인
    execSync("git rev-parse --is-inside-work-tree", { stdio: "pipe" });
  } catch {
    return null; // Git 레포가 아님
  }

  const run = (cmd: string): string => {
    try {
      return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
    } catch {
      return "";
    }
  };

  // Claude Code처럼 여러 정보를 수집한다.
  // 이상적으로는 Promise.all로 병렬 수집하겠지만,
  // execSync는 동기라 순차 실행이다.
  // 성능이 중요해지면 exec (비동기)로 바꾼다.

  const branch = run("git branch --show-current") || "HEAD (detached)";
  const defaultBranch = detectDefaultBranch();

  // Git status — Claude Code처럼 2000자로 제한
  let status = run("git status --short");
  if (status.length > 2000) {
    status = status.substring(0, 2000) + "\n... (truncated)";
  }

  const recentCommits = run("git log --oneline -5");
  const userName = run("git config user.name");

  return { branch, defaultBranch, status, recentCommits, userName };
}

function detectDefaultBranch(): string {
  const run = (cmd: string): string => {
    try {
      return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
    } catch {
      return "";
    }
  };

  // origin의 HEAD가 가리키는 브랜치
  const remoteHead = run(
    "git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null",
  );
  if (remoteHead) {
    return remoteHead.replace("refs/remotes/origin/", "");
  }

  // 없으면 main/master 중 존재하는 것
  const branches = run("git branch --list");
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";

  return "main"; // 기본값
}

function collectProjectContext(): ProjectContext {
  const cwd = process.cwd();

  // AGENT.md 탐색
  // Claude Code의 CLAUDE.md와 같은 역할:
  // 프로젝트별 지침을 AI에게 전달한다.
  const agentMd = findAgentMd(cwd);

  const today = new Date().toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  return { agentMd, cwd, today };
}

/**
 * AGENT.md 파일을 탐색한다.
 * 현재 디렉토리에서 시작해서 위로 올라가며 찾는다.
 *
 * 탐색 순서:
 * 1. ./AGENT.md
 * 2. ./.agent/AGENT.md
 * 3. 상위 디렉토리로 반복 (루트까지)
 */
function findAgentMd(startDir: string): string | null {
  let dir = startDir;

  while (true) {
    // ./AGENT.md
    const directPath = join(dir, "AGENT.md");
    if (existsSync(directPath)) {
      return readFileSync(directPath, "utf-8");
    }

    // ./.agent/AGENT.md
    const nestedPath = join(dir, ".agent", "AGENT.md");
    if (existsSync(nestedPath)) {
      return readFileSync(nestedPath, "utf-8");
    }

    // 상위 디렉토리로
    const parent = join(dir, "..");
    if (parent === dir) break; // 루트에 도달
    dir = parent;
  }

  return null;
}
```

핵심 설계:

**캐시** — `cachedContext`로 세션 중 한 번만 수집한다. Git 상태는 셸 명령을 실행해야 하므로 느리다. Claude Code도 동일한 메모이제이션을 쓴다.

**AGENT.md 탐색** — 현재 디렉토리에서 루트까지 올라가며 찾는다. 모노레포에서 서브 패키지 안에 있어도 루트의 AGENT.md를 찾을 수 있다.

**Git 없는 환경** — `git.context`가 `null`이면 Git 정보 없이 동작한다. 모든 곳이 Git 레포는 아니니까.

## Step 2: `oda/src/system-prompt.ts` — 새 파일

수집된 컨텍스트를 하나의 시스템 프롬프트 문자열로 조립한다.

```typescript
// src/system-prompt.ts
//
// 시스템 프롬프트 조립
//
// Claude Code 참고:
// 시스템 프롬프트에 Git 컨텍스트와 사용자 컨텍스트를 주입하여
// AI가 현재 프로젝트 상황을 파악할 수 있게 한다.

import type { Context } from "./context.js";

/**
 * 시스템 프롬프트를 조립한다.
 *
 * 구조:
 * 1. 에이전트 기본 역할
 * 2. 오늘 날짜
 * 3. Git 상태 (있으면)
 * 4. AGENT.md (있으면)
 * 5. 사용자 지정 시스템 프롬프트 (있으면)
 */
export function buildSystemPrompt(
  context: Context,
  userSystem?: string,
): string {
  const sections: string[] = [];

  // ── 기본 역할 ─────────────────────────────────────────
  sections.push(
    "You are an AI coding assistant running locally on the user's machine.",
    "You help with reading, writing, and understanding code.",
    "Be concise and direct. When you're not sure, say so.",
  );

  // ── 날짜 ──────────────────────────────────────────────
  sections.push(`\nToday: ${context.project.today}`);
  sections.push(`Working directory: ${context.project.cwd}`);

  // ── Git 상태 ──────────────────────────────────────────
  if (context.git) {
    const g = context.git;
    const gitLines = [
      "\n## Git Context",
      `Branch: ${g.branch}`,
      `Default branch: ${g.defaultBranch}`,
    ];

    if (g.userName) {
      gitLines.push(`User: ${g.userName}`);
    }

    if (g.status) {
      gitLines.push(`\nChanged files:\n${g.status}`);
    }

    if (g.recentCommits) {
      gitLines.push(`\nRecent commits:\n${g.recentCommits}`);
    }

    sections.push(gitLines.join("\n"));
  }

  // ── AGENT.md ──────────────────────────────────────────
  if (context.project.agentMd) {
    sections.push(
      "\n## Project Instructions (from AGENT.md)",
      context.project.agentMd,
    );
  }

  // ── 사용자 지정 시스템 프롬프트 ────────────────────────
  if (userSystem) {
    sections.push("\n## Additional Instructions", userSystem);
  }

  return sections.join("\n");
}
```

## Step 3: `oda/src/conversation.ts` — 수정

시스템 프롬프트를 문자열 대신 `Context`에서 조립하도록 변경한다.

```diff
- import type { Message, SystemMessage, UserMessage, AssistantMessage, SessionStats } from "./schemas.js";
+ import type { Message, UserMessage, AssistantMessage, SessionStats } from "./schemas.js";
  import type { OllamaMessage } from "./ollama.js";

  export class Conversation {
    private messages: Message[] = [];
-   private systemPrompt?: string;
+   private systemPrompt: string;
    private stats: SessionStats = { ... };

-   constructor(systemPrompt?: string) {
-     this.systemPrompt = systemPrompt;
+   constructor(systemPrompt: string) {
+     this.systemPrompt = systemPrompt;
    }

    toOllamaMessages(): OllamaMessage[] {
      const result: OllamaMessage[] = [];

-     if (this.systemPrompt) {
-       result.push({ role: "system", content: this.systemPrompt });
-     }
+     result.push({ role: "system", content: this.systemPrompt });

      for (const msg of this.messages) {
        result.push({ role: msg.role, content: msg.content });
      }

      return result;
    }
```

시스템 프롬프트가 이제 항상 존재한다. 컨텍스트 없이 동작하는 경우가 없기 때문이다.

## Step 4: `oda/src/ui/App.tsx` — 수정

`App` 컴포넌트 초기화 시 컨텍스트를 수집하고 시스템 프롬프트를 조립한다.

import 추가:

```diff
+ import { collectContext } from "../context.js";
+ import { buildSystemPrompt } from "../system-prompt.js";
```

`Conversation` 생성 부분 변경:

```diff
  export function App({ model, system }: Props) {
    const { exit } = useApp();

-   const [conversation] = useState(() => new Conversation(system));
+   const [conversation] = useState(() => {
+     const context = collectContext();
+     const systemPrompt = buildSystemPrompt(context, system);
+     return new Conversation(systemPrompt);
+   });
```

## Step 5: `oda/src/index.ts` — 수정

CLI 모드에서도 동일하게 컨텍스트를 수집한다.

import 추가:

```diff
+ import { collectContext } from "./context.js";
+ import { buildSystemPrompt } from "./system-prompt.js";
```

`runCli()` 변경:

```diff
  async function runCli(options: { ... }) {
    ...
-   const conversation = new Conversation(options.system);
+   const context = collectContext();
+   const systemPrompt = buildSystemPrompt(context, options.system);
+   const conversation = new Conversation(systemPrompt);
    conversation.addUser(prompt);
    ...
```

## Step 6: AGENT.md 예시 파일 만들기

프로젝트 루트(`oda/`)에 예시 AGENT.md를 만들어서 테스트한다:

```markdown
# AGENT.md

이 프로젝트는 On-Device AI Agent입니다.

## 규칙

- TypeScript를 사용합니다
- 패키지 매니저는 pnpm입니다
- 테스트는 vitest로 실행합니다: `pnpm test`
- 커밋 메시지는 Conventional Commits를 따릅니다

## 구조

- `src/query.ts` — 쿼리 루프 (핵심 엔진)
- `src/ui/` — React + Ink TUI 컴포넌트
- `src/ollama.ts` — Ollama API 클라이언트
```

이 파일이 있으면 AI가 "테스트 실행해줘"라고 했을 때 `pnpm test`를 알고, 커밋 메시지를 작성할 때 Conventional Commits를 따른다.

## 테스트

```bash
# 1. Git 레포 안에서 TUI 실행
pnpm dev
# → 시스템 프롬프트에 Git 정보가 포함되었는지 확인
# → "현재 브랜치가 뭐야?" 라고 물어보면 답할 수 있어야 한다
# → "커밋 메시지 작성해줘" 라고 하면 git status 기반으로 작성

# 2. AGENT.md 테스트
# → "이 프로젝트 테스트는 어떻게 실행해?" 라고 물어보기
# → "pnpm test" 라고 답해야 한다 (AGENT.md에 적혀있으므로)

# 3. Git 레포가 아닌 곳에서 실행
cd /tmp && npx tsx /path/to/oda/src/index.ts "안녕"
# → Git 정보 없이도 정상 동작해야 한다

# 4. CLI 모드
npx tsx src/index.ts "현재 브랜치 알려줘"
# → Git 브랜치를 답해야 한다

# 5. 타입 체크
pnpm typecheck
```

핵심 테스트는 **"현재 브랜치가 뭐야?"** 질문이다. Chapter 05까지는 대답할 수 없었지만, 이제는 시스템 프롬프트에 브랜치 정보가 있으므로 정확히 답할 수 있어야 한다.

## 체크리스트

- [ ] `context.ts` 새 파일 — Git 상태 + AGENT.md 수집
- [ ] `system-prompt.ts` 새 파일 — 시스템 프롬프트 조립
- [ ] `conversation.ts` 수정 — 시스템 프롬프트 필수화
- [ ] `App.tsx` 수정 — 초기화 시 컨텍스트 수집
- [ ] `index.ts` 수정 — CLI에서도 컨텍스트 수집
- [ ] `AGENT.md` 예시 파일 생성
- [ ] "현재 브랜치가 뭐야?"에 정확히 답한다
- [ ] "이 프로젝트 테스트 어떻게 실행해?"에 AGENT.md 기반으로 답한다
- [ ] Git 레포가 아닌 곳에서도 정상 동작
- [ ] `pnpm typecheck` 통과

## 이 챕터의 위치

```
+─────────────────────────────────────+
| UI Layer                            |
+──────────────┬──────────────────────+
               |
               v
+─────────────────────────────────────+
| query() 쿼리 루프                    |
+──────────────┬──────────────────────+
               |
               v
+─────────────────────────────────────+
| Conversation                        |
| └── systemPrompt  ← 여기가 바뀜     |
+──────────────┬──────────────────────+
               |
+──────────────┴──────────────────────+
|                                     |
v                                     v
+──────────────────+  +───────────────────────+
| system-prompt.ts |  | context.ts            |
| (프롬프트 조립)    |  | ├── Git 상태 수집      |
| ✨ 새 파일        |  | ├── AGENT.md 탐색      |
+──────────────────+  | └── 캐시 (메모이제이션)  |
                      | ✨ 새 파일              |
                      +───────────────────────+
```

시스템 프롬프트에 **현재 상황**이 주입되면서, AI가 맹목적으로 답하는 대신 프로젝트 맥락을 이해하고 답할 수 있게 되었다. 하지만 아직 AI는 "답변"만 할 수 있다. 파일을 직접 읽거나 명령을 실행하는 것은 불가능하다.

다음 Part 3에서 드디어 **도구 시스템**을 만든다. AI가 "이 파일을 읽어야겠다"고 판단하면 실제로 파일을 읽고, 그 내용을 보고 다음 행동을 결정하는 — 진짜 에이전트가 시작된다.

## 다음 챕터

→ [Chapter 07. 도구 인터페이스 설계](../07-tool-interface/) — Tool 타입을 정의하고, 도구 레지스트리를 만들고, Ollama의 function calling 포맷을 연결한다. 쿼리 루프에 도구 실행을 끼워넣을 준비를 한다.
