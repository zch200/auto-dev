# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`auto-dev` is an automated development orchestration tool that drives Claude Code Headless Mode (`claude -p`) + Git Worktree to execute multi-phase development plans unattended. It reads a plan document, extracts phases via Session 0, then executes each phase in an isolated worktree with a three-layer quality gate (typecheck → test → verification session).

The authoritative design spec is `DESIGN.md` — consult it for all architectural decisions, state machine details, and rationale.

## Commands

```bash
# Build (TypeScript → dist/)
npm run build          # tsc

# Type check only
npm run typecheck      # tsc --noEmit

# Run all tests
npm test               # vitest run

# Run test subsets
npm run test:unit          # vitest run tests/unit
npm run test:integration   # vitest run tests/integration
npm run test:e2e           # vitest run tests/e2e

# Run a single test file
npx vitest run tests/unit/config.test.ts

# Run with coverage (thresholds: 80% branches/functions/lines/statements)
npm run test:coverage

# Run the tool directly (without building)
npx tsx src/index.ts start <project-root> --plan <plan-doc>
```

## Architecture

The system follows an orchestrator pattern with three session types:

- **Session 0** — Parses plan document via Claude, outputs a candidate JSON, which is validated and assembled into a manifest.
- **Phase execution sessions** — Each phase runs in an isolated git worktree with full dev tools. Quality is enforced post-session.
- **Verification sessions** — A separate reviewer-role Claude session checks acceptance criteria against code changes.

### Key data flow

```
Plan doc → Session 0 → candidate.json → validate → manifest.json (state machine)
                                                        ↓
                                              Phase loop (pending → running → completed/failed)
                                                        ↓
                                              worktree → claude -p → auto-commit gate → L1/L2 gate → verification → merge
```

### Module responsibilities

| Module | Role |
|--------|------|
| `orchestrator.ts` | Main loop: phase selection, worktree lifecycle, gate orchestration, crash recovery dispatch |
| `manifest.ts` | Atomic read/write of manifest with .bak fallback |
| `candidate.ts` | Schema validation of Session 0 output |
| `session.ts` | Spawns `claude -p` with permission configs per session type |
| `quality-gate.ts` | Post-session L1 (typecheck) + L2 (test) + clean-tree assertions |
| `verification.ts` | Generates verification bundle (diffs/patches), runs reviewer session |
| `recovery.ts` | Crash recovery: reconciles `merged` flag + git ancestor checks |
| `retry.ts` | `--retry` logic: plan_doc_hash comparison, config refresh |
| `lock.ts` | mkdir-based atomic process lock with stale detection |
| `timeout.ts` | `runWithTimeout()` — all subprocess execution goes through this |
| `paths.ts` | Deterministic path derivation for runtime dirs, worktrees, branches |
| `config.ts` | Loads and validates `.auto-dev.json` from target project |
| `prompt.ts` | Constructs prompts for all three session types |
| `git.ts` | Git operation wrappers (branch, merge, diff, clean-tree check) |

### Runtime state layout

All runtime files live under `{git_common_dir}/auto-dev/`, never in the working tree:

```
manifests/{plan_id}.json       — state machine (single source of truth)
candidates/{plan_id}.candidate.json  — Session 0 output (temporary)
locks/{plan_id}.lock/          — process mutex (mkdir-based)
verification/{plan_id}/{slug}/ — verification bundles
logs/{plan_id}/                — orchestrator + gate logs
```

Worktrees are created outside the target repo at `{project_parent}/.auto-dev-worktrees/{repo_key}/{plan_id}/{slug}/`.

### Branch model

```
base_branch (e.g. dev)
 └── feat/{plan_id}
      ├── phase/{plan_id}/{slug-1} → merge --no-ff back
      └── phase/{plan_id}/{slug-2} → merge --no-ff back
```

Phase branches use the `phase/` namespace (not `feat/`) to avoid git ref conflicts.

## Testing

- **Unit tests** (`tests/unit/`) — Pure logic: candidate validation, config parsing, path derivation, prompt construction, CLI arg parsing.
- **Integration tests** (`tests/integration/`) — Tests involving filesystem/git: manifest I/O, locking, worktree management, quality gates, recovery, verification.
- **E2E tests** (`tests/e2e/`) — Full orchestrator flow with mocked Claude CLI.
- **Test helpers** (`tests/helpers/`) — `git-repo.ts` (temp git repos), `mock-claude.ts` (fake claude CLI), `temp-dir.ts`.
- **Fixtures** (`tests/fixtures/`) — Sample configs, candidates, plan documents.

Test timeout is 30s per test, hook timeout 15s (configured in `vitest.config.ts`).

## Design Principles

- **Manifest is the single source of truth** — all state transitions are atomic writes (write-tmp → fsync → rename).
- **Quality gates are non-bypassable** — typecheck, test, and verification must all pass before merge; no "skip on error" path.
- **Crash safety** — every step is idempotent; recovery uses explicit `merged` flag + git ancestor check.
- **No interactive auth** — all Claude sessions use `--permission-mode dontAsk`; tools must be pre-authorized.
- **Minimal dependencies** — relies primarily on Node.js built-ins (`child_process`, `fs`, `crypto`, `path`).
