import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  atomicWriteManifest,
  readManifest,
  deleteManifest,
  ManifestError,
} from '../../src/manifest.js'
import type { Manifest } from '../../src/types.js'
import { createTempDir, type TempDir } from '../helpers/temp-dir.js'

function makeManifest(overrides?: Partial<Manifest>): Manifest {
  return {
    plan_id: 'test-plan',
    plan_doc: '.claude/plans/test.md',
    plan_doc_hash: 'abc123',
    feature_branch: 'feat/test-plan',
    base_branch: 'dev',
    quality_gate: { typecheck: 'tsc' },
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

describe('manifest I/O', () => {
  let tmpDir: TempDir

  afterEach(() => {
    tmpDir?.cleanup()
  })

  describe('atomicWriteManifest', () => {
    it('should write manifest atomically', () => {
      tmpDir = createTempDir()
      const filePath = tmpDir.path('manifests', 'test.json')
      const manifest = makeManifest()

      atomicWriteManifest(filePath, manifest)

      expect(fs.existsSync(filePath)).toBe(true)
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      expect(content.plan_id).toBe('test-plan')
    })

    it('should create backup of existing manifest', () => {
      tmpDir = createTempDir()
      const filePath = tmpDir.path('manifests', 'test.json')

      // Write first version
      atomicWriteManifest(filePath, makeManifest({ plan_id: 'v1' }))

      // Write second version (should create .bak)
      atomicWriteManifest(filePath, makeManifest({ plan_id: 'v2' }))

      expect(fs.existsSync(filePath + '.bak')).toBe(true)
      const backup = JSON.parse(fs.readFileSync(filePath + '.bak', 'utf-8'))
      expect(backup.plan_id).toBe('v1')

      const current = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      expect(current.plan_id).toBe('v2')
    })

    it('should update last_updated timestamp', () => {
      tmpDir = createTempDir()
      const filePath = tmpDir.path('test.json')
      const manifest = makeManifest()
      const originalTime = manifest.last_updated

      atomicWriteManifest(filePath, manifest)

      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      expect(content.last_updated).not.toBe(originalTime)
    })

    it('should not leave .tmp file on success', () => {
      tmpDir = createTempDir()
      const filePath = tmpDir.path('test.json')
      atomicWriteManifest(filePath, makeManifest())
      expect(fs.existsSync(filePath + '.tmp')).toBe(false)
    })
  })

  describe('readManifest', () => {
    it('should return null when file does not exist', () => {
      tmpDir = createTempDir()
      const result = readManifest(tmpDir.path('nonexistent.json'))
      expect(result).toBeNull()
    })

    it('should read valid manifest', () => {
      tmpDir = createTempDir()
      const filePath = tmpDir.path('test.json')
      atomicWriteManifest(filePath, makeManifest({ plan_id: 'read-test' }))

      const result = readManifest(filePath)
      expect(result).not.toBeNull()
      expect(result!.plan_id).toBe('read-test')
    })

    it('should recover from backup when primary is corrupted', () => {
      tmpDir = createTempDir()
      const filePath = tmpDir.path('test.json')

      // Write valid manifest, then write again to create .bak
      atomicWriteManifest(filePath, makeManifest({ plan_id: 'backup-version' }))
      atomicWriteManifest(filePath, makeManifest({ plan_id: 'current-version' }))

      // Corrupt primary
      fs.writeFileSync(filePath, '{invalid json')

      const result = readManifest(filePath)
      expect(result).not.toBeNull()
      expect(result!.plan_id).toBe('backup-version')
    })

    it('should throw when both primary and backup are corrupted', () => {
      tmpDir = createTempDir()
      const filePath = tmpDir.path('test.json')
      fs.mkdirSync(path.dirname(filePath), { recursive: true })

      fs.writeFileSync(filePath, '{invalid')
      fs.writeFileSync(filePath + '.bak', '{also invalid')

      expect(() => readManifest(filePath)).toThrow(ManifestError)
    })

    it('should throw when primary is corrupt and no backup exists', () => {
      tmpDir = createTempDir()
      const filePath = tmpDir.path('test.json')
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, '{corrupt}')

      expect(() => readManifest(filePath)).toThrow(ManifestError)
    })
  })

  describe('deleteManifest', () => {
    it('should delete all manifest-related files', () => {
      tmpDir = createTempDir()
      const filePath = tmpDir.path('test.json')

      atomicWriteManifest(filePath, makeManifest())
      atomicWriteManifest(filePath, makeManifest()) // creates .bak

      deleteManifest(filePath)

      expect(fs.existsSync(filePath)).toBe(false)
      expect(fs.existsSync(filePath + '.bak')).toBe(false)
    })

    it('should not throw when files do not exist', () => {
      tmpDir = createTempDir()
      expect(() => deleteManifest(tmpDir.path('nonexistent.json'))).not.toThrow()
    })
  })
})
