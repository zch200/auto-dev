import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createTempGitRepo, type TempGitRepo } from '../helpers/git-repo.js'
import { createMockClaudeWithSequence, type MockClaudeSequence } from '../helpers/mock-claude.js'
import { orchestrate } from '../../src/orchestrator.js'
import { readManifest } from '../../src/manifest.js'
import * as paths from '../../src/paths.js'
import { EXIT_CODES } from '../../src/types.js'
import type { CliArgs } from '../../src/index.js'

function makeCliArgs(
  repo: TempGitRepo,
  overrides: Partial<CliArgs> = {},
): CliArgs {
  const planDocPath = path.join(repo.dir, '.claude/plans/test-plan.md')
  return {
    command: 'start',
    projectRoot: repo.dir,
    planDocPath,
    planId: 'test-plan',
    reset: false,
    retry: false,
    dryRun: false,
    ...overrides,
  }
}

function setupRepo(): TempGitRepo {
  const repo = createTempGitRepo()
  repo.writeFile('init.txt', 'initial content')
  repo.git('add', '-A')
  repo.git('commit', '-m', 'initial commit')

  // Create .auto-dev.json with simple gates that always pass
  repo.writeFile(
    '.auto-dev.json',
    JSON.stringify({
      base_branch: 'main',
      quality_gate: { typecheck: 'true', test: 'true' },
      session_timeout_minutes: 1,
      setup_timeout_minutes: 1,
      gate_timeout_minutes: 1,
      max_attempts_per_phase: 2,
    }),
  )
  repo.git('add', '.auto-dev.json')
  repo.git('commit', '-m', 'add config')

  // Create plan doc
  repo.writeFile(
    '.claude/plans/test-plan.md',
    '# Test Plan\n\n## Phase 1: Test Feature\nImplement a test feature.\n\n### Acceptance Criteria\n- Feature file exists\n',
  )
  repo.git('add', '.claude/plans/test-plan.md')
  repo.git('commit', '-m', 'add plan')

  return repo
}

/**
 * Inject mock claude into PATH via env override on the process level.
 * Since orchestrator spawns child processes which inherit process.env,
 * we modify process.env.PATH directly.
 */
function injectMockPath(mockDir: string): string {
  const originalPath = process.env.PATH || ''
  process.env.PATH = `${mockDir}:${originalPath}`
  return originalPath
}

function restorePath(originalPath: string): void {
  process.env.PATH = originalPath
}

describe('orchestrator E2E', () => {
  let repo: TempGitRepo
  let mock: MockClaudeSequence
  let originalPath: string

  afterEach(() => {
    if (originalPath !== undefined) {
      restorePath(originalPath)
    }
    if (mock) mock.cleanup()
    if (repo) {
      // Clean up worktrees before removing repo
      try {
        const wtBase = paths.worktreeBase(repo.dir)
        if (fs.existsSync(wtBase)) {
          fs.rmSync(wtBase, { recursive: true, force: true })
        }
      } catch { /* ok */ }
      repo.cleanup()
    }
  })

  it('should complete a single-phase plan successfully', async () => {
    repo = setupRepo()
    // Sequence: preflight ok → session0 → phase execute → verification pass
    mock = createMockClaudeWithSequence([
      'ok',                // preflight
      'session0-success',  // Session 0
      'phase-success',     // Phase execution
      'verify-pass',       // Verification session
    ])
    originalPath = injectMockPath(mock.dir)

    const exitCode = await orchestrate(makeCliArgs(repo))

    expect(exitCode).toBe(EXIT_CODES.SUCCESS)

    // Verify manifest state
    const manifest = readManifest(paths.manifestPath(repo.dir, 'test-plan'))
    expect(manifest).not.toBeNull()
    expect(manifest!.phases).toHaveLength(1)
    expect(manifest!.phases[0].status).toBe('completed')
    expect(manifest!.phases[0].merged).toBe(true)
    expect(manifest!.phases[0].merge_commit_sha).toBeTruthy()

    // Verify feature branch exists with the merge
    expect(() => repo.git('rev-parse', 'feat/test-plan')).not.toThrow()

    // Verify phase branch was cleaned up
    expect(() =>
      repo.git('rev-parse', '--verify', 'refs/heads/phase/test-plan/test-feature'),
    ).toThrow()

    // Verify tokens were accumulated
    expect(manifest!.total_tokens.input).toBeGreaterThan(0)
    expect(manifest!.total_cost_usd).toBeGreaterThan(0)
  }, 30_000)

  it('should retry phase on failure then succeed', async () => {
    repo = setupRepo()
    // Phase crashes first time → retry → succeeds second time
    // Sequence:
    //   preflight ok → session0 → phase crash (attempt 1) →
    //   phase-success (attempt 2) → verify-pass
    mock = createMockClaudeWithSequence([
      'ok',                // preflight
      'session0-success',  // Session 0
      'crash',             // Phase execution - attempt 1 (crash = exit 1, no commit)
      'phase-success',     // Phase execution - attempt 2 (retry)
      'verify-pass',       // Verification
    ])
    originalPath = injectMockPath(mock.dir)

    const exitCode = await orchestrate(makeCliArgs(repo))

    expect(exitCode).toBe(EXIT_CODES.SUCCESS)

    const manifest = readManifest(paths.manifestPath(repo.dir, 'test-plan'))
    expect(manifest!.phases[0].status).toBe('completed')
    expect(manifest!.phases[0].attempts).toBe(2)
  }, 30_000)

  it('should fail after max attempts reached', async () => {
    repo = setupRepo()
    // max_attempts_per_phase = 2, phase crashes both times
    mock = createMockClaudeWithSequence([
      'ok',                // preflight
      'session0-success',  // Session 0
      'crash',             // Phase attempt 1
      'crash',             // Phase attempt 2
    ])
    originalPath = injectMockPath(mock.dir)

    const exitCode = await orchestrate(makeCliArgs(repo))

    expect(exitCode).toBe(EXIT_CODES.PHASE_FAILED)

    const manifest = readManifest(paths.manifestPath(repo.dir, 'test-plan'))
    expect(manifest!.phases[0].status).toBe('failed')
    expect(manifest!.phases[0].attempts).toBe(2)
    expect(manifest!.phases[0].last_error).toBeTruthy()
  }, 30_000)

  it('should handle verification failure', async () => {
    repo = setupRepo()
    // Phase succeeds but verification fails → retry → pass
    mock = createMockClaudeWithSequence([
      'ok',                // preflight
      'session0-success',  // Session 0
      'phase-success',     // Phase attempt 1
      'verify-fail',       // Verification fails
      'phase-success',     // Phase attempt 2 (retry)
      'verify-pass',       // Verification passes
    ])
    originalPath = injectMockPath(mock.dir)

    const exitCode = await orchestrate(makeCliArgs(repo))

    expect(exitCode).toBe(EXIT_CODES.SUCCESS)

    const manifest = readManifest(paths.manifestPath(repo.dir, 'test-plan'))
    expect(manifest!.phases[0].status).toBe('completed')
    expect(manifest!.phases[0].attempts).toBe(2)
  }, 30_000)

  it('should handle --dry-run mode', async () => {
    repo = setupRepo()
    mock = createMockClaudeWithSequence([
      'session0-success',  // Session 0 (no preflight in dry-run)
    ])
    originalPath = injectMockPath(mock.dir)

    const exitCode = await orchestrate(makeCliArgs(repo, { dryRun: true }))

    expect(exitCode).toBe(EXIT_CODES.SUCCESS)

    // Verify no feature branch was created
    expect(() => repo.git('rev-parse', '--verify', 'refs/heads/feat/test-plan')).toThrow()

    // Verify manifest was created (for display) but feature branch not created
    const manifest = readManifest(paths.manifestPath(repo.dir, 'test-plan'))
    expect(manifest).not.toBeNull()
    expect(manifest!.phases[0].status).toBe('pending')
  }, 30_000)

  it('should handle --reset then start fresh', async () => {
    repo = setupRepo()

    // First run: complete successfully
    mock = createMockClaudeWithSequence([
      'ok',
      'session0-success',
      'phase-success',
      'verify-pass',
    ])
    originalPath = injectMockPath(mock.dir)
    await orchestrate(makeCliArgs(repo))
    mock.cleanup()

    // Verify first run completed
    let manifest = readManifest(paths.manifestPath(repo.dir, 'test-plan'))
    expect(manifest!.phases[0].status).toBe('completed')

    // Now --reset and run again
    mock = createMockClaudeWithSequence([
      'ok',
      'session0-success',
      'phase-success',
      'verify-pass',
    ])
    // Reset counter since it's a new mock
    process.env.PATH = `${mock.dir}:${originalPath}`

    const exitCode = await orchestrate(makeCliArgs(repo, { reset: true }))

    expect(exitCode).toBe(EXIT_CODES.SUCCESS)

    manifest = readManifest(paths.manifestPath(repo.dir, 'test-plan'))
    expect(manifest!.phases[0].status).toBe('completed')
  }, 30_000)

  it('should complete multi-phase plan', async () => {
    repo = setupRepo()
    // 2 phases: both succeed
    mock = createMockClaudeWithSequence([
      'ok',                   // preflight
      'session0-two-phases',  // Session 0 (produces 2 phases)
      'phase-success',        // Phase A execution
      'verify-pass',          // Phase A verification
      'phase-success',        // Phase B execution
      'verify-pass',          // Phase B verification
    ])
    originalPath = injectMockPath(mock.dir)

    const exitCode = await orchestrate(makeCliArgs(repo))

    expect(exitCode).toBe(EXIT_CODES.SUCCESS)

    const manifest = readManifest(paths.manifestPath(repo.dir, 'test-plan'))
    expect(manifest!.phases).toHaveLength(2)
    expect(manifest!.phases[0].status).toBe('completed')
    expect(manifest!.phases[1].status).toBe('completed')
    expect(manifest!.phases[0].merged).toBe(true)
    expect(manifest!.phases[1].merged).toBe(true)
  }, 30_000)

  it('should resume from where it left off', async () => {
    repo = setupRepo()

    // First run: session0 + phase succeeds but let the plan have 2 phases
    mock = createMockClaudeWithSequence([
      'ok',
      'session0-two-phases',
      'phase-success',     // Phase A
      'verify-pass',
      'crash',             // Phase B attempt 1 fails
      'crash',             // Phase B attempt 2 fails → terminates
    ])
    originalPath = injectMockPath(mock.dir)

    let exitCode = await orchestrate(makeCliArgs(repo))
    expect(exitCode).toBe(EXIT_CODES.PHASE_FAILED)
    mock.cleanup()

    // Resume — should skip session0 and completed phase A, retry phase B
    mock = createMockClaudeWithSequence([
      'ok',              // preflight
      'phase-success',   // Phase B retry
      'verify-pass',     // Phase B verification
    ])
    process.env.PATH = `${mock.dir}:${originalPath}`

    exitCode = await orchestrate(makeCliArgs(repo, { retry: true }))

    expect(exitCode).toBe(EXIT_CODES.SUCCESS)

    const manifest = readManifest(paths.manifestPath(repo.dir, 'test-plan'))
    expect(manifest!.phases[0].status).toBe('completed')
    expect(manifest!.phases[1].status).toBe('completed')
  }, 30_000)

  it('should fail after max attempts when setup command fails', async () => {
    repo = setupRepo()
    // Override config with a failing setup command
    repo.writeFile(
      '.auto-dev.json',
      JSON.stringify({
        base_branch: 'main',
        quality_gate: { typecheck: 'true', test: 'true' },
        setup_commands: ['false'],  // always fails with exit 1
        session_timeout_minutes: 1,
        setup_timeout_minutes: 1,
        gate_timeout_minutes: 1,
        max_attempts_per_phase: 2,
      }),
    )
    repo.git('add', '.auto-dev.json')
    repo.git('commit', '-m', 'config with failing setup')

    mock = createMockClaudeWithSequence([
      'ok',                // preflight
      'session0-success',  // Session 0
      // No phase execution — setup fails before Claude session starts
    ])
    originalPath = injectMockPath(mock.dir)

    const exitCode = await orchestrate(makeCliArgs(repo))

    expect(exitCode).toBe(EXIT_CODES.PHASE_FAILED)

    const manifest = readManifest(paths.manifestPath(repo.dir, 'test-plan'))
    expect(manifest!.phases[0].status).toBe('failed')
    expect(manifest!.phases[0].attempts).toBe(2)
    expect(manifest!.phases[0].last_error).toContain('Setup command failed')
  }, 30_000)

  it('should return correct exit code on config error', async () => {
    repo = createTempGitRepo()
    repo.writeFile('init.txt', 'init')
    repo.git('add', '-A')
    repo.git('commit', '-m', 'init')
    // No .auto-dev.json
    repo.writeFile('.claude/plans/test-plan.md', '# Plan')

    mock = createMockClaudeWithSequence(['ok'])
    originalPath = injectMockPath(mock.dir)

    const exitCode = await orchestrate(makeCliArgs(repo))

    expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR)
  }, 10_000)

  it('should return CLAUDE_UNAVAILABLE on preflight failure', async () => {
    repo = setupRepo()
    mock = createMockClaudeWithSequence([
      'crash',  // preflight fails
    ])
    originalPath = injectMockPath(mock.dir)

    const exitCode = await orchestrate(makeCliArgs(repo))

    expect(exitCode).toBe(EXIT_CODES.CLAUDE_UNAVAILABLE)
  }, 10_000)
})
