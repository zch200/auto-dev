# auto-dev

> **WIP**: 本项目处于早期开发阶段，核心功能已实现但尚未经过充分的场景测试验证，暂不建议用于生产环境。欢迎试用并反馈问题。

基于 Claude Code Headless Mode + Git Worktree 的自动化开发编排工具。

一条命令启动，自动按计划文档逐阶段执行开发任务，每个阶段在独立 worktree 中运行，通过三层质量门禁后自动合并。

## 工作原理

```
计划文档 (.md)
    ↓ Session 0 (Claude 解析)
plan-manifest.json (状态机)
    ↓ Phase 循环
    ┌─────────────────────────────────────────────┐
    │ 创建 worktree → Claude session 编码 →        │
    │ 类型检查 → 测试 → 验收标准审查 → 合并          │
    │ → 下一个 Phase                               │
    └─────────────────────────────────────────────┘
    ↓ 全部完成
feat/{plan_id} 分支 (等待人工合并到主分支)
```

### 三层质量门禁

1. **Session 内** — Agent 自行编码、测试、修复
2. **Session 外** — 编排器独立运行 typecheck + test（不可绕过）
3. **验证 Session** — 独立的 reviewer Claude session 对照验收标准审查代码

## 前置条件

- Node.js >= 20
- Git
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 已安装并完成认证

## 安装

```bash
npm i -g auto-dev-cc
```

## 快速开始

### 1. 在目标项目中创建配置文件

在目标项目根目录创建 `.auto-dev.json`：

```json
{
  "base_branch": "dev",
  "quality_gate": {
    "typecheck": "npx tsc --noEmit",
    "test": "npx vitest run"
  },
  "setup_commands": ["npm ci"]
}
```

| 字段 | 必填 | 说明 | 默认值 |
|------|------|------|--------|
| `base_branch` | 是 | 基础分支名，feature 分支从此创建 | — |
| `quality_gate` | 是 | 质量门禁命令（至少含 typecheck 或 test 之一） | — |
| `setup_commands` | 否 | worktree 创建后的初始化命令 | `[]` |
| `session_timeout_minutes` | 否 | 单个 Claude session 超时 | `20` |
| `setup_timeout_minutes` | 否 | setup 命令超时 | `5` |
| `gate_timeout_minutes` | 否 | 单条门禁命令超时 | `10` |
| `max_attempts_per_phase` | 否 | 每个 phase 最大重试次数 | `3` |
| `max_turns` | 否 | Claude session 最大对话轮数 | `200` |

### 2. 准备开发计划

使用 Claude Code Plan Mode 或手写一份 Markdown 计划文档，包含多个 Phase，每个 Phase 有标题、描述和验收标准。放在目标项目中，例如 `.claude/plans/v2.1.0.md`。

### 3. 试运行

在目标项目根目录下运行：

```bash
auto-dev-cc start --plan .claude/plans/v2.1.0.md --dry-run
```

确认 Phase 拆分和 slug 命名合理后再正式执行。

### 4. 正式执行

```bash
auto-dev-cc start --plan .claude/plans/v2.1.0.md
```

## 命令参考

### start — 启动或恢复计划执行

```bash
auto-dev-cc start --plan <plan-doc> [--project <path>] [--dry-run] [--retry] [--reset]
```

| 参数 | 说明 |
|------|------|
| `--plan <path>` | 计划文档路径，文件名即 plan_id（如 `v2.1.0.md` → `v2.1.0`） |
| `--project <path>` | 目标项目根目录（默认为当前工作目录） |
| `--dry-run` | 只运行 Session 0 解析计划，展示 phase 结构，不执行 |
| `--retry` | 重试失败的 phase，自动刷新配置（计划文档不能改动） |
| `--reset` | 清理所有状态（分支、worktree、manifest），从头开始 |

### status — 查看执行状态

```bash
auto-dev-cc status --plan <plan-doc>
```

可在另一个终端运行，实时查看当前进度。输出示例：

```
计划: v2.1.0 (feat/v2.1.0)
基础分支: dev

  #  | Phase                | 状态         | 尝试次数
  ---|----------------------|-------------|--------
   1 | db-schema            | completed   | 1
   2 | backend-api          | running     | 1
   3 | frontend-ui          | pending     | 0
```

## 分支模型

```
base_branch (如 dev)
 └── feat/{plan_id}              ← feature 分支（只接受通过质检的代码）
      ├── phase/{plan_id}/slug-1  ← phase 分支（临时，合并后清理）
      └── phase/{plan_id}/slug-2
```

所有 phase 完成后，`feat/{plan_id}` 分支上的代码即为最终成果，由你人工决定是否合并到 base 分支。

## 中断与恢复

- **进程崩溃/被 kill**：重新运行同一条 `start` 命令，自动从中断处恢复
- **Phase 失败**：自动重试（默认最多 3 次），全部失败则终止并保留现场
- **修改配置后重试**：`--retry` 会用最新的 `.auto-dev.json` 刷新配置
- **修改计划后重跑**：`--reset` 清理一切从头开始

## 并行计划

不同终端可以同时运行不同 plan_id 的计划，各自使用独立的 feature 分支、worktree 和锁：

```bash
# 终端 1
auto-dev-cc start --plan .claude/plans/v2.1.0.md

# 终端 2
auto-dev-cc start --plan .claude/plans/refactor-auth.md
```

## 退出码

| 码 | 含义 |
|----|------|
| 0 | 全部 phase 完成 |
| 1 | phase 失败终止 |
| 2 | 配置或参数错误 |
| 3 | 锁冲突（同 plan_id 已有进程运行） |
| 4 | Claude CLI 不可用或认证失败 |

## 开发

```bash
npm run build          # 编译 TypeScript
npm run typecheck      # 类型检查
npm test               # 运行全部测试
npm run test:unit      # 单元测试
npm run test:integration  # 集成测试
npm run test:e2e       # E2E 测试
npm run test:coverage  # 覆盖率检查（阈值 80%）
```

## 设计文档

详细的架构设计、状态机、崩溃恢复策略、prompt 模板等请参阅 [DESIGN.md](./DESIGN.md)。

## License

MIT
