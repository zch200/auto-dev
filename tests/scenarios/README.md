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
3. **可重复运行** — `git reset --hard` 回初始状态即可重跑
4. **渐进构建** — 先覆盖 4 个核心场景，再逐步扩展

## Scenario Matrix

### Priority 1 — Core Paths (先做)

| ID | Scenario | Project State | Plan | Tests |
|----|----------|--------------|------|-------|
| S1 | happy-path | 有完整 TS 项目 + tests | 单 phase: 加一个工具函数 | 正常全链路 |
| S2 | empty-bootstrap | 空目录 | 单 phase: 初始化项目骨架 | setup tolerance, preflight skip, config refresh |
| S3 | wrong-pm | npm 项目配了 pnpm 的 config | 单 phase: 加功能 | config refresh |
| S4 | crash-recovery | 预置 "running" manifest | 恢复后继续 | 崩溃恢复 |

### Priority 2 — Extended Coverage (后做)

| ID | Scenario | Project State | Plan | Tests |
|----|----------|--------------|------|-------|
| S5 | two-phase-chain | TS 项目 | 2 phase 有依赖 | phase 顺序, 产物传递 |
| S6 | docs-only | 有代码的项目 | 只改 README | 纯文档 plan 的 gate 处理 |
| S7 | python-project | Python 项目 | 加一个模块 | 非 Node 技术栈 |
| S8 | retry-resume | Phase 1 done + Phase 2 failed | --retry | retry 流程 |
| S9 | verification-fail | TS 项目 | 故意不满足验收标准 | 验证失败 → retry |

## Directory Structure

```
tests/scenarios/
├── README.md               ← 本文件
├── runner.ts               ← 场景运行器（统一的运行/清理/报告逻辑）
├── s1-happy-path/
│   ├── scenario.json       ← 场景元数据（描述、预期结果、超时时间）
│   ├── setup.sh            ← 初始化脚本（创建 git repo、安装依赖等）
│   ├── plan.md             ← 计划文档
│   ├── config.json         ← .auto-dev.json 内容
│   └── seed/               ← 初始项目文件（会被 setup.sh 复制到临时目录）
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
├── s2-empty-bootstrap/
│   ├── scenario.json
│   ├── setup.sh
│   ├── plan.md
│   ├── config.json
│   └── seed/               ← 空或只有 .gitkeep
├── s3-wrong-pm/
│   └── ...
└── s4-crash-recovery/
    └── ...
```

### scenario.json Schema

```json
{
  "name": "happy-path",
  "description": "完整 TypeScript 项目上的单 phase 正常流程",
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

1. **Setup** — 复制 seed/ 到临时目录，初始化 git repo，写入 config
2. **Execute** — `env -u CLAUDECODE npx tsx src/index.ts start --plan ...` with timeout
3. **Collect** — 读取 manifest、orchestrator.log、exit code
4. **Assert** — 比对 scenario.json 中的预期
5. **Cleanup** — 删除临时目录、worktree、branches
6. **Report** — 输出结构化结果（pass/fail/error + 日志摘要）

## How to Run

```bash
# 运行单个场景
npx tsx tests/scenarios/runner.ts s1-happy-path

# 运行所有场景
npx tsx tests/scenarios/runner.ts --all

# 运行 Priority 1 场景
npx tsx tests/scenarios/runner.ts --priority 1
```

## Iteration History

| Date | Change | Trigger |
|------|--------|---------|
| 2026-03-13 | 创建框架文档 | redbook 实战测试暴露 3 个 mock 未覆盖的问题 |

## Next Steps

- [ ] 构建 S1 (happy-path) — 最简单的场景，验证 runner 框架可用
- [ ] 构建 S2 (empty-bootstrap) — 验证首次运行的 3 个修复
- [ ] 构建 S3 (wrong-pm) — 验证 config refresh
- [ ] 构建 S4 (crash-recovery) — 验证崩溃恢复
- [ ] 实现 runner.ts — 统一的运行/清理/报告逻辑
