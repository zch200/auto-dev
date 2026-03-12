import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createTempGitRepo, type TempGitRepo } from '../helpers/git-repo.js'
import { recoverPhase, recoverManifest, reconcileInit, validateManifestConsistency } from '../../src/recovery.js'
import { atomicWriteManifest, readManifest } from '../../src/manifest.js'
import * as paths from '../../src/paths.js'
import type { Manifest, Phase } from '../../src/types.js'

function makePhase(overrides: Partial<Phase> = {}): Phase {
  return {
    slug: 'test-phase',
    order: 1,
    title: 'Test Phase',
    summary: 'A test phase',
    acceptance_criteria: ['criterion 1'],
    status: 'running',
    attempts: 1,
    last_error: null,
    feature_base_sha: null,
    phase_head_sha: null,
    merged: false,
    merge_commit_sha: null,
    ...overrides,
  }
}

function makeManifest(
  projectRoot: string,
  phases: Phase[] = [],
  overrides: Partial<Manifest> = {},
): Manifest {
  return {
    plan_id: 'test-plan',
    plan_doc: '.claude/plans/test-plan.md',
    plan_doc_hash: 'abc123',
    feature_branch: 'feat/test-plan',
    base_branch: 'main',
    quality_gate: { typecheck: 'echo ok' },
    setup_commands: [],
    session_timeout_minutes: 20,
    setup_timeout_minutes: 5,
    gate_timeout_minutes: 10,
    max_attempts_per_phase: 3,
    max_turns: 200,
    total_tokens: { input: 0, output: 0 },
    total_cost_usd: 0,
    phases,
    created_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    ...overrides,
  }
}

describe('recovery', () => {
  let repo: TempGitRepo

  afterEach(() => {
    if (repo) {
      repo.cleanup()
    }
  })

  describe('recoverPhase', () => {
    it('should mark completed when merged=true', () => {
      repo = createTempGitRepo()
      repo.writeFile('init.txt', 'init')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'init')

      const phase = makePhase({ merged: true })
      const manifest = makeManifest(repo.dir, [phase])

      const result = recoverPhase(manifest, phase, repo.dir)

      expect(result).toBe('completed')
      expect(phase.status).toBe('completed')
    })

    it('should reset to pending when no phase_head_sha', () => {
      repo = createTempGitRepo()
      repo.writeFile('init.txt', 'init')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'init')

      const phase = makePhase({ phase_head_sha: null })
      const manifest = makeManifest(repo.dir, [phase])

      const result = recoverPhase(manifest, phase, repo.dir)

      expect(result).toBe('pending')
      expect(phase.status).toBe('pending')
      expect(phase.feature_base_sha).toBeNull()
    })

    it('should reset to pending for no-op (head == base)', () => {
      repo = createTempGitRepo()
      repo.writeFile('init.txt', 'init')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'init')

      const sha = repo.git('rev-parse', 'HEAD')

      const phase = makePhase({
        feature_base_sha: sha,
        phase_head_sha: sha,
      })
      const manifest = makeManifest(repo.dir, [phase])

      const result = recoverPhase(manifest, phase, repo.dir)

      expect(result).toBe('pending')
      expect(phase.status).toBe('pending')
    })

    it('should mark completed when ancestor check passes (merge done but merged=false)', () => {
      repo = createTempGitRepo()
      repo.writeFile('init.txt', 'init')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'init')

      // Create feature branch
      repo.git('branch', 'feat/test-plan')

      // Create phase branch with a commit
      repo.git('checkout', '-b', 'phase/test-plan/test-phase')
      repo.writeFile('phase.txt', 'phase work')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'phase work')
      const phaseHeadSha = repo.git('rev-parse', 'HEAD')
      const baseSha = repo.git('rev-parse', 'feat/test-plan')

      // Merge phase into feature
      repo.git('checkout', 'feat/test-plan')
      repo.git('merge', '--no-ff', 'phase/test-plan/test-phase', '-m', 'merge phase')

      const phase = makePhase({
        feature_base_sha: baseSha,
        phase_head_sha: phaseHeadSha,
        merged: false, // Simulates crash before merged=true was written
      })
      const manifest = makeManifest(repo.dir, [phase])

      const result = recoverPhase(manifest, phase, repo.dir)

      expect(result).toBe('completed')
      expect(phase.status).toBe('completed')
      expect(phase.merged).toBe(true)
      expect(phase.merge_commit_sha).toBeTruthy()
    })

    it('should reset to pending when merge not done and worktree missing', () => {
      repo = createTempGitRepo()
      repo.writeFile('init.txt', 'init')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'init')
      const baseSha = repo.git('rev-parse', 'HEAD')

      // Create feature branch
      repo.git('branch', 'feat/test-plan')

      // Create a separate commit to simulate phase work
      repo.git('checkout', '-b', 'phase/test-plan/test-phase')
      repo.writeFile('phase.txt', 'work')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'phase')
      const phaseHeadSha = repo.git('rev-parse', 'HEAD')

      // Go back to main so worktree is not checked out
      repo.git('checkout', 'main')

      const phase = makePhase({
        feature_base_sha: baseSha,
        phase_head_sha: phaseHeadSha,
        merged: false,
      })
      const manifest = makeManifest(repo.dir, [phase])

      const result = recoverPhase(manifest, phase, repo.dir)

      expect(result).toBe('pending')
      expect(phase.status).toBe('pending')
    })
  })

  describe('recoverManifest', () => {
    it('should skip when no running phases', () => {
      repo = createTempGitRepo()
      repo.writeFile('init.txt', 'init')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'init')

      const manifest = makeManifest(repo.dir, [
        makePhase({ status: 'completed', slug: 'done' }),
        makePhase({ status: 'pending', slug: 'todo' }),
      ])

      // Create manifest dir and file
      const manifestFile = paths.manifestPath(repo.dir, manifest.plan_id)
      fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
      atomicWriteManifest(manifestFile, manifest)

      // Should not throw
      recoverManifest(manifest, repo.dir)
    })

    it('should recover running phases and persist', () => {
      repo = createTempGitRepo()
      repo.writeFile('init.txt', 'init')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'init')

      const phase = makePhase({
        status: 'running',
        slug: 'recovering',
        phase_head_sha: null,
      })
      const manifest = makeManifest(repo.dir, [phase])

      const manifestFile = paths.manifestPath(repo.dir, manifest.plan_id)
      fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
      atomicWriteManifest(manifestFile, manifest)

      recoverManifest(manifest, repo.dir)

      // Phase should be reset to pending
      expect(phase.status).toBe('pending')

      // Manifest should be persisted
      const saved = readManifest(manifestFile)
      expect(saved!.phases[0].status).toBe('pending')
    })
  })

  describe('reconcileInit', () => {
    it('should return init when neither manifest nor branch exists', () => {
      repo = createTempGitRepo()
      repo.writeFile('init.txt', 'init')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'init')

      const result = reconcileInit(repo.dir, 'test-plan', '.claude/plans/test-plan.md')
      expect(result).toBe('init')
    })

    it('should throw on inconsistency: manifest exists but branch does not', () => {
      repo = createTempGitRepo()
      repo.writeFile('init.txt', 'init')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'init')

      // Create manifest without feature branch
      const manifest = makeManifest(repo.dir, [])
      const manifestFile = paths.manifestPath(repo.dir, 'test-plan')
      fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
      atomicWriteManifest(manifestFile, manifest)

      expect(() =>
        reconcileInit(repo.dir, 'test-plan', '.claude/plans/test-plan.md'),
      ).toThrow(/状态不一致/)
    })

    it('should throw on inconsistency: branch exists but manifest does not', () => {
      repo = createTempGitRepo()
      repo.writeFile('init.txt', 'init')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'init')

      // Create feature branch without manifest
      repo.git('branch', 'feat/test-plan')

      expect(() =>
        reconcileInit(repo.dir, 'test-plan', '.claude/plans/test-plan.md'),
      ).toThrow(/状态不一致/)
    })

    it('should return ready when both exist and are consistent', () => {
      repo = createTempGitRepo()
      repo.writeFile('init.txt', 'init')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'init')

      // Create feature branch
      repo.git('branch', 'feat/test-plan')

      // Create manifest
      const manifest = makeManifest(repo.dir, [
        makePhase({ status: 'pending' }),
      ])
      const manifestFile = paths.manifestPath(repo.dir, 'test-plan')
      fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
      atomicWriteManifest(manifestFile, manifest)

      const result = reconcileInit(repo.dir, 'test-plan', '.claude/plans/test-plan.md')
      expect(result).toBe('ready')
    })
  })

  describe('validateManifestConsistency', () => {
    it('should throw when plan_doc does not match', () => {
      repo = createTempGitRepo()
      repo.writeFile('init.txt', 'init')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'init')
      repo.git('branch', 'feat/test-plan')

      const manifest = makeManifest(repo.dir, [], {
        plan_doc: '.claude/plans/other.md',
      })

      expect(() =>
        validateManifestConsistency(
          manifest,
          'test-plan',
          '.claude/plans/test-plan.md',
          repo.dir,
        ),
      ).toThrow(/不一致/)
    })

    it('should throw when base_branch is not ancestor of feature_branch', () => {
      repo = createTempGitRepo()
      repo.writeFile('init.txt', 'init')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'init')

      // Create feature branch from a different point
      repo.git('checkout', '-b', 'feat/test-plan')
      repo.writeFile('feat.txt', 'feat')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'feat')

      // Create an orphan branch as base
      repo.git('checkout', '--orphan', 'orphan')
      repo.writeFile('orphan.txt', 'orphan')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'orphan')

      const manifest = makeManifest(repo.dir, [], {
        base_branch: 'orphan',
      })

      expect(() =>
        validateManifestConsistency(
          manifest,
          'test-plan',
          '.claude/plans/test-plan.md',
          repo.dir,
        ),
      ).toThrow(/不是.*祖先/)
    })

    it('should pass for consistent state', () => {
      repo = createTempGitRepo()
      repo.writeFile('init.txt', 'init')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'init')

      repo.git('branch', 'feat/test-plan')

      const manifest = makeManifest(repo.dir, [])

      // Should not throw
      validateManifestConsistency(
        manifest,
        'test-plan',
        '.claude/plans/test-plan.md',
        repo.dir,
      )
    })

    it('should validate completed phase SHAs are ancestors', () => {
      repo = createTempGitRepo()
      repo.writeFile('init.txt', 'init')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'init')
      const baseSha = repo.git('rev-parse', 'HEAD')

      repo.git('branch', 'feat/test-plan')
      repo.git('checkout', 'feat/test-plan')
      repo.writeFile('feat.txt', 'work')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'work')
      const headSha = repo.git('rev-parse', 'HEAD')

      repo.git('checkout', 'main')

      const manifest = makeManifest(repo.dir, [
        makePhase({
          status: 'completed',
          feature_base_sha: baseSha,
          phase_head_sha: headSha,
          merge_commit_sha: headSha,
        }),
      ])

      // Should not throw
      validateManifestConsistency(
        manifest,
        'test-plan',
        '.claude/plans/test-plan.md',
        repo.dir,
      )
    })
  })
})
