import * as fs from 'node:fs'
import * as path from 'node:path'
import * as git from './git.js'
import { verificationDir } from './paths.js'
import { logger } from './logger.js'
import type { Phase, VerificationResult } from './types.js'

export class VerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VerificationError'
  }
}

export interface BundleMetadata {
  plan_id: string
  slug: string
  order: number
  title: string
  attempt: number
  feature_base_sha: string
  phase_head_sha: string
  worktree_path: string
}

export interface ChangedFileEntry {
  path: string
  status: string
  additions: number
  deletions: number
}

/**
 * Generate the verification bundle for a phase.
 * Returns the bundle directory path, or null if no-op (no changes).
 */
export function generateBundle(
  projectRoot: string,
  planId: string,
  phase: Phase,
  attempt: number,
  worktreePath: string,
): string | null {
  const baseSha = phase.feature_base_sha!
  const headSha = phase.phase_head_sha!

  // Check for no-op (no new commits)
  if (baseSha === headSha) {
    logger.info('No-op detected: phase produced no new commits, skipping verification')
    return null
  }

  const bundleDir = verificationDir(projectRoot, planId, phase.slug, attempt)
  fs.mkdirSync(bundleDir, { recursive: true })

  // 1. metadata.json
  const metadata: BundleMetadata = {
    plan_id: planId,
    slug: phase.slug,
    order: phase.order,
    title: phase.title,
    attempt,
    feature_base_sha: baseSha,
    phase_head_sha: headSha,
    worktree_path: worktreePath,
  }
  fs.writeFileSync(
    path.join(bundleDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2),
  )

  // 2. diff.stat.txt
  try {
    const stat = git.diffStat(baseSha, headSha, worktreePath)
    fs.writeFileSync(path.join(bundleDir, 'diff.stat.txt'), stat)
  } catch (err) {
    logger.warn(`Failed to generate diff stat: ${(err as Error).message}`)
    fs.writeFileSync(path.join(bundleDir, 'diff.stat.txt'), '')
  }

  // 3. changed-files.json
  const changedFileEntries = buildChangedFiles(baseSha, headSha, worktreePath)
  fs.writeFileSync(
    path.join(bundleDir, 'changed-files.json'),
    JSON.stringify(changedFileEntries, null, 2),
  )

  // 4. patches/*.diff — per-file patches
  const patchesDir = path.join(bundleDir, 'patches')
  fs.mkdirSync(patchesDir, { recursive: true })

  for (const entry of changedFileEntries) {
    try {
      const patch = git.diffFile(baseSha, headSha, entry.path, worktreePath)
      if (patch) {
        // Sanitize filename: replace / with __
        const safeName = entry.path.replace(/\//g, '__') + '.diff'
        fs.writeFileSync(path.join(patchesDir, safeName), patch)
      }
    } catch (err) {
      logger.debug(`Failed to generate patch for ${entry.path}: ${(err as Error).message}`)
    }
  }

  logger.info(`Verification bundle generated: ${bundleDir} (${changedFileEntries.length} files)`)
  return bundleDir
}

/**
 * Build changed files list with line counts from git diff --numstat.
 */
function buildChangedFiles(
  baseSha: string,
  headSha: string,
  cwd: string,
): ChangedFileEntry[] {
  const entries: ChangedFileEntry[] = []

  // Get name-status for status info
  let nameStatusOutput: string
  try {
    nameStatusOutput = git.diffNameStatus(baseSha, headSha, cwd)
  } catch {
    return entries
  }

  if (!nameStatusOutput) return entries

  // Build status map
  const statusMap = new Map<string, string>()
  for (const line of nameStatusOutput.split('\n').filter(Boolean)) {
    const parts = line.split('\t')
    if (parts.length >= 2) {
      statusMap.set(parts[1], parts[0])
    }
  }

  // Get numstat for line counts
  let numstatOutput: string
  try {
    numstatOutput = git.diffNumstat(baseSha, headSha, cwd)
  } catch {
    // Fallback: use name-status only
    for (const [filePath, status] of statusMap) {
      entries.push({ path: filePath, status, additions: 0, deletions: 0 })
    }
    return entries
  }

  if (!numstatOutput) {
    for (const [filePath, status] of statusMap) {
      entries.push({ path: filePath, status, additions: 0, deletions: 0 })
    }
    return entries
  }

  for (const line of numstatOutput.split('\n').filter(Boolean)) {
    const parts = line.split('\t')
    if (parts.length >= 3) {
      const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10)
      const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10)
      const filePath = parts[2]
      entries.push({
        path: filePath,
        status: statusMap.get(filePath) || 'M',
        additions,
        deletions,
      })
    }
  }

  return entries
}

/**
 * Read and validate verification.json output from verification session.
 */
export function readVerificationResult(
  verificationJsonPath: string,
): VerificationResult {
  if (!fs.existsSync(verificationJsonPath)) {
    throw new VerificationError(
      `Verification result file not found: ${verificationJsonPath}`,
    )
  }

  let content: string
  try {
    content = fs.readFileSync(verificationJsonPath, 'utf-8')
  } catch (err) {
    throw new VerificationError(
      `Failed to read verification result: ${(err as Error).message}`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    throw new VerificationError(
      `Verification result is not valid JSON: ${(err as Error).message}`,
    )
  }

  return validateVerificationResult(parsed)
}

/**
 * Validate the structure of a verification result.
 */
export function validateVerificationResult(raw: unknown): VerificationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new VerificationError('Verification result must be a JSON object')
  }

  const obj = raw as Record<string, unknown>

  if (!Array.isArray(obj.criteria)) {
    throw new VerificationError('Verification result must contain a criteria array')
  }

  if (obj.criteria.length === 0) {
    throw new VerificationError('Verification result criteria array must not be empty')
  }

  for (let i = 0; i < obj.criteria.length; i++) {
    const criterion = obj.criteria[i]
    if (typeof criterion !== 'object' || criterion === null) {
      throw new VerificationError(`criteria[${i}] must be an object`)
    }
    const c = criterion as Record<string, unknown>
    if (typeof c.description !== 'string' || !c.description.trim()) {
      throw new VerificationError(`criteria[${i}].description must be a non-empty string`)
    }
    if (typeof c.met !== 'boolean') {
      throw new VerificationError(`criteria[${i}].met must be a boolean`)
    }
    if (typeof c.evidence !== 'string') {
      throw new VerificationError(`criteria[${i}].evidence must be a string`)
    }
  }

  if (obj.overall !== 'pass' && obj.overall !== 'fail') {
    throw new VerificationError('Verification result overall must be "pass" or "fail"')
  }

  return obj as unknown as VerificationResult
}

/**
 * Get the path where verification.json should be written.
 */
export function verificationJsonPath(bundleDir: string): string {
  return path.join(bundleDir, 'verification.json')
}
