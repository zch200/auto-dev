import * as fs from 'node:fs'
import * as path from 'node:path'
import * as git from './git.js'
import { worktreePath, worktreeBase, repoKey, phaseBranch } from './paths.js'
import { logger } from './logger.js'

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorktreeError'
  }
}

// Patterns injected into .git/info/exclude to prevent build artifacts
// from being staged by `git add -A` in the auto-commit gate.
const GIT_EXCLUDE_PATTERNS = [
  'node_modules/',
  'dist/',
  '.vite/',
  '*.tsbuildinfo',
  'coverage/',
]

/**
 * Ensure common build-artifact patterns are listed in .git/info/exclude.
 * This prevents `git add -A` from staging node_modules, build caches, etc.
 * Uses the shared git exclude file (not .gitignore) to avoid modifying the project.
 */
function ensureGitExcludePatterns(projectRoot: string): void {
  const commonDirRel = git.gitCommonDir(projectRoot)
  const commonDir = path.resolve(projectRoot, commonDirRel)
  const excludePath = path.join(commonDir, 'info', 'exclude')

  fs.mkdirSync(path.dirname(excludePath), { recursive: true })

  let existing = ''
  try {
    existing = fs.readFileSync(excludePath, 'utf-8')
  } catch { /* file may not exist */ }

  const missing = GIT_EXCLUDE_PATTERNS.filter((p) => !existing.includes(p))
  if (missing.length === 0) return

  const needsNewline = existing.length > 0 && !existing.endsWith('\n')
  const block =
    (needsNewline ? '\n' : '') +
    '# auto-dev: prevent build artifacts from being tracked\n' +
    missing.join('\n') + '\n'

  fs.appendFileSync(excludePath, block)
  logger.debug(`Added ${missing.length} exclude pattern(s) to ${excludePath}`)
}

/**
 * Create a worktree for a phase execution.
 * git worktree add {path} -b phase/{plan_id}/{slug} {startPoint}
 */
export function createWorktree(
  projectRoot: string,
  planId: string,
  slug: string,
  startPoint: string,
): string {
  const wtPath = worktreePath(projectRoot, planId, slug)
  const branch = phaseBranch(planId, slug)

  // Clean up stale worktree from previous run (e.g. --no-cleanup or killed process)
  if (fs.existsSync(wtPath)) {
    logger.warn(`Stale worktree directory found, cleaning up: ${wtPath}`)
    try {
      git.removeWorktree(wtPath, projectRoot)
    } catch { /* ok */ }
    if (fs.existsSync(wtPath)) {
      fs.rmSync(wtPath, { recursive: true, force: true })
    }
  }

  // Clean up stale phase branch if exists
  if (git.branchExists(branch, projectRoot)) {
    logger.warn(`Stale phase branch found, deleting: ${branch}`)
    git.deleteBranch(branch, projectRoot)
  }

  // Ensure build artifacts are excluded from git tracking
  ensureGitExcludePatterns(projectRoot)

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(wtPath), { recursive: true })

  logger.debug(`Creating worktree: ${wtPath} on branch ${branch} from ${startPoint}`)

  try {
    git.addWorktree(wtPath, branch, startPoint, projectRoot)
  } catch (err) {
    throw new WorktreeError(
      `Failed to create worktree at ${wtPath}: ${(err as Error).message}`,
    )
  }

  logger.info(`Worktree created: ${wtPath}`)
  return wtPath
}

/**
 * Remove a worktree and delete its phase branch.
 */
export function cleanupWorktree(
  projectRoot: string,
  planId: string,
  slug: string,
): void {
  const wtPath = worktreePath(projectRoot, planId, slug)
  const branch = phaseBranch(planId, slug)

  logger.debug(`Cleaning up worktree: ${wtPath}`)

  // Remove worktree via git
  git.removeWorktree(wtPath, projectRoot)

  // Force remove directory if still exists (git worktree remove may leave remnants)
  if (fs.existsSync(wtPath)) {
    fs.rmSync(wtPath, { recursive: true, force: true })
  }

  // Delete the phase branch
  git.deleteBranch(branch, projectRoot)

  logger.debug(`Worktree cleaned: ${wtPath}, branch deleted: ${branch}`)
}

/**
 * Clean up all worktrees for a given plan.
 * Used by --reset to remove all phase worktrees.
 */
export function cleanupAllWorktrees(
  projectRoot: string,
  planId: string,
  slugs: string[],
): void {
  logger.debug(`Cleaning up all worktrees for plan: ${planId}`)

  for (const slug of slugs) {
    try {
      cleanupWorktree(projectRoot, planId, slug)
    } catch (err) {
      logger.warn(
        `Failed to clean worktree for ${slug}: ${(err as Error).message}`,
      )
    }
  }

  // Clean up plan directory under worktree base if empty
  const planDir = path.join(
    worktreeBase(projectRoot),
    repoKey(projectRoot),
    planId,
  )
  try {
    if (fs.existsSync(planDir)) {
      const entries = fs.readdirSync(planDir)
      if (entries.length === 0) {
        fs.rmdirSync(planDir)
      }
    }
  } catch {
    // Ignore cleanup errors for empty dirs
  }
}

/**
 * Check if a worktree directory exists on disk.
 */
export function worktreeExists(
  projectRoot: string,
  planId: string,
  slug: string,
): boolean {
  const wtPath = worktreePath(projectRoot, planId, slug)
  return fs.existsSync(wtPath)
}
