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
