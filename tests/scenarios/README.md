# Scenario-Based Integration Test Environments

## Background

auto-dev 的现有测试体系（unit / integration / e2e）使用 mock Claude CLI 验证逻辑正确性，
但无法覆盖 **真实 Claude session 与真实项目交互** 时暴露的问题。

2026-03-13 使用 redbook 项目做首次实战测试时发现了 3 个此前未被 mock 测试捕获的问题：

1. **Preflight 阻塞空项目** — 空项目上 `tsc --noEmit` 失败，Phase 1 无法启动
2. **Setup commands 不容忍首 phase 失败** — `npm ci` 在无 package.json 时必然失败
3. **Config 不随项目演进刷新** — 交互式生成 `npm ci`，Phase 1 用 pnpm 建项目后 Phase 2+ 仍用 npm

这些问题的共同特征：**只有真实跑完整流程才能暴露**。

但 redbook 项目太重（7 phase，每个 10-20 min），反馈循环太慢。
因此需要构造一组 **轻量级场景化测试项目**，每个聚焦一个测试维度，
单次运行控制在 1-5 分钟内。

## Design Principles

1. **每个场景 1-2 个 phase**，Claude session 1-3 分钟内完成
2. **每个场景聚焦一个测试维度**，不混杂多个问题
3. **Git 隔离** — seed/ 目录只存模板文件（无 .git），runner 在 `/tmp` 创建独立 git repo 运行
4. **分层构建、分层测试** — P0 必须通过，P1/P2 逐步扩展覆盖
5. **可重复运行** — 每次在全新临时目录运行，无残留状态

## Git Isolation Strategy

测试项目 **不能** 放在 auto-dev 仓库内作为 git repo，原因：
- auto-dev 依赖 `git rev-parse --git-common-dir` 定位运行时目录，嵌套 repo 会导致路径混乱
- 测试创建的 `phase/*`、`feat/*` 分支会污染 auto-dev 本身的分支空间
- worktree 操作会在 auto-dev 的 `.git/worktrees/` 下创建条目

**解决方案**：仓库内只存 seed 文件和 scenario 配置，runner 动态构建独立 git repo：

```
仓库内（版本控制）                              运行时（临时，/tmp）
tests/scenarios/s1-happy-path/seed/    ──复制──▶  /tmp/auto-dev-scenarios/s1-happy-path/
  ├── package.json                                  ├── .git/          ← runner 执行 git init
  ├── tsconfig.json                                 ├── .auto-dev.json ← runner 从 config.json 复制
  └── src/index.ts                                  ├── package.json
                                                    └── src/index.ts
                                                         ↓
                                              auto-dev start --plan ... --project /tmp/.../
                                                         ↓
                                                    完成后清理整个临时目录
```

与现有 E2E 测试的 `fs.mkdtempSync()` 模式一致，只是 seed 内容更丰富。

## Test Priority Levels

### P0 — Gate (必须通过，阻塞发布)

核心路径，覆盖最常见的使用场景。任何一个 P0 失败都说明基本功能有问题。

| ID | Scenario | Project State | Plan | Validates |
|----|----------|--------------|------|-----------|
| S1 | happy-path | 完整 TS 项目 + vitest | 单 phase: 加一个工具函数 | 全链路 happy path |
| S2 | empty-bootstrap | 空目录 | 单 phase: 初始化 Node.js 项目 | setup tolerance, preflight skip, config refresh |

### P1 — Core (应该通过，不阻塞但需跟踪)

重要但非阻塞的场景，覆盖常见边界情况。

| ID | Scenario | Project State | Plan | Validates |
|----|----------|--------------|------|-----------|
| S3 | wrong-pm | npm config + pnpm 项目 | 单 phase: 加功能 | config refresh 机制 |
| S4 | crash-recovery | "running" 状态 manifest | resume | 崩溃恢复 |
| S5 | two-phase-chain | TS 项目 | 2 phase 有依赖 | phase 顺序, 前序产物传递 |
| S6 | retry-resume | Phase 1 done + Phase 2 failed | --retry | retry 逻辑 |

### P2 — Extended (锦上添花，扩展覆盖)

非核心路径，覆盖其他技术栈和特殊 plan 类型。

| ID | Scenario | Project State | Plan | Validates |
|----|----------|--------------|------|-----------|
| S7 | docs-only | 有代码的项目 | 只改 markdown | 纯文档 plan 的 gate 处理 |
| S8 | python-project | Python 项目 | 加一个模块 | 非 Node 技术栈检测 |
| S9 | verification-fail | TS 项目 | 不可能满足的验收标准 | 验证失败 → retry → 最终失败 |
| S10 | go-project | Go 项目 | 加一个 handler | Go 技术栈 |

## Directory Structure

```
tests/scenarios/
├── README.md                ← 本文件
├── runner.ts                ← 场景运行器
├── s1-happy-path/
│   ├── scenario.json        ← 场景元数据
│   ├── plan.md              ← 计划文档
│   ├── config.json          ← .auto-dev.json 内容
│   └── seed/                ← 初始项目文件（无 .git）
│       ├── package.json
│       ├── tsconfig.json
│       ├── vitest.config.ts
│       └── src/
│           ├── index.ts
│           └── index.test.ts
├── s2-empty-bootstrap/
│   ├── scenario.json
│   ├── plan.md
│   ├── config.json
│   └── seed/                ← 空或只有 .gitkeep
└── ...
```

### scenario.json Schema

```json
{
  "name": "happy-path",
  "description": "完整 TypeScript 项目上的单 phase 正常流程",
  "priority": 0,
  "timeout_minutes": 5,
  "expected_exit_code": 0,
  "expected_phases": [
    { "slug": "add-utility", "expected_status": "completed" }
  ],
  "assertions": [
    "setup_commands_succeeded",
    "preflight_passed",
    "quality_gates_passed",
    "verification_passed"
  ]
}
```

## runner.ts Responsibilities

1. **Setup** — 复制 seed/ 到 `/tmp/auto-dev-scenarios/{name}/`，`git init` + initial commit，写入 .auto-dev.json
2. **Execute** — `env -u CLAUDECODE npx tsx src/index.ts start --plan ...` with timeout
3. **Collect** — 读取 manifest、orchestrator.log、exit code
4. **Assert** — 比对 scenario.json 中的预期
5. **Cleanup** — 删除临时目录、worktree、branches
6. **Report** — 输出结构化结果（pass/fail/error + 日志摘要）

## How to Run

```bash
# 运行单个场景
npx tsx tests/scenarios/runner.ts s1-happy-path

# 按优先级运行
npx tsx tests/scenarios/runner.ts --p0          # 只跑 P0（gate 测试）
npx tsx tests/scenarios/runner.ts --p0 --p1     # 跑 P0 + P1

# 运行所有场景
npx tsx tests/scenarios/runner.ts --all
```

## Iteration History

| Date | Change | Trigger |
|------|--------|---------|
| 2026-03-13 | 创建框架文档，定义分级策略 | redbook 实战测试暴露 3 个 mock 未覆盖的问题 |

## Next Steps

- [ ] 实现 runner.ts 框架
- [ ] 构建 S1 (happy-path) — P0，验证 runner + 全链路
- [ ] 构建 S2 (empty-bootstrap) — P0，验证 bootstrap 修复
- [ ] 构建 S3-S4 — P1，验证 config refresh + crash recovery
- [ ] CI 集成考虑（P0 作为 PR gate，P1 nightly）
