#!/usr/bin/env node

import * as fs from 'node:fs'
import * as path from 'node:path'
import { EXIT_CODES, PLAN_ID_PATTERN } from './types.js'
import { logger } from './logger.js'
import * as paths from './paths.js'
import { readManifest } from './manifest.js'
import { orchestrate } from './orchestrator.js'
import type { Manifest } from './types.js'

export interface CliArgs {
  command: 'start' | 'status'
  projectRoot: string
  planDocPath: string
  planId: string
  reset: boolean
  retry: boolean
  dryRun: boolean
}

export class CliError extends Error {
  constructor(
    message: string,
    public exitCode: number = EXIT_CODES.CONFIG_ERROR,
  ) {
    super(message)
    this.name = 'CliError'
  }
}

/**
 * Parse CLI arguments from process.argv.
 */
export function parseArgs(argv: string[]): CliArgs {
  // Strip node and script path
  const args = argv.slice(2)

  if (args.length === 0) {
    printUsage()
    throw new CliError('No command specified', EXIT_CODES.CONFIG_ERROR)
  }

  const command = args[0]
  if (command !== 'start' && command !== 'status') {
    printUsage()
    throw new CliError(
      `Unknown command: ${command}. Use "start" or "status".`,
      EXIT_CODES.CONFIG_ERROR,
    )
  }

  // Parse remaining args
  let projectRoot: string | undefined
  let planDocPath: string | undefined
  let reset = false
  let retry = false
  let dryRun = false

  let i = 1
  while (i < args.length) {
    const arg = args[i]

    if (arg === '--plan') {
      i++
      if (i >= args.length) {
        throw new CliError('--plan requires a value')
      }
      planDocPath = args[i]
    } else if (arg === '--reset') {
      reset = true
    } else if (arg === '--retry') {
      retry = true
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (!arg.startsWith('-')) {
      projectRoot = arg
    } else {
      throw new CliError(`Unknown option: ${arg}`)
    }

    i++
  }

  // Validate required args
  if (!projectRoot) {
    throw new CliError('Project root path is required')
  }

  if (!planDocPath) {
    throw new CliError('--plan is required')
  }

  // Validate mutually exclusive flags
  if (reset && retry) {
    throw new CliError('--reset and --retry cannot be used together')
  }

  if (dryRun && (reset || retry)) {
    throw new CliError('--dry-run cannot be used with --reset or --retry')
  }

  // status command doesn't support --reset, --retry, --dry-run
  if (command === 'status' && (reset || retry || dryRun)) {
    throw new CliError('status command does not support --reset, --retry, or --dry-run')
  }

  // Resolve paths
  const resolvedProjectRoot = path.resolve(projectRoot)
  const resolvedPlanDoc = path.resolve(planDocPath)

  // Validate project root exists
  if (!fs.existsSync(resolvedProjectRoot)) {
    throw new CliError(`Project root does not exist: ${resolvedProjectRoot}`)
  }

  // Validate plan doc exists
  if (!fs.existsSync(resolvedPlanDoc)) {
    throw new CliError(`Plan document does not exist: ${resolvedPlanDoc}`)
  }

  // Derive plan_id from filename
  const planId = paths.planIdFromFilename(resolvedPlanDoc)

  // Validate plan_id naming
  if (!PLAN_ID_PATTERN.test(planId)) {
    throw new CliError(
      `计划文件名不符合命名规范 (${planId})，` +
        `请使用英文、数字、点、短横线（如 v2.1.0.md、refactor-auth.md）`,
    )
  }

  return {
    command,
    projectRoot: resolvedProjectRoot,
    planDocPath: resolvedPlanDoc,
    planId,
    reset,
    retry,
    dryRun,
  }
}

/**
 * Print usage information.
 */
export function printUsage(): void {
  const usage = `
auto-dev - Automated development orchestration tool

Usage:
  auto-dev start <project-root> --plan <plan-doc> [options]
  auto-dev status <project-root> --plan <plan-doc>

Commands:
  start     Start or resume plan execution
  status    Show current plan execution status

Options:
  --plan <path>   Path to the plan document (required)
  --reset         Clear all state and restart from scratch
  --retry         Reset failed phases and retry with refreshed config
  --dry-run       Only run Session 0, show extracted phases, don't execute
`.trim()
  console.log(usage)
}

/**
 * Display plan status from manifest.
 */
export function displayStatus(manifest: Manifest): void {
  console.log(`\n计划: ${manifest.plan_id} (${manifest.feature_branch})`)
  console.log(`基础分支: ${manifest.base_branch}`)
  console.log('')

  // Header
  const header = `  #  | ${'Phase'.padEnd(20)} | ${'状态'.padEnd(12)} | 尝试次数`
  console.log(header)
  console.log('  ' + '-'.repeat(header.length - 2))

  for (const phase of manifest.phases) {
    const orderStr = String(phase.order).padStart(2)
    const slugStr = phase.slug.padEnd(20)
    const statusStr = phase.status.padEnd(12)
    console.log(`  ${orderStr} | ${slugStr} | ${statusStr} | ${phase.attempts}`)
  }

  // Show failure details
  const failed = manifest.phases.filter((p) => p.status === 'failed')
  for (const phase of failed) {
    console.log(`\n失败原因 (${phase.slug}):`)
    console.log(`  ${phase.last_error || '(无错误信息)'}`)

    const wtPath = paths.worktreePath(
      '', // we only need relative display
      manifest.plan_id,
      phase.slug,
    )
    const branch = paths.phaseBranch(manifest.plan_id, phase.slug)
    console.log(`\n保留现场:`)
    console.log(`  branch: ${branch}`)
  }

  // Token summary
  if (manifest.total_tokens.input > 0 || manifest.total_tokens.output > 0) {
    console.log(
      `\nToken 使用: input ${manifest.total_tokens.input.toLocaleString()} / ` +
        `output ${manifest.total_tokens.output.toLocaleString()} | ` +
        `预估费用: $${manifest.total_cost_usd.toFixed(2)}`,
    )
  }
}

/**
 * Handle the 'status' command.
 */
export function handleStatus(projectRoot: string, planId: string): number {
  const manifestFilePath = paths.manifestPath(projectRoot, planId)
  const manifest = readManifest(manifestFilePath)

  if (!manifest) {
    console.log(`计划 ${planId} 的 manifest 不存在。请先运行 auto-dev start。`)
    return EXIT_CODES.CONFIG_ERROR
  }

  displayStatus(manifest)
  return EXIT_CODES.SUCCESS
}

/**
 * Main entry point.
 */
export async function main(argv: string[] = process.argv): Promise<number> {
  try {
    const args = parseArgs(argv)

    // Initialize logger
    try {
      const logFilePath = path.join(
        paths.logDir(args.projectRoot, args.planId),
        'orchestrator.log',
      )
      logger.init(logFilePath)
    } catch {
      // Logger init may fail if not in a git repo — that's ok for now
    }

    if (args.command === 'status') {
      return handleStatus(args.projectRoot, args.planId)
    }

    // 'start' command — delegate to orchestrator
    return await orchestrate(args)
  } catch (err) {
    if (err instanceof CliError) {
      logger.error(err.message)
      return err.exitCode
    }
    logger.error(`Unexpected error: ${(err as Error).message}`)
    return EXIT_CODES.PHASE_FAILED
  }
}

// Run if this is the main module
const isMainModule =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('/index.ts') ||
    process.argv[1].endsWith('/index.js'))

if (isMainModule) {
  main().then((code) => process.exit(code))
}
