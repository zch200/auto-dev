import { spawn, type StdioOptions } from 'node:child_process'
import type { RunResult } from './types.js'

const SIGTERM_GRACE_MS = 5000

export async function runWithTimeout(
  command: string,
  args: string[],
  options: {
    timeoutMs: number
    cwd?: string
    stdio?: StdioOptions
    env?: NodeJS.ProcessEnv
  },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let resolved = false
    let killTimer: ReturnType<typeof setTimeout> | null = null

    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (proc.pid) {
          process.kill(-proc.pid, signal)
        }
      } catch {
        // Process group may already be gone
      }
    }

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({ exitCode, stdout, stderr, timedOut, signal })
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    proc.on('error', (err) => {
      finish(1, null)
    })

    proc.on('exit', (code, signal) => {
      finish(code, signal as NodeJS.Signals | null)
    })

    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      killTimer = setTimeout(() => killGroup('SIGKILL'), SIGTERM_GRACE_MS)
    }, options.timeoutMs)

    // Unref timer so it doesn't prevent process exit
    if (timer && typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }
  })
}
