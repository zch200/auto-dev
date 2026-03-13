import { runWithTimeout } from './timeout.js'
import { logger } from './logger.js'
import type { RunResult, TokenUsage } from './types.js'
import { DEFAULTS } from './types.js'

export interface SessionOptions {
  prompt: string
  cwd: string
  timeoutMs: number
  maxTurns: number
  allowedTools: string[]
  disallowedTools?: string[]
  env?: NodeJS.ProcessEnv
}

export interface SessionResult {
  runResult: RunResult
  tokens: TokenUsage
  costUsd: number
}

/**
 * Parse token usage and cost from Claude CLI JSON output.
 * Claude CLI with --output-format json outputs a JSON object with usage and cost fields.
 */
export function parseSessionOutput(stdout: string): {
  tokens: TokenUsage
  costUsd: number
} {
  const defaults = { tokens: { input: 0, output: 0 }, costUsd: 0 }

  if (!stdout.trim()) return defaults

  try {
    const parsed = JSON.parse(stdout.trim())
    const tokens: TokenUsage = {
      input: parsed?.usage?.input_tokens ?? 0,
      output: parsed?.usage?.output_tokens ?? 0,
    }
    const costUsd = parsed?.cost_usd ?? 0
    return { tokens, costUsd }
  } catch {
    // stdout might contain multiple lines; try the last line
    const lines = stdout.trim().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i])
        const tokens: TokenUsage = {
          input: parsed?.usage?.input_tokens ?? 0,
          output: parsed?.usage?.output_tokens ?? 0,
        }
        const costUsd = parsed?.cost_usd ?? 0
        return { tokens, costUsd }
      } catch {
        continue
      }
    }
    logger.debug(`Failed to parse session output for token usage`)
    return defaults
  }
}

/**
 * Build Claude CLI arguments for a session.
 */
export function buildClaudeArgs(options: {
  prompt: string
  maxTurns: number
  allowedTools: string[]
  disallowedTools?: string[]
}): string[] {
  const args: string[] = [
    '-p',
    options.prompt,
    '--output-format',
    'json',
    '--permission-mode',
    'dontAsk',
    '--max-turns',
    String(options.maxTurns),
  ]

  if (options.allowedTools.length > 0) {
    args.push('--allowedTools', options.allowedTools.join(' '))
  }

  if (options.disallowedTools && options.disallowedTools.length > 0) {
    args.push('--disallowedTools', options.disallowedTools.join(' '))
  }

  return args
}

/**
 * Run a Claude headless session with timeout.
 */
export async function runSession(options: SessionOptions): Promise<SessionResult> {
  const args = buildClaudeArgs({
    prompt: options.prompt,
    maxTurns: options.maxTurns,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
  })

  logger.debug(`Running Claude session in ${options.cwd} (timeout: ${options.timeoutMs}ms)`)

  const runResult = await runWithTimeout('claude', args, {
    timeoutMs: options.timeoutMs,
    cwd: options.cwd,
    env: options.env,
  })

  if (runResult.timedOut) {
    logger.warn(`Claude session timed out after ${options.timeoutMs}ms`)
  } else if (runResult.exitCode !== 0) {
    logger.warn(`Claude session exited with code ${runResult.exitCode}`)
  }

  const { tokens, costUsd } = parseSessionOutput(runResult.stdout)

  logger.debug(
    `Session tokens: input=${tokens.input} output=${tokens.output} cost=$${costUsd}`,
  )

  return { runResult, tokens, costUsd }
}

/**
 * Run Session 0 (init): parse plan document and generate candidate.
 */
export async function runSession0(
  prompt: string,
  projectRoot: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<SessionResult> {
  return runSession({
    prompt,
    cwd: projectRoot,
    timeoutMs,
    maxTurns: DEFAULTS.SESSION0_MAX_TURNS,
    allowedTools: ['Read', 'Write', 'WebFetch', 'WebSearch'],
    env,
  })
}

/**
 * Run Phase execution session.
 */
export async function runPhaseSession(
  prompt: string,
  worktreePath: string,
  timeoutMs: number,
  maxTurns: number,
  env?: NodeJS.ProcessEnv,
): Promise<SessionResult> {
  return runSession({
    prompt,
    cwd: worktreePath,
    timeoutMs,
    maxTurns,
    allowedTools: [
      'Read',
      'Write',
      'Edit',
      'Bash',
      'Glob',
      'Grep',
      'WebFetch',
      'WebSearch',
    ],
    disallowedTools: ['Bash(git push *)', 'Bash(rm -rf *)'],
    env,
  })
}

/**
 * Run Verification session (reviewer role).
 */
export async function runVerificationSession(
  prompt: string,
  worktreePath: string,
  env?: NodeJS.ProcessEnv,
): Promise<SessionResult> {
  return runSession({
    prompt,
    cwd: worktreePath,
    timeoutMs: DEFAULTS.VERIFICATION_TIMEOUT_MS,
    maxTurns: DEFAULTS.VERIFICATION_MAX_TURNS,
    allowedTools: ['Read', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    env,
  })
}

/**
 * Run preflight check: verify Claude CLI is available and auth works.
 */
export async function runPreflight(
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  const result = await runWithTimeout(
    'claude',
    [
      '-p',
      'respond with ok',
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      'Read',
      '--max-turns',
      '1',
      '--output-format',
      'json',
    ],
    {
      timeoutMs: DEFAULTS.PREFLIGHT_TIMEOUT_MS,
      env,
    },
  )

  if (result.timedOut) {
    logger.error('Claude CLI preflight timed out')
    return false
  }

  if (result.exitCode !== 0) {
    logger.error(`Claude CLI preflight failed with exit code ${result.exitCode}`)
    return false
  }

  return true
}
