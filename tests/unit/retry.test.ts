import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createTempGitRepo, type TempGitRepo } from '../helpers/git-repo.js'
import { computeFileHash, executeRetry, RetryError } from '../../src/retry.js'
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
    status: 'pending',
    attempts: 0,
    last_error: null,
    feature_base_sha: null,
    phase_head_sha: null,
    merged: false,
    merge_commit_sha: null,
    ...overrides,
  }
}

function makeManifest(phases: Phase[] = [], overrides: Partial<Manifest> = {}): Manifest {
  return {
    plan_id: 'test-plan',
    plan_doc: '.claude/plans/test-plan.md',
    plan_doc_hash: '',
    feature_branch: 'feat/test-plan',
    base_branch: 'main',
    quality_gate: { typecheck: 'echo old' },
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

describe('retry', () => {
  let repo: TempGitRepo
  const planDocContent = '# Test Plan\n\n## Phase 1\nDo something'

  afterEach(() => {
    if (repo) {
      repo.cleanup()
    }
  })

  describe('computeFileHash', () => {
    it('should compute consistent SHA-256 hash', () => {
      repo = createTempGitRepo()
      repo.writeFile('test.txt', 'hello world')

      const hash1 = computeFileHash(path.join(repo.dir, 'test.txt'))
      const hash2 = computeFileHash(path.join(repo.dir, 'test.txt'))

      expect(hash1).toBe(hash2)
      expect(hash1).toMatch(/^[a-f0-9]{64}$/)
    })

    it('should produce different hashes for different content', () => {
      repo = createTempGitRepo()
      repo.writeFile('a.txt', 'content A')
      repo.writeFile('b.txt', 'content B')

      const hashA = computeFileHash(path.join(repo.dir, 'a.txt'))
      const hashB = computeFileHash(path.join(repo.dir, 'b.txt'))

      expect(hashA).not.toBe(hashB)
    })
  })

  describe('executeRetry', () => {
    it('should throw when manifest does not exist', async () => {
      repo = createTempGitRepo()
      repo.writeFile('init.txt', 'init')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'init')

      repo.writeFile('.claude/plans/test-plan.md', planDocContent)

      await expect(
        executeRetry(
          repo.dir,
          'test-plan',
          path.join(repo.dir, '.claude/plans/test-plan.md'),
        ),
      ).rejects.toThrow(/manifest 不存在/)
    })

    it('should throw when plan doc hash has changed', async () => {
      repo = createTempGitRepo()
      repo.writeFile('init.txt', 'init')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'init')

      // Write plan doc
      const planPath = path.join(repo.dir, '.claude/plans/test-plan.md')
      repo.writeFile('.claude/plans/test-plan.md', planDocContent)

      // Create manifest with a different hash
      const manifest = makeManifest(
        [makePhase({ status: 'failed', attempts: 3 })],
        { plan_doc_hash: 'different-hash' },
      )
      const manifestFile = paths.manifestPath(repo.dir, 'test-plan')
      fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
      atomicWriteManifest(manifestFile, manifest)

      // Write config
      repo.writeFile(
        '.auto-dev.json',
        JSON.stringify({
          base_branch: 'main',
          quality_gate: { typecheck: 'echo ok' },
        }),
      )

      await expect(executeRetry(repo.dir, 'test-plan', planPath)).rejects.toThrow(
        /plan_doc_hash 不匹配/,
      )
    })

    it('should reset failed phases and refresh config when hash matches', async () => {
      repo = createTempGitRepo()
      repo.writeFile('init.txt', 'init')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'init')

      // Write plan doc and compute its hash
      const planPath = path.join(repo.dir, '.claude/plans/test-plan.md')
      repo.writeFile('.claude/plans/test-plan.md', planDocContent)
      const hash = computeFileHash(planPath)

      // Write new config (different from what's in manifest)
      repo.writeFile(
        '.auto-dev.json',
        JSON.stringify({
          base_branch: 'main',
          quality_gate: { typecheck: 'echo new-typecheck', test: 'echo new-test' },
          max_attempts_per_phase: 5,
        }),
      )

      // Create manifest with matching hash but failed phase
      const manifest = makeManifest(
        [
          makePhase({
            slug: 'done',
            order: 1,
            status: 'completed',
            merged: true,
          }),
          makePhase({
            slug: 'failed-phase',
            order: 2,
            status: 'failed',
            attempts: 3,
            last_error: 'L2 test failed',
          }),
          makePhase({
            slug: 'pending-phase',
            order: 3,
            status: 'pending',
          }),
        ],
        { plan_doc_hash: hash },
      )
      const manifestFile = paths.manifestPath(repo.dir, 'test-plan')
      fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
      atomicWriteManifest(manifestFile, manifest)

      const result = await executeRetry(repo.dir, 'test-plan', planPath)

      // Completed phase should remain completed
      expect(result.phases[0].status).toBe('completed')

      // Failed phase should be reset
      expect(result.phases[1].status).toBe('pending')
      expect(result.phases[1].attempts).toBe(0)
      expect(result.phases[1].last_error).toBeNull()

      // Pending phase should remain pending with reset fields
      expect(result.phases[2].status).toBe('pending')
      expect(result.phases[2].attempts).toBe(0)

      // Config should be refreshed
      expect(result.quality_gate.typecheck).toBe('echo new-typecheck')
      expect(result.quality_gate.test).toBe('echo new-test')
      expect(result.max_attempts_per_phase).toBe(5)

      // Verify persisted
      const saved = readManifest(manifestFile)
      expect(saved!.quality_gate.typecheck).toBe('echo new-typecheck')
      expect(saved!.phases[1].status).toBe('pending')
    })
  })
})
