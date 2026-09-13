import { describe, test, expect } from "bun:test";
import { detectCommand } from "../src/core/detect.js";

const hits: Array<[string, string]> = [
  ["git checkout HEAD -- src/a.ts", "checkout"],
  ["git checkout -- src/a.ts", "checkout"],
  ["git checkout abc123 -- src/a.ts", "checkout"],
  ["git checkout .", "checkout"],
  ["git checkout -- .", "checkout"],
  ["git checkout main", "checkout"],
  ["git checkout -f main", "checkout"],
  ["git checkout abc123", "checkout"],
  ["git restore src/a.ts", "restore"],
  ["git restore .", "restore"],
  ["git reset --hard", "reset"],
  ["git reset --hard HEAD~1", "reset"],
  ["git clean -f", "clean"],
  ["git clean -fd", "clean"],
  ["git clean -fdx", "clean"],
  ["git clean -dfx", "clean"],
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
