import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempRepo, writeIn } from "./helpers.js";
import { createBackup, buildNote } from "../src/core/backup.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gsg-root-"));
});

describe("createBackup", () => {
  test("有 diff + untracked 时生成完整产物", () => {
    const repo = makeTempRepo();
    writeIn(repo, "a.txt", "changed\n");
    writeIn(repo, "new.txt", "untracked\n");
    const r = createBackup(repo, { triggerCommand: "git reset --hard", agent: "pi", backupRoot: root });
    expect(r).not.toBeNull();
    expect(existsSync(join(r!.dir, "diff.patch"))).toBe(true);
    expect(existsSync(join(r!.dir, "untracked", "new.txt"))).toBe(true);
    const m = JSON.parse(readFileSync(join(r!.dir, "manifest.json"), "utf8"));
    expect(m.version).toBe(1);
    expect(m.repoRoot).toBe(repo);
    expect(m.triggerCommand).toBe("git reset --hard");
    expect(m.agent).toBe("pi");
    expect(m.untrackedFiles).toEqual(["new.txt"]);
    expect(m.untrackedTruncated).toBe(false);
    expect(m.versions.git).toBeTruthy();
  });

  test("工作区干净且无 stash 返回 null", () => {
    const repo = makeTempRepo();
    expect(createBackup(repo, { triggerCommand: "git reset --hard", agent: "pi", backupRoot: root })).toBeNull();
  });

  test("非 git 目录返回 null", () => {
    expect(createBackup("/tmp", { triggerCommand: "git reset --hard", agent: "pi", backupRoot: root })).toBeNull();
  });

  test("同秒多次触发不覆盖目录", () => {
    const repo = makeTempRepo();
    writeIn(repo, "a.txt", "x\n");
    const r1 = createBackup(repo, { triggerCommand: "git reset --hard", agent: "pi", backupRoot: root })!;
    const r2 = createBackup(repo, { triggerCommand: "git reset --hard", agent: "pi", backupRoot: root })!;
    expect(r1.dir).not.toBe(r2.dir);
    expect(existsSync(r1.dir)).toBe(true);
  });

  test("stash drop 备份 stash patch 与 stashList", () => {
    const repo = makeTempRepo();
    writeIn(repo, "a.txt", "wip\n");
    execGitSync(["stash", "push", "-q", "-m", "wip"], repo);
    const r = createBackup(repo, { triggerCommand: "git stash drop", agent: "pi", backupRoot: root })!;
    expect(existsSync(join(r.dir, "stash", "stash-0.patch"))).toBe(true);
    expect(r.manifest.stashRefs).toEqual(["stash@{0}"]);
    expect(r.manifest.stashList).toContain("wip");
    expect(readFileSync(join(r.dir, "stash", "stash-0.patch"), "utf8")).toContain("a.txt");
  });

  test("stash clear 备份全部 stash", () => {
    const repo = makeTempRepo();
    for (const msg of ["w1", "w2"]) {
      writeIn(repo, "a.txt", `${msg}\n`);
      execGitSync(["stash", "push", "-q", "-m", msg], repo);
    }
    const r = createBackup(repo, { triggerCommand: "git stash clear", agent: "pi", backupRoot: root })!;
    expect(r.manifest.stashRefs).toEqual(["stash@{0}", "stash@{1}"]);
    expect(readdirSync(join(r.dir, "stash")).sort()).toEqual(["stash-0.patch", "stash-1.patch"]);
  });

  test("超 500 untracked 只列清单不复制", () => {
    const repo = makeTempRepo();
    for (let i = 0; i < 501; i++) writeIn(repo, `f${i}.txt`, "x");
    const r = createBackup(repo, { triggerCommand: "git clean -fd", agent: "pi", backupRoot: root })!;
    expect(r.manifest.untrackedTruncated).toBe(true);
    expect(r.manifest.untrackedFiles).toHaveLength(501);
    expect(existsSync(join(r.dir, "untracked"))).toBe(false);
  });
});

describe("buildNote", () => {
  test("有备份", () => {
    const note = buildNote("/backups/2026");
    expect(note).toContain("/backups/2026");
    expect(note).toContain("git-safety-guard restore latest");
  });
  test("无备份", () => {
    expect(buildNote(null)).toContain("无可备份改动");
  });
});

import { execFileSync } from "node:child_process";
function execGitSync(args: string[], cwd: string) {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}
