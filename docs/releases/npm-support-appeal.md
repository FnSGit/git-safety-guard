# npm 账号申诉模板

> 用途：npm 账号 `blunt.f` 发布 `git-safety-guard@0.1.0` 时持续报
> `403 Your account has been temporarily suspended due to a recent security-sensitive action`
> （2026-09-29 起，已持续 2 天）。2FA 认证本身成功，PUT 被账号层拒绝。
>
> 提交入口：https://www.npmjs.com/support （选 "Account Suspensions / Bans" 或
> "Publishing / Packages"）。

## 建议正文（按需删改）

Hi npm support team,

My account `blunt.f` (email xiaofan1219@outlook.com, verified; 2FA enabled = auth-and-writes; GitHub: FnSGit) returns the following error when I try to publish a new, original package:

```
npm error code E403
npm error 403 Forbidden - PUT https://registry.npmjs.org/git-safety-guard - Your account has been temporarily suspended due to a recent security-sensitive action.
```

This has persisted since 2026-09-29 (2+ days). The 2FA web-authentication step completes successfully; the suspension blocks only the write (PUT).

**About the package:** `git-safety-guard` is an open-source developer-tooling package — a "backup-then-allow" safety guard for AI coding agents (pi / Claude Code / Codex). When an agent runs a discarding git command (`git checkout --`, `git restore`, `git reset --hard`, `git clean -f`, `git stash drop`), the tool backs up the current diff + untracked files + stashes to `~/.git-safety-guard/backups/` *before* letting the command run, so discarded changes are recoverable. Source (public): https://github.com/FnSGit/git-safety-guard — 87 unit tests, zero runtime dependencies, MIT license.

**What may have triggered the flag:** I am based in China and publish through a local proxy (socks5). The account was created 2026-07-26 and this is its first publish of a brand-new package; a login from a proxy exit IP followed immediately by a publish of a fresh package name likely matched an automated abuse pattern. There is no malicious content, no dependency confusion, no postinstall script, no network calls at install or runtime.

**Request:** Please review and lift the account suspension so I can publish `git-safety-guard@0.1.0`. Happy to provide any additional verification (identity, package review) you need.

Thank you.

## 附：检查清单（提交前自查）

- [ ] 登录 https://www.npmjs.com 看是否有横幅要求"验证身份 / 重置 2FA"
- [ ] 查收 xiaofan1219@outlook.com 的 npm 邮件（含垃圾箱）——封禁/验证通知常发邮件
- [ ] 若有"Recent security-sensitive action"具体说明，按邮件指引完成
- [ ] 提交工单后 1–2 个工作日留意回复

## 提交后

解封后一条命令即可正式发布（包与 bin 已修复就绪）：

```bash
cd ~/IDE/ai-agent/ai-agent-plugin/git-safety-guard
npm publish
```
