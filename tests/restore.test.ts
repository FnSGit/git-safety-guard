import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempRepo, writeIn } from "./helpers.js";
import { createBackup } from "../src/core/backup.js";
import { restoreBackup, listBackups } from "../src/core/restore.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "gsg-r-")); });

function backupRepoWithChanges(): { repo: string; dir: string } {
  const repo = makeTempRepo();
  writeIn(repo, "a.txt", "modified\n");
  writeIn(repo, "untracked.txt", "precious\n");
  const r = createBackup(repo, { triggerCommand: "git reset --hard", agent: "pi", backupRoot: root })!;
  return { repo, dir: r.dir };
}

/** 模拟丢弃已发生：a.txt 回到 HEAD 内容，untracked 被 clean 掉 */
function simulateDiscard(repo: string) {
  writeFileSync(join(repo, "a.txt"), "hello\n"); // HEAD 内容
  rmSync(join(repo, "untracked.txt"));
}

describe("restoreBackup", () => {
  test("round-trip：备份 → 破坏 → latest 恢复", () => {
    const { repo, dir } = backupRepoWithChanges();
    simulateDiscard(repo);
    writeIn(repo, "b.txt", "dirty during restore\n"); // 无关脏文件，触发自保备份

    const res = restoreBackup("latest", { backupRoot: root });
    expect(res.backupDir).toBe(dir);
    expect(res.applied).toBe(true);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toContain("modified");
    expect(readFileSync(join(repo, "untracked.txt"), "utf8")).toBe("precious\n");
    expect(res.selfBackupDir).not.toBeNull();
    expect(res.selfBackupStatus).toBe("created"); // b.txt 脏，self-backup 创建
  });

  test("--dry-run 不动文件", () => {
    const { repo } = backupRepoWithChanges();
    simulateDiscard(repo);
    const res = restoreBackup("latest", { dryRun: true, backupRoot: root });
    expect(res.applied).toBe(false);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("hello\n");
    // M6：dry-run + 无额外脏文件 → 自保状态为 clean
    expect(res.selfBackupStatus).toBe("clean");
    expect(res.selfBackupDir).toBeNull();
  });

  test("--dry-run 不写 untracked 文件但列出预览", () => {
    const { repo } = backupRepoWithChanges();
    simulateDiscard(repo); // untracked.txt 被删
    const res = restoreBackup("latest", { dryRun: true, backupRoot: root });
    expect(existsSync(join(repo, "untracked.txt"))).toBe(false); // 确实没写
    expect(res.restoredUntracked).toContain("untracked.txt"); // 预览里有
  });

  test("stash patch 应用：stash 丢丢 → restore 回填到工作树", () => {
    const repo = makeTempRepo();
    // 先造一个有未提交改动的仓库，然后 stash
    writeFileSync(join(repo, "a.txt"), "stashed-content\n");
    execFileSync("git", ["stash", "push", "-q", "-m", "wip-a"], { cwd: repo });
    // 备份（针对 stash drop 触发）
    const b = createBackup(repo, { triggerCommand: "git stash drop", agent: "pi", backupRoot: root })!;
    expect(existsSync(join(b.dir, "stash", "stash-0.patch"))).toBe(true);
    // stash drop 仅删除栈条目，不动工作树——此时 a.txt 仍是 HEAD 内容
    execFileSync("git", ["stash", "drop"], { cwd: repo });
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("hello\n");
    // 恢复：stash patch 被 apply，a.txt 变回 stashed-content
    const res = restoreBackup("latest", { backupRoot: root });
    expect(res.appliedStashes).toContain("stash-0.patch");
    expect(res.skippedStashes).toEqual([]);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("stashed-content\n");
  });

  test("stash patch 冲突时跳过而非中止", () => {
    const repo = makeTempRepo();
    writeFileSync(join(repo, "a.txt"), "stashed-content\n");
    execFileSync("git", ["stash", "push", "-q", "-m", "wip-collision"], { cwd: repo });
    const b = createBackup(repo, { triggerCommand: "git stash drop", agent: "pi", backupRoot: root })!;
    execFileSync("git", ["stash", "drop"], { cwd: repo });
    // 制造冲突：把仓库 a.txt 改成不同内容并提交（使 stash patch 不可应用）
    writeFileSync(join(repo, "a.txt"), "totally-different-base\n");
    execCommitAll(repo);
    const res = restoreBackup("latest", { backupRoot: root });
    expect(res.skippedStashes).toContain("stash-0.patch");
    expect(res.appliedStashes).toEqual([]);
    // diff.patch 为空（原始无 diff），restore 不应抛错
    expect(res.applied).toBe(false);
  });

  test("M6 repo-missing：仓库不存在时自保状态明确", () => {
    const repo = makeTempRepo();
    writeIn(repo, "a.txt", "modified\n");
    const b = createBackup(repo, { triggerCommand: "git reset --hard", agent: "pi", backupRoot: root })!;
    // 模拟仓库被删：把 repoRoot 目录 rm 掉，restore 仍走自保分支但 repo 不存在
    rmSync(repo, { recursive: true, force: true });
    const res = restoreBackup("latest", { backupRoot: root });
    expect(res.selfBackupStatus).toBe("repo-missing");
    expect(res.selfBackupDir).toBeNull();
    expect(b.dir).toBeTruthy(); // 仅断言原备份可被列出解析
  });

  test("不覆盖已存在文件，--force 覆盖", () => {
    const { repo } = backupRepoWithChanges();
    simulateDiscard(repo);
    writeIn(repo, "untracked.txt", "newer\n");
    restoreBackup("latest", { backupRoot: root });
    expect(readFileSync(join(repo, "untracked.txt"), "utf8")).toBe("newer\n");
    // force 场景在 CLI 层测，这里验证默认跳过即可
  });

  test("patch 冲突时中止不部分应用", () => {
    const { repo } = backupRepoWithChanges();
    // 把文件改成与备份基线无关的状态，制造 apply 冲突
    writeFileSync(join(repo, "a.txt"), "totally different content that cannot apply\n");
    execCommitAll(repo);
    expect(() => restoreBackup("latest", { backupRoot: root })).toThrow();
  });
});

describe("listBackups", () => {
  test("列出备份含 cwd 与摘要", () => {
    backupRepoWithChanges();
    const list = listBackups(root);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].cwd).toBeTruthy();
    expect(list[0].timestamp).toBeTruthy();
  });
});

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
function execCommitAll(repo: string) {
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "x"], { cwd: repo });
}
