import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs, handleStatus, displayStatus, CliError } from '../../src/index.js'
import { createTempGitRepo, type TempGitRepo } from '../helpers/git-repo.js'
import { atomicWriteManifest } from '../../src/manifest.js'
import * as paths from '../../src/paths.js'
import type { Manifest, Phase } from '../../src/types.js'

function makePhase(overrides: Partial<Phase> = {}): Phase {
  return {
    slug: 'test-phase',
    order: 1,
    title: 'Test Phase',
    summary: 'A test phase',
    acceptance_criteria: ['criterion 1'],
    status: 'pending',
    attempts: 0,
    last_error: null,
    feature_base_sha: null,
    phase_head_sha: null,
    merged: false,
    merge_commit_sha: null,
    ...overrides,
  }
}

function makeManifest(phases: Phase[] = [], overrides: Partial<Manifest> = {}): Manifest {
  return {
    plan_id: 'test-plan',
    plan_doc: '.claude/plans/test-plan.md',
    plan_doc_hash: 'abc123',
    feature_branch: 'feat/test-plan',
    base_branch: 'main',
    quality_gate: { typecheck: 'echo ok' },
    setup_commands: [],
    session_timeout_minutes: 20,
    setup_timeout_minutes: 5,
    gate_timeout_minutes: 10,
    max_attempts_per_phase: 3,
    max_turns: 200,
    total_tokens: { input: 100, output: 50 },
    total_cost_usd: 0.5,
    phases,
    created_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    ...overrides,
  }
}

describe('CLI parseArgs', () => {
  let repo: TempGitRepo

  afterEach(() => {
    if (repo) {
      repo.cleanup()
    }
  })

  function setupRepo(): string {
    repo = createTempGitRepo()
    repo.writeFile('init.txt', 'init')
    repo.git('add', '-A')
    repo.git('commit', '-m', 'init')
    repo.writeFile('.claude/plans/v2.1.0.md', '# Plan')
    return repo.dir
  }

  it('should parse start command with required args', () => {
    const dir = setupRepo()
    const planPath = path.join(dir, '.claude/plans/v2.1.0.md')

    const args = parseArgs(['node', 'index.ts', 'start', dir, '--plan', planPath])

    expect(args.command).toBe('start')
    expect(args.projectRoot).toBe(path.resolve(dir))
    expect(args.planDocPath).toBe(path.resolve(planPath))
    expect(args.planId).toBe('v2.1.0')
    expect(args.reset).toBe(false)
    expect(args.retry).toBe(false)
    expect(args.dryRun).toBe(false)
  })

  it('should parse status command', () => {
    const dir = setupRepo()
    const planPath = path.join(dir, '.claude/plans/v2.1.0.md')

    const args = parseArgs(['node', 'index.ts', 'status', dir, '--plan', planPath])

    expect(args.command).toBe('status')
  })

  it('should parse --reset flag', () => {
    const dir = setupRepo()
    const planPath = path.join(dir, '.claude/plans/v2.1.0.md')

    const args = parseArgs([
      'node', 'index.ts', 'start', dir, '--plan', planPath, '--reset',
    ])

    expect(args.reset).toBe(true)
    expect(args.retry).toBe(false)
  })

  it('should parse --retry flag', () => {
    const dir = setupRepo()
    const planPath = path.join(dir, '.claude/plans/v2.1.0.md')

    const args = parseArgs([
      'node', 'index.ts', 'start', dir, '--plan', planPath, '--retry',
    ])

    expect(args.retry).toBe(true)
    expect(args.reset).toBe(false)
  })

  it('should parse --dry-run flag', () => {
    const dir = setupRepo()
    const planPath = path.join(dir, '.claude/plans/v2.1.0.md')

    const args = parseArgs([
      'node', 'index.ts', 'start', dir, '--plan', planPath, '--dry-run',
    ])

    expect(args.dryRun).toBe(true)
  })

  it('should throw on no command', () => {
    expect(() => parseArgs(['node', 'index.ts'])).toThrow(CliError)
  })

  it('should throw on unknown command', () => {
    expect(() => parseArgs(['node', 'index.ts', 'unknown'])).toThrow(CliError)
  })

  it('should throw on missing --plan', () => {
    const dir = setupRepo()
    expect(() => parseArgs(['node', 'index.ts', 'start', dir])).toThrow(
      /--plan is required/,
    )
  })

  it('should throw on missing project root', () => {
    expect(() =>
      parseArgs(['node', 'index.ts', 'start', '--plan', 'some.md']),
    ).toThrow(/Project root/)
  })

  it('should throw when --reset and --retry used together', () => {
    const dir = setupRepo()
    const planPath = path.join(dir, '.claude/plans/v2.1.0.md')

    expect(() =>
      parseArgs([
        'node', 'index.ts', 'start', dir, '--plan', planPath,
        '--reset', '--retry',
      ]),
    ).toThrow(/cannot be used together/)
  })

  it('should throw when --dry-run used with --reset', () => {
    const dir = setupRepo()
    const planPath = path.join(dir, '.claude/plans/v2.1.0.md')

    expect(() =>
      parseArgs([
        'node', 'index.ts', 'start', dir, '--plan', planPath,
        '--dry-run', '--reset',
      ]),
    ).toThrow(/cannot be used with/)
  })

  it('should throw on status with --reset', () => {
    const dir = setupRepo()
    const planPath = path.join(dir, '.claude/plans/v2.1.0.md')

    expect(() =>
      parseArgs([
        'node', 'index.ts', 'status', dir, '--plan', planPath, '--reset',
      ]),
    ).toThrow(/does not support/)
  })

  it('should throw on invalid plan_id', () => {
    repo = createTempGitRepo()
    repo.writeFile('init.txt', 'init')
    repo.git('add', '-A')
    repo.git('commit', '-m', 'init')
    repo.writeFile('.claude/plans/invalid name.md', '# Plan')
    const planPath = path.join(repo.dir, '.claude/plans/invalid name.md')

    expect(() =>
      parseArgs(['node', 'index.ts', 'start', repo.dir, '--plan', planPath]),
    ).toThrow(/命名规范/)
  })

  it('should throw on non-existent project root', () => {
    expect(() =>
      parseArgs([
        'node', 'index.ts', 'start', '/nonexistent/path',
        '--plan', '/some/plan.md',
      ]),
    ).toThrow(/does not exist/)
  })

  it('should throw on non-existent plan doc', () => {
    const dir = setupRepo()
    expect(() =>
      parseArgs([
        'node', 'index.ts', 'start', dir,
        '--plan', path.join(dir, 'nonexistent.md'),
      ]),
    ).toThrow(/does not exist/)
  })

  it('should throw on unknown option', () => {
    const dir = setupRepo()
    const planPath = path.join(dir, '.claude/plans/v2.1.0.md')

    expect(() =>
      parseArgs(['node', 'index.ts', 'start', dir, '--plan', planPath, '--unknown']),
    ).toThrow(/Unknown option/)
  })

  it('should derive correct plan_id from filename', () => {
    repo = createTempGitRepo()
    repo.writeFile('init.txt', 'init')
    repo.git('add', '-A')
    repo.git('commit', '-m', 'init')
    repo.writeFile('.claude/plans/refactor-auth.md', '# Plan')
    const planPath = path.join(repo.dir, '.claude/plans/refactor-auth.md')

    const args = parseArgs([
      'node', 'index.ts', 'start', repo.dir, '--plan', planPath,
    ])

    expect(args.planId).toBe('refactor-auth')
  })
})

describe('handleStatus', () => {
  let repo: TempGitRepo

  afterEach(() => {
    if (repo) {
      repo.cleanup()
    }
  })

  it('should return CONFIG_ERROR when manifest does not exist', () => {
    repo = createTempGitRepo()
    repo.writeFile('init.txt', 'init')
    repo.git('add', '-A')
    repo.git('commit', '-m', 'init')

    const result = handleStatus(repo.dir, 'nonexistent')
    expect(result).toBe(2) // CONFIG_ERROR
  })

  it('should return SUCCESS when manifest exists', () => {
    repo = createTempGitRepo()
    repo.writeFile('init.txt', 'init')
    repo.git('add', '-A')
    repo.git('commit', '-m', 'init')

    const manifest = makeManifest([
      makePhase({ slug: 'db-schema', order: 1, status: 'completed', attempts: 1 }),
      makePhase({ slug: 'backend-api', order: 2, status: 'failed', attempts: 3, last_error: 'L2 test failed' }),
      makePhase({ slug: 'frontend-ui', order: 3, status: 'pending' }),
    ])

    const manifestFile = paths.manifestPath(repo.dir, 'test-plan')
    fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
    atomicWriteManifest(manifestFile, manifest)

    const result = handleStatus(repo.dir, 'test-plan')
    expect(result).toBe(0) // SUCCESS
  })
})
