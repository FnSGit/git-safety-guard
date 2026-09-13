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
  });

  test("--dry-run 不动文件", () => {
    const { repo } = backupRepoWithChanges();
    simulateDiscard(repo);
    const res = restoreBackup("latest", { dryRun: true, backupRoot: root });
    expect(res.applied).toBe(false);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("hello\n");
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
