import { execFileSync } from "node:child_process";

const MAX_BUF = 64 * 1024 * 1024;

export function execGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_BUF });
}

/** 在 git 仓库内则返回 repoRoot，否则 null */
export function inRepo(cwd: string): string | null {
  try {
    const root = execGit(["rev-parse", "--show-toplevel"], cwd).trim();
    return root || null;
  } catch {
    return null;
  }
}

export function getDiff(repoRoot: string): string {
  let body = "";
  try {
    body += execGit(["diff"], repoRoot);
    body += execGit(["diff", "--staged"], repoRoot);
  } catch {
    /* fail-open：拿不到 diff 就当没有 */
  }
  return body;
}

export function getDiffStat(repoRoot: string): string | null {
  try {
    const s = execGit(["diff", "--stat"], repoRoot).trim();
    return s || null;
  } catch {
    return null;
  }
}

export function listUntracked(repoRoot: string): string[] {
  try {
    return execGit(["ls-files", "--others", "--exclude-standard"], repoRoot)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function listStashes(repoRoot: string): { ref: string; message: string }[] {
  try {
    return execGit(["stash", "list"], repoRoot)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(stash@\{\d+\}):(.*)$/);
        return m ? { ref: m[1], message: m[2].trim() } : null;
      })
      .filter((s): s is { ref: string; message: string } => s !== null);
  } catch {
    return [];
  }
}

export function getStashPatch(repoRoot: string, ref: string): string {
  try {
    return execGit(["stash", "show", "-p", "--include-untracked", ref], repoRoot);
  } catch {
    return "";
  }
}
