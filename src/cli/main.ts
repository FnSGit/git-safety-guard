#!/usr/bin/env node
import { runHook } from "./hook.js";
import { restoreBackup, listBackups } from "../core/restore.js";

const [, , cmd, ...args] = process.argv;

function usage(): number {
  process.stderr.write(`git-safety-guard — 备份后放行的 git 安全守卫

用法:
  git-safety-guard hook                  # PreToolUse hook 入口（stdin JSON）
  git-safety-guard restore latest        # 恢复最近一次备份
  git-safety-guard restore <timestamp> [--dry-run] [--force]
  git-safety-guard list                  # 列出备份
`);
  return 1;
}

async function main(): Promise<number> {
  if (cmd === "hook") return runHook();

  if (cmd === "list") {
    const list = listBackups();
    if (list.length === 0) {
      console.log("（无备份）");
      return 0;
    }
    for (const b of list) console.log(`${b.timestamp}  ${b.cwd}\n    ${b.summary}\n    ${b.dir}`);
    return 0;
  }

  if (cmd === "restore") {
    const target = args[0];
    if (!target) return usage();
    const dryRun = args.includes("--dry-run");
    const force = args.includes("--force");
    try {
      const r = restoreBackup(target, { dryRun, force });
      console.log(`备份: ${r.backupDir}`);
      if (r.selfBackupDir) console.log(`自保备份: ${r.selfBackupDir}`);
      if (dryRun) {
        // dry-run 预览：不打印"diff.patch 已应用"，只展示将要做什么
        if (r.appliedFiles.length > 0) console.log(`(预览) 将恢复: ${r.appliedFiles.join(", ")}`);
        if (r.appliedStashes.length > 0) console.log(`(预览) 将应用 stash patch: ${r.appliedStashes.join(", ")}`);
        if (r.skippedStashes.length > 0) console.log(`(预览) 将跳过 stash patch（冲突）: ${r.skippedStashes.join(", ")}`);
        if (r.restoredUntracked.length > 0) console.log(`(预览) 将恢复 untracked ${r.restoredUntracked.length} 个`);
        if (r.skippedExisting.length > 0) console.log(`(预览) untracked 跳过已存在 ${r.skippedExisting.length} 个（--force 可覆盖）`);
      } else {
        if (r.applied) console.log("diff.patch 已应用");
        if (r.appliedFiles.length > 0) console.log(`已恢复: ${r.appliedFiles.join(", ")}`);
        if (r.appliedStashes.length > 0) console.log(`stash patch 已应用: ${r.appliedStashes.join(", ")}`);
        if (r.skippedStashes.length > 0) console.log(`stash patch 跳过（冲突）: ${r.skippedStashes.join(", ")}`);
        console.log(`untracked 恢复 ${r.restoredUntracked.length} 个${r.skippedExisting.length ? `，跳过已存在 ${r.skippedExisting.length} 个（--force 可覆盖）` : ""}`);
      }
      return 0;
    } catch (e) {
      process.stderr.write(`restore 失败: ${e}\n`);
      return 1;
    }
  }

  return usage();
}

main().then((code) => process.exit(code));
