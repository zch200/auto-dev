import * as fs from 'node:fs'
import * as crypto from 'node:crypto'
import * as path from 'node:path'
import { loadConfig, applyDefaults } from './config.js'
import { readManifest, atomicWriteManifest } from './manifest.js'
import { cleanupWorktree, worktreeExists } from './worktree.js'
import * as git from './git.js'
import * as paths from './paths.js'
import { logger } from './logger.js'
import type { Manifest } from './types.js'

export class RetryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RetryError'
  }
}

/**
 * Compute SHA-256 hash of a file's content.
 */
export function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8')
  return crypto.createHash('sha256').update(content).digest('hex')
}

/**
 * Execute --retry logic (DESIGN.md 8.3).
 *
 * 1. Compare current plan doc hash with manifest's plan_doc_hash
 * 2. If same: reset failed/pending phases, refresh config, continue
 * 3. If different: block — must use --reset instead
 *
 * Returns the updated manifest ready for execution.
 */
export function executeRetry(
  projectRoot: string,
  planId: string,
  planDocPath: string,
): Manifest {
  const manifestFilePath = paths.manifestPath(projectRoot, planId)
  const manifest = readManifest(manifestFilePath)

  if (!manifest) {
    throw new RetryError(
      `计划 ${planId} 的 manifest 不存在。请先运行 auto-dev start。`,
    )
  }

  // 1. Compare plan_doc_hash
  const absPlanDoc = path.resolve(planDocPath)
  const currentHash = computeFileHash(absPlanDoc)

  if (currentHash !== manifest.plan_doc_hash) {
    throw new RetryError(
      `计划文档已变更（plan_doc_hash 不匹配），--retry 仅适用于计划未修改的情况。` +
        `请使用 --reset 从头开始，或使用新的 plan_id。`,
    )
  }

  // 2. Clean up residual worktrees/branches for failed phases
  for (const phase of manifest.phases) {
    if (phase.status === 'failed' || phase.status === 'pending') {
      cleanupResidual(projectRoot, planId, phase.slug)
    }
  }

  // 3. Reset all failed and pending phases
  for (const phase of manifest.phases) {
    if (phase.status === 'failed' || phase.status === 'pending') {
      phase.status = 'pending'
      phase.attempts = 0
      phase.last_error = null
      phase.feature_base_sha = null
      phase.phase_head_sha = null
      phase.merged = false
      phase.merge_commit_sha = null
    }
  }

  // 4. Refresh non-phase config from current .auto-dev.json
  const config = loadConfig(projectRoot)
  const resolved = applyDefaults(config)

  manifest.quality_gate = resolved.quality_gate
  manifest.setup_commands = resolved.setup_commands
  manifest.session_timeout_minutes = resolved.session_timeout_minutes
  manifest.setup_timeout_minutes = resolved.setup_timeout_minutes
  manifest.gate_timeout_minutes = resolved.gate_timeout_minutes
  manifest.max_attempts_per_phase = resolved.max_attempts_per_phase
  manifest.max_turns = resolved.max_turns

  // 5. Persist
  atomicWriteManifest(manifestFilePath, manifest)

  logger.info(
    `Retry: 已重置 ${manifest.phases.filter((p) => p.status === 'pending').length} 个 phase，配置已刷新`,
  )

  return manifest
}

/**
 * Clean up residual worktree and phase branch for a phase.
 */
function cleanupResidual(
  projectRoot: string,
  planId: string,
  slug: string,
): void {
  try {
    if (worktreeExists(projectRoot, planId, slug)) {
      cleanupWorktree(projectRoot, planId, slug)
    } else {
      // Just try to delete the branch in case worktree was already removed
      const branch = paths.phaseBranch(planId, slug)
      git.deleteBranch(branch, projectRoot)
    }
  } catch (err) {
    logger.debug(`Retry cleanup failed for ${slug}: ${(err as Error).message}`)
  }
}
