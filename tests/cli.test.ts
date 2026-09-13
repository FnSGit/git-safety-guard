import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempRepo, writeIn } from "./helpers.js";
import { createBackup } from "../src/core/backup.js";

/**
 * 通过 async Bun.spawn + stdin:"pipe" 显式 write+end 传递 stdin。
 * 背景：Bun.spawnSync({input}) 在当前 Bun 版本下不向子进程 stdin 传递内容
 * （无论子进程是 bun 还是 node，readFileSync(0)/process.stdin 都读不到）。
 * async Bun.spawn + 手动写管道可绕过该 quirk。
 */
async function runHook(payload: unknown, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const main = new URL("../src/cli/main.ts", import.meta.url).pathname;
  const proc = Bun.spawn(["bun", "run", main, "hook"], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode: exitCode ?? 0 };
}

describe("hook", () => {
  test("Claude payload：命中 → JSON 输出 allow + reason，exit 0", async () => {
    const repo = makeTempRepo();
    writeIn(repo, "a.txt", "changed\n");
    const r = await runHook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git reset --hard" }, cwd: repo },
      repo,
    );
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("git-guard");
  });

  test("未命中命令：无备份，输出空 stdout，exit 0", async () => {
    const repo = makeTempRepo();
    const r = await runHook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" }, cwd: repo },
      repo,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("非法 stdin：fail-open，exit 0", async () => {
    const main = new URL("../src/cli/main.ts", import.meta.url).pathname;
    const proc = Bun.spawn(["bun", "run", main, "hook"], { cwd: "/tmp", stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write("not json");
    proc.stdin.end();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });

  test("Codex payload（turn_id）：stderr 提示，exit 0", async () => {
    const repo = makeTempRepo();
    writeIn(repo, "a.txt", "changed\n");
    const r = await runHook({ turn_id: "t1", input: { command: "git checkout -- ." }, cwd: repo }, repo);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("git-guard");
    expect(r.stdout.trim()).toBe("");
  });
});

describe("restore 子命令", () => {
  test("restore latest 恢复并输出摘要", async () => {
    const repo = makeTempRepo();
    writeIn(repo, "a.txt", "modified\n");
    const backupRoot = mkdtempSync(join(tmpdir(), "gsg-cli-"));
    const b = createBackup(repo, { triggerCommand: "git reset --hard", agent: "claude", backupRoot })!;
    writeFileSync(join(repo, "a.txt"), "hello\n"); // 模拟丢弃已发生（HEAD 内容）
    const main = new URL("../src/cli/main.ts", import.meta.url).pathname;
    const proc = Bun.spawn(["bun", "run", main, "restore", "latest"], {
      cwd: repo,
      env: { ...process.env, GIT_SAFETY_GUARD_BACKUP_ROOT: backupRoot },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout).toContain("a.txt");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toContain("modified");
  });
});

import { writeFileSync, readFileSync } from "node:fs";
