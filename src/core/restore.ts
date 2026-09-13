import { readdirSync, readFileSync, existsSync, mkdirSync, cpSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { Manifest } from "../types.js";
import { execGit, inRepo } from "./git.js";
import { createBackup } from "./backup.js";

export interface RestoreResult {
  backupDir: string;
  applied: boolean;
  appliedFiles: string[];
  restoredUntracked: string[];
  skippedExisting: string[];
  appliedStashes: string[];
  skippedStashes: string[];
  selfBackupDir: string | null;
}

/** 从 diff.patch 中解析受影响的路径名（"diff --git a/<p> b/<p>" 头去重） */
function parseAppliedFiles(patch: string): string[] {
  const seen = new Set<string>();
  const re = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch)) !== null) {
    // rename/rename 或 mode 变更时 a/b 不同；记录 b 为准（apply 后状态）
    seen.add(m[2]);
  }
  return [...seen];
}

function defaultRoot(): string {
  return process.env.GIT_SAFETY_GUARD_BACKUP_ROOT || join(homedir(), ".git-safety-guard", "backups");
}

export function listBackups(backupRoot?: string) {
  const root = backupRoot || defaultRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => existsSync(join(root, d, "manifest.json")))
    .sort()
    .reverse()
    .map((d) => {
      const m: Manifest = JSON.parse(readFileSync(join(root, d, "manifest.json"), "utf8"));
      return {
        dir: join(root, d),
        timestamp: m.timestamp,
        cwd: m.cwd,
        summary: `${m.diffStat ?? "no diff"} · untracked:${m.untrackedFiles.length}${m.untrackedTruncated ? "(截断)" : ""} · stash:${m.stashRefs.length}`,
      };
    });
}

function resolveDir(root: string, target: string): string {
  if (target === "latest") {
    const all = readdirSync(root).filter((d) => existsSync(join(root, d, "manifest.json"))).sort();
    if (all.length === 0) throw new Error("没有可用备份");
    return join(root, all[all.length - 1]);
  }
  const dir = join(root, target);
  if (!existsSync(join(dir, "manifest.json"))) throw new Error(`备份不存在: ${target}`);
  return dir;
}

export function restoreBackup(
  target: string,
  opts: { dryRun?: boolean; force?: boolean; backupRoot?: string },
): RestoreResult {
  const root = opts.backupRoot || defaultRoot();
  const dir = resolveDir(root, target);
  const manifest: Manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));

  // 1. 自保备份（恢复动作本身也可能是丢弃；dry-run 也会做，落在 BACKUP_ROOT）
  let selfBackupDir: string | null = null;
  const cur = inRepo(manifest.repoRoot);
  if (cur) {
    const self = createBackup(manifest.repoRoot, {
      triggerCommand: `git-safety-guard restore ${basename(dir)} (self-backup)`,
      agent: "unknown",
      backupRoot: opts.backupRoot,
    });
    selfBackupDir = self?.dir ?? null;
  }

  // 2. diff.patch 应用：先 --check 再 apply，失败整体中止（spec 7.4）
  const patchPath = join(dir, "diff.patch");
  let applied = false;
  let appliedFiles: string[] = [];
  if (existsSync(patchPath)) {
    const patchText = readFileSync(patchPath, "utf8");
    appliedFiles = parseAppliedFiles(patchText);
    try {
      execGit(["apply", "--check", patchPath], manifest.repoRoot);
    } catch (e) {
      throw new Error(`git apply --check 失败（已中止，未做任何修改；自保备份: ${selfBackupDir ?? "无"}）: ${e}`);
    }
    if (!opts.dryRun) {
      execGit(["apply", patchPath], manifest.repoRoot);
      applied = true;
    }
  }

  // 3. stash patch 应用（spec 7.2）：逐个 --check，失败跳过而非中止
  const appliedStashes: string[] = [];
  const skippedStashes: string[] = [];
  const stashDir = join(dir, "stash");
  if (existsSync(stashDir)) {
    for (const name of readdirSync(stashDir).filter((f) => f.endsWith(".patch")).sort()) {
      const p = join(stashDir, name);
      try {
        execGit(["apply", "--check", p], manifest.repoRoot);
      } catch {
        skippedStashes.push(name);
        continue;
      }
      if (opts.dryRun) {
        appliedStashes.push(name); // 预览：check 通过即视为将要应用
      } else {
        execGit(["apply", p], manifest.repoRoot);
        appliedStashes.push(name);
      }
    }
  }

  // 4. untracked 复制回（不覆盖已存在，除非 --force；dry-run 不动文件但仍预览）
  const restoredUntracked: string[] = [];
  const skippedExisting: string[] = [];
  const uDir = join(dir, "untracked");
  if (existsSync(uDir)) {
    for (const rel of manifest.untrackedFiles) {
      const src = join(uDir, rel);
      const dest = join(manifest.repoRoot, rel);
      if (!existsSync(src)) continue;
      if (existsSync(dest) && !opts.force) {
        skippedExisting.push(rel);
        continue;
      }
      if (opts.dryRun) {
        // 预览：列入将要恢复的列表，但不动磁盘
        restoredUntracked.push(rel);
        continue;
      }
      mkdirSync(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
      cpSync(src, dest);
      restoredUntracked.push(rel);
    }
  }

  return {
    backupDir: dir,
    applied,
    appliedFiles,
    restoredUntracked,
    skippedExisting,
    appliedStashes,
    skippedStashes,
    selfBackupDir,
  };
}
