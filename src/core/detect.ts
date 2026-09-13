import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { DetectResult } from "../types.js";

interface Pattern {
  sub: NonNullable<DetectResult["subcommand"]>;
  re: RegExp;
  exclude?: RegExp;
}

// 按段匹配（段 = 按 &&/||/;/换行 切分后的单条命令）
const PATTERNS: Pattern[] = [
  // checkout 带路径还原（HEAD/sha -- path、-- . 等）
  { sub: "checkout", re: /^git\s+checkout\b.*\s--\s+\S/ },
  // checkout <ref> <path>（不带 --、不带 -b，两个非选项参数）
  { sub: "checkout", re: /^git\s+checkout\s+(?!-b\b)(?!-)\S+\s+(?!-)\S+\s*$/ },
  // checkout -f <branch-or-sha>
  { sub: "checkout", re: /^git\s+checkout\s+-f\s+\S+\s*$/ },
  // checkout <branch-or-sha>（排除 -b 与 -- 开头）
  { sub: "checkout", re: /^git\s+checkout\s+(?!-b\b)(?!-)\S+\s*$/ },
  // restore（排除 --staged）
  { sub: "restore", re: /^git\s+restore\b/, exclude: /--staged\b/ },
  // switch 强制/丢弃
  { sub: "switch", re: /^git\s+switch\s+(?:-f\b|--discard-changes\b)/ },
  { sub: "reset", re: /^git\s+reset\s+--hard\b/ },
  // clean 需含 f（短选项 -f/-fd/-fdx 或长选项 --force）
  { sub: "clean", re: /^git\s+clean\s+(?:-[a-z]*f|--force)/ },
  { sub: "stash", re: /^git\s+stash\s+(?:drop|clear)\b/ },
];

/** 按 && / || / ; / 换行 把整条命令切成段（两处共用：detect 与 cd 解析） */
export function splitSegments(cmd: string): string[] {
  return cmd.split(/\s*(?:&&|\|\||;|\r?\n)\s*/).filter(Boolean);
}

/** 第一个 pattern 命中的段及其在 splitSegments(cmd) 中的索引；未命中 null */
function firstMatch(cmd: string): { segment: string; index: number } | null {
  const segments = splitSegments(cmd);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    for (const p of PATTERNS) {
      if (!p.re.test(seg)) continue;
      if (p.exclude?.test(seg)) continue;
      return { segment: seg.trim(), index: i };
    }
  }
  return null;
}

export function detectCommand(cmd: string): DetectResult {
  const m = firstMatch(cmd);
  if (!m) return { matched: false };
  // 通过 re-test 取出 subcommand（firstMatch 内部已知，但接口拆分便于复用）
  for (const p of PATTERNS) {
    if (!p.re.test(m.segment)) continue;
    if (p.exclude?.test(m.segment)) continue;
    return { matched: true, subcommand: p.sub, segment: m.segment };
  }
  return { matched: false };
}

/** 解析单引号/双引号包裹的路径；返回 { dir, consumed } 或 null */
function parseQuotedDir(rest: string): { dir: string; consumed: number } | null {
  const q = rest[0];
  if (q !== '"' && q !== "'") return null;
  const close = rest.indexOf(q, 1);
  if (close < 0) return null;
  return { dir: rest.slice(1, close), consumed: close + 1 };
}

/** 从一段中解析 `cd <dir>` 的目标路径；返回绝对路径或 null */
function parseCdTarget(seg: string, baseCwd: string): string | null {
  // 必须是 `cd` 单独命令段（不与管道/`&&` 混在一起，前面已 split 过）
  const m = seg.match(/^cd\s+(.*)$/);
  if (!m) return null;
  const rest = m[1].trim();
  if (rest === "" || rest === "-") return null; // cd / cd - 不改变 cwd 解析
  let dir: string;
  let consumed = rest.length;
  if (rest[0] === '"' || rest[0] === "'") {
    const q = parseQuotedDir(rest);
    if (!q) return null;
    dir = q.dir;
  } else {
    // 普通无引号：取第一个 token（空格分隔）；支持 ~/x
    const sp = rest.indexOf(" ");
    dir = sp < 0 ? rest : rest.slice(0, sp);
  }
  if (dir === "" || dir === "-") return null;
  let resolved: string;
  try {
    resolved = resolve(baseCwd, dir);
  } catch {
    return null;
  }
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * 解析命令里 `cd <dir>` 前缀链，返回破坏动作实际发生的目录。
 * 规则：取**第一个命中段之前**的最后一个 `cd <dir>` 段；无 cd 段、cd 单独 / `cd -` /
 * 解析失败 → 回退 sessionCwd。命中段之后的 cd 不影响（已晚）。
 */
export function resolveCwdForCommand(cmd: string, sessionCwd: string): string {
  const m = firstMatch(cmd);
  if (!m) return sessionCwd;
  const segments = splitSegments(cmd);
  let last: string | null = null;
  for (let i = 0; i < m.index; i++) {
    const d = parseCdTarget(segments[i], last ?? sessionCwd);
    if (d !== null) last = d;
  }
  return last ?? sessionCwd;
}