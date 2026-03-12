import { describe, it, expect, afterEach } from 'vitest'
import {
  revParse,
  branchExists,
  createBranch,
  deleteBranch,
  checkout,
  mergeNoFf,
  isAncestor,
  mergeBase,
  diffStat,
  changedFiles,
  hasUncommittedChanges,
  isCleanTree,
  addAll,
  commit,
  currentBranch,
  getUntrackedFiles,
} from '../../src/git.js'
import { createTempGitRepo, type TempGitRepo } from '../helpers/git-repo.js'

describe('git', () => {
  let repo: TempGitRepo

  afterEach(() => {
    repo?.cleanup()
  })

  function initRepo(): TempGitRepo {
    repo = createTempGitRepo()
    repo.writeFile('init.txt', 'initial')
    repo.git('add', '-A')
    repo.git('commit', '-m', 'initial commit')
    return repo
  }

  describe('revParse', () => {
    it('should resolve HEAD', () => {
      initRepo()
      const sha = revParse('HEAD', repo.dir)
      expect(sha).toMatch(/^[a-f0-9]{40}$/)
    })
  })

  describe('branchExists', () => {
    it('should detect existing branch', () => {
      initRepo()
      expect(branchExists('main', repo.dir)).toBe(true)
    })

    it('should return false for non-existing branch', () => {
      initRepo()
      expect(branchExists('nonexistent', repo.dir)).toBe(false)
    })
  })

  describe('createBranch / deleteBranch', () => {
    it('should create and delete branch', () => {
      initRepo()
      createBranch('feat/test', 'main', repo.dir)
      expect(branchExists('feat/test', repo.dir)).toBe(true)
      deleteBranch('feat/test', repo.dir)
      expect(branchExists('feat/test', repo.dir)).toBe(false)
    })
  })

  describe('checkout', () => {
    it('should switch branches', () => {
      initRepo()
      createBranch('feat/test', 'main', repo.dir)
      checkout('feat/test', repo.dir)
      expect(currentBranch(repo.dir)).toBe('feat/test')
    })
  })

  describe('mergeNoFf', () => {
    it('should create merge commit', () => {
      initRepo()
      createBranch('feature', 'main', repo.dir)
      checkout('feature', repo.dir)
      repo.writeFile('feature.txt', 'feature work')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'feature commit')
      const featureHead = revParse('HEAD', repo.dir)

      checkout('main', repo.dir)
      mergeNoFf('feature', 'Merge feature', repo.dir)
      const mergeHead = revParse('HEAD', repo.dir)
      expect(mergeHead).not.toBe(featureHead)
      expect(isAncestor(featureHead, mergeHead, repo.dir)).toBe(true)
    })
  })

  describe('isAncestor', () => {
    it('should return true for ancestor', () => {
      initRepo()
      const base = revParse('HEAD', repo.dir)
      repo.writeFile('new.txt', 'new')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'new commit')
      const head = revParse('HEAD', repo.dir)
      expect(isAncestor(base, head, repo.dir)).toBe(true)
    })

    it('should return false for non-ancestor', () => {
      initRepo()
      const base = revParse('HEAD', repo.dir)
      createBranch('other', 'main', repo.dir)
      checkout('other', repo.dir)
      repo.writeFile('other.txt', 'other')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'other commit')
      const otherHead = revParse('HEAD', repo.dir)
      // otherHead is not ancestor of base
      expect(isAncestor(otherHead, base, repo.dir)).toBe(false)
    })
  })

  describe('mergeBase', () => {
    it('should find common ancestor', () => {
      initRepo()
      const initial = revParse('HEAD', repo.dir)
      createBranch('branch-a', 'main', repo.dir)
      checkout('branch-a', repo.dir)
      repo.writeFile('a.txt', 'a')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'a')

      checkout('main', repo.dir)
      repo.writeFile('b.txt', 'b')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'b')

      const mb = mergeBase('main', 'branch-a', repo.dir)
      expect(mb).toBe(initial)
    })
  })

  describe('changedFiles', () => {
    it('should list changed files between refs', () => {
      initRepo()
      const base = revParse('HEAD', repo.dir)
      repo.writeFile('new-file.ts', 'content')
      repo.writeFile('another.ts', 'content2')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'add files')
      const head = revParse('HEAD', repo.dir)
      const files = changedFiles(base, head, repo.dir)
      expect(files).toContain('new-file.ts')
      expect(files).toContain('another.ts')
    })
  })

  describe('clean tree detection', () => {
    it('should detect clean tree', () => {
      initRepo()
      expect(isCleanTree(repo.dir)).toBe(true)
    })

    it('should detect uncommitted changes', () => {
      initRepo()
      repo.writeFile('dirty.txt', 'dirty')
      expect(hasUncommittedChanges(repo.dir)).toBe(true)
      expect(isCleanTree(repo.dir)).toBe(false)
    })

    it('should detect untracked files', () => {
      initRepo()
      repo.writeFile('untracked.txt', 'untracked')
      const untracked = getUntrackedFiles(repo.dir)
      expect(untracked).toContain('untracked.txt')
    })
  })

  describe('addAll / commit', () => {
    it('should stage and commit all changes', () => {
      initRepo()
      repo.writeFile('new.txt', 'content')
      addAll(repo.dir)
      commit('test commit', repo.dir)
      expect(isCleanTree(repo.dir)).toBe(true)
    })
  })

  describe('diffStat', () => {
    it('should produce diff stats', () => {
      initRepo()
      const base = revParse('HEAD', repo.dir)
      repo.writeFile('added.ts', 'export const x = 1;\n')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'add file')
      const head = revParse('HEAD', repo.dir)
      const stat = diffStat(base, head, repo.dir)
      expect(stat).toContain('added.ts')
    })
  })
})
