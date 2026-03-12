import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFileSync } from 'node:child_process'

export interface TempGitRepo {
  dir: string
  git: (...args: string[]) => string
  writeFile: (relPath: string, content: string) => void
  readFile: (relPath: string) => string
  cleanup: () => void
}

export function createTempGitRepo(options?: { bare?: boolean }): TempGitRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-dev-test-'))

  const git = (...args: string[]): string => {
    return execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      },
    }).trim()
  }

  if (options?.bare) {
    git('init', '--bare')
  } else {
    git('init')
    git('checkout', '-b', 'main')
  }

  const writeFile = (relPath: string, content: string) => {
    const fullPath = path.join(dir, relPath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content)
  }

  const readFile = (relPath: string): string => {
    return fs.readFileSync(path.join(dir, relPath), 'utf-8')
  }

  const cleanup = () => {
    fs.rmSync(dir, { recursive: true, force: true })
  }

  return { dir, git, writeFile, readFile, cleanup }
}
