import { mkdirSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { BackupResult, Manifest } from "../types.js";
import { inRepo, getDiff, getDiffStat, listUntracked, listStashes, getStashPatch, execGit } from "./git.js";

const UNTRACKED_LIMIT = 500;

function defaultRoot(): string {
  return process.env.GIT_SAFETY_GUARD_BACKUP_ROOT || join(homedir(), ".git-safety-guard", "backups");
}

/** 从 triggerCommand 解析需备份的 stash 引用；无需备份返回 [] */
function parseStashRefs(cmd: string, repoRoot: string): string[] {
  if (/git\s+stash\s+clear\b/.test(cmd)) return listStashes(repoRoot).map((s) => s.ref);
  const m = cmd.match(/git\s+stash\s+drop\s+(?:--\s+)?stash@\{(\d+)\}/);
  if (m) return [`stash@{${m[1]}}`];
  if (/git\s+stash\s+drop\b/.test(cmd)) return ["stash@{0}"];
  return [];
}

/** 时间戳目录名，冲突则加 ms 后缀去重 */
function uniqueDir(root: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-"); // 含 ms
  let dir = join(root, ts);
  if (!existsSync(dir)) return dir;
  dir = `${dir}-${Date.now()}`;
  while (existsSync(dir)) dir = `${dir}-x`;
  return dir;
}

export function buildNote(dir: string | null): string {
  if (!dir) return "[git-guard] 检测到丢弃型 git 命令，但当前无可备份改动（工作区干净）。";
  return `[git-guard] ⚠️ 该命令会丢弃未提交改动。已自动备份到 ${dir}（恢复：git-safety-guard restore latest）`;
}

export function createBackup(
  cwd: string,
  opts: { triggerCommand: string; agent: Manifest["agent"]; backupRoot?: string },
): BackupResult | null {
  const repoRoot = inRepo(cwd);
  if (!repoRoot) return null;

  const diff = getDiff(repoRoot);
  const untracked = listUntracked(repoRoot);
  const stashRefs = parseStashRefs(opts.triggerCommand, repoRoot);
  const stashes = stashRefs
    .map((ref) => ({ ref, patch: getStashPatch(repoRoot, ref) }))
    .filter((s) => s.patch.trim().length > 0);

  if (!diff.trim() && untracked.length === 0 && stashes.length === 0) return null;

  const dir = uniqueDir(opts.backupRoot || defaultRoot());
  mkdirSync(dir, { recursive: true });

  if (diff.trim()) {
    const header = `# git-safety-guard 自动备份 ${new Date().toISOString()}\n# 触发命令: ${opts.triggerCommand}\n# 恢复: git-safety-guard restore ${dir.split("/").pop()}\n`;
    writeFileSync(join(dir, "diff.patch"), header + diff);
  }

  let truncated = false;
  if (untracked.length > 0 && untracked.length <= UNTRACKED_LIMIT) {
    const uDir = join(dir, "untracked");
    for (const rel of untracked) {
      const src = join(repoRoot, rel);
      const dest = join(uDir, rel);
      mkdirSync(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
      cpSync(src, dest);
    }
  } else if (untracked.length > UNTRACKED_LIMIT) {
    truncated = true; // 只列清单不复制
  }

  if (stashes.length > 0) {
    const sDir = join(dir, "stash");
    mkdirSync(sDir, { recursive: true });
    for (const s of stashes) {
      const n = s.ref.match(/\d+/)![0];
      writeFileSync(join(sDir, `stash-${n}.patch`), s.patch);
    }
  }

  const manifest: Manifest = {
    version: 1,
    timestamp: new Date().toISOString(),
    cwd,
    repoRoot,
    triggerCommand: opts.triggerCommand,
    agent: opts.agent,
    diffStat: getDiffStat(repoRoot),
    untrackedFiles: untracked,
    untrackedTruncated: truncated,
    stashRefs: stashes.map((s) => s.ref),
    stashList: stashes.length > 0 ? listStashes(repoRoot).map((s) => `${s.ref}: ${s.message}`).join("\n") : null,
    versions: {
      guard: "0.1.0",
      node: process.version,
      git: gitVersion(),
    },
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

  return { dir, manifest, note: buildNote(dir) };
}

function gitVersion(): string {
  try {
    return execGit(["--version"], process.cwd()).trim();
  } catch {
    return "unknown";
  }
}
