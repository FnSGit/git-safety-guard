# git-safety-guard

> **备份后放行的 git 安全守卫** — 丢弃型 git 命令执行前自动备份 diff + untracked + stash，然后放行。可能该丢、但**绝不无声丢**。

同类工具分两派：阻断型（dcg、codex-safeguard 等，PreToolUse 拒绝危险命令）和快照型（cowback、git-rewind，每回合全量快照）。本工具走第三条路——让命令照跑，事前留底，可恢复。

## 安装与启用

### 1. pi（原生扩展）

```bash
pi install npm:git-safety-guard
```

包内 `package.json` 通过 `pi.extensions` 自动声明，启用后立即生效，无需额外配置。

### 2. Claude Code（PreToolUse hook）

在 `~/.claude/settings.json`（项目级则 `.claude/settings.json`）的 `hooks.PreToolUse` 加入：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "git-safety-guard hook"
          }
        ]
      }
    ]
  }
}
```

### 3. Codex（hooks.json）

在 `.codex/hooks.json` 加入类似配置（事件名与字段名以 Codex 当前文档为准——本工具消费 `PreToolUse` 的 `tool_input.command` 或 `input.command`，可识别 `turn_id` 字段以判定 Codex 来源）：

```json
{
  "hooks": [
    {
      "event": "PreToolUse",
      "command": "git-safety-guard hook"
    }
  ]
}
```

未知来源 payload 一律 fail-open：stdout 留空、stderr 写一行提示、exit 0。

## 覆盖的丢弃命令

| 命令 | 说明 |
|---|---|
| `git checkout <path>` / `git checkout HEAD -- <path>` / `git checkout -- <path>` / `git checkout <sha> -- <path>` / `git checkout .` | 还原路径 |
| `git checkout <branch-or-sha>` / `git checkout -f <branch-or-sha>` | 切分支（含 force） |
| `git restore <path>` / `git restore .` | 丢弃 working tree |
| `git switch -f` / `git switch --discard-changes` | 强制切换 |
| `git reset --hard [<commit>]` | 硬重置 |
| `git clean -f` / `git clean -fd` / `git clean -fdx` | 删除未跟踪文件 |
| `git stash drop [stash@{N}]` / `git stash clear` | 破坏 stash |

**复合命令**按 `&&` / `||` / `;` / 换行切段后匹配（`cd /tmp && git reset --hard` 会命中）。

**显式排除**：`git restore --staged`、`git checkout -b`、`git stash pop` / `apply` / `branch`、`git reset`（软/mixed）、`git branch -D`（不在 v0.1 范围）。

## 恢复与列表

```bash
git-safety-guard list                  # 列出所有备份（时间戳 / cwd / 改动量摘要）
git-safety-guard restore latest        # 恢复最近一次备份
git-safety-guard restore 2026-09-13T20-30-00-123Z
git-safety-guard restore latest --dry-run
git-safety-guard restore latest --force   # untracked 回填时覆盖已存在文件
```

**恢复语义**（diff.patch 任何失败整体中止，不部分修改；stash/untracked 跳过而非中止）：

1. 对当前状态再做一次自保备份（恢复动作本身也可能丢弃改动；即使 `--dry-run` 也会生成，落在 `BACKUP_ROOT`，不触碰仓库）
2. `git apply --check` 校验 `diff.patch`，失败则中止并报告自保目录
3. `git apply` 应用 diff.patch
4. 对 `stash/` 下每个 stash patch 依次 `--check`：`git apply` 回填到工作树（不重建 `git stash list`）；冲突的 patch 跳过并在摘要中报告
5. 把 `untracked/` 下文件复制回仓库相对路径；**已存在的同名文件默认跳过**，`--force` 才覆盖

**`--dry-run`**：完全不动仓库文件（diff.patch / untracked / stash 全部不写）；仍会做一次自保备份（守卫自身保护）；输出预览"将恢复 / 将应用 / 将跳过"。

恢复不重建 stash 栈——`stash/` 下的 patch 以 `git apply` 回填到工作树。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `GIT_SAFETY_GUARD_BACKUP_ROOT` | `~/.git-safety-guard/backups/` | 备份根目录，pi 与 CLI 共用 |
| `GIT_SAFETY_GUARD_QUIET` | 未设 | 设为 `1` 关闭提示输出（备份照做，可用 `list` 查询） |
| `GIT_SAFETY_GUARD_WORKER_DETECT` | 未设 | 设为 `1` 开启并行 pi RPC worker 检测（仅 pi 入口，会话启动时 `ctx.ui.notify` 提示） |

## 备份产物

每次丢弃命令触发后，在 `BACKUP_ROOT/<ISO 时间戳>/` 生成：

```
<ISO 时间戳>/
├─ diff.patch          # git diff + git diff --staged（untracked 不在其中）
├─ untracked/          # ls-files --others --exclude-standard 逐个复制
│  └─ <仓库相对路径原样>
├─ stash/              # 仅 stash drop / stash clear 触发
│  └─ stash-N.patch    # git stash show -p --include-untracked stash@{N}
└─ manifest.json       # {timestamp, cwd, repoRoot, triggerCommand, agent,
                       #  diffStat, untrackedFiles, untrackedTruncated,
                       #  stashRefs, stashList, versions}
```

`untracked` 超过 500 个文件时只备份清单不复制内容，`manifest.untrackedTruncated: true`。备份目录无自动清理——`list` 暴露数量，可手动 `rm -rf` 旧条目。

## 局限

- **fail-open**：备份失败 / 解析失败 / 任何异常一律放行原命令并 exit 0。本工具是备份器不是闸门，阻断失败后果比备份失败更重。如果你需要硬阻断，请搭配 dcg 等阻断型工具。
- **不做 shell 解析**：引号内文本可能误报（如 `echo "git reset --hard"`）。误报成本仅为多做一次空备份，可接受。如需严格语义，请改造 `src/core/detect.ts` 的分段逻辑。
- **恢复不重建 stash 栈**：`stash/` 下的 patch 以 `git apply` 还原到工作树，不会恢复 `git stash list` 中的条目。如需重建栈，属 v0.2 范围。
- **并行 pi worker 污染**：默认关闭 worker 检测；开启后会话启动时 `ctx.ui.notify` 提示同 cwd 的 `pi --mode rpc` 进程，但需你自行确认 worker 已停止（ps 扫描依赖 BSD `ps` 字段格式，Linux 下需自行验证）。
- **覆盖范围仅 git 丢弃类**：本工具不管 `rm -rf`、非 git 命令、shell 注入等更广泛的风险面。

## 许可证

MIT — Copyright (c) 2026 FnSGit