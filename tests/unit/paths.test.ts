import { describe, it, expect, afterEach } from 'vitest'
import * as path from 'node:path'
import {
  repoKey,
  worktreePath,
  featureBranch,
  phaseBranch,
  planIdFromFilename,
  relativePlanDoc,
  manifestPath,
  candidatePath,
  lockDir,
  verificationDir,
  logDir,
  runtimeDir,
  worktreeBase,
} from '../../src/paths.js'
import { createTempGitRepo, type TempGitRepo } from '../helpers/git-repo.js'

describe('paths', () => {
  let repo: TempGitRepo | null = null

  afterEach(() => {
    repo?.cleanup()
    repo = null
  })

  describe('repoKey', () => {
    it('should produce {dirname}-{hash8} format', () => {
      const key = repoKey('/some/path/my-project')
      expect(key).toMatch(/^my-project-[a-f0-9]{8}$/)
    })

    it('should produce different keys for different paths', () => {
      const key1 = repoKey('/path/a/project')
      const key2 = repoKey('/path/b/project')
      expect(key1).not.toBe(key2)
    })

    it('should produce consistent keys for same path', () => {
      const key1 = repoKey('/some/path')
      const key2 = repoKey('/some/path')
      expect(key1).toBe(key2)
    })
  })

  describe('featureBranch', () => {
    it('should return feat/{planId}', () => {
      expect(featureBranch('v2.1.0')).toBe('feat/v2.1.0')
    })
  })

  describe('phaseBranch', () => {
    it('should return phase/{planId}/{slug}', () => {
      expect(phaseBranch('v2.1.0', 'db-schema')).toBe('phase/v2.1.0/db-schema')
    })
  })

  describe('planIdFromFilename', () => {
    it('should strip extension', () => {
      expect(planIdFromFilename('v2.1.0.md')).toBe('v2.1.0')
      expect(planIdFromFilename('refactor-auth.md')).toBe('refactor-auth')
    })

    it('should handle paths', () => {
      expect(planIdFromFilename('.claude/plans/v2.1.0.md')).toBe('v2.1.0')
    })
  })

  describe('relativePlanDoc', () => {
    it('should produce relative path', () => {
      const result = relativePlanDoc('/project', '/project/.claude/plans/v2.1.0.md')
      expect(result).toBe(path.join('.claude', 'plans', 'v2.1.0.md'))
    })
  })

  describe('git-dependent paths', () => {
    it('should derive runtime paths under git common dir', () => {
      repo = createTempGitRepo()
      repo.writeFile('init.txt', 'init')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'init')

      const rt = runtimeDir(repo.dir)
      expect(rt).toContain('auto-dev')

      const mp = manifestPath(repo.dir, 'v2.1.0')
      expect(mp).toContain('manifests')
      expect(mp).toContain('v2.1.0.json')

      const cp = candidatePath(repo.dir, 'v2.1.0')
      expect(cp).toContain('candidates')
      expect(cp).toContain('v2.1.0.candidate.json')

      const ld = lockDir(repo.dir, 'v2.1.0')
      expect(ld).toContain('locks')
      expect(ld).toContain('v2.1.0.lock')

      const vd = verificationDir(repo.dir, 'v2.1.0', 'db-schema', 1)
      expect(vd).toContain('verification')
      expect(vd).toContain('db-schema')
      expect(vd).toContain('attempt-1')

      const lgd = logDir(repo.dir, 'v2.1.0')
      expect(lgd).toContain('logs')
      expect(lgd).toContain('v2.1.0')
    })
  })

  describe('worktree paths', () => {
    it('should use parent directory and repo key', () => {
      const wBase = worktreeBase('/parent/project')
      expect(wBase).toBe('/parent/.auto-dev-worktrees')

      const wPath = worktreePath('/parent/project', 'v2.1.0', 'db-schema')
      expect(wPath).toContain('.auto-dev-worktrees')
      expect(wPath).toContain('v2.1.0')
      expect(wPath).toContain('db-schema')
    })
  })
})
