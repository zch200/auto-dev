import { describe, it, expect } from 'vitest'
import { runWithTimeout } from '../../src/timeout.js'

describe('runWithTimeout', () => {
  it('should capture stdout and stderr', async () => {
    const result = await runWithTimeout('node', ['-e', 'console.log("hello"); console.error("err")'], {
      timeoutMs: 5000,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('hello')
    expect(result.stderr.trim()).toBe('err')
    expect(result.timedOut).toBe(false)
  })

  it('should return exit code on failure', async () => {
    const result = await runWithTimeout('node', ['-e', 'process.exit(42)'], {
      timeoutMs: 5000,
    })
    expect(result.exitCode).toBe(42)
    expect(result.timedOut).toBe(false)
  })

  it('should kill process on timeout and set timedOut flag', async () => {
    const result = await runWithTimeout(
      'node',
      ['-e', 'setInterval(() => {}, 100000)'],
      { timeoutMs: 500 },
    )
    expect(result.timedOut).toBe(true)
  }, 10000)

  it('should handle non-existent command', async () => {
    const result = await runWithTimeout(
      'nonexistent-command-xyz',
      [],
      { timeoutMs: 5000 },
    )
    expect(result.exitCode).toBe(1)
  })

  it('should pass cwd option', async () => {
    const result = await runWithTimeout('node', ['-e', 'console.log(process.cwd())'], {
      timeoutMs: 5000,
      cwd: '/tmp',
    })
    expect(result.exitCode).toBe(0)
    // /tmp may resolve to /private/tmp on macOS
    expect(result.stdout.trim()).toMatch(/\/tmp$/)
  })

  it('should terminate entire process group on timeout', async () => {
    // Spawn a child that itself spawns a subprocess
    const script = `
      const { spawn } = require('child_process');
      const child = spawn('sleep', ['60']);
      child.unref();
      setInterval(() => {}, 100000);
    `
    const result = await runWithTimeout('node', ['-e', script], {
      timeoutMs: 500,
    })
    expect(result.timedOut).toBe(true)
  }, 10000)
})
