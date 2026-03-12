import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Phase, Manifest } from '../../src/types.js'

// Mock git before importing prompt
vi.mock('../../src/git.js', () => ({
  diffStat: vi.fn().mockReturnValue('file.ts | 10 ++++\n 1 file changed, 10 insertions(+)'),
}))

import {
  buildInitPrompt,
  buildPhasePrompt,
  buildPhaseRetryPrompt,
  buildVerificationPrompt,
} from '../../src/prompt.js'

function makePhase(overrides: Partial<Phase> = {}): Phase {
  return {
    slug: 'db-schema',
    order: 1,
    title: 'Database Schema',
    summary: 'Create DB schema',
    acceptance_criteria: ['Schema file exists', 'Tests pass'],
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

function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    plan_id: 'v1',
    plan_doc: 'plan.md',
    plan_doc_hash: 'abc123',
    feature_branch: 'feat/v1',
    base_branch: 'main',
    quality_gate: { typecheck: 'npx tsc --noEmit' },
    setup_commands: [],
    session_timeout_minutes: 20,
    setup_timeout_minutes: 5,
    gate_timeout_minutes: 10,
    max_attempts_per_phase: 3,
    max_turns: 200,
    total_tokens: { input: 0, output: 0 },
    total_cost_usd: 0,
    phases: [],
    created_at: '2026-01-01T00:00:00Z',
    last_updated: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('prompt', () => {
  describe('buildInitPrompt', () => {
    it('should include plan content and candidate path', () => {
      const prompt = buildInitPrompt('# My Plan\nPhase 1: Setup', '/tmp/candidate.json')

      expect(prompt).toContain('# My Plan')
      expect(prompt).toContain('Phase 1: Setup')
      expect(prompt).toContain('/tmp/candidate.json')
      expect(prompt).toContain('开发计划解析助手')
    })
  })

  describe('buildPhasePrompt', () => {
    it('should include phase info and plan content', () => {
      const phase = makePhase()
      const manifest = makeManifest()

      const prompt = buildPhasePrompt(phase, manifest, '# Plan', '/project')

      expect(prompt).toContain('Phase 1 - Database Schema [db-schema]')
      expect(prompt).toContain('Create DB schema')
      expect(prompt).toContain('- Schema file exists')
      expect(prompt).toContain('- Tests pass')
      expect(prompt).toContain('# Plan')
    })

    it('should include completed phases summary', () => {
      const completedPhase = makePhase({
        slug: 'setup',
        order: 1,
        title: 'Setup',
        summary: 'Initial setup',
        status: 'completed',
        feature_base_sha: 'abc',
        merge_commit_sha: 'def',
      })
      const currentPhase = makePhase({ slug: 'api', order: 2, title: 'API' })
      const manifest = makeManifest({ phases: [completedPhase, currentPhase] })

      const prompt = buildPhasePrompt(currentPhase, manifest, '# Plan', '/project')

      expect(prompt).toContain('Setup')
      expect(prompt).toContain('Initial setup')
    })

    it('should show no completed phases message when none completed', () => {
      const phase = makePhase()
      const manifest = makeManifest({ phases: [phase] })

      const prompt = buildPhasePrompt(phase, manifest, '# Plan', '/project')

      expect(prompt).toContain('无已完成的阶段')
    })
  })

  describe('buildPhaseRetryPrompt', () => {
    it('should include last error info', () => {
      const phase = makePhase({ last_error: 'L2 test failed: 3 tests failed' })
      const manifest = makeManifest()

      const prompt = buildPhaseRetryPrompt(phase, manifest, '# Plan', '/project')

      expect(prompt).toContain('L2 test failed: 3 tests failed')
      expect(prompt).toContain('重试')
      expect(prompt).toContain('上次失败原因')
    })

    it('should handle null last_error', () => {
      const phase = makePhase({ last_error: null })
      const manifest = makeManifest()

      const prompt = buildPhaseRetryPrompt(phase, manifest, '# Plan', '/project')

      expect(prompt).toContain('无错误信息')
    })

    it('should include the same phase info as first-time prompt', () => {
      const phase = makePhase({ last_error: 'error' })
      const manifest = makeManifest()

      const prompt = buildPhaseRetryPrompt(phase, manifest, '# Plan', '/project')

      expect(prompt).toContain('Phase 1 - Database Schema [db-schema]')
      expect(prompt).toContain('Create DB schema')
    })
  })

  describe('buildVerificationPrompt', () => {
    it('should include phase title, criteria, and paths', () => {
      const phase = makePhase()

      const prompt = buildVerificationPrompt(
        phase,
        '/tmp/bundle',
        '/tmp/bundle/verification.json',
      )

      expect(prompt).toContain('Database Schema')
      expect(prompt).toContain('db-schema')
      expect(prompt).toContain('- Schema file exists')
      expect(prompt).toContain('- Tests pass')
      expect(prompt).toContain('/tmp/bundle')
      expect(prompt).toContain('/tmp/bundle/verification.json')
      expect(prompt).toContain('代码审查员')
    })
  })
})
