# auto-dev 设计文档

> 基于 Claude Code Headless Mode + Git Worktree 的自动化开发编排工具

## 1. 背景与目标

### 1.1 问题

在使用 Claude Code 进行项目开发时，通常的流程是：

1. 用 Plan Mode 制定版本开发计划（分为多个 Phase）
2. 手动逐个 Phase 执行，每次需要人工启动 session、加载上下文、确认结果
3. 每个 Phase 完成后手动处理分支合并

这个过程有大量可自动化的重复操作，且无法并行执行多个开发计划。

### 1.2 目标

构建一个编排脚本 `auto-dev`，实现：

- **一条命令启动**：指定项目路径和计划文档，自动完成全部 Phase
- **一个 Phase = 一个 Session**：每个 Phase 在独立的 Claude headless session 中执行，上下文隔离
- **Git Worktree 隔离**：每个 Phase 在独立 worktree 中执行，不影响主工作区
- **质量门禁**：自动化质量检查，不合格的代码绝不合并
- **并行计划**：支持同时运行多个开发计划，各自使用独立 feature 分支

### 1.3 参考项目

[anthropics/claude-quickstarts/autonomous-coding](https://github.com/anthropics/claude-quickstarts/tree/main/autonomous-coding)

该项目的核心思路：
- 两阶段 Agent（初始化 + 循环编码），用 Claude Agent SDK 驱动
- `feature_list.json` 作为状态机，跟踪 feature 完成情况
- 每个 session 用全新上下文窗口，状态通过文件 + git 持久化

**与本项目的关键差异**：

| 维度 | 参考项目 | auto-dev |
|------|---------|----------|
| 计划来源 | app_spec.txt → 自动生成 200 features | Plan Mode 文档 → Session 0 提取为 JSON |
| 粒度 | 单个 feature（细粒度） | Phase（粗粒度，4-7 个） |
| 隔离方式 | 单目录，git commit | Git Worktree |
| 分支模型 | 单分支 commit | phase 分支 → feature 分支 → dev |
| 驱动方式 | Python + Claude Agent SDK | Node.js/TS + Claude CLI Headless Mode |
| 人工介入 | 无 | 仅在全部完成或流程终止时 |

## 2. 核心概念

### 2.1 分支模型

```
dev (基础分支)
 └── feat/v2.1.0 (计划级 feature 分支)
      ├── phase/v2.1.0/db-schema → worktree → 质检通过 → merge 回 feat/v2.1.0
      ├── phase/v2.1.0/backend-api → worktree → 质检通过 → merge 回 feat/v2.1.0
      └── phase/v2.1.0/frontend-ui → worktree → 质检通过 → merge 回 feat/v2.1.0
                                                             ↓
                                                   所有 phase 完成后
                                                   人工决定 merge → dev
```

**为什么 phase 分支不用 `feat/{plan_id}/{slug}`**：

Git 不允许一个 ref 既作为分支存在，又作为其他 ref 的路径前缀。例如 `feat/v2.1.0`（文件）和 `feat/v2.1.0/db-schema`（需要 `feat/v2.1.0` 作为目录）会冲突，导致 `cannot lock ref` 错误。Phase 分支使用独立的 `phase/` 命名空间彻底避免此问题，且语义上更准确——phase 分支是临时操作产物，不是 feature。

**设计原则**：feature 分支是干净的，只接受通过质检的代码。

**Worktree 路径约定**：

worktree **不放在目标仓库内部**，避免污染主工作区的 `git status`。每个 phase 的 worktree 创建在仓库外的稳定目录：

```
{project_parent}/.auto-dev-worktrees/{repo_key}/{plan_id}/{slug}/
```

示例：

```
/path/to/.auto-dev-worktrees/testhub-a1b2c3d4/v2.1.0/db-schema/
/path/to/.auto-dev-worktrees/testhub-a1b2c3d4/v2.1.0/backend-api/
```

其中：
- `project_parent` = 目标项目父目录
- `repo_key` = `{project_dir_name}-{sha1(realpath(project_root)).slice(0, 8)}`

Phase 完成后清理对应 worktree；可重试的失败 attempt 也清理对应 worktree；仅在终态 `failed` 时保留最后一次 worktree 供人工排查。`--reset` 清理该计划下所有 worktree。

**Worktree 管理决策（v1）**：

`v1` **不使用** `claude --worktree`。所有 phase worktree 一律由编排器显式创建和管理：

```bash
git worktree add {worktree_path} -b phase/{plan_id}/{slug} {feature_branch}
```

随后在该目录中运行 Claude session：

```bash
spawn('claude', ['-p', prompt, ...args], { cwd: worktree_path })
```

**决策原因**：

- 控制权一致：worktree 的创建、清理、保留现场、崩溃恢复都由 `auto-dev` 负责，不把生命周期拆给 Claude CLI。
- 目录语义稳定：避免使用 `claude --worktree` 时默认落到 `<repo>/.claude/worktrees/<name>`，从而把运行时目录重新塞回仓库树内。
- 降低产品耦合：编排器只依赖 git worktree 原语和“在指定 cwd 运行一个 coder/reviewer agent”这个抽象，未来更容易切换到其他 CLI 或 Agent 产品。
- 恢复逻辑更简单：manifest、lock、verification bundle 和 worktree 路径都由编排器统一推导，不受外部 CLI 默认路径策略影响。

**运行时状态目录约定**：

所有编排器运行时文件都放在 git 元数据目录下，不进入版本控制：

```
{git_common_dir}/auto-dev/
  manifests/{plan_id}.json
  candidates/{plan_id}.candidate.json
  locks/{plan_id}.lock/
  verification/{plan_id}/{slug}/attempt-{n}/
```

其中 `git_common_dir = git rev-parse --git-common-dir`。

### 2.2 两类 Session

```
Session 0 (初始化)                  Sessions 1~N (执行)
┌───────────────────────┐          ┌───────────────────────┐
│ 输入: 计划文档路径       │          │ 输入: plan-manifest.json│
│                       │          │                       │
│ ① 读取 plan.md        │          │ ① 找到当前待执行 phase  │
│ ② Claude 提取 phase   │          │ ② 创建 worktree        │
│    结构化数据          │          │ ③ 运行 claude headless │
│ ③ 合并项目配置生成      │          │ ④ 后置质量门禁          │
│    plan-manifest.json │          │ ⑤ 验证 session         │
│ ④ 创建 feature 分支    │          │ ⑥ 合并或丢弃           │
│                       │          │ ⑦ 更新 manifest 状态   │
└───────────────────────┘          └───────────────────────┘
```

**为什么用 Session 0 提取 JSON 而不是直接解析 plan.md**：
Plan Mode 是 Claude Code 预置模式，输出格式不完全可控。用一个 Claude session 将其转化为结构化 JSON，比用正则解析 markdown 更可靠。JSON 作为任务路标（状态机），plan.md 作为任务详情（供 Agent 阅读理解）。

### 2.3 项目配置文件（.auto-dev.json）

项目级配置文件，放置在目标项目根目录，由用户维护。提供可重复、可审计的项目级参数，避免依赖 LLM 推断。

```json
{
  "base_branch": "dev",
  "quality_gate": {
    "typecheck": "npx tsc --noEmit",
    "test": "npx vitest run"
  },
  "setup_commands": ["npm ci"],
  "session_timeout_minutes": 20,
  "setup_timeout_minutes": 5,
  "gate_timeout_minutes": 10,
  "max_attempts_per_phase": 3,
  "max_turns": 200
}
```

**配置字段说明**：

| 字段 | 必填 | 说明 |
|------|------|------|
| `base_branch` | 是 | 基础分支名（如 `dev`、`main`），feature 分支从此创建 |
| `quality_gate` | 是 | 质量门禁命令，包含 `typecheck` 和/或 `test` |
| `setup_commands` | 否 | worktree 创建后执行的初始化命令，默认空数组；只能做环境准备，不能修改 tracked 文件或产生未忽略的脏文件 |
| `session_timeout_minutes` | 否 | 单个 Claude session（Phase 执行）超时时间，默认 20 分钟 |
| `setup_timeout_minutes` | 否 | setup_commands 执行超时，默认 5 分钟 |
| `gate_timeout_minutes` | 否 | 质量门禁（typecheck/test）单条命令超时，默认 10 分钟 |
| `max_attempts_per_phase` | 否 | 每个 phase 最大尝试次数，默认 3 |
| `max_turns` | 否 | Phase 执行 session 的最大对话轮数，默认 200 |

**配置快照规则**：

```
首次 start:
  项目 .auto-dev.json → 写入 manifest（冻结为本计划的执行配置）

后续 start / status / 崩溃恢复:
  只读取 manifest 中已冻结的配置，不重新解释 .auto-dev.json

--retry:
  总是用当前 .auto-dev.json 刷新 manifest 中的非 phase 配置
```

这样同一个 manifest 在重启、恢复和审计时具有确定性；`--retry` 时总是应用最新项目配置，因为修改配置后重试是最常见的使用场景。

Session 0 **只负责提取 phase 信息**（title、summary、acceptance_criteria、slug），不生成 quality_gate 和 setup_commands。这些由项目配置显式提供，并在首次启动时冻结到 manifest。

如果项目中没有 `.auto-dev.json`，编排脚本在首次运行时报错提示用户创建，而不是猜测。

### 2.4 plan-manifest.json（状态机）

```json
{
  "plan_id": "v2.1.0",
  "plan_doc": ".claude/plans/v2.1.0.md",
  "plan_doc_hash": "sha256-of-plan-doc-file...",
  "feature_branch": "feat/v2.1.0",
  "base_branch": "dev",
  "quality_gate": {
    "typecheck": "npx tsc --noEmit",
    "test": "npx vitest run"
  },
  "setup_commands": ["npm ci"],
  "session_timeout_minutes": 20,
  "setup_timeout_minutes": 5,
  "gate_timeout_minutes": 10,
  "max_attempts_per_phase": 3,
  "max_turns": 200,
  "total_tokens": { "input": 0, "output": 0 },
  "total_cost_usd": 0.0,
  "phases": [
    {
      "slug": "db-schema",
      "order": 1,
      "title": "数据库 Schema 变更",
      "summary": "新增 xxx 表，修改 yyy 字段",
      "acceptance_criteria": [
        "新增了 migrations/001_add_xxx.sql 文件且包含 CREATE TABLE 语句",
        "现有测试不受影响"
      ],
      "status": "pending",
      "attempts": 0,
      "last_error": null,
      "feature_base_sha": null,
      "phase_head_sha": null,
      "merged": false,
      "merge_commit_sha": null
    }
  ],
  "created_at": "2026-03-12T10:00:00",
  "last_updated": "2026-03-12T10:00:00"
}
```

**字段说明**：

| 字段 | 用途 |
|------|------|
| `plan_doc_hash` | 顶层字段。`SHA-256(readFile(plan_doc))`，计划文档文件的摘要，用于 `--retry` 时判断计划是否变更 |
| `total_tokens` | 顶层字段。累计所有 Claude session 的 token 使用量 `{ input, output }` |
| `total_cost_usd` | 顶层字段。累计预估费用（美元） |
| `slug` | 稳定标识，从标题派生（如 "数据库Schema变更" → "db-schema"） |
| `order` | 执行顺序 |
| `feature_base_sha` | 创建 phase 分支时 feature 分支的 HEAD SHA，用于区分"有新 commit"和"no-op" |
| `phase_head_sha` | phase 分支 HEAD 的 commit SHA，merge 前记录 |
| `merged` | 显式布尔标记，仅在 merge 成功后置 true，用于崩溃恢复的确定性判断 |
| `merge_commit_sha` | merge 到 feature 分支后的 commit SHA |

**状态流转**：

```
pending ──→ running ──→ completed ✅
              │
              ↓ (质检/验证失败)
           attempts < max?
            ├── Yes → pending (重试)
            └── No  → failed ❌ (终止流程)
```

### 2.5 Phase 标识稳定性

Phase 使用 `slug`（而非位置编号）作为稳定标识。slug 格式为小写英文 + 短横线（如 `db-schema`、`backend-api`）。

**slug 生成策略**：

slug 在首次 Session 0 中由 Claude 从标题含义派生（因为中文标题无法通过纯算法可靠地转换为有意义的英文标识）。slug 一旦写入 manifest 即为**不可变的规范标识**。

```
首次运行: Claude 生成候选 slug → candidate 校验通过 → 写入 manifest → slug 固化
--retry:  不重新解析计划，直接复用已有 manifest 中的 slug（见 8.3）
```

**slug 命名约束**（在 Session 0 prompt 中明确）：
- 小写英文 + 短横线，如 `db-schema`、`backend-api`
- 从标题含义派生，简短且可辨识
- 同一计划内 slug 唯一

**为什么不在编排脚本中确定性生成 slug**：
中文标题（如"数据库 Schema 变更"）无法通过纯算法可靠地转换为有意义的英文短标识。使用 Claude 做一次性翻译+提炼是合理的，关键是 slug 一旦生成就固化在 manifest 中，不依赖 Claude 的重复一致性。

### 2.6 Claude CLI 调用约定

编排脚本通过 `claude -p`（headless mode）驱动所有 Claude session。`-p` 模式**不支持交互式授权**，必须在启动时预配置全部权限，否则 session 遇到未授权工具会直接拒绝，整次对话白跑。

**明确约束**：这里的 Claude CLI 只负责”在指定目录执行一个 session”，**不负责创建 worktree**。因此 `auto-dev` 不使用 `claude --worktree` 参数。

**调用方式**：

```bash
claude -p “{prompt}” \
  --output-format json \
  --permission-mode dontAsk \
  --allowedTools {tools} \
  --disallowedTools {disallowed} \
  --max-turns {max_turns}
```

其中：
- 进程工作目录由编排器通过 `cwd={worktree_path}` 指定，而不是通过 `claude --worktree` 隐式创建
- `--permission-mode dontAsk`：未在 `--allowedTools` 中列出的工具会被**直接拒绝**（不弹出交互式确认），这是 headless 模式的唯一安全选择
- `--allowedTools` 接受空格分隔的权限规则，Bash 工具支持通配符模式（如 `”Bash(npm run *)”` 匹配 `npm run test`、`npm run build` 等）
- `--disallowedTools` 的优先级高于 `--allowedTools`，用于排除明确危险的操作

**各 session 类型权限配置**：

| Session 类型 | --allowedTools | --disallowedTools | --max-turns | 说明 |
|-------------|----------------|-------------------|-------------|------|
| Session 0（初始化） | `Read Write WebFetch WebSearch` | — | 10 | 读取计划文档、写入 candidate 文件、可搜索参考资料 |
| Phase 执行 | `Read Write Edit Bash Glob Grep WebFetch WebSearch` | 见下方 | `max_turns`（默认 200） | 完整的开发能力 |
| 验证 Session | `Read Write Glob Grep WebFetch WebSearch` | — | 10 | 读取/搜索 verification bundle 和代码文件、写入 verification.json |

**Phase 执行的 disallowedTools**：

默认排除以下危险操作：

```
Bash(git push *) Bash(rm -rf *)
```

v1 硬编码，不可配置。

**权限预检**：

在正式执行流程前，编排脚本运行一次极简的权限验证：

```bash
claude -p “respond with ok” --permission-mode dontAsk --allowedTools “Read” --max-turns 1 --output-format json
```

验证 Claude CLI 可用、认证有效、权限配置生效。失败则报错退出，避免后续 session 白跑。

**session 成功/失败判断**：

编排脚本不依赖 `claude -p` 的 stdout 判断业务逻辑，而是检查 session 应产出的**文件**：

```
Session 0:
  期望产出: {git_common_dir}/auto-dev/candidates/{plan_id}.candidate.json
  判断: 文件存在 + JSON 合法 + schema 校验通过

Phase 执行:
  期望产出: worktree 中有新的 git commit
  判断: phase 分支 HEAD 是否相对 feature_base_sha 有新 commit
  注意: Agent 未 commit 的变更由编排脚本自动提交后再判断

验证 Session:
  期望产出: {git_common_dir}/auto-dev/verification/{plan_id}/{slug}/attempt-{n}/verification.json
  判断: 文件存在 + JSON 合法 + schema 校验通过 + overall === "pass"
```

`--output-format json` 的 stdout 仅用于日志记录和调试，不作为控制流依据。

### 2.7 系统不变量

- 运行时产物（candidate、lock、verification、日志）不得写入目标仓库工作树。
- `feat/{plan_id}` 及其 `phase/{plan_id}/*` 分支在计划运行期间由 `auto-dev` 独占管理；不支持人工并发改写、rebase 或直接提交。
- `setup_commands`、`quality_gate` 和验证流程都必须保持 worktree 干净；允许生成 gitignored 缓存，但不允许留下 tracked 修改或未忽略的脏文件。
- manifest 中的执行配置一经创建即冻结，`--retry` 时自动刷新。

## 3. 质量门禁（三层设计）

这是整个系统最重要的安全机制。

### 3.1 第一层：Session 内（Agent 自我修复）

Claude Agent 在 session 内有完整的编码-测试-修复循环能力。Prompt 中指示 Agent：
- 实现功能后运行测试
- 测试失败则修复代码（不允许修改测试来凑通过）
- 所有测试通过后 commit

这一层给 Agent 充分的自我修复机会。Agent 可以在一个 session 内多次迭代，直到测试通过或判断无法修复为止。

### 3.2 第二层：Session 外（编排脚本硬门禁）

Session 结束后，编排脚本独立运行质量检查，作为不可绕过的硬门禁：

```
① 检查 worktree 是否有未提交变更
   ├── 无变更 → 继续
   └── 有变更 → auto-commit 门控:
       快速运行 typecheck 命令
       ├── typecheck 通过 → auto-commit，继续
       └── typecheck 失败 → 直接丢弃变更，本次 attempt 失败
           last_error: "Session 结束时存在未提交变更且无法通过类型检查"
② 记录 phase_head_sha（此时 worktree 必须是干净的）
③ L1 - 类型检查: typecheck 命令
   ├── 命令失败 → 本次 attempt 失败
   └── 命令成功后再次检查 worktree 干净
       └── 不干净 → 本次 attempt 失败（gate 污染工作树）
④ L2 - 测试: test 命令
   ├── 命令失败 → 本次 attempt 失败
   └── 命令成功后再次检查 worktree 干净
       └── 不干净 → 本次 attempt 失败（gate 污染工作树）
```

**Auto-commit 门控设计要点**：
Agent 可能在 session 超时或崩溃时留下未提交的半成品代码。直接 auto-commit 会把明显损坏的代码推入门禁流程，浪费时间。先做一次 typecheck 快速筛选：通过说明代码至少在结构上完整，值得进入完整门禁；不通过则直接丢弃，节省一轮门禁流程的时间。

**setup_commands 也属于门禁前置条件**：

在创建 worktree 后、启动 Claude session 前执行 `setup_commands`。执行完成后立即做一次 clean-tree 断言：

- 允许 gitignored 文件/目录（如 `node_modules/`、构建缓存）
- 不允许 tracked 文件修改
- 不允许未忽略的 untracked 文件

若 `setup_commands` 违反该约束，本次 attempt 直接失败，**不会**启动 Claude session。推荐使用 `npm ci`、`pnpm install --frozen-lockfile` 这类可复现命令，而不是会修改锁文件的命令。

**前置健康检查**：

在 setup_commands 通过后、Claude session 启动前，先运行一次 `quality_gate` 命令（typecheck + test），确认 feature 分支本身是健康的：

```
setup_commands 通过
    ↓
clean-tree 断言通过
    ↓
前置健康检查: 运行 quality_gate.typecheck + quality_gate.test
    ├── 通过 → 启动 Claude session
    └── 失败 → 直接终止流程（不消耗 attempts，不启动 Claude session）
              last_error: "Feature 分支本身未通过质量门禁: {error_output}"
              提示: "前序 phase 可能引入了问题，请人工检查 feature 分支后重新运行"
```

这确保 Agent 始终在一个健康的代码基础上开工。前置健康检查失败说明 feature 分支本身有问题，重试无意义，因此不消耗 attempts，直接终止流程由人工介入。

### 3.3 第三层：验证 Session（验收标准核查）

**为什么需要这一层**：
typecheck + test 只能证明"代码没坏"，不能证明"功能做完了"。一个"功能没做完但测试仍然绿"的 phase 可能通过前两层门禁。

在 L1/L2 通过后，启动一个**独立的短 Claude session**，角色是 reviewer（非 coder），对照验收标准检查代码变更：

```
L1 + L2 通过
    ↓
验证 session（新的 Claude session，reviewer 角色）
    输入: verification bundle + acceptance_criteria
    输出: verification.json
    ↓
全部 criteria met → 进入 L3 合并
任一 criteria met=false → 本次 attempt 失败
```

**verification.json 格式**：

```json
{
  "criteria": [
    {
      "description": "新增了 migrations/001_add_xxx.sql 文件且包含 CREATE TABLE 语句",
      "met": true,
      "evidence": "新增了 migrations/001_add_xxx.sql，包含 CREATE TABLE xxx (...) 语句"
    },
    {
      "description": "现有测试不受影响",
      "met": true,
      "evidence": "未修改任何现有测试文件，typecheck 和 test 均已通过"
    }
  ],
  "overall": "pass"
}
```

**设计要点**：
- 验证 session 用**不同角色**（reviewer），避免"自己给自己打分"
- 编排脚本先在运行时目录生成 verification bundle，reviewer 按需读取，不把整份 diff 塞进 prompt
- 如果某个标准无法从代码变更中确认，标记为 `met=false`（宁严勿松）

**验收标准编写指导**：

验证 session 具有 `Read Glob Grep` 权限，可以搜索文件和代码内容，但不能执行命令。验收标准推荐描述**可从代码变更中判断**的条件：

- 推荐：「新增了 `migrations/001_add_xxx.sql` 文件」「为新接口编写了单元测试」「错误响应包含错误码和描述」
- 可接受：「服务可正常启动」等运行时标准——验证 session 会改为检查实现完整性和测试覆盖（代码已通过 L1/L2 门禁）
- 避免：「API 响应时间 < 200ms」等需要实际度量的性能标准

Session 0 提取验收标准时不做此校验——计划文档由用户编写，编排脚本不限制其内容。

**异常处理**：
验证 session 本身也可能失败（崩溃、超时、输出不是合法 JSON、文件未生成等）。所有这些情况统一视为**门禁未通过**，进入失败处理流程。验证 session 结束后，编排脚本会再次断言 worktree 干净；如果 reviewer 错误地修改了代码，也按失败处理。不存在"验证环节出错就跳过验证"的路径。

### 3.4 合并检查

```
④ L3 - 合并: git merge --no-ff phase 分支到 feature 分支
   └── 有冲突 → 本次 attempt 失败（绝不自动解决冲突）
```

**始终使用 `--no-ff`**：即使可以 fast-forward，也创建 merge commit。这使得 `merge_commit_sha` 始终存在且与 `phase_head_sha` 不同，简化崩溃恢复逻辑（无需区分 ff/non-ff 两种情况）。

**正常情况下不应有冲突**——每个 phase 分支都是从最新的 feature 分支创建的。如果出现冲突，说明 phase 的执行结果偏离了预期（如修改了不该修改的文件），应当丢弃重来。

### 3.5 失败处理

```
attempt 失败（L1/L2/验证/L3 任一环节）
    │
    ├── attempts < max_attempts_per_phase (默认 3)
    │     → status 回到 "pending"
    │       last_error 记录失败环节 + 失败原因 + 相关输出
    │       删除 phase 分支和 worktree
    │       下一次循环重试（Prompt 携带失败上下文）
    │
    └── attempts >= max_attempts_per_phase
          → status 设为 "failed"
            保留最后一次失败的 phase 分支、worktree 和 verification bundle
            整个流程终止
            输出: "Phase {slug} 连续 {max} 次失败，疑似计划或代码问题"
                  "已保留失败现场供人工检查，请修复后使用 --retry 或 --reset"
```

**为什么限制最多 3 次**：
同一个 phase 反复失败，通常意味着开发计划本身有问题（如需求不合理、依赖未满足），继续重试只是浪费 tokens。此时应该停下来由人工介入调整计划。

**为什么最终失败要保留现场**：
终态失败与可重试失败不同。前者已经需要人工介入，再清理 worktree/分支会丢失最有价值的排查上下文，因此仅在最终失败时保留最后一次现场，由 `--reset` 负责统一清理。

## 4. Prompt 设计

### 4.1 Session 0 (初始化) Prompt

```
你是一个开发计划解析助手。请阅读以下开发计划文档，从中提取结构化信息。

## 计划文档内容
{plan_doc_content}

## 输出要求
输出一个 JSON 文件到 {candidate_path}，只包含 phases 数组，格式如下：

{
  "phases": [
    {
      "slug": "小写英文短横线标识，从标题含义派生",
      "order": 1,
      "title": "阶段标题",
      "summary": "阶段核心工作的简要描述",
      "acceptance_criteria": ["验收标准1", "验收标准2"]
    }
  ]
}

## 注意事项
1. 每个 Phase 必须有清晰的 title、summary 和 acceptance_criteria
2. Phase 按执行顺序排列，order 从 1 开始递增
3. slug 从标题含义派生（如"数据库 Schema 变更"→"db-schema"），
   同一计划内唯一，简短可辨识
4. 只提取 phase 结构信息，不要生成项目配置（quality_gate 等）
```

**Session 0 写入 candidate 文件，而非正式 manifest**：

Session 0 输出到 `{git_common_dir}/auto-dev/candidates/{plan_id}.candidate.json`（候选文件），不直接覆盖正式 manifest。候选文件是 LLM 输出，可能不合法，必须通过校验后才能合并为正式 manifest。

```
Session 0 输出 → {git_common_dir}/auto-dev/candidates/{plan_id}.candidate.json
                    ↓
编排脚本后处理（基于 candidate）:
  ① 确定执行配置:
     - 读取项目 .auto-dev.json
  ② 推导 plan_id 和 feature_branch:
     - plan_id = 计划文档文件名去掉扩展名（如 `v2.1.0.md` → `v2.1.0`）
     - plan_id 命名约束: 匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`，不允许 `/` 或空格
     - feature_branch = `feat/{plan_id}`（如 `feat/v2.1.0`）
  ③ 为每个 phase 补充运行时字段（status、attempts 等）
  ④ plan_doc_hash = SHA-256(readFile(plan_doc))
  ⑤ 组装 manifest（含执行配置 + phase 数据 + plan_doc_hash）
  ⑥ 原子写入正式 manifest
  ⑦ 删除 candidate 文件
```

**candidate 校验（硬门禁）**：

Session 0 的 candidate 文件是 LLM 输出，必须在组装 manifest 前由编排脚本做严格 schema 校验；Prompt 约束只是辅助，不构成安全保证。

```
validateCandidate(candidate):
  ① 顶层必须是对象，且包含非空 phases 数组
  ② 每个 phase 必须包含:
     - slug: 非空字符串，匹配 ^[a-z0-9]+(?:-[a-z0-9]+)*$
     - order: 正整数
     - title: 非空字符串
     - summary: 非空字符串
     - acceptance_criteria: 非空字符串数组
  ③ candidate 内部约束:
     - order 唯一
     - slug 唯一
     - 不允许缺失字段、空字符串、空数组
     - 不允许出现 status / attempts / merged 等运行时字段
  ④ 任一校验失败
     → 删除 candidate 文件
       session0_attempts < max_session0_attempts (硬编码常量 = 2)?
       ├── Yes → session0_attempts++
       │         构造重试 prompt（附带校验错误信息，指导 Claude 修正输出格式）
       │         重新运行 Session 0
       └── No  → 终止，旧 manifest 保持不变
                  输出明确错误信息（字段路径 + 原因）
                  "Session 0 连续 {max} 次未能产出合法的候选文件"
```

**校验说明**：
- 这里校验的是 candidate 的结构合法性和分支名安全性

**Session 0 重试机制**：

Session 0 依赖 LLM 输出结构化 JSON，输出可能不合规（格式错误、字段缺失、文件未生成等）。Session 0 最多尝试 2 次（`MAX_SESSION0_ATTEMPTS = 2`，硬编码常量）。

```
Session 0 执行流程:
  session0_attempts = 0
  loop:
    session0_attempts++
    ① 构造 prompt（首次用标准 prompt；重试时附带上次错误信息）
    ② 运行 claude -p (Session 0 prompt)
    ③ 检查 candidate 文件是否存在
       └── 不存在 → 记录错误 "candidate 文件未生成"，进入 [重试判定]
    ④ candidate schema 校验
       └── 校验失败 → 删除 candidate 文件，记录校验错误（字段路径 + 原因），进入 [重试判定]
    ⑤ 校验通过 → 退出循环，继续后续流程

  [重试判定]:
    session0_attempts < MAX_SESSION0_ATTEMPTS?
    ├── Yes → 继续 loop
    └── No  → 终止，旧 manifest 保持不变
              输出: "Session 0 连续 {max} 次未能产出合法的候选文件: {last_error}"
```

**为什么不直接写正式 manifest**：
候选文件是 LLM 输出，可能不合法。如果 Session 0 直接覆盖正式 manifest，一次失败的 Session 0 就能破坏整个运行时状态。候选文件必须通过 schema 校验后，才由编排脚本合并为正式 manifest。

### 4.2 Phase 执行 Prompt（首次）

```
你正在自动化开发流水线中执行任务。

## 完整开发计划（参考）
{plan_doc_content}

## 本次任务: Phase {order} - {title} [{slug}]
{summary}

### 验收标准
{acceptance_criteria}

## 已完成的阶段
{completed_phases_summary}

## 进度记录
如果工作目录中存在 PROGRESS.md，先阅读它了解前序阶段的实现情况。
完成本阶段工作后，在 PROGRESS.md 末尾追加一个章节（如果文件不存在则创建），记录：
- 本阶段的实现决策和关键变更
- 修改的核心文件及原因
- 需要后续阶段注意的事项（如新增的接口、变更的数据结构等）

格式示例:
## Phase {order}: {title}
- ...

## 执行规则
1. 只实现本阶段内容，不涉及后续阶段的工作
2. 实现后运行测试，如果测试失败请修复代码（不要修改测试来凑通过）
3. 所有测试通过后，用 git commit 提交全部变更
4. Commit message 格式: "phase({slug}): {简要描述}"
5. 不要修改与本阶段无关的文件
6. 如果反复修复测试仍无法通过，请停下来，commit 当前状态，
   并在 commit message 中说明未解决的问题
7. 不要启动长期驻留的后台进程；如果为了调试临时启动了进程，必须在 session 结束前自行停止
```

**`{completed_phases_summary}` 构成**：

对每个已完成的 phase，包含：
- title 和 summary
- 修改的文件列表（`git diff --stat {feature_base_sha}..{merge_commit_sha}`）

这为 Agent 提供足够上下文（前面做了什么、改了哪些文件），同时避免 diff 全文过长溢出 context window。

### 4.3 Phase 执行 Prompt（重试）

在首次 Prompt 基础上，前置失败上下文：

```
你正在重试一个之前未通过质量门禁的阶段。

## 上次失败原因
{last_error}

## 注意
这是一个全新的工作目录，上次的代码已被丢弃。
请在实现时特别注意规避上述问题。

（以下同首次 Prompt）
```

### 4.4 验证 Session Prompt

```
你是一个代码审查员。请对照验收标准逐条检查本次代码变更是否满足要求。

## Phase 信息
Phase: {title} [{slug}]

## 验收标准
{acceptance_criteria}

## 验证材料目录
{verification_bundle_path}

该目录包含：
- `metadata.json`：phase 基本信息、base/head SHA、worktree 路径
- `diff.stat.txt`：整体 diff 统计
- `changed-files.json`：变更文件列表
- `patches/*.diff`：每个变更文件的独立 patch

请按需读取这些文件。你可以使用 Glob 搜索文件、Grep 搜索代码内容，也可以直接读取 worktree 中的源码文件，以充分理解代码变更。

## 输出要求
输出 JSON 到 {verification_path}，格式：
{
  "criteria": [
    {
      "description": "验收标准原文",
      "met": true/false,
      "evidence": "判断依据，引用具体文件或代码"
    }
  ],
  "overall": "pass" 或 "fail"
}

## 判断原则
1. 只根据实际代码变更判断，不要推测或假设
2. 对于涉及运行时行为的标准（如"服务可正常启动"、"API 响应正常"），你无法执行命令，请改为检查：
   - 相关代码的实现是否完整和正确（配置、入口文件、依赖引入等）
   - 是否有对应的测试覆盖该行为（本 phase 的代码已通过 typecheck 和 test 门禁）
   - 如果实现完整且有测试覆盖，可视为 `met=true`
3. overall 只有在全部 criteria 都 met 时才为 "pass"
4. 只将结果写入 `{verification_path}`，不要修改 worktree 中的任何文件
```

**Verification bundle 构造策略**：

- 目录: `{git_common_dir}/auto-dev/verification/{plan_id}/{slug}/attempt-{n}/`
- `diff.stat.txt`: `git diff --stat {feature_base_sha}..{phase_head_sha}`
- `changed-files.json`: 每个变更文件的路径、状态、增删行数
- `patches/*.diff`: `git diff {feature_base_sha}..{phase_head_sha} -- {file}` 按文件拆分导出
- 若 diff 为空（no-op），跳过验证 session，直接按失败处理
- 若 verification bundle 生成失败，按失败处理；不存在”截断后放行”的路径
- v1 全量生成 verification bundle，不做截断。若后续遇到验证 session context 溢出问题，再引入截断策略。验证 Prompt 中提示 reviewer 可通过 Read 工具查看 worktree 中的完整文件。

## 5. 超时机制

### 5.1 统一超时设计

**所有子进程调用**都需要超时保护，不仅限于 Claude session。无人值守流程中，`setup_commands`、typecheck、test、verification bundle 生成等都可能 hang（如 `npm ci` 网络超时、watch 模式测试、卡住的 migration），导致锁永远不释放、恢复逻辑无法进入。

编排脚本封装统一的 `runWithTimeout(command, timeoutMs, options)` 工具函数，所有子进程执行都通过它调用。

**各执行类型超时配置**：

| 执行类型 | 超时来源 | 默认值 |
|---------|---------|-------|
| setup_commands | `setup_timeout_minutes` | 5 分钟 |
| Claude session（Phase 执行） | `session_timeout_minutes` | 20 分钟 |
| quality_gate（typecheck/test 单条） | `gate_timeout_minutes` | 10 分钟 |
| 验证 session | 硬编码 | 5 分钟 |
| verification bundle 生成（git diff） | 硬编码 | 1 分钟 |
| 权限预检 | 硬编码 | 30 秒 |

### 5.2 超时实现

超时在 Node.js 层面通过 `child_process.spawn` + `setTimeout` 实现，不依赖系统 `timeout` 命令（macOS 无内置 `timeout`）。为了避免留下孤儿子进程，所有子进程必须以**独立进程组**启动，并在超时时按进程组整体终止：

```typescript
async function runWithTimeout(
  command: string,
  args: string[],
  options: { timeoutMs: number; cwd?: string; stdio?: StdioOptions }
): Promise<RunResult> {
  const proc = spawn(command, args, {
    ...options,
    detached: true,
  })

  const killGroup = (signal: NodeJS.Signals) => {
    try { process.kill(-proc.pid!, signal) } catch {}
  }

  const timer = setTimeout(() => {
    killGroup('SIGTERM')
    // 给 SIGTERM grace period (5s)，之后 SIGKILL 强制终止
    setTimeout(() => killGroup('SIGKILL'), 5000)
  }, options.timeoutMs)

  proc.on('exit', () => clearTimeout(timer))
  // ... 收集 stdout/stderr，返回 RunResult
}
```

首版目标平台为 POSIX（macOS/Linux）；Windows 需要单独的进程树终止实现。

### 5.3 Prompt 内提示

在执行规则中加入：
> 如果你已经反复修复测试但仍无法全部通过，请停下来，commit 当前状态并在 commit message 中说明未解决的问题。

### 5.4 Session 结束后的处理

无论 session 以何种方式结束（正常完成、超时、崩溃），编排脚本都会：
1. 确认 session 进程组已退出；若仍未退出，视为本次 attempt 失败
2. 检查 worktree 是否有未提交变更，走 auto-commit 门控流程（见 3.2 节）
3. 运行后置质量门禁（L1 + L2 + 验证 + L3）
4. 由门禁结果决定合并或丢弃

## 6. 幂等恢复与崩溃安全

### 6.1 原子持久化策略

manifest 是整个系统的状态单一真相源，其写入必须是崩溃安全的。

**原子写入流程**：

```
所有 manifest 写入都通过 atomicWriteManifest() 函数:

  ① 序列化: JSON.stringify(manifest, null, 2)
  ② 写入临时文件: {manifest_path}.tmp
  ③ fsync 临时文件（确保内容落盘到磁盘）
  ④ rename 临时文件 → 正式文件（POSIX 保证原子性）
```

**备份与恢复**：

```
每次原子写入前:
  如果正式文件存在且内容可解析为合法 JSON
    → 复制为 {manifest_path}.bak

读取 manifest 时:
  尝试读取正式文件
    ├── 成功且 JSON 合法 → 使用
    ├── 文件不存在 → 正常（首次运行）
    └── 文件存在但损坏（截断/非法 JSON）
          → 尝试读取 .bak
            ├── .bak 合法 → 恢复为正式文件，使用，输出警告
            └── .bak 也损坏 → 报错，建议 --reset
```

### 6.2 状态写入顺序

正常流程中，manifest 的写入严格按以下顺序，每一步都通过原子写入落盘：

```
① 创建 worktree，记录 feature_base_sha                   [原子写入]
② 执行 setup_commands（带超时），并断言 worktree 干净
③ 前置健康检查: 运行 quality_gate（带超时）
   └── 失败 → 清理 worktree，status 保持 pending，终止流程
④ status → running, attempts++                          [原子写入]
⑤ 执行 claude session（带超时 + --permission-mode dontAsk）
⑥ auto-commit 门控（有变更 → typecheck → 通过则提交/失败则丢弃）
⑦ 断言 worktree 干净，记录 phase_head_sha                [原子写入]
⑧ 质量门禁 L1/L2（带超时，每层后都断言 worktree 干净）
⑨ 生成 verification bundle，并在验证 session 后再次断言 worktree 干净
⑩ 执行 merge
⑪ merged → true, 记录 merge_commit_sha                  [原子写入]
⑫ status → completed                                    [原子写入]
⑬ 清理 worktree + phase 分支
```

### 6.3 崩溃恢复（显式标记 + git 对账混合判定）

恢复时，对于任何 `status=running` 的 phase，编排脚本采用**混合判定策略**：`merged` 显式标记为主信号，git ancestor check 为辅助信号，根据场景组合使用。

```
发现 status=running 的 phase
    ↓
merged == true?
├── Yes → 主信号确认: merge 已完成（崩溃在 ⑩-⑪ 之间）
│         直接标记 completed
│         清理残留 worktree/分支
│
└── No  → 主信号说"未合并"，需进一步分析:
          ↓
          phase_head_sha 是否已记录?
          │
          ├── 未记录 (崩溃在 ⑥ 之前)
          │   → session 未完成或未开始
          │     清理残留 worktree/分支
          │     重置为 pending
          │
          └── 已记录 (崩溃在 ⑥ 之后)
              ↓
              phase_head_sha == feature_base_sha?
              │
              ├── Yes → no-op: phase 没有产生新 commit
              │         此时 ancestor check 不可靠（天然是祖先），不使用
              │         按失败处理（Agent 没有完成任何工作）
              │         清理残留 worktree/分支
              │         重置为 pending
              │
              └── No  → 有新 commit，用 ancestor check 做辅助判定:
                        ↓
                        git merge-base --is-ancestor
                          {phase_head_sha} {feature_branch}
                        │
                        ├── Yes → merge 实际已完成
                        │         (崩溃在 ⑨ 成功后、⑩ merged=true 写入前)
                        │         补填 merged=true
                        │         补填 merge_commit_sha（--no-ff 保证 merge commit 存在）:
                        │           git log {feature_branch}
                        │             --ancestry-path ^{feature_base_sha} -1
                        │         标记 completed
                        │         清理残留 worktree/分支
                        │
                        └── No  → merge 确实未发生（崩溃在 ⑥-⑨ 之间）
                                  worktree 仍完好?
                                  ├── Yes → 重新走门禁+合并流程（从 ⑦ 继续）
                                  └── No  → 清理残留，重置为 pending
```

**为什么混合判定是安全的**：

| 场景 | phase_head_sha vs feature_base_sha | ancestor check 可靠? | 使用策略 |
|------|-----------------------------------|--------------------|---------|
| no-op（无新 commit） | 相等 | 不可靠（天然是 ancestor，会误判） | 仅用 `merged` 标记 |
| 有新 commit | 不等 | 可靠（新 SHA 只有 merge 后才会成为 ancestor） | `merged` 为主 + ancestor 兜底 |

这样所有崩溃窗口都被覆盖：
- `merged=true` 已写入 → 直接 completed（主信号）
- merge 成功但 `merged=true` 未写入 → ancestor check 兜底发现
- merge 未发生 → ancestor check 返回 No，确认未合并
- no-op → 不使用 ancestor check，避免误判

### 6.4 锁（进程互斥）

同一个计划同一时间只允许一个编排进程运行。

**锁原语**：使用 `mkdirSync` 创建锁目录。`mkdir` 在 POSIX 上是原子操作——目录要么创建成功（获得锁），要么因已存在而失败（`EEXIST`）。**目录的存在本身就是锁**，不依赖内部文件内容的完整性。

**锁结构**：

```
{git_common_dir}/auto-dev/locks/{plan_id}.lock/           ← 锁目录（存在即锁定）
{git_common_dir}/auto-dev/locks/{plan_id}.lock/owner.json ← 元数据（PID、启动时间）
```

```
获取锁:
  try {
    fs.mkdirSync(lockDir)                  // 原子创建目录，已存在则抛 EEXIST
    写入 owner.json: { pid: process.pid, started_at: ISO时间 }
  } catch (err) {
    if (err.code !== 'EEXIST') throw err

    // 锁目录已存在，读取 owner.json
    读取 owner.json
      │
      ├── 可解析且含 pid 字段
      │     → process.kill(pid, 0)
      │       ├── 进程存活 → 拒绝启动:
      │       │   "计划 {plan_id} 已有进程 (PID: {pid}) 在运行"
      │       └── 进程已死 → 进入 [回收 stale lock]
      │
      └── owner.json 缺失 / 不可解析
            → 直接进入 [回收 stale lock]

    [回收 stale lock]:
      fs.rmSync(lockDir, { recursive: true })
      // 重新获取（仅允许一次重试）
      try {
        fs.mkdirSync(lockDir)
        写入 owner.json
      } catch (err2) {
        if (err2.code === 'EEXIST')
          → 另一个进程抢先获取了锁，拒绝启动
      }
  }
```

**设计说明**：
- 该工具由用户手动启动，同一 plan 并发启动概率极低，因此不需要复杂的竞争处理
- `mkdir` 比 `wx` 文件更安全——`wx` 只保证"创建文件"原子，不保证"写入内容"原子，进程 B 可能读到空文件误判为 stale
- owner.json 缺失时（如创建锁目录后立即崩溃）直接视为 stale lock 回收，不做宽限期判定

**释放锁**：

```
注册信号处理（进程启动时）:
  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sig =>
    process.on(sig, () => {
      try { fs.rmSync(lockDir, { recursive: true }) } catch {}
      process.exit(1)
    })
  )

正常退出时:
  fs.rmSync(lockDir, { recursive: true })
```

### 6.5 初始化对账

Session 0 初始化涉及两个独立资源的创建：manifest 和 feature branch。

```
初始化对账:

  manifest 存在?    feature branch 存在?    动作
  ──────────────    ──────────────────     ────────────────────────────
  No                No                     正常初始化:
                                           ① Session 0 提取 phases
                                           ② 组装 manifest [原子写入]
                                           ③ git branch {feature_branch} {base_branch}

  只有一个存在      —                       状态不一致（崩溃残留或外部干预）
  (Yes/No 或 No/Yes)                       → 报错:
                                             "manifest 与 feature 分支状态不一致，
                                              请使用 --reset 清理后重新开始。"

  Yes               Yes                    初始化已完成
                                           → 执行启动一致性校验:
                                             0. manifest.plan_doc 必须与
                                                --plan 参数指向同一文件
                                                （规范化为相对于项目根的路径后比较）
                                             1. base_branch 必须是
                                                feature_branch 的祖先
                                             2. 对每个 completed phase:
                                                - phase_head_sha 和
                                                  merge_commit_sha 必须是
                                                  feature_branch 的祖先
                                             任一校验失败 → 报错，
                                             要求 --reset 或人工修复
                                           → 全部通过后进入主循环
```

**每一步都是幂等的**：
- Session 0（如果 manifest 已存在则跳过）
- manifest 写入（原子写入，要么完整要么不存在）
- feature branch 创建（仅在正常初始化路径中执行）

## 7. 完整执行流程

```
auto-dev start ./testhub --plan .claude/plans/v2.1.0.md
    │
    ├── 校验 plan_id 命名
    │   └── plan_id 必须匹配 ^[a-zA-Z0-9][a-zA-Z0-9._-]*$
    │       不符合 → 报错: "计划文件名不符合命名规范，
    │       请使用英文、数字、点、短横线（如 v2.1.0.md、refactor-auth.md）"
    │
    ├── 检查项目 .auto-dev.json 是否存在
    │   └── 不存在 → 报错，提示用户创建
    │
    ├── 权限预检（Claude CLI 可用性 + 认证 + 权限配置）
    │   └── 运行极简 claude -p 测试，失败则报错退出
    │       "Claude CLI 不可用或权限配置无效，请确认已安装并完成认证"
    │
    ├── 原子获取锁（mkdir） → 失败则退出
    │
    ├── 初始化对账（见 6.5）
    │   ↓
    │   manifest 存在?    feature branch 存在?    动作
    │   ──────────────    ──────────────────     ────────────────────────
    │   No                No                     正常初始化: Session 0 → manifest → 创建分支
    │   只有一个存在       —                       状态不一致 → 报错，要求 --reset
    │   Yes               Yes                    初始化已完成 → 校验一致性 → 进入主循环
    │
    │   ※ manifest 读取含 .bak 回退机制（见 6.1）
    │   ※ 存在 manifest 时，执行崩溃恢复对账（见 6.3）
    │
    ↓
    ┌─→ 读取 manifest
    │   找到下一个待执行 phase（按 order 排序，第一个 status=pending 的）
    │       │
    │       ├── 没有 pending phase
    │       │   ├── 全部 completed → 输出 token 汇总，通知用户，释放锁
    │       │   └── 有 failed phase → 通知用户，释放锁，终止
    │       │
    │       └── 找到 pending phase ↓
    │
    │   从 feature 分支创建 phase 分支: phase/{plan_id}/{slug}
    │   创建 worktree
    │   记录 feature_base_sha (feature 分支当前 HEAD)      [原子写入]
    │   运行 setup_commands（如 npm ci）（带超时）
    │   断言 worktree 干净（允许 gitignored 文件）
    │       │
    │       ├── 失败 → 跳转到 [失败处理]
    │       └── 通过 ↓
    │
    │   前置健康检查: 运行 quality_gate（typecheck + test）（带超时）
    │       │
    │       ├── 失败 → [前置健康检查终止]（不消耗 attempts，见下方）
    │       └── 通过 ↓
    │
    │   更新 manifest: status → running, attempts++       [原子写入]
    │       ↓
    │   构造 prompt（首次 or 重试，根据 last_error 判断）
    │   运行 claude -p（带 timeout + --permission-mode dontAsk）
    │   累加 token 使用量到 manifest                       [原子写入]
    │       ↓
    │   auto-commit 门控（见 3.2：有变更 → typecheck → 通过则提交/失败则丢弃）
    │   断言 worktree 干净
    │   记录 phase_head_sha                               [原子写入]
    │       ↓
    │   后置质量门禁 (L1 typecheck → clean check → L2 test → clean check)
    │       │
    │       ├── 失败 → 跳转到 [失败处理]
    │       └── 通过 ↓
    │
    │   生成 verification bundle（运行时目录，非 worktree）
    │   验证 session (reviewer 角色，检查 acceptance_criteria)
    │   累加 token 使用量到 manifest                       [原子写入]
    │   断言 worktree 干净
    │       │
    │       ├── 失败 → 跳转到 [失败处理]
    │       └── 通过 ↓
    │
    │   merge --no-ff phase 分支 → feature 分支（始终创建 merge commit）
    │       │
    │       ├── 有冲突 → 跳转到 [失败处理]
    │       └── 成功 ↓
    │
    │   merged → true, 记录 merge_commit_sha              [原子写入]
    │   更新 manifest: status → completed                  [原子写入]
    │   清理 worktree + phase 分支
    │       ↓
    │   继续下一个 phase ──→ ┘
    │
    │   [前置健康检查终止]
    │       清理 worktree + phase 分支
    │       last_error: "Feature 分支本身未通过质量门禁: {error_output}"
    │       status 保持 pending，attempts 不变             [原子写入]
    │       通知用户，释放锁，终止流程（退出码 1）
    │       提示: "feature 分支在 Phase {slug} 开始前已不健康，
    │              可能是前序 phase 引入了问题，请人工检查修复后重新运行"
    │
    │   [失败处理]
    │       attempts < max_attempts_per_phase?
    │       ├── Yes → 清理 worktree + phase 分支
    │       │         更新 manifest: status → pending, 记录 last_error
    │       │         重置 merged/phase_head_sha/feature_base_sha [原子写入]
    │       │         继续下一个循环（重试同一 phase）──→ ┘
    │       └── No  → 更新 manifest: status → failed       [原子写入]
    │                 保留最后一次失败的 phase 分支/worktree
    │                 通知用户，释放锁，终止流程
    └
```

## 8. 中途重启与重试

### 8.1 正常恢复（进程中断后）

```bash
auto-dev start ./testhub --plan .claude/plans/v2.1.0.md
# → 检测到已有 manifest
# → 执行崩溃恢复对账（见 6.3）
# → 从中断处继续
```

### 8.2 完全重置

```bash
auto-dev start ./testhub --plan .claude/plans/v2.1.0.md --reset
```

**--reset 的清理顺序**：

```
① 清理所有残留 worktree（git worktree list → 匹配 plan_id 的 → 逐个 remove）
② 删除所有 phase 分支（git branch -D phase/{plan_id}/*）
③ 删除 feature 分支（git branch -D {feature_branch}）
④ 删除 runtime 目录中的 manifest / .bak / candidate / verification bundle / lock
⑤ 重新执行 Session 0，从头开始
```

### 8.3 失败后重试（--retry）

当 phase 失败导致流程终止后：

```bash
auto-dev start ./testhub --plan .claude/plans/v2.1.0.md --retry
```

**--retry 的处理流程**：

```
① 计算当前计划文档的 SHA-256
② 与 manifest.plan_doc_hash 比较
   │
   ├── 相同 → 计划未修改，继续:
   │     清理失败 phase 的残留 worktree 和 phase 分支
   │     所有 failed/pending phase 重置为 pending, attempts=0, last_error=null
   │     用当前 .auto-dev.json 刷新 manifest 中的非 phase 配置
   │     原子写入 manifest
   │     从第一个 pending phase 继续执行
   │
   └── 不同 → 计划已修改，阻断:
         提示: "计划文档已变更（plan_doc_hash 不匹配），--retry 仅适用于计划未修改的情况。
                请使用 --reset 从头开始，或使用新的 plan_id。"
```

**设计原则**：
- `--retry` 只适用于"不修改计划，重新执行失败的 phase"
- 任何计划文档变更（哪怕只改了一个字），都必须 `--reset` 重来或使用新 plan_id
- 这大幅简化了对账逻辑——不需要做 phase 级别的模糊匹配，也不需要重跑 Session 0
- `--retry` 总是用当前 `.auto-dev.json` 刷新非 phase 配置，因为修改配置后重试是最常见的场景

### 8.4 查看状态（status）

```bash
auto-dev status ./testhub --plan .claude/plans/v2.1.0.md
```

读取 manifest 并展示当前执行状态：

```
计划: v2.1.0 (feat/v2.1.0)
基础分支: dev

  # | Phase          | 状态        | 尝试次数
  1 | db-schema      | completed   | 1
  2 | backend-api    | failed      | 2
  3 | frontend-ui    | pending     | 0

失败原因 (backend-api):
  L2 测试失败: 3 个测试用例未通过

保留现场:
  branch: phase/v2.1.0/backend-api
  worktree: /path/to/.auto-dev-worktrees/testhub-a1b2c3d4/v2.1.0/backend-api
```

如果 manifest 不存在，提示用户先运行 `auto-dev start`。

### 8.5 试运行（--dry-run）

```bash
auto-dev start ./testhub --plan .claude/plans/v2.1.0.md --dry-run
```

只执行 Session 0 解析计划文档，展示提取出的 phase 结构，不创建分支、不执行任何 phase：

```
[dry-run] 计划: v2.1.0
[dry-run] 提取到 3 个 phase:

  # | Slug           | Title              | 验收标准数
  1 | db-schema      | 数据库 Schema 变更   | 2
  2 | backend-api    | 后端 API 开发        | 3
  3 | frontend-ui    | 前端界面实现          | 4

[dry-run] 验收标准检查:
  [warn] backend-api 标准 #3: "API 响应时间 < 200ms"
         → 可能需要运行时验证，验证 Session 无法执行命令，将改为检查实现完整性和测试覆盖

[dry-run] 质量门禁:
  typecheck: npx tsc --noEmit
  test: npx vitest run

[dry-run] 未执行任何操作。确认无误后去掉 --dry-run 重新运行。
```

用途：在正式执行前确认 Session 0 的 phase 拆分和 slug 命名是否合理。

**验收标准启发式检查**：`--dry-run` 会对每条 acceptance_criteria 做关键词扫描，匹配以下模式时输出警告（不阻断流程）：

- `[<>]\s*\d+\s*(ms|s|秒|毫秒)` — 延迟/性能阈值
- `可正常(运行|执行|启动|访问|连接|响应)` — 运行时断言
- `(运行|执行|启动).*(后|时|成功)` — 时序断言

## 9. 并行计划

```bash
# 终端 1
auto-dev start ./testhub --plan .claude/plans/v2.1.0.md
# → feature 分支: feat/v2.1.0，锁: v2.1.0.lock

# 终端 2
auto-dev start ./testhub --plan .claude/plans/refactor-auth.md
# → feature 分支: feat/refactor-auth，锁: refactor-auth.lock
```

每个计划有独立的：
- feature 分支
- phase 分支
- worktree
- plan-manifest.json
- 锁文件

**Git 隔离**：计划之间在各自分支上工作，互不影响。冲突仅在最终 merge 到 dev 时需要处理，由用户人工决定。

**互斥保障**：同一个 plan_id 通过 `mkdir` 原子锁目录防止重复启动（见 6.4）。不同 plan_id 可以并行运行。

**运行环境隔离（已知限制）**：

v1 仅提供 Git 层面的隔离。并行计划共享操作系统运行环境，可能存在资源冲突：
- 端口冲突：两个计划的测试/调试进程可能争抢同一端口
- 数据库冲突：共享数据库的并行 migration 可能互相干扰
- 缓存冲突：共享缓存目录的写入冲突

启动并行计划时，编排脚本输出警告：

```
[warn] 检测到已有计划 {other_plan_id} 正在运行。
       并行计划共享运行环境（端口、数据库等），可能产生资源冲突。
       建议确保两个计划涉及的子系统不重叠。
```

## 10. 技术栈

- **语言**: Node.js + TypeScript
- **Claude 调用**: `claude` CLI headless mode (`claude -p`)
- **运行方式**: `npx tsx src/index.ts` 或编译后的 CLI
- **依赖**: 尽量最小化，主要使用 Node.js 内置模块
  - `child_process` — 执行 git / claude CLI
  - `fs/promises` + `fs` — 文件操作（含原子写入）
  - `crypto` — SHA-256 plan_doc_hash 计算
  - `path` — 路径处理

## 11. 项目结构（预期）

```
auto-dev/
├── DESIGN.md               ← 本文档
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts             ← CLI 入口，参数解析
│   ├── orchestrator.ts      ← 主循环编排逻辑
│   ├── session.ts           ← Claude headless session 执行
│   ├── manifest.ts          ← plan-manifest.json 原子读写与状态管理
│   ├── candidate.ts         ← Session 0 candidate 校验与 slug 分配
│   ├── paths.ts             ← runtime/worktree 路径推导
│   ├── recovery.ts          ← 崩溃恢复与 git 对账
│   ├── retry.ts             ← --retry plan_doc_hash 比对与状态重置
│   ├── worktree.ts          ← git worktree 创建/清理
│   ├── quality-gate.ts      ← 后置质量门禁 (L1 + L2 + clean-tree 断言)
│   ├── verification.ts      ← verification bundle 生成 + 验证 session
│   ├── lock.ts              ← 进程锁管理（mkdir 原子获取）
│   ├── timeout.ts           ← 统一超时管理（runWithTimeout）
│   ├── prompt.ts            ← Prompt 模板构造
│   ├── git.ts               ← git 操作封装
│   ├── config.ts            ← .auto-dev.json 加载、校验与冻结刷新
│   ├── logger.ts            ← 日志输出
│   └── notify.ts            ← 完成/失败通知
└── prompts/
    ├── init.md              ← Session 0 初始化 prompt 模板
    ├── phase.md             ← Phase 执行 prompt 模板
    ├── phase-retry.md       ← Phase 重试 prompt 模板
    └── verification.md      ← 验证 session prompt 模板
```

## 12. 运维与可观测性

### 12.1 日志

**存放位置**：

```
{git_common_dir}/auto-dev/logs/{plan_id}/
  orchestrator.log                    ← 编排器主日志
  gate-{slug}-attempt-{n}.log         ← 质量门禁 stdout/stderr
```

**日志策略**：

- 终端输出 INFO 级别：phase 开始/结束、门禁结果、错误信息、最终汇总
- 文件记录 DEBUG 级别：所有命令执行细节、git 操作输出、状态变更
- 日志文件随 `--reset` 一起清理

### 12.2 Token 与成本追踪

每个 Claude session（Session 0 / Phase 执行 / 验证 Session）结束后，从 `--output-format json` 输出中解析 token/cost 数据，累加到 manifest 的 `total_tokens` 和 `total_cost_usd` 字段。

流程完成时输出汇总：

```
Token 使用: input 45,230 / output 28,100 | 预估费用: $2.35
```

### 12.3 退出码

| 退出码 | 含义 |
|--------|------|
| 0 | 全部 phase 完成 |
| 1 | phase 失败终止（含前置健康检查终止） |
| 2 | 配置/参数错误（缺少 .auto-dev.json、plan_id 不合法等） |
| 3 | 锁冲突（同 plan_id 已有进程运行） |
| 4 | Claude CLI 不可用或认证失败 |

### 12.4 完成/失败通知

流程结束时（无论成功或失败），通过系统通知提醒用户：

- macOS：`osascript` 发送系统通知
- 通用：终端 bell（`\x07`）
