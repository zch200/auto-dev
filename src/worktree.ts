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
