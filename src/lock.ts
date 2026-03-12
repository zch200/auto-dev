import * as fs from 'node:fs'
import * as path from 'node:path'
import type { LockOwner } from './types.js'
import { logger } from './logger.js'

export class LockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LockError'
  }
}

function ownerFilePath(lockDirPath: string): string {
  return path.join(lockDirPath, 'owner.json')
}

function writeOwner(lockDirPath: string): void {
  const owner: LockOwner = {
    pid: process.pid,
    started_at: new Date().toISOString(),
  }
  fs.writeFileSync(ownerFilePath(lockDirPath), JSON.stringify(owner, null, 2))
}

function readOwner(lockDirPath: string): LockOwner | null {
  try {
    const content = fs.readFileSync(ownerFilePath(lockDirPath), 'utf-8')
    const owner = JSON.parse(content) as LockOwner
    if (typeof owner.pid !== 'number') return null
    return owner
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function removeLock(lockDirPath: string): void {
  try {
    fs.rmSync(lockDirPath, { recursive: true })
  } catch {
    // Already gone
  }
}

export function acquireLock(lockDirPath: string, planId: string): void {
  const parentDir = path.dirname(lockDirPath)
  fs.mkdirSync(parentDir, { recursive: true })

  try {
    fs.mkdirSync(lockDirPath)
    writeOwner(lockDirPath)
    logger.debug(`Lock acquired: ${lockDirPath}`)
    return
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err
    }
  }

  // Lock directory already exists — check if it's stale
  const owner = readOwner(lockDirPath)

  if (owner && isProcessAlive(owner.pid)) {
    throw new LockError(
      `计划 ${planId} 已有进程 (PID: ${owner.pid}) 在运行，启动于 ${owner.started_at}`,
    )
  }

  // Stale lock — reclaim
  logger.info(`回收过期锁 (PID: ${owner?.pid ?? 'unknown'})`)
  removeLock(lockDirPath)

  // Retry once
  try {
    fs.mkdirSync(lockDirPath)
    writeOwner(lockDirPath)
    logger.debug(`Lock acquired after stale reclaim: ${lockDirPath}`)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new LockError(
        `计划 ${planId} 的锁被另一个进程抢先获取`,
      )
    }
    throw err
  }
}

export function releaseLock(lockDirPath: string): void {
  removeLock(lockDirPath)
  logger.debug(`Lock released: ${lockDirPath}`)
}

export function registerLockCleanup(lockDirPath: string): void {
  const handler = () => {
    try {
      removeLock(lockDirPath)
    } catch {
      // Best effort
    }
    process.exit(1)
  }

  process.on('SIGINT', handler)
  process.on('SIGTERM', handler)
  process.on('SIGHUP', handler)
}
