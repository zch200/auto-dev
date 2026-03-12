import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Manifest } from './types.js'
import { logger } from './logger.js'

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

export function atomicWriteManifest(filePath: string, manifest: Manifest): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })

  // Backup current file if it exists and is valid
  if (fs.existsSync(filePath)) {
    try {
      const existing = fs.readFileSync(filePath, 'utf-8')
      JSON.parse(existing) // Validate it's parseable
      fs.copyFileSync(filePath, filePath + '.bak')
    } catch {
      // Current file is corrupt, don't back it up
    }
  }

  // Update timestamp
  manifest.last_updated = new Date().toISOString()

  // Write to temp file
  const tmpPath = filePath + '.tmp'
  const content = JSON.stringify(manifest, null, 2)
  const fd = fs.openSync(tmpPath, 'w')
  try {
    fs.writeSync(fd, content)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }

  // Atomic rename
  fs.renameSync(tmpPath, filePath)
}

export function readManifest(filePath: string): Manifest | null {
  // Try primary file
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      return JSON.parse(content) as Manifest
    } catch {
      // Primary file is corrupt, try backup
      logger.warn(`Manifest 文件损坏，尝试从备份恢复: ${filePath}`)
    }
  } else {
    // File doesn't exist — normal for first run
    return null
  }

  // Try backup
  const bakPath = filePath + '.bak'
  if (fs.existsSync(bakPath)) {
    try {
      const bakContent = fs.readFileSync(bakPath, 'utf-8')
      const manifest = JSON.parse(bakContent) as Manifest
      // Restore backup as primary
      atomicWriteManifest(filePath, manifest)
      logger.warn(`已从备份恢复 manifest: ${bakPath}`)
      return manifest
    } catch {
      throw new ManifestError(
        `Manifest 主文件和备份均已损坏。请使用 --reset 清理后重新开始。`,
      )
    }
  }

  throw new ManifestError(
    `Manifest 文件损坏且无可用备份。请使用 --reset 清理后重新开始。`,
  )
}

export function deleteManifest(filePath: string): void {
  try {
    fs.unlinkSync(filePath)
  } catch {
    // File may not exist
  }
  try {
    fs.unlinkSync(filePath + '.bak')
  } catch {
    // Backup may not exist
  }
  try {
    fs.unlinkSync(filePath + '.tmp')
  } catch {
    // Temp may not exist
  }
}
