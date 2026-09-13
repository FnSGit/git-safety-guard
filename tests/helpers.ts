import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export function makeTempRepo(): string {
  // realpath：macOS 下 tmpdir() 是 /var → /private/var 符号链接，git 报解析后的真实路径
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gsg-test-")));
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
