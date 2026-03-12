import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { acquireLock, releaseLock, LockError } from '../../src/lock.js'
import { createTempDir, type TempDir } from '../helpers/temp-dir.js'

describe('lock', () => {
  let tmpDir: TempDir

  afterEach(() => {
    tmpDir?.cleanup()
  })

  describe('acquireLock', () => {
    it('should create lock directory with owner.json', () => {
      tmpDir = createTempDir()
      const lockPath = tmpDir.path('locks', 'test.lock')

      acquireLock(lockPath, 'test')

      expect(fs.existsSync(lockPath)).toBe(true)
      expect(fs.existsSync(path.join(lockPath, 'owner.json'))).toBe(true)

      const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf-8'))
      expect(owner.pid).toBe(process.pid)
      expect(owner.started_at).toBeTruthy()

      releaseLock(lockPath)
    })

    it('should throw LockError when lock is held by alive process', () => {
      tmpDir = createTempDir()
      const lockPath = tmpDir.path('locks', 'test.lock')

      acquireLock(lockPath, 'test')

      // Trying to acquire again should fail (same process is alive)
      expect(() => acquireLock(lockPath, 'test')).toThrow(LockError)
      expect(() => acquireLock(lockPath, 'test')).toThrow('已有进程')

      releaseLock(lockPath)
    })

    it('should reclaim stale lock (dead process)', () => {
      tmpDir = createTempDir()
      const lockPath = tmpDir.path('locks', 'test.lock')

      // Create a stale lock with a non-existent PID
      fs.mkdirSync(lockPath, { recursive: true })
      fs.writeFileSync(
        path.join(lockPath, 'owner.json'),
        JSON.stringify({ pid: 999999999, started_at: '2020-01-01T00:00:00Z' }),
      )

      // Should succeed by reclaiming
      acquireLock(lockPath, 'test')

      const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf-8'))
      expect(owner.pid).toBe(process.pid)

      releaseLock(lockPath)
    })

    it('should reclaim lock when owner.json is missing', () => {
      tmpDir = createTempDir()
      const lockPath = tmpDir.path('locks', 'test.lock')

      // Create lock dir without owner.json (simulates crash during lock acquisition)
      fs.mkdirSync(lockPath, { recursive: true })

      acquireLock(lockPath, 'test')

      expect(fs.existsSync(path.join(lockPath, 'owner.json'))).toBe(true)

      releaseLock(lockPath)
    })

    it('should reclaim lock when owner.json is corrupt', () => {
      tmpDir = createTempDir()
      const lockPath = tmpDir.path('locks', 'test.lock')

      fs.mkdirSync(lockPath, { recursive: true })
      fs.writeFileSync(path.join(lockPath, 'owner.json'), '{corrupt json')

      acquireLock(lockPath, 'test')

      const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf-8'))
      expect(owner.pid).toBe(process.pid)

      releaseLock(lockPath)
    })
  })

  describe('releaseLock', () => {
    it('should remove lock directory', () => {
      tmpDir = createTempDir()
      const lockPath = tmpDir.path('locks', 'test.lock')

      acquireLock(lockPath, 'test')
      expect(fs.existsSync(lockPath)).toBe(true)

      releaseLock(lockPath)
      expect(fs.existsSync(lockPath)).toBe(false)
    })

    it('should not throw when lock does not exist', () => {
      tmpDir = createTempDir()
      expect(() => releaseLock(tmpDir.path('nonexistent.lock'))).not.toThrow()
    })
  })

  describe('concurrency', () => {
    it('should ensure only one lock succeeds with concurrent attempts', async () => {
      tmpDir = createTempDir()
      const lockPath = tmpDir.path('locks', 'concurrent.lock')

      // Simulate concurrency by having one lock held by current process
      acquireLock(lockPath, 'test')

      // Second attempt should fail
      expect(() => acquireLock(lockPath, 'test')).toThrow(LockError)

      releaseLock(lockPath)
    })
  })
})
