import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import { createTempGitRepo, type TempGitRepo } from '../helpers/git-repo.js'
import {
  assertCleanTree,
  runGateCommand,
  autoCommitGate,
  runQualityGates,
  runSetupCommands,
  runPreflightCheck,
} from '../../src/quality-gate.js'

describe('quality-gate', () => {
  let repo: TempGitRepo

  afterEach(() => {
    repo?.cleanup()
  })

  function initRepo(): TempGitRepo {
    repo = createTempGitRepo()
    repo.writeFile('README.md', '# Test')
    repo.git('add', '-A')
    repo.git('commit', '-m', 'init')
    return repo
  }

  describe('assertCleanTree', () => {
    it('should pass for clean worktree', () => {
      const r = initRepo()
      const result = assertCleanTree(r.dir)
      expect(result.passed).toBe(true)
    })

    it('should fail for tracked modifications', () => {
      const r = initRepo()
      fs.writeFileSync(`${r.dir}/README.md`, '# Changed')

      const result = assertCleanTree(r.dir)
      expect(result.passed).toBe(false)
      expect(result.error).toContain('tracked modifications')
    })

    it('should fail for untracked non-ignored files', () => {
      const r = initRepo()
      fs.writeFileSync(`${r.dir}/new-file.txt`, 'new')

      const result = assertCleanTree(r.dir)
      expect(result.passed).toBe(false)
      expect(result.error).toContain('untracked')
    })

    it('should pass when only gitignored files exist', () => {
      const r = initRepo()
      r.writeFile('.gitignore', 'node_modules/\n')
      r.git('add', '.gitignore')
      r.git('commit', '-m', 'add gitignore')

      fs.mkdirSync(`${r.dir}/node_modules`, { recursive: true })
      fs.writeFileSync(`${r.dir}/node_modules/package.json`, '{}')

      const result = assertCleanTree(r.dir)
      expect(result.passed).toBe(true)
    })
  })

  describe('runGateCommand', () => {
    it('should pass for successful command', async () => {
      const r = initRepo()
      const result = await runGateCommand('echo "ok"', r.dir, 10_000)
      expect(result.passed).toBe(true)
    })

    it('should fail for failing command', async () => {
      const r = initRepo()
      const result = await runGateCommand('exit 1', r.dir, 10_000)
      expect(result.passed).toBe(false)
      expect(result.error).toContain('exit 1')
    })

    it('should fail on timeout', async () => {
      const r = initRepo()
      const result = await runGateCommand('sleep 30', r.dir, 500)
      expect(result.passed).toBe(false)
      expect(result.error).toContain('timed out')
    })
  })

  describe('autoCommitGate', () => {
    it('should pass when no uncommitted changes', async () => {
      const r = initRepo()
      const result = await autoCommitGate(r.dir, 'true', 10_000)
      expect(result.passed).toBe(true)
    })

    it('should auto-commit when typecheck passes', async () => {
      const r = initRepo()
      fs.writeFileSync(`${r.dir}/new.ts`, 'export const x = 1;')

      const result = await autoCommitGate(r.dir, 'true', 10_000)
      expect(result.passed).toBe(true)

      // Verify committed
      const log = r.git('log', '--oneline', '-1')
      expect(log).toContain('auto-commit')
    })

    it('should discard changes when typecheck fails', async () => {
      const r = initRepo()
      fs.writeFileSync(`${r.dir}/bad.ts`, 'invalid syntax{{{')

      const result = await autoCommitGate(r.dir, 'exit 1', 10_000)
      expect(result.passed).toBe(false)
      expect(result.error).toContain('failed typecheck')

      // Verify changes discarded
      expect(fs.existsSync(`${r.dir}/bad.ts`)).toBe(false)
    })

    it('should auto-commit even without typecheck command', async () => {
      const r = initRepo()
      fs.writeFileSync(`${r.dir}/new.ts`, 'export const x = 1;')

      const result = await autoCommitGate(r.dir, undefined, 10_000)
      expect(result.passed).toBe(true)

      const log = r.git('log', '--oneline', '-1')
      expect(log).toContain('auto-commit')
    })
  })

  describe('runQualityGates', () => {
    it('should pass when both typecheck and test succeed', async () => {
      const r = initRepo()
      const result = await runQualityGates(
        { typecheck: 'true', test: 'true' },
        r.dir,
        10_000,
      )
      expect(result.passed).toBe(true)
    })

    it('should fail when typecheck fails', async () => {
      const r = initRepo()
      const result = await runQualityGates(
        { typecheck: 'exit 1', test: 'true' },
        r.dir,
        10_000,
      )
      expect(result.passed).toBe(false)
      expect(result.error).toContain('L1 typecheck')
    })

    it('should fail when test fails', async () => {
      const r = initRepo()
      const result = await runQualityGates(
        { typecheck: 'true', test: 'exit 1' },
        r.dir,
        10_000,
      )
      expect(result.passed).toBe(false)
      expect(result.error).toContain('L2 test')
    })

    it('should fail when typecheck pollutes worktree', async () => {
      const r = initRepo()
      const result = await runQualityGates(
        { typecheck: `touch "${r.dir}/dirty-file"`, test: 'true' },
        r.dir,
        10_000,
      )
      expect(result.passed).toBe(false)
      expect(result.error).toContain('dirty after typecheck')
    })

    it('should fail when test pollutes worktree', async () => {
      const r = initRepo()
      const result = await runQualityGates(
        { typecheck: 'true', test: `touch "${r.dir}/dirty-file"` },
        r.dir,
        10_000,
      )
      expect(result.passed).toBe(false)
      expect(result.error).toContain('dirty after test')
    })

    it('should pass with only typecheck configured', async () => {
      const r = initRepo()
      const result = await runQualityGates(
        { typecheck: 'true' },
        r.dir,
        10_000,
      )
      expect(result.passed).toBe(true)
    })

    it('should pass with only test configured', async () => {
      const r = initRepo()
      const result = await runQualityGates(
        { test: 'true' },
        r.dir,
        10_000,
      )
      expect(result.passed).toBe(true)
    })
  })

  describe('runSetupCommands', () => {
    it('should pass when commands succeed and tree is clean', async () => {
      const r = initRepo()
      const result = await runSetupCommands(['echo setup'], r.dir, 10_000)
      expect(result.passed).toBe(true)
    })

    it('should fail when a command fails', async () => {
      const r = initRepo()
      const result = await runSetupCommands(
        ['echo ok', 'exit 1'],
        r.dir,
        10_000,
      )
      expect(result.passed).toBe(false)
      expect(result.error).toContain('Setup command failed')
    })

    it('should fail when setup pollutes worktree', async () => {
      const r = initRepo()
      const result = await runSetupCommands(
        [`touch "${r.dir}/dirty"`],
        r.dir,
        10_000,
      )
      expect(result.passed).toBe(false)
      expect(result.error).toContain('dirty after setup')
    })

    it('should pass with empty commands array', async () => {
      const r = initRepo()
      const result = await runSetupCommands([], r.dir, 10_000)
      expect(result.passed).toBe(true)
    })
  })

  describe('runPreflightCheck', () => {
    it('should pass when quality gates pass', async () => {
      const r = initRepo()
      const result = await runPreflightCheck(
        { typecheck: 'true', test: 'true' },
        r.dir,
        10_000,
      )
      expect(result.passed).toBe(true)
    })

    it('should fail when quality gates fail', async () => {
      const r = initRepo()
      const result = await runPreflightCheck(
        { typecheck: 'exit 1' },
        r.dir,
        10_000,
      )
      expect(result.passed).toBe(false)
    })
  })
})
