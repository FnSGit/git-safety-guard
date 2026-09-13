import { describe, test, expect } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { detectCommand, resolveCwdForCommand, splitSegments } from "../src/core/detect.js";

const hits: Array<[string, string]> = [
  ["git checkout HEAD -- src/a.ts", "checkout"],
  ["git checkout -- src/a.ts", "checkout"],
  ["git checkout abc123 -- src/a.ts", "checkout"],
  ["git checkout .", "checkout"],
  ["git checkout -- .", "checkout"],
  ["git checkout main", "checkout"],
  ["git checkout -f main", "checkout"],
  ["git checkout abc123", "checkout"],
  // I3 新增：checkout <ref> <path>（不带 --）
  ["git checkout main src/a.ts", "checkout"],
  ["git checkout HEAD~1 file.txt", "checkout"],
  ["git restore src/a.ts", "restore"],
  ["git restore .", "restore"],
  ["git reset --hard", "reset"],
  ["git reset --hard HEAD~1", "reset"],
  ["git clean -f", "clean"],
  ["git clean -fd", "clean"],
  ["git clean -fdx", "clean"],
  ["git clean -dfx", "clean"],
  // I3 新增：clean --force
  ["git clean --force", "clean"],
  ["git clean --force -d", "clean"],
  ["git switch --discard-changes", "switch"],
  ["git switch -f main", "switch"],
  ["git stash drop", "stash"],
  ["git stash drop stash@{2}", "stash"],
  ["git stash clear", "stash"],
  // 复合命令分段
  ["cd /tmp && git reset --hard", "reset"],
  ["git status; git checkout -- .", "checkout"],
  ["ls && git restore src/a.ts && echo done", "restore"],
];

describe("detectCommand 命中", () => {
  for (const [cmd, sub] of hits) {
    test(`命中 ${cmd}`, () => {
      const r = detectCommand(cmd);
      expect(r.matched).toBe(true);
      expect(r.subcommand).toBe(sub);
    });
  }
});

const misses = [
  "git status",
  "git diff",
  "git add .",
  "git commit -m 'x'",
  "git restore --staged src/a.ts",
  "git checkout -b feature/x",
  // I3 新增 2-arg checkout 变体不应误伤
  "git checkout -b main src/a.ts",     // 以 -b 开头被排除
  "git stash",
  "git stash pop",
  "git stash apply",
  "git stash list",
  "git stash branch tmp",
  "git reset",
  "git reset --soft HEAD~1",
  "git clean -n",
  "git switch main",
  "git branch -D tmp",
  "",
];

describe("detectCommand 放行", () => {
  for (const cmd of misses) {
    test(`放行 ${cmd || "(空)"}`, () => {
      expect(detectCommand(cmd).matched).toBe(false);
    });
  }
});

describe("splitSegments", () => {
  test("按 && / || / ; / 换行 分段", () => {
    expect(splitSegments("a && b || c; d\ne")).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("resolveCwdForCommand", () => {
  test("cd 命中之前：取最后一个 cd 目标", () => {
    expect(resolveCwdForCommand("cd /tmp && git reset --hard", "/session")).toBe(realpathSync("/tmp"));
  });
  test("多个 cd 取最后一个", () => {
    const realDir = realpathSync("/tmp"); // macOS /tmp → /private/tmp，不存在路径会回退 resolve 结果
    expect(resolveCwdForCommand(`cd ${realDir} && cd ${realDir} && git restore .`, "/session")).toBe(realDir);
  });
  test("无 cd 段 → 回退 sessionCwd", () => {
    expect(resolveCwdForCommand("git reset --hard", "/session")).toBe("/session");
  });
  test("cd 后带引号路径（目标不存在时回退 resolve 结果）", () => {
    // 目标不存在 → realpathSync 抛 ENOENT → 函数返回 resolve() 结果
    const target = "/tmp/gsg-resolve-nonexistent-" + Math.random().toString(36).slice(2);
    expect(resolveCwdForCommand(`cd "${target}" && git clean -fd`, "/session")).toBe(resolve("/session", target));
  });
  test("cd - 忽略 → 回退 sessionCwd", () => {
    expect(resolveCwdForCommand("cd - && git reset --hard", "/session")).toBe("/session");
  });
  test("cd 在命中段之后 → 忽略（已晚）", () => {
    expect(resolveCwdForCommand("git reset --hard && cd /tmp", "/session")).toBe("/session");
  });
  test("未命中命令 → 原样返回 sessionCwd", () => {
    expect(resolveCwdForCommand("ls && echo hi", "/session")).toBe("/session");
  });
});
