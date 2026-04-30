// src/permissions.ts
//
// 권한 판단 엔진
//
// Claude Code 참고 (13절):
// "어떤 도구를, 어떤 입력으로, 실행해도 되는가"를 판단하는 게이트키퍼.
//
// 우리의 단순화 버전:
// - default 모드: 읽기 전용 → 자동 승인, 변경 도구 → 사용자 확인
// - bypass 모드: 모든 것 자동 승인
// - 규칙: alwaysAllow / alwaysDeny 패턴 매칭

import type { Tool } from "./tools/types.js";

// ── 타입 ────────────────────────────────────────────────

export type PermissionMode = "default" | "bypass";

export type PermissionDecision =
  | { type: "allow"; reason: string }
  | { type: "deny"; reason: string }
  | { type: "ask"; reason: string };

/** 허용/차단 규칙 */
export interface PermissionRule {
  /** 매칭할 도구 이름 (정확히 일치 또는 "*" 와일드카드) */
  tool: string;
  /** 매칭할 입력 패턴 (선택, 정규식 문자열) */
  inputPattern?: string;
  /** allow 또는 deny */
  action: "allow" | "deny";
}

export interface PermissionConfig {
  mode: PermissionMode;
  rules: PermissionRule[];
}

// ── 기본 설정 ───────────────────────────────────────────

export const DEFAULT_PERMISSION_CONFIG: PermissionConfig = {
  mode: "default",
  rules: [],
};

// ── 판단 함수 ───────────────────────────────────────────

/**
 * 도구 실행 권한을 판단한다.
 *
 * Claude Code의 권한 파이프라인 (13.2절):
 * [1] 도구별 규칙 확인
 * [2] alwaysAllow/alwaysDeny 매칭
 * [3] 모드별 처리
 *
 * 우리의 단순화:
 * [1] bypass 모드 → 무조건 allow
 * [2] 규칙 매칭 (allow/deny)
 * [3] 읽기 전용 → allow, 변경 도구 → ask
 */
export function checkPermission(
  tool: Tool,
  input: Record<string, unknown>,
  config: PermissionConfig,
): PermissionDecision {
  // ── [1] Bypass 모드 ─────────────────────────────────
  if (config.mode === "bypass") {
    return { type: "allow", reason: "bypass mode" };
  }

  // ── [2] 규칙 매칭 ──────────────────────────────────
  for (const rule of config.rules) {
    if (matchesRule(rule, tool, input)) {
      if (rule.action === "allow") {
        return { type: "allow", reason: `rule: allow ${rule.tool}` };
      } else {
        return { type: "deny", reason: `rule: deny ${rule.tool}` };
      }
    }
  }

  // ── [3] 기본 판단 ──────────────────────────────────
  if (tool.isReadOnly) {
    return { type: "allow", reason: "read-only tool" };
  }

  // 변경 도구 → 사용자에게 물어본다
  return {
    type: "ask",
    reason: `${tool.name} can modify files or system`,
  };
}

function matchesRule(
  rule: PermissionRule,
  tool: Tool,
  input: Record<string, unknown>,
): boolean {
  // 도구 이름 매칭
  if (rule.tool !== "*" && rule.tool !== tool.name) {
    return false;
  }

  // 입력 패턴 매칭 (있으면)
  if (rule.inputPattern) {
    const inputStr = JSON.stringify(input);
    try {
      const regex = new RegExp(rule.inputPattern);
      if (!regex.test(inputStr)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

// ── 세션 중 동적 규칙 추가 ──────────────────────────────

/**
 * 사용자가 "항상 허용"을 선택했을 때 규칙을 추가한다.
 */
export function addSessionRule(
  config: PermissionConfig,
  tool: string,
  action: "allow" | "deny",
  inputPattern?: string,
): void {
  config.rules.push({ tool, action, inputPattern });
}
