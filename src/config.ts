import * as fs from 'node:fs'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { execFileSync } from 'node:child_process'
import type { ProjectConfig, QualityGate } from './types.js'
import { DEFAULTS } from './types.js'
import { logger } from './logger.js'

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

function validateQualityGate(gate: unknown, fieldPath: string): QualityGate {
  if (typeof gate !== 'object' || gate === null || Array.isArray(gate)) {
    throw new ConfigError(`${fieldPath} must be an object`)
  }

  const obj = gate as Record<string, unknown>
  const result: QualityGate = {}

  if ('typecheck' in obj) {
    if (typeof obj.typecheck !== 'string' || obj.typecheck.trim() === '') {
      throw new ConfigError(`${fieldPath}.typecheck must be a non-empty string`)
    }
    result.typecheck = obj.typecheck
  }

  if ('test' in obj) {
    if (typeof obj.test !== 'string' || obj.test.trim() === '') {
      throw new ConfigError(`${fieldPath}.test must be a non-empty string`)
    }
    result.test = obj.test
  }

  if (!result.typecheck && !result.test) {
    throw new ConfigError(
      `${fieldPath} must contain at least one of "typecheck" or "test"`,
    )
  }

  return result
}

function validateStringArray(arr: unknown, fieldPath: string): string[] {
  if (!Array.isArray(arr)) {
    throw new ConfigError(`${fieldPath} must be an array`)
  }
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] !== 'string') {
      throw new ConfigError(`${fieldPath}[${i}] must be a string`)
    }
  }
  return arr as string[]
}

function validatePositiveNumber(
  val: unknown,
  fieldPath: string,
): number {
  if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
    throw new ConfigError(`${fieldPath} must be a positive number`)
  }
  return val
}

function validatePositiveInteger(
  val: unknown,
  fieldPath: string,
): number {
  const num = validatePositiveNumber(val, fieldPath)
  if (!Number.isInteger(num)) {
    throw new ConfigError(`${fieldPath} must be a positive integer`)
  }
  return num
}

export function validateConfig(raw: unknown): ProjectConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('Config must be a JSON object')
  }

  const obj = raw as Record<string, unknown>

  // Required fields
  if (!('base_branch' in obj)) {
    throw new ConfigError('Missing required field: base_branch')
  }
  if (typeof obj.base_branch !== 'string' || obj.base_branch.trim() === '') {
    throw new ConfigError('base_branch must be a non-empty string')
  }

  if (!('quality_gate' in obj)) {
    throw new ConfigError('Missing required field: quality_gate')
  }

  const config: ProjectConfig = {
    base_branch: obj.base_branch,
    quality_gate: validateQualityGate(obj.quality_gate, 'quality_gate'),
  }

  // Optional fields
  if ('setup_commands' in obj) {
    config.setup_commands = validateStringArray(obj.setup_commands, 'setup_commands')
  }

  if ('session_timeout_minutes' in obj) {
    config.session_timeout_minutes = validatePositiveNumber(
      obj.session_timeout_minutes,
      'session_timeout_minutes',
    )
  }

  if ('setup_timeout_minutes' in obj) {
    config.setup_timeout_minutes = validatePositiveNumber(
      obj.setup_timeout_minutes,
      'setup_timeout_minutes',
    )
  }

  if ('gate_timeout_minutes' in obj) {
    config.gate_timeout_minutes = validatePositiveNumber(
      obj.gate_timeout_minutes,
      'gate_timeout_minutes',
    )
  }

  if ('max_attempts_per_phase' in obj) {
    config.max_attempts_per_phase = validatePositiveInteger(
      obj.max_attempts_per_phase,
      'max_attempts_per_phase',
    )
  }

  if ('max_turns' in obj) {
    config.max_turns = validatePositiveInteger(obj.max_turns, 'max_turns')
  }

  return config
}

/**
 * Detect the default branch name from the git repo.
 * Tries: main, dev, master. Falls back to 'main'.
 */
function detectBaseBranch(projectRoot: string): string {
  const candidates = ['main', 'dev', 'master']
  for (const branch of candidates) {
    try {
      execFileSync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], {
        cwd: projectRoot,
        stdio: 'ignore',
      })
      return branch
    } catch {
      // branch doesn't exist, try next
    }
  }
  return 'main'
}

interface TechStackDetection {
  quality_gate: QualityGate
  setup_commands: string[]
}

/**
 * Detect the project's tech stack and generate appropriate quality_gate / setup_commands.
 */
export function detectTechStack(projectRoot: string): TechStackDetection | null {
  const exists = (f: string) => fs.existsSync(path.join(projectRoot, f))

  // Node.js / TypeScript
  if (exists('package.json')) {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'))
    const scripts: Record<string, string> = pkg.scripts ?? {}
    const gate: QualityGate = {}

    // Detect typecheck
    if (exists('tsconfig.json')) {
      gate.typecheck = scripts.typecheck ?? 'npx tsc --noEmit'
    }

    // Detect test
    if (scripts.test) {
      gate.test = `npm test`
    } else if (exists('vitest.config.ts') || exists('vitest.config.js')) {
      gate.test = 'npx vitest run'
    } else if (exists('jest.config.ts') || exists('jest.config.js') || exists('jest.config.cjs')) {
      gate.test = 'npx jest'
    }

    // Fallback: at least one gate required
    if (!gate.typecheck && !gate.test) {
      gate.test = 'npm test'
    }

    // Detect package manager
    let installCmd = 'npm ci'
    if (exists('pnpm-lock.yaml')) {
      installCmd = 'pnpm install --frozen-lockfile'
    } else if (exists('yarn.lock')) {
      installCmd = 'yarn install --frozen-lockfile'
    }

    return { quality_gate: gate, setup_commands: [installCmd] }
  }

  // Python
  if (exists('pyproject.toml') || exists('setup.py') || exists('requirements.txt')) {
    const gate: QualityGate = {}
    const setup: string[] = []

    if (exists('pyproject.toml')) {
      const content = fs.readFileSync(path.join(projectRoot, 'pyproject.toml'), 'utf-8')
      if (content.includes('mypy')) gate.typecheck = 'mypy .'
      if (content.includes('pytest')) gate.test = 'pytest'
      if (content.includes('ruff')) gate.typecheck = gate.typecheck ?? 'ruff check .'
    }

    if (exists('requirements.txt')) {
      setup.push('pip install -r requirements.txt')
    }

    if (!gate.typecheck && !gate.test) {
      gate.test = 'pytest'
    }

    return { quality_gate: gate, setup_commands: setup }
  }

  // Go
  if (exists('go.mod')) {
    return {
      quality_gate: { typecheck: 'go vet ./...', test: 'go test ./...' },
      setup_commands: [],
    }
  }

  // Rust
  if (exists('Cargo.toml')) {
    return {
      quality_gate: { typecheck: 'cargo check', test: 'cargo test' },
      setup_commands: [],
    }
  }

  // Fallback — cannot detect
  return null
}

interface StackPreset {
  label: string
  quality_gate: QualityGate
  setup_commands: string[]
}

const STACK_PRESETS: StackPreset[] = [
  {
    label: 'Node.js / TypeScript',
    quality_gate: { typecheck: 'npx tsc --noEmit', test: 'npm test' },
    setup_commands: ['npm ci'],
  },
  {
    label: 'Python',
    quality_gate: { typecheck: 'mypy .', test: 'pytest' },
    setup_commands: ['pip install -r requirements.txt'],
  },
  {
    label: 'Go',
    quality_gate: { typecheck: 'go vet ./...', test: 'go test ./...' },
    setup_commands: [],
  },
  {
    label: 'Rust',
    quality_gate: { typecheck: 'cargo check', test: 'cargo test' },
    setup_commands: [],
  },
]

function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

/**
 * Interactive tech stack selection when auto-detection fails.
 */
export async function interactiveStackSelect(
  projectRoot: string,
  baseBranch: string,
): Promise<ProjectConfig> {
  const configPath = path.join(projectRoot, '.auto-dev.json')

  // Non-interactive environment (piped stdin, CI, tests) — cannot prompt
  if (!process.stdin.isTTY) {
    throw new ConfigError(
      '无法自动检测项目技术栈，请手动创建 .auto-dev.json 配置文件。',
    )
  }

  console.error('\n未检测到已知技术栈，请选择项目类型:\n')
  for (let i = 0; i < STACK_PRESETS.length; i++) {
    console.error(`  ${i + 1}) ${STACK_PRESETS[i].label}`)
  }
  console.error(`  ${STACK_PRESETS.length + 1}) 其他（生成模板，自行编辑）`)
  console.error('')

  const answer = await promptUser(`请输入选项 [1-${STACK_PRESETS.length + 1}]: `)
  const choice = parseInt(answer, 10)

  if (choice >= 1 && choice <= STACK_PRESETS.length) {
    const preset = STACK_PRESETS[choice - 1]
    const config: ProjectConfig = {
      base_branch: baseBranch,
      quality_gate: preset.quality_gate,
    }
    if (preset.setup_commands.length > 0) {
      config.setup_commands = preset.setup_commands
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
    logger.info(`已创建配置文件 (${preset.label}): ${configPath}`)
    return config
  }

  // "其他" or invalid input — generate template
  const template: ProjectConfig = {
    base_branch: baseBranch,
    quality_gate: { typecheck: 'echo TODO', test: 'echo TODO' },
    setup_commands: [],
  }
  fs.writeFileSync(configPath, JSON.stringify(template, null, 2) + '\n', 'utf-8')
  logger.info(`已创建模板配置文件: ${configPath}`)
  logger.info('请编辑 .auto-dev.json 中的 quality_gate 命令，然后重新运行。')
  throw new ConfigError(
    `请编辑 ${configPath} 填入实际的质量门禁命令后重新运行。`,
  )
}

/**
 * Auto-detect tech stack and create .auto-dev.json in the project root.
 * Returns the generated config.
 */
export async function autoCreateConfig(projectRoot: string): Promise<ProjectConfig> {
  const baseBranch = detectBaseBranch(projectRoot)
  const detected = detectTechStack(projectRoot)

  if (!detected) {
    return interactiveStackSelect(projectRoot, baseBranch)
  }

  const { quality_gate, setup_commands } = detected

  const config: ProjectConfig = {
    base_branch: baseBranch,
    quality_gate,
  }
  if (setup_commands.length > 0) {
    config.setup_commands = setup_commands
  }

  const configPath = path.join(projectRoot, '.auto-dev.json')
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')

  logger.info(`已自动生成配置文件: ${configPath}`)
  logger.info(`  base_branch: ${config.base_branch}`)
  if (config.quality_gate.typecheck) {
    logger.info(`  typecheck: ${config.quality_gate.typecheck}`)
  }
  if (config.quality_gate.test) {
    logger.info(`  test: ${config.quality_gate.test}`)
  }
  if (config.setup_commands) {
    logger.info(`  setup: ${config.setup_commands.join(', ')}`)
  }

  return config
}

export async function loadConfig(projectRoot: string): Promise<ProjectConfig> {
  const configPath = path.join(projectRoot, '.auto-dev.json')

  if (!fs.existsSync(configPath)) {
    return autoCreateConfig(projectRoot)
  }

  let rawContent: string
  try {
    rawContent = fs.readFileSync(configPath, 'utf-8')
  } catch (err) {
    throw new ConfigError(`无法读取配置文件: ${(err as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawContent)
  } catch (err) {
    throw new ConfigError(`配置文件 JSON 解析失败: ${(err as Error).message}`)
  }

  return validateConfig(parsed)
}

export function applyDefaults(config: ProjectConfig): Required<ProjectConfig> {
  return {
    base_branch: config.base_branch,
    quality_gate: config.quality_gate,
    setup_commands: config.setup_commands ?? [],
    session_timeout_minutes:
      config.session_timeout_minutes ?? DEFAULTS.SESSION_TIMEOUT_MINUTES,
    setup_timeout_minutes:
      config.setup_timeout_minutes ?? DEFAULTS.SETUP_TIMEOUT_MINUTES,
    gate_timeout_minutes:
      config.gate_timeout_minutes ?? DEFAULTS.GATE_TIMEOUT_MINUTES,
    max_attempts_per_phase:
      config.max_attempts_per_phase ?? DEFAULTS.MAX_ATTEMPTS_PER_PHASE,
    max_turns: config.max_turns ?? DEFAULTS.MAX_TURNS,
  }
}
