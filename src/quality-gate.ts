import * as git from './git.js'
import { runWithTimeout } from './timeout.js'
import { logger } from './logger.js'
import type { QualityGate } from './types.js'

export class QualityGateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QualityGateError'
  }
}

export interface GateResult {
  passed: boolean
  error?: string
  output?: string
}

/**
 * Assert that the worktree is clean: no tracked modifications, no untracked non-ignored files.
 * gitignored files (node_modules, build cache) are allowed.
 */
export function assertCleanTree(cwd: string): GateResult {
  if (git.hasTrackedChanges(cwd)) {
    return {
      passed: false,
      error: 'Worktree has tracked modifications',
    }
  }

  const untracked = git.getUntrackedFiles(cwd)
  if (untracked.length > 0) {
    return {
      passed: false,
      error: `Worktree has untracked non-ignored files: ${untracked.join(', ')}`,
    }
  }

  return { passed: true }
}

/**
 * Run a single gate command (typecheck or test) with timeout.
 * Uses shell execution for commands like "npx tsc --noEmit".
 */
export async function runGateCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<GateResult> {
  logger.debug(`Running gate command: ${command} in ${cwd}`)

  const result = await runWithTimeout('sh', ['-c', command], {
    timeoutMs,
    cwd,
  })

  if (result.timedOut) {
    return {
      passed: false,
      error: `Gate command timed out after ${timeoutMs}ms: ${command}`,
      output: result.stderr || result.stdout,
    }
  }

  if (result.exitCode !== 0) {
    return {
      passed: false,
      error: `Gate command failed (exit ${result.exitCode}): ${command}`,
      output: result.stderr || result.stdout,
    }
  }

  return { passed: true, output: result.stdout }
}

/**
 * Auto-commit gate: when session leaves uncommitted changes,
 * run typecheck first. Pass → auto-commit. Fail → discard.
 */
export async function autoCommitGate(
  cwd: string,
  typecheckCommand: string | undefined,
  timeoutMs: number,
): Promise<GateResult> {
  if (!git.hasUncommittedChanges(cwd)) {
    return { passed: true }
  }

  logger.info('Session left uncommitted changes, running auto-commit gate')

  // Stage all changes for typecheck
  git.addAll(cwd)

  if (typecheckCommand) {
    const result = await runGateCommand(typecheckCommand, cwd, timeoutMs)
    if (!result.passed) {
      // Typecheck failed → discard all changes
      logger.warn('Auto-commit gate: typecheck failed, discarding changes')
      git.resetHard(cwd)
      git.cleanForce(cwd)
      return {
        passed: false,
        error: `Session ended with uncommitted changes that failed typecheck: ${result.error}`,
        output: result.output,
      }
    }
  }

  // Typecheck passed (or no typecheck) → auto-commit
  try {
    git.commit('auto-commit: uncommitted changes from session', cwd)
    logger.info('Auto-commit gate: changes committed successfully')
    return { passed: true }
  } catch (err) {
    // Nothing to commit (e.g., only gitignored files changed)
    logger.debug(`Auto-commit: ${(err as Error).message}`)
    return { passed: true }
  }
}

/**
 * Run L1 (typecheck) + L2 (test) quality gates.
 * After each command, assert worktree is clean.
 */
export async function runQualityGates(
  qualityGate: QualityGate,
  cwd: string,
  timeoutMs: number,
): Promise<GateResult> {
  // L1: typecheck
  if (qualityGate.typecheck) {
    logger.info(`L1 typecheck: ${qualityGate.typecheck}`)

    const typecheckResult = await runGateCommand(
      qualityGate.typecheck,
      cwd,
      timeoutMs,
    )
    if (!typecheckResult.passed) {
      return {
        passed: false,
        error: `L1 typecheck failed: ${typecheckResult.error}`,
        output: typecheckResult.output,
      }
    }

    // Assert clean tree after typecheck
    const cleanAfterTypecheck = assertCleanTree(cwd)
    if (!cleanAfterTypecheck.passed) {
      return {
        passed: false,
        error: `Worktree dirty after typecheck: ${cleanAfterTypecheck.error}`,
      }
    }
  }

  // L2: test
  if (qualityGate.test) {
    logger.info(`L2 test: ${qualityGate.test}`)

    const testResult = await runGateCommand(qualityGate.test, cwd, timeoutMs)
    if (!testResult.passed) {
      return {
        passed: false,
        error: `L2 test failed: ${testResult.error}`,
        output: testResult.output,
      }
    }

    // Assert clean tree after test
    const cleanAfterTest = assertCleanTree(cwd)
    if (!cleanAfterTest.passed) {
      return {
        passed: false,
        error: `Worktree dirty after test: ${cleanAfterTest.error}`,
      }
    }
  }

  logger.info('Quality gates passed')
  return { passed: true }
}

/**
 * Run setup commands in the worktree with timeout.
 * After all commands run, assert worktree is clean.
 */
export async function runSetupCommands(
  commands: string[],
  cwd: string,
  timeoutMs: number,
): Promise<GateResult> {
  for (const cmd of commands) {
    logger.info(`Running setup command: ${cmd}`)
    const result = await runGateCommand(cmd, cwd, timeoutMs)
    if (!result.passed) {
      return {
        passed: false,
        error: `Setup command failed: ${result.error}`,
        output: result.output,
      }
    }
  }

  // Assert clean tree after setup
  const cleanResult = assertCleanTree(cwd)
  if (!cleanResult.passed) {
    return {
      passed: false,
      error: `Worktree dirty after setup commands: ${cleanResult.error}`,
    }
  }

  return { passed: true }
}

/**
 * Preflight health check: run quality gates on the worktree before starting Claude session.
 * Ensures the feature branch is healthy.
 */
export async function runPreflightCheck(
  qualityGate: QualityGate,
  cwd: string,
  timeoutMs: number,
): Promise<GateResult> {
  logger.info('Running preflight health check')
  return runQualityGates(qualityGate, cwd, timeoutMs)
}
