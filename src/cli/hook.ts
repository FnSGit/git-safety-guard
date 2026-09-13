import { detectCommand, resolveCwdForCommand } from "../core/detect.js";
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

/** 流式读尽 stdin（兼容 Node 与 Bun；readFileSync(0) 在 Bun.spawnSync 管道下读空） */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let d = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { d += String(c); });
    process.stdin.on("end", () => resolve(d));
    process.stdin.on("error", () => resolve(d));
  });
}

export async function runHook(): Promise<number> {
  try {
    const raw = await readStdin();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw);
    } catch {
      return 0; // fail-open：解析失败放行
    }
    const cmd = extractCommand(payload);
    const result = detectCommand(cmd);
    if (!result.matched) return 0;

    const agent = detectAgent(payload);
    const sessionCwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
    const cwd = resolveCwdForCommand(cmd, sessionCwd);
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
      process.stderr.write(note + "\n");
    }
    return 0;
  } catch {
    return 0; // fail-open：任何异常都放行
  }
}
