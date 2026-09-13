import { describe, test, expect } from "bun:test";
import { makeTempRepo, writeIn } from "./helpers.js";
import { inRepo, getDiff, listUntracked, listStashes, getStashPatch } from "../src/core/git.js";

describe("git.ts", () => {
  test("inRepo 返回 repoRoot，非仓库返回 null", () => {
    const repo = makeTempRepo();
    expect(inRepo(repo)).toBe(repo);
    expect(inRepo("/tmp")).toBe(null);
  });

  test("getDiff 含 unstaged 与 staged", () => {
    const repo = makeTempRepo();
    writeIn(repo, "a.txt", "changed\n");
    writeIn(repo, "staged.txt", "new\n");
    execGit(["add", "staged.txt"], repo);
    const diff = getDiff(repo);
    expect(diff).toContain("a.txt");
    expect(diff).toContain("staged.txt");
  });

  test("listUntracked 递归列出且排除 .gitignore", () => {
    const repo = makeTempRepo();
    writeIn(repo, "u1.txt", "x");
    writeIn(repo, "sub/u2.txt", "y");
    writeIn(repo, ".gitignore", "ignored.txt\n");
    writeIn(repo, "ignored.txt", "z");
    // .gitignore 本身也是 untracked，需出现在清单中；ignored.txt 被其排除
    expect(listUntracked(repo).sort()).toEqual([".gitignore", "sub/u2.txt", "u1.txt"]);
  });

  test("listStashes / getStashPatch", () => {
    const repo = makeTempRepo();
    writeIn(repo, "a.txt", "stashme\n");
    execGit(["stash", "push", "-q", "-m", "wip"], repo);
    const stashes = listStashes(repo);
    expect(stashes).toHaveLength(1);
    expect(stashes[0].ref).toBe("stash@{0}");
    expect(stashes[0].message).toContain("wip");
    expect(getStashPatch(repo, "stash@{0}")).toContain("a.txt");
  });
});

import { execFileSync } from "node:child_process";
function execGit(args: string[], cwd: string) {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}
