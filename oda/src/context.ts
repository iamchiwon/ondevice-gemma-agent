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
import { existsSync, readFileSync } from "node:fs";
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
