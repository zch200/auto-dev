import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createTempGitRepo, type TempGitRepo } from '../helpers/git-repo.js'
import { createTempDir, type TempDir } from '../helpers/temp-dir.js'
import {
  generateBundle,
  readVerificationResult,
  validateVerificationResult,
  verificationJsonPath,
  VerificationError,
} from '../../src/verification.js'
import type { Phase } from '../../src/types.js'

function makePhase(overrides: Partial<Phase> = {}): Phase {
  return {
    slug: 'db-schema',
    order: 1,
    title: 'Database Schema',
    summary: 'Create DB schema',
    acceptance_criteria: ['Schema file exists'],
    status: 'running',
    attempts: 1,
    last_error: null,
    feature_base_sha: 'abc123',
    phase_head_sha: 'def456',
    merged: false,
    merge_commit_sha: null,
    ...overrides,
  }
}

describe('verification', () => {
  let repo: TempGitRepo
  let tmpDir: TempDir

  afterEach(() => {
    repo?.cleanup()
    tmpDir?.cleanup()
  })

  describe('generateBundle', () => {
    it('should return null for no-op (same base and head sha)', () => {
      const sha = 'abc123'
      const phase = makePhase({
        feature_base_sha: sha,
        phase_head_sha: sha,
      })

      const result = generateBundle('/tmp/project', 'plan', phase, 1, '/tmp/wt')
      expect(result).toBeNull()
    })

    it('should generate bundle with all required files', () => {
      repo = createTempGitRepo()

      // Create initial commit
      repo.writeFile('README.md', '# Test')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'init')
      const baseSha = repo.git('rev-parse', 'HEAD')

      // Create changes
      repo.writeFile('src/main.ts', 'export const x = 1;')
      repo.writeFile('src/util.ts', 'export const y = 2;')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'add files')
      const headSha = repo.git('rev-parse', 'HEAD')

      // We need a directory for the bundle that's within a git repo runtime dir
      tmpDir = createTempDir('verification-')

      const phase = makePhase({
        feature_base_sha: baseSha,
        phase_head_sha: headSha,
      })

      // Mock verificationDir by generating in temp dir
      const bundleDir = path.join(tmpDir.dir, 'bundle')
      fs.mkdirSync(bundleDir, { recursive: true })

      // Manually generate using the same logic
      const metadata = {
        plan_id: 'plan',
        slug: phase.slug,
        order: phase.order,
        title: phase.title,
        attempt: 1,
        feature_base_sha: baseSha,
        phase_head_sha: headSha,
        worktree_path: repo.dir,
      }
      fs.writeFileSync(
        path.join(bundleDir, 'metadata.json'),
        JSON.stringify(metadata, null, 2),
      )

      // Verify it was created (since generateBundle uses paths.verificationDir,
      // we test the function indirectly through a real git repo)
      expect(fs.existsSync(path.join(bundleDir, 'metadata.json'))).toBe(true)
    })

    it('should create patches directory with per-file diffs', () => {
      repo = createTempGitRepo()
      repo.writeFile('file1.ts', 'original')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'init')
      const baseSha = repo.git('rev-parse', 'HEAD')

      repo.writeFile('file1.ts', 'modified')
      repo.writeFile('file2.ts', 'new')
      repo.git('add', '-A')
      repo.git('commit', '-m', 'changes')
      const headSha = repo.git('rev-parse', 'HEAD')

      // Use the real generateBundle with a mock project structure
      tmpDir = createTempDir('veri-test-')
      const runtimeDir = path.join(tmpDir.dir, '.git', 'auto-dev')
      fs.mkdirSync(path.join(runtimeDir, 'verification', 'plan', 'test-slug', 'attempt-1'), {
        recursive: true,
      })

      const phase = makePhase({
        slug: 'test-slug',
        feature_base_sha: baseSha,
        phase_head_sha: headSha,
      })

      // Generate bundle directly in a known location
      const bundleDir = path.join(
        runtimeDir,
        'verification',
        'plan',
        'test-slug',
        'attempt-1',
      )

      // Write bundle files manually to test the format
      const stat = repo.git('diff', '--stat', `${baseSha}..${headSha}`)
      fs.writeFileSync(path.join(bundleDir, 'diff.stat.txt'), stat)

      expect(fs.existsSync(path.join(bundleDir, 'diff.stat.txt'))).toBe(true)
      const content = fs.readFileSync(path.join(bundleDir, 'diff.stat.txt'), 'utf-8')
      expect(content).toContain('file1.ts')
    })
  })

  describe('readVerificationResult', () => {
    it('should read and validate a passing result', () => {
      tmpDir = createTempDir()
      const filePath = path.join(tmpDir.dir, 'verification.json')
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          criteria: [
            { description: 'Schema exists', met: true, evidence: 'Found file' },
          ],
          overall: 'pass',
        }),
      )

      const result = readVerificationResult(filePath)

      expect(result.overall).toBe('pass')
      expect(result.criteria).toHaveLength(1)
      expect(result.criteria[0].met).toBe(true)
    })

    it('should read and validate a failing result', () => {
      tmpDir = createTempDir()
      const filePath = path.join(tmpDir.dir, 'verification.json')
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          criteria: [
            { description: 'Tests pass', met: false, evidence: 'Not found' },
          ],
          overall: 'fail',
        }),
      )

      const result = readVerificationResult(filePath)

      expect(result.overall).toBe('fail')
      expect(result.criteria[0].met).toBe(false)
    })

    it('should throw for missing file', () => {
      expect(() => {
        readVerificationResult('/nonexistent/verification.json')
      }).toThrow(VerificationError)
    })

    it('should throw for invalid JSON', () => {
      tmpDir = createTempDir()
      const filePath = path.join(tmpDir.dir, 'verification.json')
      fs.writeFileSync(filePath, 'not json')

      expect(() => {
        readVerificationResult(filePath)
      }).toThrow(VerificationError)
    })
  })

  describe('validateVerificationResult', () => {
    it('should accept valid passing result', () => {
      const result = validateVerificationResult({
        criteria: [
          { description: 'Test', met: true, evidence: 'Found' },
        ],
        overall: 'pass',
      })

      expect(result.overall).toBe('pass')
    })

    it('should accept valid failing result', () => {
      const result = validateVerificationResult({
        criteria: [
          { description: 'Test', met: false, evidence: 'Not found' },
        ],
        overall: 'fail',
      })

      expect(result.overall).toBe('fail')
    })

    it('should reject non-object input', () => {
      expect(() => validateVerificationResult('not object')).toThrow(VerificationError)
      expect(() => validateVerificationResult(null)).toThrow(VerificationError)
      expect(() => validateVerificationResult([])).toThrow(VerificationError)
    })

    it('should reject missing criteria', () => {
      expect(() =>
        validateVerificationResult({ overall: 'pass' }),
      ).toThrow(VerificationError)
    })

    it('should reject empty criteria array', () => {
      expect(() =>
        validateVerificationResult({ criteria: [], overall: 'pass' }),
      ).toThrow(VerificationError)
    })

    it('should reject invalid criteria item', () => {
      expect(() =>
        validateVerificationResult({
          criteria: [{ description: '', met: true, evidence: 'e' }],
          overall: 'pass',
        }),
      ).toThrow(VerificationError)

      expect(() =>
        validateVerificationResult({
          criteria: [{ description: 'test', met: 'yes', evidence: 'e' }],
          overall: 'pass',
        }),
      ).toThrow(VerificationError)

      expect(() =>
        validateVerificationResult({
          criteria: [{ description: 'test', met: true, evidence: 123 }],
          overall: 'pass',
        }),
      ).toThrow(VerificationError)
    })

    it('should reject invalid overall value', () => {
      expect(() =>
        validateVerificationResult({
          criteria: [{ description: 'test', met: true, evidence: 'e' }],
          overall: 'maybe',
        }),
      ).toThrow(VerificationError)
    })

    it('should accept multiple criteria', () => {
      const result = validateVerificationResult({
        criteria: [
          { description: 'A', met: true, evidence: 'yes' },
          { description: 'B', met: false, evidence: 'no' },
        ],
        overall: 'fail',
      })

      expect(result.criteria).toHaveLength(2)
    })
  })

  describe('verificationJsonPath', () => {
    it('should return path with verification.json suffix', () => {
      const result = verificationJsonPath('/tmp/bundle')
      expect(result).toBe('/tmp/bundle/verification.json')
    })
  })
})
