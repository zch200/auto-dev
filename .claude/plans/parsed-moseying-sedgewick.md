# auto-dev 开发任务拆分计划

## Context

auto-dev 是一个基于 Claude Code Headless Mode + Git Worktree 的自动化开发编排工具。设计文档 (`DESIGN.md`) 已完成，项目目前是空项目（仅有设计文档），需要从零开始实现全部功能。

本计划将项目拆分为 6 个 Phase，按模块依赖关系从底层到顶层逐步构建，每个 Phase 可独立编译和测试。同时包含完整的自动化测试方案设计。

---

## Phase 1: 项目骨架与基础设施层

**交付物**:
- `package.json`、`tsconfig.json`、`vitest.config.ts`
- `src/types.ts` — 共享类型定义 (Manifest, Phase, Config, RunResult 等)
- `src/paths.ts` — repo_key 计算、worktree/runtime 路径推导
- `src/logger.ts` — 终端 INFO + 文件 DEBUG 双通道日志
- `src/timeout.ts` — `runWithTimeout()` 统一超时封装
- `src/config.ts` — `.auto-dev.json` 加载与 schema 校验
- `prompts/` 目录下 4 个 prompt 模板文件
- `tests/helpers/` — 测试辅助工具 (git-repo.ts, mock-claude.ts, temp-dir.ts)

**验收标准**:
1. `npx tsc --noEmit` 通过
2. `npx vitest run` 全部通过
3. `runWithTimeout` 能正确终止超时进程并返回超时标记
4. `config.ts` 对合法/非法配置的校验覆盖所有字段约束
5. `paths.ts` 路径推导结果符合设计文档约定

---

## Phase 2: 核心层 — Git 封装、Manifest、锁、Candidate 校验

**交付物**:
- `src/git.ts` — git 命令封装 (branch, merge, diff, rev-parse, merge-base 等)
- `src/manifest.ts` — 原子读写 (tmp+fsync+rename)、.bak 备份与恢复
- `src/lock.ts` — mkdir 原子锁获取/释放、stale lock 回收
- `src/candidate.ts` — Session 0 candidate JSON schema 校验

**验收标准**:
1. `git.ts` 在临时 git 仓库中的集成测试全部通过
2. `manifest.ts` 原子写入 + .bak 恢复测试通过
3. `lock.ts` 锁竞争与 stale lock 回收测试通过
4. `candidate.ts` 对各类非法 candidate 全部正确拒绝

---

## Phase 3: 业务层 — Worktree、Session、Prompt、Notify

**交付物**:
- `src/worktree.ts` — worktree 创建/清理/批量清理
- `src/session.ts` — Claude headless session 执行封装 (参数组装 + token 解析)
- `src/prompt.ts` — 4 种 prompt 模板变量填充
- `src/notify.ts` — macOS 通知 + terminal bell

**验收标准**:
1. `worktree.ts` 在临时 git 仓库中创建/清理 worktree 测试通过
2. `session.ts` 通过 mock 验证参数组装、超时处理、token 解析
3. `prompt.ts` 对 4 种场景的输出包含正确的变量替换
4. `notify.ts` 对 osascript 不可用时优雅降级

---

## Phase 4: 质量门禁与验证流水线

**交付物**:
- `src/quality-gate.ts` — auto-commit 门控、clean-tree 断言、L1/L2 门禁、前置健康检查
- `src/verification.ts` — verification bundle 生成 + 验证 session 调用与结果校验

**验收标准**:
1. auto-commit 门控: 有变更+typecheck 通过→提交 / 失败→丢弃
2. clean-tree 断言: tracked 修改/未忽略 untracked 失败，gitignored 通过
3. bundle 生成: patches 文件数 = 变更文件数
4. verification.json 校验: overall=pass/fail 判定正确，no-op 跳过验证

---

## Phase 5: 崩溃恢复、Retry、CLI 入口

**交付物**:
- `src/recovery.ts` — merged 标记 + git ancestor check 混合恢复、初始化对账
- `src/retry.ts` — plan_doc_hash 比对、配置刷新、状态重置
- `src/index.ts` — CLI 参数解析 (start/status, --plan, --reset, --retry, --dry-run)

**验收标准**:
1. `recovery.ts` 覆盖设计文档 6.3 节所有崩溃场景分支
2. `retry.ts` hash 匹配时重置+刷新 / 不匹配时阻断
3. CLI 参数解析正确，退出码符合设计文档 12.3 节

---

## Phase 6: 编排器主循环与 E2E 集成测试

**交付物**:
- `src/orchestrator.ts` — 主循环: Session 0 流程、phase 执行循环、失败处理、信号处理、token 汇总
- E2E 集成测试 (mock Claude CLI + 真实 git)

**验收标准**:
1. 正常完成全部 phase 的 E2E 流程测试通过
2. phase 失败重试后成功 / 达到 max_attempts 终止 / 前置健康检查失败终止
3. `--dry-run` 只做 Session 0 不执行 phase
4. `--reset` 清理行为正确
5. 退出码在各场景下正确

---

## 自动化测试方案

### 测试框架

| 工具 | 用途 |
|------|------|
| vitest | 测试运行器 (原生 TS 支持) |
| vitest 内置 mock | 函数/模块 mock |
| 真实 git | 集成测试中在临时目录操作 |

### 测试目录结构

```
tests/
├── unit/                    # 纯逻辑，无 I/O
│   ├── paths.test.ts
│   ├── config.test.ts
│   ├── candidate.test.ts
│   ├── prompt.test.ts
│   ├── manifest.test.ts    # schema 校验部分
│   └── retry.test.ts
├── integration/             # 涉及文件系统/git
│   ├── timeout.test.ts
│   ├── git.test.ts
│   ├── manifest-io.test.ts # 原子读写 + .bak 恢复
│   ├── lock.test.ts
│   ├── worktree.test.ts
│   ├── quality-gate.test.ts
│   ├── verification.test.ts
│   ├── recovery.test.ts
│   └── session.test.ts
├── e2e/                     # 完整流程 (mock Claude CLI)
│   └── orchestrator.test.ts
├── fixtures/                # 测试数据
│   ├── plans/               # 测试用计划文档
│   ├── configs/             # 合法/非法配置
│   ├── candidates/          # 合法/非法 candidate
│   └── manifests/           # 各种状态的 manifest
└── helpers/
    ├── git-repo.ts          # 临时 git 仓库创建/销毁
    ├── mock-claude.ts       # Claude CLI mock (可执行脚本)
    └── temp-dir.ts          # 临时目录管理
```

### Mock 策略

| 对象 | 方式 | 范围 |
|------|------|------|
| Claude CLI | 可执行脚本，根据环境变量返回预设行为 | session, e2e |
| `child_process.spawn` | `vi.spyOn` / `vi.mock` | session 单元测试 |
| git 命令 | **不 mock**，临时目录真实操作 | integration, e2e |
| 文件系统 | **不 mock**，`mkdtemp` 临时目录 | integration, e2e |

### Mock Claude CLI 设计

可执行 Node.js 脚本，通过环境变量控制行为:
- `session0-success`: 写入合法 candidate.json
- `phase-success`: 创建文件 + git commit
- `phase-no-commit`: 创建文件但不 commit
- `verify-pass` / `verify-fail`: 写入对应 verification.json
- `timeout`: sleep 无限期 (测试超时终止)
- `crash`: exit 1
- `sequence`: 按调用顺序依次使用不同行为 (E2E 多次调用场景)

### 关键测试场景

**超时测试**: 使用 500ms-2s 小超时值，验证进程组整体终止（无孤儿进程）

**崩溃恢复测试**: 直接构造崩溃后状态 (manifest + git 分支)，调用 recovery 函数验证恢复结果，覆盖设计文档 6.3 节全部 6 个分支

**并发锁测试**: `Promise.all` 同时触发两个 `acquireLock()`，验证只有一个成功

**quality-gate 测试**: 用 `exit 0`/`exit 1` 临时脚本替代真实 tsc/vitest

### CI 配置要点

- 矩阵: macOS + Linux, Node 20 + 22
- git 需配置 user.name/email (集成测试 commit 需要)
- 分层运行: unit → integration → e2e
- 覆盖率阈值: branches/functions/lines/statements >= 80%

---

## Phase 依赖关系

```
Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6
(骨架)    (核心层)   (业务层)   (门禁)    (恢复+CLI)  (编排+E2E)
```

严格线性依赖，每个 Phase 完成后下一个才能开始。

## 关键文件

- `DESIGN.md` — 实现的唯一权威来源
- `src/orchestrator.ts` — 系统核心，组装所有模块
- `src/manifest.ts` — 崩溃安全的基石
- `src/recovery.ts` — 最复杂的分支判定逻辑
- `tests/helpers/mock-claude.ts` — 测试方案的核心基础设施

## 验证方式

每个 Phase 完成后运行:
```bash
npx tsc --noEmit          # 类型检查
npx vitest run            # 全部测试
npx vitest run --coverage # 覆盖率检查
```
