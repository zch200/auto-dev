import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  validateConfig,
  loadConfig,
  applyDefaults,
  autoCreateConfig,
  detectTechStack,
  ConfigError,
} from '../../src/config.js'
import { DEFAULTS } from '../../src/types.js'
import { createTempDir, type TempDir } from '../helpers/temp-dir.js'
import { createTempGitRepo, type TempGitRepo } from '../helpers/git-repo.js'

const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'configs')

describe('config', () => {
  let tmpDir: TempDir | null = null

  afterEach(() => {
    tmpDir?.cleanup()
    tmpDir = null
  })

  describe('validateConfig', () => {
    it('should accept valid full config', () => {
      const raw = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'valid.json'), 'utf-8'))
      const config = validateConfig(raw)
      expect(config.base_branch).toBe('dev')
      expect(config.quality_gate.typecheck).toBe('npx tsc --noEmit')
      expect(config.quality_gate.test).toBe('npx vitest run')
      expect(config.setup_commands).toEqual(['npm ci'])
      expect(config.session_timeout_minutes).toBe(20)
      expect(config.max_attempts_per_phase).toBe(3)
    })

    it('should accept minimal config', () => {
      const raw = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'minimal.json'), 'utf-8'))
      const config = validateConfig(raw)
      expect(config.base_branch).toBe('main')
      expect(config.quality_gate.typecheck).toBe('npx tsc --noEmit')
      expect(config.setup_commands).toBeUndefined()
    })

    it('should reject missing base_branch', () => {
      const raw = JSON.parse(
        fs.readFileSync(path.join(fixturesDir, 'invalid-missing-base.json'), 'utf-8'),
      )
      expect(() => validateConfig(raw)).toThrow(ConfigError)
      expect(() => validateConfig(raw)).toThrow('base_branch')
    })

    it('should reject empty quality_gate', () => {
      const raw = JSON.parse(
        fs.readFileSync(path.join(fixturesDir, 'invalid-empty-gate.json'), 'utf-8'),
      )
      expect(() => validateConfig(raw)).toThrow(ConfigError)
      expect(() => validateConfig(raw)).toThrow('at least one')
    })

    it('should reject negative timeout', () => {
      const raw = JSON.parse(
        fs.readFileSync(path.join(fixturesDir, 'invalid-bad-timeout.json'), 'utf-8'),
      )
      expect(() => validateConfig(raw)).toThrow(ConfigError)
      expect(() => validateConfig(raw)).toThrow('positive number')
    })

    it('should reject non-object input', () => {
      expect(() => validateConfig(null)).toThrow('must be a JSON object')
      expect(() => validateConfig([])).toThrow('must be a JSON object')
      expect(() => validateConfig('string')).toThrow('must be a JSON object')
    })

    it('should reject empty base_branch', () => {
      expect(() => validateConfig({ base_branch: '', quality_gate: { test: 'x' } })).toThrow(
        'non-empty string',
      )
    })

    it('should reject non-integer max_attempts_per_phase', () => {
      expect(() =>
        validateConfig({
          base_branch: 'main',
          quality_gate: { test: 'x' },
          max_attempts_per_phase: 2.5,
        }),
      ).toThrow('positive integer')
    })

    it('should reject non-string array items in setup_commands', () => {
      expect(() =>
        validateConfig({
          base_branch: 'main',
          quality_gate: { test: 'x' },
          setup_commands: ['npm ci', 42],
        }),
      ).toThrow('must be a string')
    })

    it('should reject empty string in quality_gate typecheck', () => {
      expect(() =>
        validateConfig({
          base_branch: 'main',
          quality_gate: { typecheck: '  ' },
        }),
      ).toThrow('non-empty string')
    })
  })

  describe('loadConfig', () => {
    it('should load from project root', () => {
      tmpDir = createTempDir()
      tmpDir.writeFile(
        '.auto-dev.json',
        JSON.stringify({
          base_branch: 'dev',
          quality_gate: { test: 'npm test' },
        }),
      )
      const config = loadConfig(tmpDir.dir)
      expect(config.base_branch).toBe('dev')
    })

    it('should auto-create config when missing in a git repo with package.json', () => {
      let repo: TempGitRepo | null = null
      try {
        repo = createTempGitRepo()
        // Create a Node.js project with tsconfig
        fs.writeFileSync(
          path.join(repo.dir, 'package.json'),
          JSON.stringify({ name: 'test', scripts: { test: 'vitest run' } }),
        )
        fs.writeFileSync(path.join(repo.dir, 'tsconfig.json'), '{}')
        const config = loadConfig(repo.dir)
        expect(config.base_branch).toBe('main')
        expect(config.quality_gate.typecheck).toBe('npx tsc --noEmit')
        expect(config.quality_gate.test).toBe('npm test')
        // File should have been created
        expect(fs.existsSync(path.join(repo.dir, '.auto-dev.json'))).toBe(true)
      } finally {
        repo?.cleanup()
      }
    })

    it('should throw on invalid JSON', () => {
      tmpDir = createTempDir()
      tmpDir.writeFile('.auto-dev.json', '{invalid json}')
      expect(() => loadConfig(tmpDir!.dir)).toThrow('JSON 解析失败')
    })
  })

  describe('detectTechStack', () => {
    it('should detect Node.js + TypeScript project', () => {
      tmpDir = createTempDir()
      tmpDir.writeFile('package.json', JSON.stringify({ name: 'test', scripts: { test: 'vitest run' } }))
      tmpDir.writeFile('tsconfig.json', '{}')
      const result = detectTechStack(tmpDir.dir)
      expect(result.quality_gate.typecheck).toBe('npx tsc --noEmit')
      expect(result.quality_gate.test).toBe('npm test')
      expect(result.setup_commands).toEqual(['npm ci'])
    })

    it('should detect pnpm project', () => {
      tmpDir = createTempDir()
      tmpDir.writeFile('package.json', JSON.stringify({ name: 'test' }))
      tmpDir.writeFile('pnpm-lock.yaml', '')
      tmpDir.writeFile('tsconfig.json', '{}')
      const result = detectTechStack(tmpDir.dir)
      expect(result.setup_commands).toEqual(['pnpm install --frozen-lockfile'])
    })

    it('should detect yarn project', () => {
      tmpDir = createTempDir()
      tmpDir.writeFile('package.json', JSON.stringify({ name: 'test' }))
      tmpDir.writeFile('yarn.lock', '')
      const result = detectTechStack(tmpDir.dir)
      expect(result.setup_commands).toEqual(['yarn install --frozen-lockfile'])
    })

    it('should detect vitest config without test script', () => {
      tmpDir = createTempDir()
      tmpDir.writeFile('package.json', JSON.stringify({ name: 'test' }))
      tmpDir.writeFile('vitest.config.ts', '')
      const result = detectTechStack(tmpDir.dir)
      expect(result.quality_gate.test).toBe('npx vitest run')
    })

    it('should detect jest config', () => {
      tmpDir = createTempDir()
      tmpDir.writeFile('package.json', JSON.stringify({ name: 'test' }))
      tmpDir.writeFile('jest.config.js', '')
      const result = detectTechStack(tmpDir.dir)
      expect(result.quality_gate.test).toBe('npx jest')
    })

    it('should use custom typecheck script from package.json', () => {
      tmpDir = createTempDir()
      tmpDir.writeFile(
        'package.json',
        JSON.stringify({ name: 'test', scripts: { typecheck: 'tsc --noEmit --strict' } }),
      )
      tmpDir.writeFile('tsconfig.json', '{}')
      const result = detectTechStack(tmpDir.dir)
      expect(result.quality_gate.typecheck).toBe('tsc --noEmit --strict')
    })

    it('should detect Go project', () => {
      tmpDir = createTempDir()
      tmpDir.writeFile('go.mod', 'module example.com/test')
      const result = detectTechStack(tmpDir.dir)
      expect(result.quality_gate.typecheck).toBe('go vet ./...')
      expect(result.quality_gate.test).toBe('go test ./...')
      expect(result.setup_commands).toEqual([])
    })

    it('should detect Rust project', () => {
      tmpDir = createTempDir()
      tmpDir.writeFile('Cargo.toml', '[package]\nname = "test"')
      const result = detectTechStack(tmpDir.dir)
      expect(result.quality_gate.typecheck).toBe('cargo check')
      expect(result.quality_gate.test).toBe('cargo test')
    })

    it('should detect Python project with pytest', () => {
      tmpDir = createTempDir()
      tmpDir.writeFile('pyproject.toml', '[tool.pytest]\n')
      const result = detectTechStack(tmpDir.dir)
      expect(result.quality_gate.test).toBe('pytest')
    })

    it('should throw for unrecognized project', () => {
      tmpDir = createTempDir()
      expect(() => detectTechStack(tmpDir!.dir)).toThrow('无法自动检测')
    })
  })

  describe('autoCreateConfig', () => {
    it('should create .auto-dev.json and detect base branch', () => {
      let repo: TempGitRepo | null = null
      try {
        repo = createTempGitRepo()
        fs.writeFileSync(
          path.join(repo.dir, 'package.json'),
          JSON.stringify({ name: 'test', scripts: { test: 'jest' } }),
        )
        const config = autoCreateConfig(repo.dir)
        expect(config.base_branch).toBe('main')
        expect(config.quality_gate.test).toBe('npm test')

        const written = JSON.parse(fs.readFileSync(path.join(repo.dir, '.auto-dev.json'), 'utf-8'))
        expect(written.base_branch).toBe('main')
      } finally {
        repo?.cleanup()
      }
    })

    it('should detect dev branch when it exists', () => {
      let repo: TempGitRepo | null = null
      try {
        repo = createTempGitRepo()
        // Need an initial commit before we can create branches
        repo.writeFile('init.txt', 'init')
        repo.git('add', '.')
        repo.git('commit', '-m', 'init')
        repo.git('checkout', '-b', 'dev')
        repo.git('checkout', 'main')
        fs.writeFileSync(
          path.join(repo.dir, 'package.json'),
          JSON.stringify({ name: 'test' }),
        )
        fs.writeFileSync(path.join(repo.dir, 'tsconfig.json'), '{}')
        const config = autoCreateConfig(repo.dir)
        // 'main' comes first in detection order, so it should still be 'main'
        expect(config.base_branch).toBe('main')
      } finally {
        repo?.cleanup()
      }
    })
  })

  describe('applyDefaults', () => {
    it('should fill all defaults for minimal config', () => {
      const config = validateConfig({
        base_branch: 'main',
        quality_gate: { typecheck: 'tsc' },
      })
      const full = applyDefaults(config)
      expect(full.setup_commands).toEqual([])
      expect(full.session_timeout_minutes).toBe(DEFAULTS.SESSION_TIMEOUT_MINUTES)
      expect(full.setup_timeout_minutes).toBe(DEFAULTS.SETUP_TIMEOUT_MINUTES)
      expect(full.gate_timeout_minutes).toBe(DEFAULTS.GATE_TIMEOUT_MINUTES)
      expect(full.max_attempts_per_phase).toBe(DEFAULTS.MAX_ATTEMPTS_PER_PHASE)
      expect(full.max_turns).toBe(DEFAULTS.MAX_TURNS)
    })

    it('should preserve explicitly set values', () => {
      const config = validateConfig({
        base_branch: 'main',
        quality_gate: { typecheck: 'tsc' },
        max_turns: 50,
      })
      const full = applyDefaults(config)
      expect(full.max_turns).toBe(50)
    })
  })
})
