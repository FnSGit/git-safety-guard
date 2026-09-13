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
  // checkout -f <branch-or-sha>
  { sub: "checkout", re: /^git\s+checkout\s+-f\s+\S+\s*$/ },
  // checkout <branch-or-sha>（排除 -b 与 -- 开头）
  { sub: "checkout", re: /^git\s+checkout\s+(?!-b\b)(?!-)\S+\s*$/ },
  // restore（排除 --staged）
  { sub: "restore", re: /^git\s+restore\b/, exclude: /--staged\b/ },
  // switch 强制/丢弃
  { sub: "switch", re: /^git\s+switch\s+(?:-f\b|--discard-changes\b)/ },
  { sub: "reset", re: /^git\s+reset\s+--hard\b/ },
  // clean 需含 f（-f、-fd、-fdx、-dfx）
  { sub: "clean", re: /^git\s+clean\s+-[a-z]*f/ },
  { sub: "stash", re: /^git\s+stash\s+(?:drop|clear)\b/ },
];

export function detectCommand(cmd: string): DetectResult {
  const segments = cmd.split(/\s*(?:&&|\|\||;|\r?\n)\s*/).filter(Boolean);
  for (const seg of segments) {
    for (const p of PATTERNS) {
      if (!p.re.test(seg)) continue;
      if (p.exclude?.test(seg)) continue;
      return { matched: true, subcommand: p.sub, segment: seg.trim() };
    }
  }
  return { matched: false };
}
