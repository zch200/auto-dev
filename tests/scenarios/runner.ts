#!/usr/bin/env npx tsx

/**
 * Scenario runner — sets up isolated git repos from seed templates,
 * runs auto-dev against them with real Claude sessions, and validates results.
 *
 * Usage:
 *   npx tsx tests/scenarios/runner.ts s1-happy-path
 *   npx tsx tests/scenarios/runner.ts --p0
 *   npx tsx tests/scenarios/runner.ts --p0 --p1
 *   npx tsx tests/scenarios/runner.ts --all
 *   npx tsx tests/scenarios/runner.ts s1-happy-path --no-cleanup --verbose
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

// ── Types ────────────────────────────────────────────────────────────

interface ScenarioConfig {
  name: string
  description: string
  priority: number
  timeout_minutes: number
  expected_exit_code: number
  expected_phase_count?: number
  expected_all_phases_status?: string
  expected_phases?: { slug: string; expected_status: string }[]
  assertions: string[]
}

interface PhaseCheckResult {
  slug: string
  expected: string
  actual: string
  passed: boolean
}

interface AssertionResult {
  name: string
  passed: boolean
  detail: string
}

interface ScenarioResult {
  name: string
  passed: boolean
  exitCode: number | null
  expectedExitCode: number
  phaseResults: PhaseCheckResult[]
  assertionResults: AssertionResult[]
  durationMs: number
  error?: string
}

// ── Constants ────────────────────────────────────────────────────────

const SCENARIOS_DIR = path.dirname(new URL(import.meta.url).pathname)
const AUTO_DEV_ROOT = path.resolve(SCENARIOS_DIR, '../..')
const TEMP_BASE = path.resolve(AUTO_DEV_ROOT, '..', 'auto-dev-scenarios')

// CLI flags
const ARGV = process.argv.slice(2)
const NO_CLEANUP = ARGV.includes('--no-cleanup')
const VERBOSE = ARGV.includes('--verbose')

// ── Helpers ──────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Scenario Test',
      GIT_AUTHOR_EMAIL: 'test@auto-dev.local',
      GIT_COMMITTER_NAME: 'Scenario Test',
      GIT_COMMITTER_EMAIL: 'test@auto-dev.local',
    },
  }).trim()
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[${ts}] ${msg}`)
}

// ── Setup ────────────────────────────────────────────────────────────

function setupScenario(scenarioDir: string, config: ScenarioConfig): string {
  const tempDir = path.join(TEMP_BASE, config.name)

  // Clean if leftover from previous run
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }

  // Copy seed files
  const seedDir = path.join(scenarioDir, 'seed')
  if (fs.existsSync(seedDir)) {
    copyDirRecursive(seedDir, tempDir)
  } else {
    fs.mkdirSync(tempDir, { recursive: true })
  }

  // Git init + initial commit
  git(tempDir, 'init')
  git(tempDir, 'checkout', '-b', 'main')
  git(tempDir, 'add', '-A')
  git(tempDir, 'commit', '--allow-empty', '-m', 'Initial commit')

  // Write .auto-dev.json from config.json
  const configSrc = path.join(scenarioDir, 'config.json')
  if (fs.existsSync(configSrc)) {
    fs.copyFileSync(configSrc, path.join(tempDir, '.auto-dev.json'))
    git(tempDir, 'add', '.auto-dev.json')
    git(tempDir, 'commit', '-m', 'Add .auto-dev.json')
  }

  // Copy plan.md (not committed — it's the input document, not project code)
  const planSrc = path.join(scenarioDir, 'plan.md')
  if (fs.existsSync(planSrc)) {
    fs.copyFileSync(planSrc, path.join(tempDir, 'plan.md'))
  }

  return tempDir
}

// ── Execute ──────────────────────────────────────────────────────────

function executeScenario(
  tempDir: string,
  config: ScenarioConfig,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const planPath = path.join(tempDir, 'plan.md')
    const timeoutMs = config.timeout_minutes * 60 * 1000

    // Remove CLAUDECODE env var so auto-dev spawns fresh claude sessions
    const env = { ...process.env }
    delete env.CLAUDECODE

    const child = spawn(
      'npx',
      [
        'tsx',
        path.join(AUTO_DEV_ROOT, 'src/index.ts'),
        'start',
        '--plan', planPath,
        '--project', tempDir,
      ],
      {
        cwd: AUTO_DEV_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString()
      stdout += text
      if (VERBOSE) process.stdout.write(text)
    })

    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString()
      stderr += text
      if (VERBOSE) process.stderr.write(text)
    })

    const timer = setTimeout(() => {
      log(`Timeout reached (${config.timeout_minutes}min), killing process...`)
      child.kill('SIGTERM')
      // Force kill after 10s
      setTimeout(() => child.kill('SIGKILL'), 10_000)
    }, timeoutMs)

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code, stdout, stderr })
    })
  })
}

// ── Collect & Assert ─────────────────────────────────────────────────

function readManifest(tempDir: string): Record<string, unknown> | null {
  // Manifest lives at {git_common_dir}/auto-dev/manifests/{plan_id}.json
  // plan_id = "plan" (from plan.md filename)
  const planId = 'plan'
  const manifestPath = path.join(
    tempDir, '.git', 'auto-dev', 'manifests', `${planId}.json`,
  )

  try {
    if (fs.existsSync(manifestPath)) {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    }
  } catch { /* corrupt or missing */ }

  return null
}

function collectAndAssert(
  tempDir: string,
  config: ScenarioConfig,
  exitCode: number | null,
): { phaseResults: PhaseCheckResult[]; assertionResults: AssertionResult[] } {
  const manifest = readManifest(tempDir)
  const phases: Array<{ slug: string; status: string; attempts: number; merged: boolean }> =
    (manifest?.phases as never[]) ?? []

  // ── Phase results ──
  const phaseResults: PhaseCheckResult[] = []

  if (config.expected_phases) {
    // Exact slug matching
    for (const ep of config.expected_phases) {
      const actual = phases.find((p) => p.slug === ep.slug)
      phaseResults.push({
        slug: ep.slug,
        expected: ep.expected_status,
        actual: actual?.status ?? 'not_found',
        passed: (actual?.status ?? 'not_found') === ep.expected_status,
      })
    }
  }

  if (config.expected_phase_count !== undefined) {
    phaseResults.push({
      slug: '(phase_count)',
      expected: String(config.expected_phase_count),
      actual: String(phases.length),
      passed: phases.length === config.expected_phase_count,
    })
  }

  if (config.expected_all_phases_status) {
    const expected = config.expected_all_phases_status
    const allMatch = phases.length > 0 && phases.every((p) => p.status === expected)
    phaseResults.push({
      slug: '(all_phases_status)',
      expected,
      actual: phases.map((p) => p.status).join(',') || 'none',
      passed: allMatch,
    })
  }

  // ── Assertion results ──
  const assertionResults: AssertionResult[] = config.assertions.map((assertion) => {
    switch (assertion) {
      case 'quality_gates_passed':
        return {
          name: assertion,
          passed: phases.length > 0 && phases.every((p) => p.status === 'completed'),
          detail: phases.map((p) => `${p.slug}:${p.status}`).join(', ') || 'no phases',
        }

      case 'verification_passed':
        return {
          name: assertion,
          passed: phases.length > 0 && phases.every((p) => p.status === 'completed' && p.merged),
          detail: phases.map((p) => `${p.slug}:merged=${p.merged}`).join(', ') || 'no phases',
        }

      case 'setup_commands_succeeded':
        // If manifest exists and phases were attempted, setup succeeded
        return {
          name: assertion,
          passed: manifest !== null && phases.some((p) => p.attempts > 0),
          detail: manifest ? 'manifest exists, phases attempted' : 'no manifest',
        }

      case 'preflight_passed':
        // Preflight is skipped for the first phase (no prior completed phases),
        // so we just check that phases were attempted
        return {
          name: assertion,
          passed: phases.some((p) => p.attempts > 0),
          detail: phases.some((p) => p.attempts > 0) ? 'phases attempted' : 'no phases attempted',
        }

      case 'phase_failed':
        return {
          name: assertion,
          passed: phases.some((p) => p.status === 'failed'),
          detail: phases.map((p) => `${p.slug}:${p.status}`).join(', ') || 'no phases',
        }

      default:
        return { name: assertion, passed: false, detail: `unknown assertion: ${assertion}` }
    }
  })

  return { phaseResults, assertionResults }
}

// ── Cleanup ──────────────────────────────────────────────────────────

function cleanup(tempDir: string): void {
  // Worktrees are at {parent_of_project}/.auto-dev-worktrees/
  const worktreeBase = path.join(path.dirname(tempDir), '.auto-dev-worktrees')

  // Prune worktree references
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: tempDir, stdio: 'ignore' })
  } catch { /* ok */ }

  // Delete worktree directories
  if (fs.existsSync(worktreeBase)) {
    fs.rmSync(worktreeBase, { recursive: true, force: true })
  }

  // Delete project temp dir
  fs.rmSync(tempDir, { recursive: true, force: true })

  // Remove TEMP_BASE if empty
  try {
    const remaining = fs.readdirSync(TEMP_BASE)
    if (remaining.length === 0) {
      fs.rmSync(TEMP_BASE, { recursive: true })
    }
  } catch { /* ok */ }
}

// ── Report ───────────────────────────────────────────────────────────

function report(result: ScenarioResult): void {
  const icon = result.passed ? '✅' : '❌'
  const duration = (result.durationMs / 1000).toFixed(1)
  console.log(`\n${icon} ${result.name} (${duration}s)`)

  // Exit code
  const exitMatch = result.exitCode === result.expectedExitCode
  console.log(
    `  exit code: ${result.exitCode} (expected ${result.expectedExitCode}) ${exitMatch ? '✓' : '✗'}`,
  )

  // Phase results
  for (const pr of result.phaseResults) {
    console.log(
      `  phase ${pr.slug}: ${pr.actual} (expected ${pr.expected}) ${pr.passed ? '✓' : '✗'}`,
    )
  }

  // Assertion results
  for (const ar of result.assertionResults) {
    console.log(`  ${ar.name}: ${ar.passed ? '✓' : '✗'} (${ar.detail})`)
  }

  if (result.error) {
    console.log(`  error: ${result.error.slice(0, 300)}`)
  }
}

// ── Run Single Scenario ──────────────────────────────────────────────

async function runScenario(name: string): Promise<ScenarioResult> {
  const scenarioDir = path.join(SCENARIOS_DIR, name)

  if (!fs.existsSync(scenarioDir)) {
    return {
      name,
      passed: false,
      exitCode: null,
      expectedExitCode: 0,
      phaseResults: [],
      assertionResults: [],
      durationMs: 0,
      error: `Scenario directory not found: ${scenarioDir}`,
    }
  }

  const configPath = path.join(scenarioDir, 'scenario.json')
  if (!fs.existsSync(configPath)) {
    return {
      name,
      passed: false,
      exitCode: null,
      expectedExitCode: 0,
      phaseResults: [],
      assertionResults: [],
      durationMs: 0,
      error: `scenario.json not found in ${scenarioDir}`,
    }
  }

  const config: ScenarioConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  const start = Date.now()
  let tempDir: string | null = null

  try {
    // 1. Setup
    log(`Setting up: ${config.name} — ${config.description}`)
    tempDir = setupScenario(scenarioDir, config)
    log(`Project created at ${tempDir}`)

    // 2. Execute
    log(`Running auto-dev (timeout: ${config.timeout_minutes}min)...`)
    const { exitCode, stdout, stderr } = await executeScenario(tempDir, config)
    log(`auto-dev exited with code ${exitCode}`)

    // 3. Collect & Assert
    const { phaseResults, assertionResults } = collectAndAssert(tempDir, config, exitCode)

    const exitCodePassed = exitCode === config.expected_exit_code
    const phasesPassed = phaseResults.every((pr) => pr.passed)
    const assertionsPassed = assertionResults.every((ar) => ar.passed)

    const result: ScenarioResult = {
      name: config.name,
      passed: exitCodePassed && phasesPassed && assertionsPassed,
      exitCode,
      expectedExitCode: config.expected_exit_code,
      phaseResults,
      assertionResults,
      durationMs: Date.now() - start,
    }

    // Attach stderr snippet on failure
    if (!result.passed && stderr) {
      result.error = stderr.slice(-500)
    }

    return result
  } catch (err) {
    return {
      name: config.name,
      passed: false,
      exitCode: null,
      expectedExitCode: config.expected_exit_code,
      phaseResults: [],
      assertionResults: [],
      durationMs: Date.now() - start,
      error: (err as Error).message,
    }
  } finally {
    // 4. Cleanup
    if (tempDir && fs.existsSync(tempDir)) {
      if (NO_CLEANUP) {
        log(`Skipping cleanup (--no-cleanup), temp dir: ${tempDir}`)
      } else {
        log('Cleaning up...')
        cleanup(tempDir)
      }
    }
  }
}

// ── Discovery ────────────────────────────────────────────────────────

function discoverScenarios(): string[] {
  return fs.readdirSync(SCENARIOS_DIR, { withFileTypes: true })
    .filter((d) =>
      d.isDirectory() &&
      fs.existsSync(path.join(SCENARIOS_DIR, d.name, 'scenario.json')),
    )
    .map((d) => d.name)
    .sort()
}

function filterByPriority(scenarios: string[], maxPriority: number): string[] {
  return scenarios.filter((name) => {
    const configPath = path.join(SCENARIOS_DIR, name, 'scenario.json')
    const config: ScenarioConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    return config.priority <= maxPriority
  })
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const positionalArgs = ARGV.filter((a) => !a.startsWith('--'))
  const hasFlag = (f: string) => ARGV.includes(f)

  if (ARGV.length === 0) {
    console.log(`Usage:
  npx tsx tests/scenarios/runner.ts <scenario-name>
  npx tsx tests/scenarios/runner.ts --p0
  npx tsx tests/scenarios/runner.ts --p0 --p1
  npx tsx tests/scenarios/runner.ts --all

Options:
  --no-cleanup    Preserve temp directories after run (for debugging)
  --verbose       Stream auto-dev stdout/stderr in real-time`)
    process.exit(1)
  }

  let scenarioNames: string[]

  if (hasFlag('--all')) {
    scenarioNames = discoverScenarios()
  } else if (hasFlag('--p0') || hasFlag('--p1') || hasFlag('--p2')) {
    let maxPriority = -1
    if (hasFlag('--p2')) maxPriority = 2
    else if (hasFlag('--p1')) maxPriority = 1
    else maxPriority = 0
    scenarioNames = filterByPriority(discoverScenarios(), maxPriority)
  } else if (positionalArgs.length > 0) {
    scenarioNames = positionalArgs
  } else {
    console.log('No scenarios specified.')
    process.exit(1)
  }

  if (scenarioNames.length === 0) {
    console.log('No scenarios found matching criteria.')
    process.exit(1)
  }

  console.log(`\nRunning ${scenarioNames.length} scenario(s): ${scenarioNames.join(', ')}\n`)

  const results: ScenarioResult[] = []

  for (const name of scenarioNames) {
    const result = await runScenario(name)
    report(result)
    results.push(result)
  }

  // Summary
  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed).length

  console.log(`\n${'═'.repeat(50)}`)
  console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`)

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
