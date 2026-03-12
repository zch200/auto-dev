import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

export interface TempDir {
  dir: string
  path: (...segments: string[]) => string
  writeFile: (relPath: string, content: string) => void
  readFile: (relPath: string) => string
  exists: (relPath: string) => boolean
  cleanup: () => void
}

export function createTempDir(prefix = 'auto-dev-test-'): TempDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))

  return {
    dir,
    path: (...segments: string[]) => path.join(dir, ...segments),
    writeFile: (relPath: string, content: string) => {
      const fullPath = path.join(dir, relPath)
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, content)
    },
    readFile: (relPath: string) => fs.readFileSync(path.join(dir, relPath), 'utf-8'),
    exists: (relPath: string) => fs.existsSync(path.join(dir, relPath)),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}
