import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

export function repoKey(projectRoot: string): string {
  const realPath = path.resolve(projectRoot)
  const dirName = path.basename(realPath)
  const hash = crypto.createHash('sha1').update(realPath).digest('hex').slice(0, 8)
  return `${dirName}-${hash}`
}

export function gitCommonDir(projectRoot: string): string {
  return execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: projectRoot,
    encoding: 'utf-8',
  }).trim()
}

export function runtimeDir(projectRoot: string): string {
  const commonDir = gitCommonDir(projectRoot)
  const resolved = path.isAbsolute(commonDir)
    ? commonDir
    : path.resolve(projectRoot, commonDir)
  return path.join(resolved, 'auto-dev')
}

export function manifestPath(projectRoot: string, planId: string): string {
  return path.join(runtimeDir(projectRoot), 'manifests', `${planId}.json`)
}

export function candidatePath(projectRoot: string, planId: string): string {
  return path.join(runtimeDir(projectRoot), 'candidates', `${planId}.candidate.json`)
}

export function lockDir(projectRoot: string, planId: string): string {
  return path.join(runtimeDir(projectRoot), 'locks', `${planId}.lock`)
}

export function verificationDir(
  projectRoot: string,
  planId: string,
  slug: string,
  attempt: number,
): string {
  return path.join(
    runtimeDir(projectRoot),
    'verification',
    planId,
    slug,
    `attempt-${attempt}`,
  )
}

export function logDir(projectRoot: string, planId: string): string {
  return path.join(runtimeDir(projectRoot), 'logs', planId)
}

export function worktreeBase(projectRoot: string): string {
  const parentDir = path.dirname(path.resolve(projectRoot))
  return path.join(parentDir, '.auto-dev-worktrees')
}

export function worktreePath(
  projectRoot: string,
  planId: string,
  slug: string,
): string {
  return path.join(worktreeBase(projectRoot), repoKey(projectRoot), planId, slug)
}

export function featureBranch(planId: string): string {
  return `feat/${planId}`
}

export function phaseBranch(planId: string, slug: string): string {
  return `phase/${planId}/${slug}`
}

export function planIdFromFilename(planDocPath: string): string {
  return path.basename(planDocPath, path.extname(planDocPath))
}

export function relativePlanDoc(projectRoot: string, planDocPath: string): string {
  const absProject = path.resolve(projectRoot)
  const absPlan = path.resolve(planDocPath)
  return path.relative(absProject, absPlan)
}
