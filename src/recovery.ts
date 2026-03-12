import * as fs from 'node:fs'
import * as path from 'node:path'
import * as git from './git.js'
import * as paths from './paths.js'
import { readManifest, atomicWriteManifest } from './manifest.js'
import { worktreeExists, cleanupWorktree } from './worktree.js'
import { logger } from './logger.js'
import type { Manifest, Phase } from './types.js'

export class RecoveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecoveryError'
  }
}

/**
 * Recover a single phase with status=running after a crash.
 * Implements the mixed-judgment strategy from DESIGN.md 6.3.
 *
 * Returns the action taken for logging/testing purposes.
 */
export function recoverPhase(
  manifest: Manifest,
  phase: Phase,
  projectRoot: string,
): 'completed' | 'pending' | 'resumed' {
  const planId = manifest.plan_id
  const featureBranch = manifest.feature_branch

  // Case 1: merged == true → crash between step ⑩ and ⑫
  if (phase.merged) {
    logger.info(
      `Recovery: phase ${phase.slug} merged=true, marking completed`,
    )
    phase.status = 'completed'
    cleanupWorktreeQuiet(projectRoot, planId, phase.slug)
    return 'completed'
  }

  // Case 2: merged == false, need further analysis
  // Check if phase_head_sha is recorded
  if (!phase.phase_head_sha) {
    // Crash before step ⑥ — session not completed or not started
    logger.info(
      `Recovery: phase ${phase.slug} has no phase_head_sha, resetting to pending`,
    )
    resetPhaseForRetry(phase)
    cleanupWorktreeQuiet(projectRoot, planId, phase.slug)
    return 'pending'
  }

  // phase_head_sha is recorded (crash after step ⑥)
  // Check if it's a no-op
  if (phase.phase_head_sha === phase.feature_base_sha) {
    // No new commits — ancestor check unreliable here
    logger.info(
      `Recovery: phase ${phase.slug} is no-op (head == base), resetting to pending`,
    )
    resetPhaseForRetry(phase)
    cleanupWorktreeQuiet(projectRoot, planId, phase.slug)
    return 'pending'
  }

  // Has new commits — use ancestor check as auxiliary signal
  const isAnc = git.isAncestor(phase.phase_head_sha, featureBranch, projectRoot)

  if (isAnc) {
    // Merge actually completed (crash between step ⑨ success and ⑩ merged=true write)
    logger.info(
      `Recovery: phase ${phase.slug} ancestor check passed, merge already done`,
    )
    phase.merged = true

    // Try to find the merge commit SHA
    const mergeCommit = git.findMergeCommit(
      featureBranch,
      phase.feature_base_sha!,
      projectRoot,
    )
    if (mergeCommit) {
      phase.merge_commit_sha = mergeCommit
    }

    phase.status = 'completed'
    cleanupWorktreeQuiet(projectRoot, planId, phase.slug)
    return 'completed'
  }

  // Merge did not happen (crash between step ⑥ and ⑨)
  // Check if worktree still exists to potentially resume
  if (worktreeExists(projectRoot, planId, phase.slug)) {
    const wtPath = paths.worktreePath(projectRoot, planId, phase.slug)
    // Worktree intact — can resume from step ⑦ (quality gates)
    logger.info(
      `Recovery: phase ${phase.slug} worktree intact, can resume quality gates`,
    )
    return 'resumed'
  }

  // Worktree gone — reset to pending
  logger.info(
    `Recovery: phase ${phase.slug} worktree missing, resetting to pending`,
  )
  resetPhaseForRetry(phase)
  return 'pending'
}

/**
 * Run crash recovery for all phases with status=running.
 * Called when manifest exists on startup.
 */
export function recoverManifest(
  manifest: Manifest,
  projectRoot: string,
): void {
  const runningPhases = manifest.phases.filter((p) => p.status === 'running')

  if (runningPhases.length === 0) {
    logger.debug('Recovery: no running phases found')
    return
  }

  logger.info(`Recovery: found ${runningPhases.length} running phase(s)`)

  for (const phase of runningPhases) {
    recoverPhase(manifest, phase, projectRoot)
  }

  // Persist recovery results
  atomicWriteManifest(
    paths.manifestPath(projectRoot, manifest.plan_id),
    manifest,
  )
}

/**
 * Initialization reconciliation (DESIGN.md 6.5).
 * Check consistency between manifest existence and feature branch existence.
 *
 * Returns 'init' if both are missing (need Session 0),
 * 'ready' if both exist and are consistent,
 * throws on inconsistency.
 */
export function reconcileInit(
  projectRoot: string,
  planId: string,
  planDocRelPath: string,
): 'init' | 'ready' {
  const manifestFilePath = paths.manifestPath(projectRoot, planId)
  const featureBranch = paths.featureBranch(planId)

  const manifest = readManifest(manifestFilePath)
  const branchExists = git.branchExists(featureBranch, projectRoot)

  if (!manifest && !branchExists) {
    // Normal initialization needed
    return 'init'
  }

  if ((!manifest && branchExists) || (manifest && !branchExists)) {
    throw new RecoveryError(
      `manifest 与 feature 分支状态不一致，请使用 --reset 清理后重新开始。` +
        ` (manifest: ${manifest ? '存在' : '不存在'}, branch ${featureBranch}: ${branchExists ? '存在' : '不存在'})`,
    )
  }

  // Both exist — validate consistency
  validateManifestConsistency(manifest!, planId, planDocRelPath, projectRoot)

  // Run crash recovery if needed
  recoverManifest(manifest!, projectRoot)

  return 'ready'
}

/**
 * Validate startup consistency when manifest and feature branch both exist.
 * DESIGN.md 6.5: startup consistency checks.
 */
export function validateManifestConsistency(
  manifest: Manifest,
  planId: string,
  planDocRelPath: string,
  projectRoot: string,
): void {
  // 0. plan_doc must match --plan argument
  if (manifest.plan_doc !== planDocRelPath) {
    throw new RecoveryError(
      `Manifest 中的计划文档路径 (${manifest.plan_doc}) 与 --plan 参数 (${planDocRelPath}) 不一致。` +
        `请使用 --reset 清理后重新开始。`,
    )
  }

  const featureBranch = manifest.feature_branch

  // 1. base_branch must be an ancestor of feature_branch
  if (!git.isAncestor(manifest.base_branch, featureBranch, projectRoot)) {
    throw new RecoveryError(
      `base_branch (${manifest.base_branch}) 不是 feature_branch (${featureBranch}) 的祖先。` +
        `请使用 --reset 或人工修复。`,
    )
  }

  // 2. For each completed phase, check SHAs are ancestors
  for (const phase of manifest.phases) {
    if (phase.status !== 'completed') continue

    if (
      phase.phase_head_sha &&
      !git.isAncestor(phase.phase_head_sha, featureBranch, projectRoot)
    ) {
      throw new RecoveryError(
        `已完成的 phase ${phase.slug} 的 phase_head_sha 不是 feature_branch 的祖先。` +
          `请使用 --reset 或人工修复。`,
      )
    }

    if (
      phase.merge_commit_sha &&
      !git.isAncestor(phase.merge_commit_sha, featureBranch, projectRoot)
    ) {
      throw new RecoveryError(
        `已完成的 phase ${phase.slug} 的 merge_commit_sha 不是 feature_branch 的祖先。` +
          `请使用 --reset 或人工修复。`,
      )
    }
  }
}

/**
 * Reset a phase's runtime fields for retry.
 */
function resetPhaseForRetry(phase: Phase): void {
  phase.status = 'pending'
  phase.feature_base_sha = null
  phase.phase_head_sha = null
  phase.merged = false
  phase.merge_commit_sha = null
}

/**
 * Quietly cleanup a worktree, ignoring errors.
 */
function cleanupWorktreeQuiet(
  projectRoot: string,
  planId: string,
  slug: string,
): void {
  try {
    cleanupWorktree(projectRoot, planId, slug)
  } catch (err) {
    logger.debug(`Recovery cleanup failed for ${slug}: ${(err as Error).message}`)
  }
}
