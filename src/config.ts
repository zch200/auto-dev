import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ProjectConfig, QualityGate } from './types.js'
import { DEFAULTS } from './types.js'

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

export function loadConfig(projectRoot: string): ProjectConfig {
  const configPath = path.join(projectRoot, '.auto-dev.json')

  if (!fs.existsSync(configPath)) {
    throw new ConfigError(
      `项目中未找到 .auto-dev.json 配置文件。请在 ${projectRoot} 中创建该文件。`,
    )
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
