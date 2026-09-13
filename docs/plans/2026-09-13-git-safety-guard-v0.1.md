# git-safety-guard v0.1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现「备份后放行」git 安全守卫：丢弃型 git 命令执行前自动备份 diff + untracked + stash，双入口（pi 扩展 + PreToolUse hook CLI）共享同一 core，提供 restore/list 恢复命令。

**Architecture:** 纯函数 core（detect/backup/restore/git 封装）不感知运行时；pi 入口挂 `tool_call`/`tool_result` 事件进程内调用；CLI 入口读 stdin hook payload、按 agent 形状输出、fail-open。

**Tech Stack:** TypeScript 5.x ESM、Node ≥ 20、bun test、零运行时依赖。

**Spec:** `docs/specs/2026-09-13-git-safety-guard-design.md`（v0.2）

## Global Constraints

- 包名 `git-safety-guard`，npm + GitHub `FnSGit/git-safety-guard`，keyword 含 `pi-package`
- 零运行时依赖；devDependencies 仅 typescript、@types/node、bun-types、@earendil-works/pi-coding-agent（类型用）
- **fail-open**：备份失败/解析失败一律放行原命令，exit 0（备份器不是闸门）
- 备份根目录默认 `~/.git-safety-guard/backups/`，env `GIT_SAFETY_GUARD_BACKUP_ROOT` 覆盖
- `GIT_SAFETY_GUARD_QUIET=1` 关提示（备份照做）；`GIT_SAFETY_GUARD_WORKER_DETECT=1` 开 worker 检测（仅 pi 入口）
- detect：按 `&&`/`||`/`;`/换行分段后逐段匹配；`--staged` 的 restore、`-b` 的 checkout、`stash pop/apply/branch` 显式排除
- untracked 超 500 文件：只备份清单不复制内容，manifest `untrackedTruncated: true`
- 测试一律用临时 git 仓库（`mkdtemp` + `git init`），不碰真实仓库
- 所有文件操作用 `node:fs`/`node:child_process`，同步 API 即可（调用频率低）

---

### Task 1: 脚手架 + types.ts + detect.ts

**Files:**
- Create: `package.json`、`tsconfig.json`、`.gitignore`、`LICENSE`
- Create: `src/types.ts`
- Create: `src/core/detect.ts`
- Test: `tests/detect.test.ts`

**Interfaces:**
- Produces: `detectCommand(cmd: string): DetectResult`、类型 `DetectResult`（后续所有任务消费）

- [ ] **Step 1: 写 package.json / tsconfig / .gitignore / LICENSE**

`package.json`：

```json
{
  "name": "git-safety-guard",
  "version": "0.1.0",
  "description": "Backup-then-allow guard for discarding git commands. Auto-backs up diff + untracked + stash before checkout/restore/reset --hard/clean/stash drop, then lets the command run. pi extension + PreToolUse hook CLI.",
  "type": "module",
  "main": "./src/pi/index.ts",
  "bin": { "git-safety-guard": "./dist/cli/main.js" },
  "files": ["src", "dist", "README.md", "LICENSE"],
  "keywords": ["pi-package", "git", "safety", "backup", "hook", "agent"],
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "bun test",
    "build": "tsc -p tsconfig.json"
  },
  "pi": { "extensions": ["./src/pi"] },
  "peerDependencies": { "@earendil-works/pi-coding-agent": "*" },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/node": "^20.0.0",
    "bun-types": "^1.1.0",
    "@earendil-works/pi-coding-agent": "*"
  }
}
```

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node", "bun-types"],
    "declaration": true
  },
  "include": ["src"]
}
```

`.gitignore`：

```
node_modules/
dist/
*.log
```

`LICENSE`：标准 MIT，版权行 `Copyright (c) 2026 FnSGit`。

- [ ] **Step 2: 写 src/types.ts（spec 7.8 原文）**

```ts
export interface DetectResult {
  matched: boolean;
  subcommand?: "checkout" | "restore" | "switch" | "reset" | "clean" | "stash";
  segment?: string; // 命中的命令段（复合命令切分后）
}

export interface Manifest {
  version: 1;
  timestamp: string;
  cwd: string;
  repoRoot: string;
  triggerCommand: string;
  agent: "pi" | "claude" | "codex" | "unknown";
  diffStat: string | null;
  untrackedFiles: string[];
  untrackedTruncated: boolean;
  stashRefs: string[];
  stashList: string | null;
  versions: { guard: string; node: string; git: string };
}

export interface BackupResult {
  dir: string;
  manifest: Manifest;
  note: string;
}

export interface Options {
  backupRoot?: string;
  quiet?: boolean;
}
```

- [ ] **Step 3: 写失败测试 tests/detect.test.ts**

```ts
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
```

- [ ] **Step 4: 运行测试确认失败**

Run: `bun test tests/detect.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 5: 实现 src/core/detect.ts**

```ts
import type { DetectResult } from "../types.js";

interface Pattern {
  sub: NonNullable<DetectResult["subcommand"]>;
  re: RegExp;
  exclude?: RegExp;
}

// 按段匹配（段 = 按 &&/||/;/换行 切分后的单条命令）
const PATTERNS: Pattern[] = [
  // checkout 带路径还原（HEAD/sha -- path、-- . 等）
  { sub: "checkout", re: /^git\s+checkout\b.*\s--\s+\S/ },
  // checkout -f <branch-or-sha>
  { sub: "checkout", re: /^git\s+checkout\s+-f\s+\S+\s*$/ },
  // checkout <branch-or-sha>（排除 -b 与 -- 开头）
  { sub: "checkout", re: /^git\s+checkout\s+(?!-b\b)(?!-)\S+\s*$/ },
  // restore（排除 --staged）
  { sub: "restore", re: /^git\s+restore\b/, exclude: /--staged\b/ },
  // switch 强制/丢弃
  { sub: "switch", re: /^git\s+switch\s+(?:-f\b|--discard-changes\b)/ },
  { sub: "reset", re: /^git\s+reset\s+--hard\b/ },
  // clean 需含 f（-f、-fd、-fdx、-dfx）
  { sub: "clean", re: /^git\s+clean\s+-[a-z]*f/ },
  { sub: "stash", re: /^git\s+stash\s+(?:drop|clear)\b/ },
];

export function detectCommand(cmd: string): DetectResult {
  const segments = cmd.split(/\s*(?:&&|\|\||;|\r?\n)\s*/).filter(Boolean);
  for (const seg of segments) {
    for (const p of PATTERNS) {
      if (!p.re.test(seg)) continue;
      if (p.exclude?.test(seg)) continue;
      return { matched: true, subcommand: p.sub, segment: seg.trim() };
    }
  }
  return { matched: false };
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `bun test tests/detect.test.ts`
Expected: 全部 PASS

- [ ] **Step 7: 安装依赖并提交**

```bash
npm install
git add package.json tsconfig.json .gitignore LICENSE src/types.ts src/core/detect.ts tests/detect.test.ts package-lock.json
git commit -m "feat: 项目脚手架 + 丢弃命令识别（分段匹配，含 switch/stash drop）"
```

---

### Task 2: src/core/git.ts — git 封装

**Files:**
- Create: `src/core/git.ts`
- Test: `tests/git.test.ts`

**Interfaces:**
- Produces: `inRepo(cwd): string | null`（返回 repoRoot）、`execGit(args, cwd): string`、`getDiff(repoRoot): string`、`getDiffStat(repoRoot): string | null`、`listUntracked(repoRoot): string[]`、`listStashes(repoRoot): { ref: string; message: string }[]`、`getStashPatch(repoRoot, ref): string`

- [ ] **Step 1: 写测试辅助 tests/helpers.ts（临时 git 仓库）**

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsg-test-"));
  const git = (args: string[], cwd = dir) =>
    execFileSync("git", args, { cwd, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@test.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(dir, "a.txt"), "hello\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  return dir;
}

export function writeIn(dir: string, rel: string, content: string) {
  const p = join(dir, rel);
  mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
  writeFileSync(p, content);
}
```

- [ ] **Step 2: 写失败测试 tests/git.test.ts**

```ts
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
    expect(listUntracked(repo).sort()).toEqual(["sub/u2.txt", "u1.txt"]);
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
```

- [ ] **Step 3: 运行确认失败**

Run: `bun test tests/git.test.ts`
Expected: FAIL

- [ ] **Step 4: 实现 src/core/git.ts**

```ts
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
```

- [ ] **Step 5: 运行确认通过，提交**

Run: `bun test tests/git.test.ts` → PASS

```bash
git add src/core/git.ts tests/git.test.ts tests/helpers.ts
git commit -m "feat: core/git.ts — diff/untracked/stash 封装"
```

---

### Task 3: src/core/backup.ts — 生成备份产物

**Files:**
- Create: `src/core/backup.ts`
- Test: `tests/backup.test.ts`

**Interfaces:**
- Consumes: Task 2 全部 git 函数、`detectCommand`
- Produces: `createBackup(cwd: string, opts: { triggerCommand: string; agent: Manifest["agent"]; backupRoot?: string }): BackupResult | null`；`buildNote(dir: string | null): string`

- [ ] **Step 1: 写失败测试 tests/backup.test.ts**

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/backup.test.ts` → FAIL

- [ ] **Step 3: 实现 src/core/backup.ts**

```ts
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

- [ ] **Step 4: 运行确认通过，提交**

Run: `bun test tests/backup.test.ts` → PASS

```bash
git add src/core/backup.ts tests/backup.test.ts
git commit -m "feat: core/backup.ts — diff/untracked/stash 备份产物 + manifest"
```

---

### Task 4: src/core/restore.ts — 恢复与列表

**Files:**
- Create: `src/core/restore.ts`
- Test: `tests/restore.test.ts`

**Interfaces:**
- Consumes: `createBackup`、`execGit`、`inRepo`
- Produces: `listBackups(backupRoot?: string): { dir: string; timestamp: string; cwd: string; summary: string }[]`、`restoreBackup(target: string, opts: { dryRun?: boolean; force?: boolean; backupRoot?: string }): RestoreResult`

```ts
export interface RestoreResult {
  backupDir: string;
  applied: boolean;          // dryRun 时 false
  restoredUntracked: string[];
  skippedExisting: string[];
  selfBackupDir: string | null; // 恢复前自保备份
}
```

- [ ] **Step 1: 写失败测试 tests/restore.test.ts**

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/restore.test.ts` → FAIL

- [ ] **Step 3: 实现 src/core/restore.ts**

```ts
import { readdirSync, readFileSync, existsSync, mkdirSync, cpSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { Manifest } from "../types.js";
import { execGit, inRepo, listUntracked } from "./git.js";
import { createBackup } from "./backup.js";

export interface RestoreResult {
  backupDir: string;
  applied: boolean;
  restoredUntracked: string[];
  skippedExisting: string[];
  selfBackupDir: string | null;
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

  // 1. 自保备份（恢复动作本身也可能是丢弃）
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

  // 2. patch 应用：先 --check 再 apply，失败整体中止
  const patchPath = join(dir, "diff.patch");
  let applied = false;
  if (existsSync(patchPath)) {
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

  // 3. untracked 复制回（不覆盖已存在，除非 --force）
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
      mkdirSync(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
      cpSync(src, dest);
      restoredUntracked.push(rel);
    }
  }

  return { backupDir: dir, applied, restoredUntracked, skippedExisting, selfBackupDir };
}
```

- [ ] **Step 4: 运行全部测试确认通过，提交**

Run: `bun test` → PASS

```bash
git add src/core/restore.ts tests/restore.test.ts
git commit -m "feat: core/restore.ts — 自保备份 + patch 原子应用 + untracked 回填"
```

---

### Task 5: CLI 入口 — hook + restore/list 子命令

**Files:**
- Create: `src/cli/main.ts`（bin，含 shebang）
- Create: `src/cli/hook.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `detectCommand`、`createBackup`、`buildNote`、`restoreBackup`、`listBackups`
- Produces: bin `git-safety-guard`，子命令 `hook` / `restore <latest|timestamp> [--dry-run] [--force]` / `list`

- [ ] **Step 1: 写失败测试 tests/cli.test.ts（子进程喂 stdin）**

```ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempRepo, writeIn } from "./helpers.js";
import { createBackup } from "../src/core/backup.js";

function runHook(payload: unknown, cwd: string): { stdout: string; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync(["bun", "run", new URL("../src/cli/main.ts", import.meta.url).pathname, "hook"], {
    input: JSON.stringify(payload),
    cwd,
  });
  return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), exitCode: proc.exitCode ?? 0 };
}

describe("hook", () => {
  test("Claude payload：命中 → JSON 输出 allow + reason，exit 0", () => {
    const repo = makeTempRepo();
    writeIn(repo, "a.txt", "changed\n");
    const r = runHook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git reset --hard" }, cwd: repo },
      repo,
    );
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("git-guard");
  });

  test("未命中命令：无备份，输出空 stdout，exit 0", () => {
    const repo = makeTempRepo();
    const r = runHook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" }, cwd: repo },
      repo,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("非法 stdin：fail-open，exit 0", () => {
    const proc = Bun.spawnSync(["bun", "run", new URL("../src/cli/main.ts", import.meta.url).pathname, "hook"], {
      input: "not json",
      cwd: "/tmp",
    });
    expect(proc.exitCode).toBe(0);
  });

  test("Codex payload（turn_id）：stderr 提示，exit 0", () => {
    const repo = makeTempRepo();
    writeIn(repo, "a.txt", "changed\n");
    const r = runHook({ turn_id: "t1", input: { command: "git checkout -- ." }, cwd: repo }, repo);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("git-guard");
    expect(r.stdout.trim()).toBe("");
  });
});

describe("restore 子命令", () => {
  test("restore latest 恢复并输出摘要", () => {
    const repo = makeTempRepo();
    writeIn(repo, "a.txt", "modified\n");
    const b = createBackup(repo, { triggerCommand: "git reset --hard", agent: "claude", backupRoot: process.env.GIT_SAFETY_GUARD_BACKUP_ROOT = mkdtempSync(join(tmpdir(), "gsg-cli-")) })!;
    writeFileSync(join(repo, "a.txt"), "hello\n"); // 模拟丢弃已发生（HEAD 内容）
    const proc = Bun.spawnSync(
      ["bun", "run", new URL("../src/cli/main.ts", import.meta.url).pathname, "restore", "latest"],
      { cwd: repo, env: { ...process.env, GIT_SAFETY_GUARD_BACKUP_ROOT: b.dir.split("/").slice(0, -1).join("/") } },
    );
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("a.txt");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toContain("modified");
  });
});

import { writeFileSync, readFileSync } from "node:fs";
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test tests/cli.test.ts` → FAIL

- [ ] **Step 3: 实现 src/cli/hook.ts**

```ts
import { readFileSync } from "node:fs";
import { detectCommand } from "../core/detect.js";
import { createBackup, buildNote } from "../core/backup.js";
import type { Manifest } from "../types.js";

/** 识别 hook 来源 */
function detectAgent(payload: Record<string, unknown>): Manifest["agent"] {
  if (payload.hook_event_name === "PreToolUse") return "claude";
  if ("turn_id" in payload) return "codex";
  return "unknown";
}

function extractCommand(payload: Record<string, unknown>): string {
  const ti = payload.tool_input as Record<string, unknown> | undefined;
  if (ti && typeof ti.command === "string") return ti.command;
  const input = payload.input as Record<string, unknown> | undefined;
  if (input && typeof input.command === "string") return input.command;
  return "";
}

export function runHook(): number {
  try {
    const raw = readFileSync(0, "utf8");
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw);
    } catch {
      return 0; // fail-open
    }
    const cmd = extractCommand(payload);
    const result = detectCommand(cmd);
    if (!result.matched) return 0;

    const agent = detectAgent(payload);
    const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
    const backup = createBackup(cwd, { triggerCommand: cmd, agent });
    const note = buildNote(backup?.dir ?? null);

    if (process.env.GIT_SAFETY_GUARD_QUIET === "1") return 0; // 备份已做，不出提示
    if (agent === "claude") {
      const out = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: note,
        },
      };
      process.stdout.write(JSON.stringify(out));
    } else {
      // Codex / 未知来源：stderr 提示（模型不可见也不阻断），stdout 保持空
      if (process.env.GIT_SAFETY_GUARD_QUIET !== "1") process.stderr.write(note + "\n");
    }
    return 0;
  } catch {
    return 0; // fail-open：任何异常都放行
  }
}
```

- [ ] **Step 4: 实现 src/cli/main.ts（含 shebang）**

```ts
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
      if (dryRun) console.log("(dry-run) 未做任何修改");
      else {
        if (r.applied) console.log("diff.patch 已应用");
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
```

- [ ] **Step 5: 运行确认通过，提交**

Run: `bun test tests/cli.test.ts` → PASS

```bash
git add src/cli/hook.ts src/cli/main.ts tests/cli.test.ts
git commit -m "feat: CLI 入口 — hook（fail-open）/ restore / list 子命令"
```

---

### Task 6: pi 入口扩展

**Files:**
- Create: `src/pi/index.ts`

**Interfaces:**
- Consumes: `detectCommand`、`createBackup`、`buildNote`
- Produces: pi 扩展 default export；`buildWorkerWarning(): string | null`（导出供测试）

- [ ] **Step 1: 实现 src/pi/index.ts**

```ts
//! git-safety-guard pi 扩展：tool_call 前备份，tool_result 后挂提示
import { execFileSync } from "node:child_process";
import { detectCommand } from "../core/detect.js";
import { createBackup, buildNote } from "../core/backup.js";

/** 并行 worker 检测（默认关，GIT_SAFETY_GUARD_WORKER_DETECT=1 开启） */
export function buildWorkerWarning(): string | null {
  if (process.env.GIT_SAFETY_GUARD_WORKER_DETECT !== "1") return null;
  try {
    const out = execFileSync("ps", ["-axo", "pid,command"], { encoding: "utf8" });
    const cwdTag = process.cwd().replaceAll("/", "-").replace(/^-/, "--");
    const others = out
      .split("\n")
      .filter((l) => /pi\b.*--mode rpc/.test(l))
      .filter((l) => !l.startsWith(String(process.pid)))
      .filter((l) => l.includes(cwdTag));
    if (others.length === 0) return null;
    return `git-guard: 检测到 ${others.length} 个同项目并行 pi worker（可能正在写文件）：\n${others.join("\n")}\n丢弃型 git 操作前请确认 worker 已停止。`;
  } catch {
    return null;
  }
}

export default function gitSafetyGuard(pi: {
  on(event: string, handler: (event: any, ctx: any) => any): void;
}) {
  const pending = new Map<string, string>(); // toolCallId → note

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const cmd: string = event.input?.command ?? "";
    if (!detectCommand(cmd).matched) return;
    try {
      const cwd = ctx?.cwd ?? process.cwd();
      const backup = createBackup(cwd, { triggerCommand: cmd, agent: "pi" });
      pending.set(event.toolCallId, backup?.note ?? buildNote(null));
    } catch {
      // fail-open：备份失败不阻断
    }
  });

  pi.on("tool_result", async (event) => {
    const note = pending.get(event.toolCallId);
    if (!note) return;
    pending.delete(event.toolCallId);
    if (process.env.GIT_SAFETY_GUARD_QUIET === "1") return;
    return { content: [...(event.content ?? []), { type: "text", text: note }] };
  });

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return;
    const warning = buildWorkerWarning();
    if (warning) ctx?.ui?.notify?.(warning, "warning");
  });
}
```

- [ ] **Step 2: 写 buildWorkerWarning 的最小单测 tests/pi.test.ts**

```ts
import { describe, test, expect } from "bun:test";
import { buildWorkerWarning } from "../src/pi/index.js";

describe("buildWorkerWarning", () => {
  test("默认关闭返回 null", () => {
    delete process.env.GIT_SAFETY_GUARD_WORKER_DETECT;
    expect(buildWorkerWarning()).toBeNull();
  });
});
```

Run: `bun test tests/pi.test.ts` → PASS

- [ ] **Step 3: 手动验证 pi 加载（真机冒烟）**

```bash
cd ~/IDE/ai-agent/llm-proxy   # 任一 git 仓库
pi -e /Users/fengshuai/IDE/ai-agent/ai-agent-plugin/git-safety-guard
# 会话中执行: git checkout -- <某有改动文件>
# 预期：tool_result 末尾出现 [git-guard] ⚠️ 备份提示；~/.git-safety-guard/backups/ 出现新目录
```

- [ ] **Step 4: 全量测试 + 提交**

```bash
bun test
git add src/pi/index.ts tests/pi.test.ts
git commit -m "feat: pi 扩展入口 — tool_call 备份 + tool_result 提示 + worker 检测（默认关）"
```

---

### Task 7: 构建、README、发布准备

**Files:**
- Create: `README.md`
- Modify: `package.json`（确认 build 产物可执行）

- [ ] **Step 1: tsc 构建并验证 bin**

```bash
npm run build
node dist/cli/main.js list   # 输出（无备份）或列表，exit 0
chmod +x dist/cli/main.js    # tsc 不保留执行位，npm bin 会自动处理，但本地直跑需要
```

Expected: `list` 正常输出。

- [ ] **Step 2: 写 README.md**

内容结构（必须包含）：
1. 一句话定位 + 哲学（备份后放行，可能该丢、但绝不无声丢）
2. 三种安装用法：
   - pi：`pi install npm:git-safety-guard`
   - Claude Code hooks 配置 JSON（`"command": "git-safety-guard hook"`，matcher Bash）
   - Codex hooks.json 配置
3. 覆盖的命令表（checkout/restore/switch -f/reset --hard/clean -f/stash drop/clear）
4. restore/list 用法与恢复语义（自保备份 → apply → untracked 回填不覆盖）
5. 环境变量表（BACKUP_ROOT / QUIET / WORKER_DETECT）
6. 局限（fail-open、引号内误报、不重建 stash 栈）

- [ ] **Step 3: npm pack 预检**

```bash
npm pack --dry-run
```

Expected: 包含 src/ dist/ README.md LICENSE，不含 node_modules/tests。

- [ ] **Step 4: 全量测试 + 提交**

```bash
bun test
git add README.md package-lock.json
git commit -m "docs: README — 三种安装用法 + 恢复说明"
```

- [ ] **Step 5: 发布（需用户确认后执行）**

```bash
gh repo create FnSGit/git-safety-guard --public --source . --push
npm publish        # 先 npm pack --dry-run 已确认
```

注意：npm publish 前确认 `.npmrc` 代理可用；GitHub 推送走 socks5 代理（.gitconfig 已配）。
