import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import { createTempGitRepo, type TempGitRepo } from '../helpers/git-repo.js'
import {
  createWorktree,
  cleanupWorktree,
  cleanupAllWorktrees,
  worktreeExists,
  WorktreeError,
} from '../../src/worktree.js'
import { worktreePath, phaseBranch } from '../../src/paths.js'
import * as git from '../../src/git.js'

describe('worktree', () => {
  let repo: TempGitRepo

  afterEach(() => {
    repo?.cleanup()
  })

  function initRepo(): TempGitRepo {
    repo = createTempGitRepo()
    // Need at least one commit for worktree operations
    repo.writeFile('README.md', '# Test')
    repo.git('add', '-A')
    repo.git('commit', '-m', 'init')
    return repo
  }

  describe('createWorktree', () => {
    it('should create a worktree at the expected path', () => {
      const r = initRepo()
      const planId = 'test-plan'
      const slug = 'db-schema'

      const wtPath = createWorktree(r.dir, planId, slug, 'main')

      expect(fs.existsSync(wtPath)).toBe(true)
      expect(wtPath).toBe(worktreePath(r.dir, planId, slug))

      // Phase branch should exist
      const branch = phaseBranch(planId, slug)
      expect(git.branchExists(branch, r.dir)).toBe(true)

      // Worktree should have the same files as main
      expect(fs.existsSync(`${wtPath}/README.md`)).toBe(true)

      // Cleanup
      git.removeWorktree(wtPath, r.dir)
      git.deleteBranch(branch, r.dir)
    })

    it('should throw WorktreeError on failure', () => {
      const r = initRepo()

      expect(() => {
        createWorktree(r.dir, 'plan', 'slug', 'nonexistent-ref')
      }).toThrow(WorktreeError)
    })
  })

  describe('cleanupWorktree', () => {
    it('should remove worktree and delete phase branch', () => {
      const r = initRepo()
      const planId = 'test-plan'
      const slug = 'cleanup-test'

      createWorktree(r.dir, planId, slug, 'main')
      const wtPath = worktreePath(r.dir, planId, slug)
      const branch = phaseBranch(planId, slug)

      expect(fs.existsSync(wtPath)).toBe(true)
      expect(git.branchExists(branch, r.dir)).toBe(true)

      cleanupWorktree(r.dir, planId, slug)

      expect(fs.existsSync(wtPath)).toBe(false)
      expect(git.branchExists(branch, r.dir)).toBe(false)
    })

    it('should not throw if worktree does not exist', () => {
      const r = initRepo()

      expect(() => {
        cleanupWorktree(r.dir, 'nonexistent', 'nonexistent')
      }).not.toThrow()
    })
  })

  describe('cleanupAllWorktrees', () => {
    it('should clean up multiple worktrees', () => {
      const r = initRepo()
      const planId = 'test-plan'
      const slugs = ['phase-a', 'phase-b']

      for (const slug of slugs) {
        createWorktree(r.dir, planId, slug, 'main')
      }

      // Verify all created
      for (const slug of slugs) {
        expect(worktreeExists(r.dir, planId, slug)).toBe(true)
      }

      cleanupAllWorktrees(r.dir, planId, slugs)

      // Verify all cleaned
      for (const slug of slugs) {
        expect(worktreeExists(r.dir, planId, slug)).toBe(false)
      }
    })

    it('should handle partial failures gracefully', () => {
      const r = initRepo()
      const planId = 'test-plan'

      createWorktree(r.dir, planId, 'exists', 'main')

      // Should not throw even if some slugs don't exist
      expect(() => {
        cleanupAllWorktrees(r.dir, planId, ['exists', 'nonexistent'])
      }).not.toThrow()

      expect(worktreeExists(r.dir, planId, 'exists')).toBe(false)
    })
  })

  describe('worktreeExists', () => {
    it('should return true for existing worktree', () => {
      const r = initRepo()
      createWorktree(r.dir, 'plan', 'slug', 'main')
      expect(worktreeExists(r.dir, 'plan', 'slug')).toBe(true)

      cleanupWorktree(r.dir, 'plan', 'slug')
    })

    it('should return false for non-existing worktree', () => {
      const r = initRepo()
      expect(worktreeExists(r.dir, 'plan', 'slug')).toBe(false)
    })
  })
})
