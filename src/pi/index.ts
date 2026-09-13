//! git-safety-guard pi 扩展：tool_call 前备份，tool_result 后挂提示
import { execFileSync } from "node:child_process";
import { detectCommand, resolveCwdForCommand } from "../core/detect.js";
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
      const sessionCwd = ctx?.cwd ?? process.cwd();
      const cwd = resolveCwdForCommand(cmd, sessionCwd);
      const backup = createBackup(cwd, { triggerCommand: cmd, agent: "pi" });
      pending.set(event.toolCallId, backup?.note ?? buildNote(null));
    } catch (e) {
      // M5：fail-open 留痕（不阻断，不改工具输入）
      process.stderr.write(`[git-guard] 备份失败（已放行）: ${e}\n`);
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
