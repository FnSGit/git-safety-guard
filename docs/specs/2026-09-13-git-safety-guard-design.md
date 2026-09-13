# git-safety-guard 设计文档（v0.2）

- 日期：2026-09-13
- 状态：待评审（v0.2：补全 detect 规格 / stash 范围 / types / hook 契约）
- 作者：fengshuai（AI 辅助起草）

## 1. 背景与动机

2026-08-29 llm-proxy 项目事故：批量 `git checkout HEAD -- <多文件>` 排雷并行
worker 污染时，把未 commit 的改动一并还原丢失。事后沉淀了一个 pi 扩展
`git-safety-guard`（私有目录 `~/.pi/agent/extensions/git-safety-guard/`），
在丢弃型 git 命令执行前自动备份当前 diff，多次避免了改动丢失。

用户决定将该扩展打磨、扩展能力后公开发布：

- 形态 1：pi 原生扩展（`pi install` 可装的 pi 包）
- 形态 2：通用 CLI / PreToolUse hook（Claude Code、Codex 等皆可接）
- 新项目位置：`~/IDE/ai-agent/ai-agent-plugin/git-safety-guard/`
- 同步到 GitHub（用户：`FnSGit`）

## 2. 核心哲学：备份后放行（backup-then-allow）

市场同类工具分两派，本工具走第三条路：

| 流派 | 代表 | 做法 | 本工具立场 |
|---|---|---|---|
| 阻断型（deny） | dcg、codex-safeguard、agent-guard、airlock | PreToolUse 拒绝危险命令，要求人工介入 | ✗ 过硬，agent 合法排雷场景被卡 |
| 快照型（snapshot） | cowback、git-rewind、ckpt | 周期性/每回合全量快照，事后回滚 | ✗ 重，非本工具范围 |
| **备份后放行** | **git-safety-guard（本工具）** | **让命令照跑，执行前静默备份 diff + untracked 到 patch 目录，并在输出挂提示** | ✓ 差异化定位 |

原则：**可能该丢、但绝不无声丢**。命令不阻断（agent 确有合法清理场景），
但任何丢弃动作发生前，必有一份可恢复的备份存在。

## 3. 目标

1. 单一 npm 包 `git-safety-guard`，双入口共享同一 core：
   - pi 原生扩展（`ExtensionAPI` + `tool_call` 事件，进程内调用）
   - 通用 CLI（stdin/stdout PreToolUse hook 协议 + `restore` 子命令）
2. 备份范围无死角：staged diff + unstaged diff + **untracked 文件实体备份**
3. 备份产物自描述（manifest），提供 `restore` 一键恢复
4. 丢弃命令识别覆盖 git 全部丢弃变体
5. 可配置：备份根目录、提示开关、并行 worker 检测开关
6. 发布到 npm，源码同步 GitHub `FnSGit/git-safety-guard`
7. 单测覆盖核心路径（识别 / 备份 / 恢复 round-trip）

## 4. 非目标（YAGNI）

- 不做 50+ 安全包的全面危险命令拦截（dcg 的范围；本工具只管 git 丢弃类）
- 不做进程内 hook 注入、MCP server、PATH shim（airlock 的范围）
- 不做 SIMD/二进制性能优化（调用频率低，JS 足够）
- 不做周期性自动快照（cowback/git-rewind 的范围；本工具只在丢弃命令触发时备份）
- 不覆盖非 git 仓库场景（无 git 则直接放行）
- v0.1 不做 `git stash` 之外的智能合并恢复策略——恢复就是 patch apply + 文件复制回

## 5. 架构：单包双入口（方案 1）

```
┌─────────────────────────────────────────────┐
│                  core/（纯函数）              │
│  detect.ts   丢弃命令识别（正则，无 IO）        │
│  backup.ts   生成备份产物（写 diff.patch /     │
│              untracked/ / manifest.json）     │
│  restore.ts  从备份产物恢复                    │
│  git.ts      git 子命令封装（rev-parse/diff/   │
│              ls-files，execFileSync）         │
└──────────────┬──────────────────────────────┘
               │
     ┌─────────┴─────────┐
     ▼                   ▼
┌──────────┐      ┌──────────────┐
│ pi/      │      │ cli/         │
│ 入口：    │      │ 入口：        │
│ tool_call│      │ PreToolUse   │
│ 事件拦截  │      │ stdin→stdout │
│ +restore │      │ +restore 子命令│
└──────────┘      └──────────────┘
```

- core 不感知 pi 或 Claude 的运行时差异，只做"识别 → 备份 → 返回提示文案"。
- pi 入口把提示注入 `tool_result`；CLI 入口把提示打 stderr / 塞进 hook 输出。

## 6. 目录结构

```
git-safety-guard/
├─ package.json        # name: git-safety-guard, bin, pi manifest, pi-package keyword
├─ README.md
├─ LICENSE             # MIT
├─ .gitignore
├─ tsconfig.json
├─ src/
│  ├─ core/
│  │  ├─ detect.ts     # detectCommand(cmd): DetectResult（纯函数，分段匹配）
│  │  ├─ backup.ts     # createBackup(cwd, opts): BackupResult | null
│  │  ├─ restore.ts    # restoreBackup(backupDir | "latest", opts)
│  │  └─ git.ts        # inRepo / getDiff / listUntracked / execGit
│  ├─ pi/
│  │  └─ index.ts      # export default (pi: ExtensionAPI) => {...}
│  ├─ cli/
│  │  ├─ hook.ts       # PreToolUse 入口：读 stdin，识别，备份，输出
│  │  └─ main.ts       # bin 入口：分发 hook / restore 子命令
│  └─ types.ts         # BackupResult / Manifest / Options
├─ tests/
│  ├─ detect.test.ts
│  ├─ backup.test.ts
│  └─ restore.test.ts
└─ docs/
   └─ specs/           # 本文件
```

## 7. 设计决策

### 7.1 命名

- npm 包名 / GitHub 仓库：`git-safety-guard`（无 `pi-` 前缀，通用 CLI 是一等公民）
- pi 扩展以包内 manifest 声明，pi 用户 `pi install npm:git-safety-guard` 即装

### 7.2 备份产物结构

```
~/.git-safety-guard/backups/          # 默认 backupRoot，可配置
└─ 2026-09-13T20-30-00-000Z/
   ├─ diff.patch          # git diff + git diff --staged 拼接（含 header 注释）
   ├─ stash/              # 仅 stash 破坏类命令触发：每个 stash 一个 patch
   │  └─ stash-0.patch    # git stash show -p --include-untracked stash@{N}
   ├─ untracked/          # git ls-files --others --exclude-standard 逐个复制
   │  └─ <仓库相对路径原样>
   └─ manifest.json
```

- **stash 备份语义**：`git stash drop [stash@{N}]` 备份目标 stash（缺省 N=0）；
  `git stash clear` 备份全部 stash（遍历 `git stash list`）。manifest 记录备份前
  的完整 `stash list`（含 message），恢复时 `git apply stash-N.patch` 还原到
  工作树（不重建 stash 栈——重建属 v0.2 范围）。`git stash pop` 成功即已应用、
  失败不丢 stash，两态均无损失，**不识别**。

- **不再写 `/tmp`**（重启清空风险）；默认 root `~/.git-safety-guard/backups/`
- `backupRoot` 可通过环境变量 `GIT_SAFETY_GUARD_BACKUP_ROOT` 覆盖（pi 与 CLI 共用）
- 同秒多次触发：时间戳加 `-ms` 后缀去重，不覆盖已有目录
- 空 diff 且无 untracked 且无 stash → 不生成备份目录（返回 null），提示"无可备份改动"

### 7.3 丢弃命令识别（detect.ts）

**分段规则（正式）**：先按 `&&` / `\|\|` / `;` / 换行把整条命令切分为段，
逐段匹配下表。这保证 `cd x && git reset --hard` 命中、而 `echo "git reset --hard"`
中引号内的文本因不构成独立段中的 git 子命令形态而误报率可控（仍可能误报，
接受——备份无副作用，误报成本低；不做 shell 解析，KISS）。

| 命令 | 说明 |
|---|---|
| `git checkout HEAD -- <path>` / `git checkout -- <path>` / `git checkout <sha> -- <path>` | 还原路径 |
| `git checkout <ref> <path>`（不带 `--`） | 还原路径（v0.1 新增：e.g. `git checkout main src/`） |
| `git checkout <branch-or-sha>`（不带 `-b`） | 切分支（冲突时可能要求清理；留底无妨） |
| `git checkout -f <branch-or-sha>` / `git checkout .` / `git checkout -- .` | 强制切换 / worktree 全量丢弃 |
| `git restore <path>` / `git restore .`（不带 `--staged`） | 丢弃 working tree |
| `git switch --discard-changes [...]` / `git switch -f [...]` | 强制切换，丢弃本地改动 |
| `git reset --hard [<commit>]` | 硬重置 |
| `git clean -f[d|x]` / `git clean --force` / `git clean --force -d` | 删除未跟踪文件（v0.1 新增 `--force`） |
| `git stash drop [stash@{N}]` / `git stash clear` | 破坏 stash（v0.1 新增，见 7.2） |

未覆盖（v0.2 候选）：选项顺序变体如 `git reset -q --hard`、`git switch --force <branch>`、
未在表格的 `--force`-style long options。

不识别为丢弃型（放行且不备份）：`git restore --staged`、`git reset`（软/mixed）、
`git checkout -b`、`git stash pop`/`stash apply`、`git stash branch`
（内容已落地分支）、`git branch -D`（v0.1 范围外，见非目标）。

**返回值**：`detectCommand` 返回 `DetectResult`（见 7.8），命中时携带
`subcommand` 与命中段文本，供提示文案与 manifest 使用；未命中返回 `{ matched: false }`。

**cd 前缀解析（v0.1 新增）**：丢弃动作实际发生的目录由**命中段之前**的
最后一个 `cd <dir>` 段决定。实现位于 `resolveCwdForCommand(cmd, sessionCwd)`
（与 `detectCommand` 复用 `splitSegments`）。支持引号包裹与 `~/x`；`cd -` /
裸 `cd` / 解析失败 → 回退 `sessionCwd`；命中段之后的 `cd` 忽略（已晚）。
pi 与 CLI 入口均在调用 `createBackup` 之前先经此函数解析 cwd。这一规则保证
`cd <other-repo> && git reset --hard` 的备份落点正确，避免虚假安全感。

### 7.4 恢复命令

```
git-safety-guard restore latest        # 最近一次备份
git-safety-guard restore <timestamp>   # 指定备份
git-safety-guard restore <ts> --dry-run
git-safety-guard list                  # 列出备份（时间戳 / cwd / 改动量摘要）
```

恢复语义：
1. 先对当前状态再做一次备份（恢复动作本身也可能是丢弃——自保）
2. `git apply diff.patch`（失败则中止，报告冲突，不部分应用）
3. 把 `untracked/` 下文件复制回仓库相对路径（不覆盖已存在的同名文件，除非 `--force`）
4. 输出恢复结果摘要

### 7.5 双入口行为

**pi 入口（`src/pi/index.ts`）**

```ts
pi.on("tool_call", async (event) => {
  if (event.toolName !== "bash") return;
  const cmd = event.input.command ?? "";
  if (!isDiscardCommand(cmd)) return;
  const cwd = resolveCwdForCommand(cmd, ctx.cwd);   // cd 前缀解析（spec 7.3）
  const result = createBackup(cwd, { triggerCommand: cmd, agent: "pi" });
  // 结果缓存到 toolCallId → 在 tool_result 事件 append 提示
});
pi.on("tool_result", async (event) => {
  // 有缓存备份则 append："[git-guard] ⚠️ 已备份到 <dir>（恢复：git-safety-guard restore latest）"
});
```

- 不再 `; echo` 拼接污染原命令，改走 `tool_result` 返回 content patch。
- 提示注入形状（已对照 pi 文档 extensions.md#tool_result）：`tool_result`
  处理器返回**部分 patch**，本工具 append 一个 text block：
  `return { content: [...event.content, { type: "text", text: note }] }`；
  `toolCallId` ↔ 备份目录的映射存入内存 Map（会话级即可，无需持久化）。
- 并行 pi RPC worker 检测：**默认关**（`GIT_SAFETY_GUARD_WORKER_DETECT=1` 开启），
  逻辑保留在 pi 入口内（core 不管这个）。

**CLI 入口（`src/cli/hook.ts`）**

Claude Code PreToolUse stdin payload（工具需消费的字段）：

```json
{ "session_id": "...", "hook_event_name": "PreToolUse",
  "tool_name": "Bash", "tool_input": { "command": "git reset --hard" },
  "cwd": "/path/to/repo" }
```

exit code 语义：0 = 放行（本工具**永远 0**，除非 restore 子命令自身出错）；
2 = 阻断（阻断型工具专用，本工具不用）。

输出契约按来源适配：
  Claude Code：输出 JSON
               {"hookSpecificOutput":{"hookEventName":"PreToolUse",
                "permissionDecision":"allow",
                "permissionDecisionReason":"<备份提示>"}}
               （模型可见 reason；裸 stderr 只进 transcript，不回灌模型）
  Codex：exit 0 + 最小 hookSpecificOutput JSON（参照 dcg 的 Codex 适配经验）
```

CLI 入口同样先用 `resolveCwdForCommand`（spec 7.3）从 payload.cwd 解析
真实破坏目录，再调用 `createBackup`。

- 识别来源：payload 字段形状 + 环境变量（Claude `hook_event_name` / Codex `turn_id`）
- 未知来源：fallback 输出空 stdout + stderr 提示 + exit 0（放行，不阻断）
- **fail-open 而非 fail-closed**：本工具是备份器不是闸门，备份失败/解析失败
  都必须放行原命令（与阻断型工具 fail-closed 哲学相反，理由：阻断失败比
  备份失败后果轻）

**bin 挂载**

```json
"bin": { "git-safety-guard": "./dist/cli/main.js" }
```

hook 配置示例（README 提供）：

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [
  { "type": "command", "command": "git-safety-guard hook",
    "statusMessage": "git-safety-guard: checking" } ] } ] } }
```

### 7.6 agent 支持矩阵（v0.1）

| Agent | 状态 |
|---|---|
| pi（原生扩展） | ✅ 一等公民 |
| Claude Code（PreToolUse hook） | ✅ 一等公民 |
| Codex（hooks.json） | ✅ 一等公民 |
| Gemini CLI / Cursor | ⚠️ experimental（payload 识别到就适配，未测） |
| 其他 | fallback：放行 + stderr 提示 |

### 7.7 并行 worker 检测

- 保留现有逻辑（ps 扫描同 cwd 的 `pi --mode rpc` 进程）
- **默认关**：`GIT_SAFETY_GUARD_WORKER_DETECT=1` 才启用
- 仅 pi 入口实现；CLI 入口无此特性（不感知 pi）

### 7.8 类型定义（types.ts）

```ts
export interface DetectResult {
  matched: boolean;
  subcommand?: "checkout" | "restore" | "switch" | "reset" | "clean" | "stash";
  segment?: string;        // 命中的命令段（复合命令切分后）
}

export interface Manifest {
  version: 1;                          // manifest schema 版本
  timestamp: string;                   // ISO 8601
  cwd: string; repoRoot: string;
  triggerCommand: string;
  agent: "pi" | "claude" | "codex" | "unknown";
  diffStat: string | null;             // git diff --stat 摘要
  untrackedFiles: string[];            // 仓库相对路径
  untrackedTruncated: boolean;         // 超 500 文件只列清单不复制
  stashRefs: string[];                 // 备份的 stash 引用，如 ["stash@{0}"]
  stashList: string | null;            // 备份前 git stash list 原文
  versions: { guard: string; node: string; git: string };
}

export interface BackupResult {
  dir: string;            // 备份目录绝对路径
  manifest: Manifest;
  note: string;           // 给 agent 看的提示文案
}

export interface Options {
  backupRoot?: string;    // 默认 ~/.git-safety-guard/backups/（env 可覆盖）
  quiet?: boolean;        // GIT_SAFETY_GUARD_QUIET=1：备份照做，不出提示
}
```

### 7.9 配置汇总

| 配置 | 默认 | 覆盖方式 |
|---|---|---|
| 备份根目录 | `~/.git-safety-guard/backups/` | `GIT_SAFETY_GUARD_BACKUP_ROOT` |
| worker 检测 | off | `GIT_SAFETY_GUARD_WORKER_DETECT=1` |
| 提示文案 | on | `GIT_SAFETY_GUARD_QUIET=1` 关闭提示输出（备份仍做） |

不做 config 文件——环境变量足够，YAGNI。

## 8. 技术栈

- 语言：TypeScript 5.x，ESM，Node ≥ 20
- pi 侧：经 jiti 直接跑 TS，无需编译；CLI 侧 `tsc` 编译到 `dist/`
- 测试：`bun test`（你环境有 bun）
- 运行时依赖：零
- devDependencies：typescript、@types/node、bun-types、
  peerDependencies：`@earendil-works/pi-coding-agent: "*"`（pi 入口类型）

## 9. 测试计划（bun test）

| 用例组 | 覆盖 |
|---|---|
| detect.test.ts | 每种丢弃变体命中（含 switch/-f/stash drop/clear）；每种安全变体不命中（含 `--staged`/`-b`/`stash pop` 排除）；**复合命令分段**（`cd x && git reset --hard` 命中、`echo "git reset --hard"` 不误伤即接受现状记录行为）；多段中仅一段命中 |
| backup.test.ts | 有改动生成完整产物；空改动返回 null；untracked 递归复制含子目录；同秒去重；backupRoot 可配置；**stash drop 生成 stash-0.patch 且 manifest.stashList 非空**；stash clear 备份全部 |
| restore.test.ts | 备份→破坏→恢复 round-trip（含 untracked 文件）；--dry-run 不动文件；恢复前自保备份 |
| cli.test.ts | hook stdin 解析 / 输出契约（Claude 形状）；未知 payload fail-open |

测试用临时 git 仓库（`mkdtemp` + `git init` + 种子文件），不碰真实仓库。

## 10. 发布与同步

1. 代码合入 main → `npm publish`（先 `npm pack --dry-run` 检查内容）
2. GitHub：`gh repo create FnSGit/git-safety-guard --public --source . --push`
3. pi 包 keyword `pi-package` → 自动出现在 pi.dev/packages 画廊
4. README 提供三种用法：pi install / Claude hook 配置 / Codex hook 配置 + restore 说明

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| untracked 大文件/海量文件拖慢备份 | manifest 记录数量；超阈值（>500 文件）只备份清单不复制内容，manifest 标注 `truncated: true` |
| `git apply` 冲突致恢复失败 | 恢复失败不部分应用；提示手动处理；自保备份兜底 |
| hook 识别误报（如 `echo "git reset --hard"` 引号内文本） | 分段匹配降低误报；残余误报接受（备份无副作用）；测试记录行为基线 |
| 备份目录无限增长 | v0.1 不做自动清理；`list` 暴露数量，README 提示手动清理；v0.2 考虑 `prune` |
| pi 扩展 jiti 加载兼容性 | 本地 `pi -e` 实测 |
