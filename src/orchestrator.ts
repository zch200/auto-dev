import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as git from './git.js'
import * as paths from './paths.js'
import { loadConfig, applyDefaults } from './config.js'
import { readManifest, atomicWriteManifest, deleteManifest } from './manifest.js'
import { validateCandidate, CandidateError } from './candidate.js'
import { acquireLock, releaseLock, registerLockCleanup } from './lock.js'
import { LockError } from './lock.js'
import { createWorktree, cleanupWorktree, cleanupAllWorktrees } from './worktree.js'
import {
  runSession0,
  runPhaseSession,
  runVerificationSession,
  runPreflight,
} from './session.js'
import {
  assertCleanTree,
  autoCommitGate,
  runQualityGates,
  runSetupCommands,
  runPreflightCheck,
} from './quality-gate.js'
import {
  generateBundle,
  readVerificationResult,
  verificationJsonPath,
} from './verification.js'
import {
  buildInitPrompt,
  buildPhasePrompt,
  buildPhaseRetryPrompt,
  buildVerificationPrompt,
} from './prompt.js'
import { reconcileInit, RecoveryError } from './recovery.js'
import { executeRetry, RetryError } from './retry.js'
import { notifySuccess, notifyFailure, notifyPreflightFailure } from './notify.js'
import { logger } from './logger.js'
import { ConfigError } from './config.js'
import type { Manifest, Phase } from './types.js'
import { EXIT_CODES, DEFAULTS } from './types.js'
import type { CliArgs } from './index.js'

// Heuristic patterns for dry-run acceptance criteria warnings
const CRITERIA_WARN_PATTERNS = [
  { pattern: /[<>]\s*\d+\s*(ms|s|秒|毫秒)/, hint: '延迟/性能阈值' },
  { pattern: /可正常(运行|执行|启动|访问|连接|响应)/, hint: '运行时断言' },
  { pattern: /(运行|执行|启动).*(后|时|成功)/, hint: '时序断言' },
]

/**
 * Main orchestration entry point. Called from index.ts for the 'start' command.
 */
export async function orchestrate(args: CliArgs): Promise<number> {
  const { projectRoot, planDocPath, planId, reset, retry, dryRun } = args

  // 1. Validate config exists
  let config
  try {
    config = await loadConfig(projectRoot)
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(err.message)
      return EXIT_CODES.CONFIG_ERROR
    }
    throw err
  }
  const resolved = applyDefaults(config)

  // 2. Preflight check (skip for --reset-only and --dry-run)
  if (!reset && !dryRun) {
    const preflightOk = await runPreflight()
    if (!preflightOk) {
      logger.error(
        'Claude CLI 不可用或权限配置无效，请确认已安装并完成认证',
      )
      return EXIT_CODES.CLAUDE_UNAVAILABLE
    }
  }

  // 3. --reset: clean everything and fall through to init
  if (reset) {
    await executeReset(projectRoot, planId, planDocPath)
  }

  // 4. --retry: validate hash and reset failed phases
  let manifest: Manifest | null = null
  if (retry) {
    try {
      manifest = await executeRetry(projectRoot, planId, planDocPath)
    } catch (err) {
      if (err instanceof RetryError) {
        logger.error(err.message)
        return EXIT_CODES.CONFIG_ERROR
      }
      throw err
    }
  }

  // 5. Acquire lock
  const lockDirPath = paths.lockDir(projectRoot, planId)
  try {
    acquireLock(lockDirPath, planId)
  } catch (err) {
    if (err instanceof LockError) {
      logger.error(err.message)
      return EXIT_CODES.LOCK_CONFLICT
    }
    throw err
  }
  registerLockCleanup(lockDirPath)

  try {
    // 6. Initialization reconciliation
    if (!manifest) {
      const planDocRelPath = paths.relativePlanDoc(projectRoot, planDocPath)
      let initState: 'init' | 'ready'

      try {
        initState = reconcileInit(projectRoot, planId, planDocRelPath)
      } catch (err) {
        if (err instanceof RecoveryError) {
          logger.error(err.message)
          return EXIT_CODES.CONFIG_ERROR
        }
        throw err
      }

      if (initState === 'init') {
        // Run Session 0 to create manifest
        manifest = await runSession0Flow(
          projectRoot,
          planId,
          planDocPath,
          resolved,
        )
        if (!manifest) {
          return EXIT_CODES.PHASE_FAILED
        }

        if (dryRun) {
          displayDryRun(manifest, resolved)
          return EXIT_CODES.SUCCESS
        }

        // Create feature branch
        git.createBranch(manifest.feature_branch, manifest.base_branch, projectRoot)
        logger.info(`Feature branch created: ${manifest.feature_branch}`)
      } else {
        // Ready — read existing manifest
        manifest = readManifest(paths.manifestPath(projectRoot, planId))!

        if (dryRun) {
          displayDryRun(manifest, resolved)
          return EXIT_CODES.SUCCESS
        }
      }
    } else if (dryRun) {
      displayDryRun(manifest, resolved)
      return EXIT_CODES.SUCCESS
    }

    // 7. Main phase loop
    return await runPhaseLoop(manifest, projectRoot, planDocPath)
  } finally {
    releaseLock(lockDirPath)
  }
}

/**
 * Execute --reset: clean all state for the given plan.
 */
async function executeReset(
  projectRoot: string,
  planId: string,
  planDocPath: string,
): Promise<void> {
  logger.info(`[reset] 清理计划 ${planId} 的所有状态...`)

  const featureBranch = paths.featureBranch(planId)

  // Read existing manifest for phase slugs (if available)
  const manifestFilePath = paths.manifestPath(projectRoot, planId)
  const existingManifest = readManifest(manifestFilePath)
  const slugs = existingManifest
    ? existingManifest.phases.map((p) => p.slug)
    : []

  // 0. Checkout base branch so we can delete feature/phase branches
  const baseBranch = existingManifest?.base_branch
  if (baseBranch) {
    try {
      git.checkout(baseBranch, projectRoot)
    } catch {
      // Best effort — base branch might not exist
    }
  }

  // 1. Clean all worktrees
  if (slugs.length > 0) {
    cleanupAllWorktrees(projectRoot, planId, slugs)
  }

  // Also scan for any remaining worktrees matching this plan
  try {
    const worktrees = git.listWorktrees(projectRoot)
    const planPrefix = paths.worktreeBase(projectRoot)
    for (const wt of worktrees) {
      if (wt.includes(planId) && wt.startsWith(planPrefix)) {
        try {
          git.removeWorktree(wt, projectRoot)
          if (fs.existsSync(wt)) {
            fs.rmSync(wt, { recursive: true, force: true })
          }
        } catch {
          // Best effort
        }
      }
    }
  } catch {
    // git worktree list may fail if not in a repo
  }

  // 2. Delete all phase branches
  for (const slug of slugs) {
    git.deleteBranch(paths.phaseBranch(planId, slug), projectRoot)
  }

  // 3. Delete feature branch
  git.deleteBranch(featureBranch, projectRoot)

  // 4. Delete runtime files
  deleteManifest(manifestFilePath)

  // Delete candidate
  const candidateFile = paths.candidatePath(projectRoot, planId)
  try { fs.unlinkSync(candidateFile) } catch { /* may not exist */ }

  // Delete verification directories
  const verificationBase = path.join(paths.runtimeDir(projectRoot), 'verification', planId)
  try { fs.rmSync(verificationBase, { recursive: true, force: true }) } catch { /* ok */ }

  // Delete log directory
  const logDirPath = paths.logDir(projectRoot, planId)
  try { fs.rmSync(logDirPath, { recursive: true, force: true }) } catch { /* ok */ }

  // Release lock if exists (reset should not require lock)
  const lockDirPath = paths.lockDir(projectRoot, planId)
  try { fs.rmSync(lockDirPath, { recursive: true, force: true }) } catch { /* ok */ }

  logger.info('[reset] 清理完成')
}

/**
 * Run Session 0 flow: execute Claude session to parse plan doc,
 * validate candidate, assemble manifest.
 */
async function runSession0Flow(
  projectRoot: string,
  planId: string,
  planDocPath: string,
  config: Required<import('./types.js').ProjectConfig>,
): Promise<Manifest | null> {
  const candidateFilePath = paths.candidatePath(projectRoot, planId)
  const planDocContent = fs.readFileSync(planDocPath, 'utf-8')
  const planDocRelPath = paths.relativePlanDoc(projectRoot, planDocPath)

  let lastError = ''

  for (let attempt = 0; attempt < DEFAULTS.MAX_SESSION0_ATTEMPTS; attempt++) {
    logger.info(
      `Session 0: 解析计划文档 (尝试 ${attempt + 1}/${DEFAULTS.MAX_SESSION0_ATTEMPTS})`,
    )

    // Build prompt
    let prompt: string
    if (attempt === 0) {
      prompt = buildInitPrompt(planDocContent, candidateFilePath)
    } else {
      // Retry with error context
      prompt = buildInitPrompt(planDocContent, candidateFilePath) +
        `\n\n## 上次错误\n上次输出未通过校验: ${lastError}\n请修正后重新输出。`
    }

    // Run Session 0
    const sessionResult = await runSession0(
      prompt,
      projectRoot,
      config.session_timeout_minutes * 60 * 1000,
    )

    // Check candidate file exists
    if (!fs.existsSync(candidateFilePath)) {
      lastError = 'candidate 文件未生成'
      logger.warn(`Session 0: ${lastError}`)
      continue
    }

    // Parse and validate candidate
    let candidateRaw: unknown
    try {
      const content = fs.readFileSync(candidateFilePath, 'utf-8')
      candidateRaw = JSON.parse(content)
    } catch (err) {
      lastError = `candidate 文件不是合法 JSON: ${(err as Error).message}`
      logger.warn(`Session 0: ${lastError}`)
      try { fs.unlinkSync(candidateFilePath) } catch { /* ok */ }
      continue
    }

    try {
      const candidate = validateCandidate(candidateRaw)

      // Assemble manifest
      const planDocHash = crypto
        .createHash('sha256')
        .update(planDocContent)
        .digest('hex')

      const manifest: Manifest = {
        plan_id: planId,
        plan_doc: planDocRelPath,
        plan_doc_hash: planDocHash,
        feature_branch: paths.featureBranch(planId),
        base_branch: config.base_branch,
        quality_gate: config.quality_gate,
        setup_commands: config.setup_commands,
        session_timeout_minutes: config.session_timeout_minutes,
        setup_timeout_minutes: config.setup_timeout_minutes,
        gate_timeout_minutes: config.gate_timeout_minutes,
        max_attempts_per_phase: config.max_attempts_per_phase,
        max_turns: config.max_turns,
        total_tokens: {
          input: sessionResult.tokens.input,
          output: sessionResult.tokens.output,
        },
        total_cost_usd: sessionResult.costUsd,
        phases: candidate.phases.map((cp) => ({
          ...cp,
          status: 'pending' as const,
          attempts: 0,
          last_error: null,
          feature_base_sha: null,
          phase_head_sha: null,
          merged: false,
          merge_commit_sha: null,
        })),
        created_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
      }

      // Atomic write manifest
      const manifestFilePath = paths.manifestPath(projectRoot, planId)
      atomicWriteManifest(manifestFilePath, manifest)

      // Delete candidate file
      try { fs.unlinkSync(candidateFilePath) } catch { /* ok */ }

      logger.info(
        `Session 0: 成功提取 ${manifest.phases.length} 个 phase`,
      )
      return manifest
    } catch (err) {
      if (err instanceof CandidateError) {
        lastError = err.message
        logger.warn(`Session 0: candidate 校验失败: ${lastError}`)
        try { fs.unlinkSync(candidateFilePath) } catch { /* ok */ }
        continue
      }
      throw err
    }
  }

  logger.error(
    `Session 0 连续 ${DEFAULTS.MAX_SESSION0_ATTEMPTS} 次未能产出合法的候选文件: ${lastError}`,
  )
  return null
}

/**
 * Main phase execution loop.
 */
async function runPhaseLoop(
  manifest: Manifest,
  projectRoot: string,
  planDocPath: string,
): Promise<number> {
  const planDocContent = fs.readFileSync(planDocPath, 'utf-8')
  const manifestFilePath = paths.manifestPath(projectRoot, manifest.plan_id)
  const gateTimeoutMs = manifest.gate_timeout_minutes * 60 * 1000

  while (true) {
    // Sort phases by order, find first pending
    const sorted = [...manifest.phases].sort((a, b) => a.order - b.order)
    const nextPhase = sorted.find((p) => p.status === 'pending')

    if (!nextPhase) {
      // Check if all completed
      const allCompleted = manifest.phases.every(
        (p) => p.status === 'completed',
      )
      if (allCompleted) {
        logger.info('全部 phase 已完成!')
        displayTokenSummary(manifest)
        notifySuccess(manifest.plan_id)
        return EXIT_CODES.SUCCESS
      }

      // Has failed phases
      const failed = manifest.phases.find((p) => p.status === 'failed')
      if (failed) {
        logger.error(
          `Phase ${failed.slug} 连续 ${manifest.max_attempts_per_phase} 次失败，疑似计划或代码问题`,
        )
        logger.error(
          '已保留失败现场供人工检查，请修复后使用 --retry 或 --reset',
        )
        displayTokenSummary(manifest)
        notifyFailure(manifest.plan_id, failed.slug, failed.last_error || '')
        return EXIT_CODES.PHASE_FAILED
      }

      // Shouldn't reach here
      return EXIT_CODES.SUCCESS
    }

    // Execute the phase
    const result = await executePhase(
      manifest,
      nextPhase,
      projectRoot,
      planDocContent,
      manifestFilePath,
      gateTimeoutMs,
    )

    if (result === 'preflight-failed') {
      displayTokenSummary(manifest)
      notifyPreflightFailure(manifest.plan_id, nextPhase.slug)
      return EXIT_CODES.PHASE_FAILED
    }

    if (result === 'max-attempts-reached') {
      displayTokenSummary(manifest)
      notifyFailure(
        manifest.plan_id,
        nextPhase.slug,
        nextPhase.last_error || '',
      )
      return EXIT_CODES.PHASE_FAILED
    }

    // result === 'completed' or 'retry' → continue loop
  }
}

/**
 * Execute a single phase through the full pipeline.
 */
async function executePhase(
  manifest: Manifest,
  phase: Phase,
  projectRoot: string,
  planDocContent: string,
  manifestFilePath: string,
  gateTimeoutMs: number,
): Promise<'completed' | 'retry' | 'preflight-failed' | 'max-attempts-reached'> {
  const planId = manifest.plan_id
  const featureBranch = manifest.feature_branch
  const setupTimeoutMs = manifest.setup_timeout_minutes * 60 * 1000
  const sessionTimeoutMs = manifest.session_timeout_minutes * 60 * 1000

  logger.info(
    `\n${'='.repeat(60)}\nPhase ${phase.order}: ${phase.title} [${phase.slug}] (attempt ${phase.attempts + 1}/${manifest.max_attempts_per_phase})\n${'='.repeat(60)}`,
  )

  // 1. Create worktree from feature branch
  const featureHeadSha = git.revParse(featureBranch, projectRoot)
  let wtPath: string
  try {
    wtPath = createWorktree(projectRoot, planId, phase.slug, featureBranch)
  } catch (err) {
    return handlePhaseFailure(
      manifest,
      phase,
      `Worktree 创建失败: ${(err as Error).message}`,
      projectRoot,
      manifestFilePath,
    )
  }

  // Record feature_base_sha
  phase.feature_base_sha = featureHeadSha
  atomicWriteManifest(manifestFilePath, manifest)

  // 2. Run setup commands
  if (manifest.setup_commands.length > 0) {
    logger.info('Running setup commands...')
    const setupResult = await runSetupCommands(
      manifest.setup_commands,
      wtPath,
      setupTimeoutMs,
    )
    if (!setupResult.passed) {
      return handlePhaseFailure(
        manifest,
        phase,
        setupResult.error || 'Setup commands failed',
        projectRoot,
        manifestFilePath,
      )
    }
  }

  // 3. Preflight health check
  logger.info('Running preflight health check...')
  const preflightResult = await runPreflightCheck(
    manifest.quality_gate,
    wtPath,
    gateTimeoutMs,
  )
  if (!preflightResult.passed) {
    // Preflight failure — don't consume attempts, terminate flow
    phase.last_error = `Feature 分支本身未通过质量门禁: ${preflightResult.error}`
    atomicWriteManifest(manifestFilePath, manifest)
    cleanupWorktreeQuiet(projectRoot, planId, phase.slug)

    logger.error(phase.last_error)
    logger.error(
      `feature 分支在 Phase ${phase.slug} 开始前已不健康，` +
        '可能是前序 phase 引入了问题，请人工检查修复后重新运行',
    )
    return 'preflight-failed'
  }

  // 4. Update manifest: status → running, attempts++
  phase.status = 'running'
  phase.attempts++
  atomicWriteManifest(manifestFilePath, manifest)

  // 5. Build and run Claude session
  const prompt = phase.last_error
    ? buildPhaseRetryPrompt(phase, manifest, planDocContent, projectRoot)
    : buildPhasePrompt(phase, manifest, planDocContent, projectRoot)

  logger.info('Starting Claude session...')
  const sessionResult = await runPhaseSession(
    prompt,
    wtPath,
    sessionTimeoutMs,
    manifest.max_turns,
  )

  // Accumulate tokens
  manifest.total_tokens.input += sessionResult.tokens.input
  manifest.total_tokens.output += sessionResult.tokens.output
  manifest.total_cost_usd += sessionResult.costUsd
  atomicWriteManifest(manifestFilePath, manifest)

  // 6. Auto-commit gate
  const autoCommitResult = await autoCommitGate(
    wtPath,
    manifest.quality_gate.typecheck,
    gateTimeoutMs,
  )
  if (!autoCommitResult.passed) {
    return handlePhaseFailure(
      manifest,
      phase,
      autoCommitResult.error || 'Auto-commit gate failed',
      projectRoot,
      manifestFilePath,
    )
  }

  // Assert clean tree
  const cleanCheck = assertCleanTree(wtPath)
  if (!cleanCheck.passed) {
    return handlePhaseFailure(
      manifest,
      phase,
      `Worktree not clean after auto-commit: ${cleanCheck.error}`,
      projectRoot,
      manifestFilePath,
    )
  }

  // Record phase_head_sha
  phase.phase_head_sha = git.revParse('HEAD', wtPath)
  atomicWriteManifest(manifestFilePath, manifest)

  // Check for no-op
  if (phase.phase_head_sha === phase.feature_base_sha) {
    return handlePhaseFailure(
      manifest,
      phase,
      'Phase 没有产生任何新 commit（no-op）',
      projectRoot,
      manifestFilePath,
    )
  }

  // 7. Post-session quality gates (L1 + L2)
  logger.info('Running post-session quality gates...')
  const gateResult = await runQualityGates(
    manifest.quality_gate,
    wtPath,
    gateTimeoutMs,
  )
  if (!gateResult.passed) {
    return handlePhaseFailure(
      manifest,
      phase,
      gateResult.error || 'Quality gates failed',
      projectRoot,
      manifestFilePath,
    )
  }

  // 8. Verification session
  logger.info('Generating verification bundle...')
  let bundleDir: string | null
  try {
    bundleDir = generateBundle(
      projectRoot,
      planId,
      phase,
      phase.attempts,
      wtPath,
    )
  } catch (err) {
    return handlePhaseFailure(
      manifest,
      phase,
      `Verification bundle 生成失败: ${(err as Error).message}`,
      projectRoot,
      manifestFilePath,
    )
  }

  if (!bundleDir) {
    // No-op — should have been caught above, but just in case
    return handlePhaseFailure(
      manifest,
      phase,
      'Phase 没有产生任何新 commit（no-op at verification）',
      projectRoot,
      manifestFilePath,
    )
  }

  const vJsonPath = verificationJsonPath(bundleDir)

  logger.info('Running verification session...')
  const verificationPrompt = buildVerificationPrompt(phase, bundleDir, vJsonPath)
  const verifyResult = await runVerificationSession(verificationPrompt, wtPath)

  // Accumulate verification tokens
  manifest.total_tokens.input += verifyResult.tokens.input
  manifest.total_tokens.output += verifyResult.tokens.output
  manifest.total_cost_usd += verifyResult.costUsd
  atomicWriteManifest(manifestFilePath, manifest)

  // Assert clean tree after verification
  const cleanAfterVerify = assertCleanTree(wtPath)
  if (!cleanAfterVerify.passed) {
    return handlePhaseFailure(
      manifest,
      phase,
      `Worktree dirty after verification session: ${cleanAfterVerify.error}`,
      projectRoot,
      manifestFilePath,
    )
  }

  // Read and validate verification result
  try {
    const verResult = readVerificationResult(vJsonPath)
    if (verResult.overall !== 'pass') {
      const failedCriteria = verResult.criteria
        .filter((c) => !c.met)
        .map((c) => `  - ${c.description}: ${c.evidence}`)
        .join('\n')
      return handlePhaseFailure(
        manifest,
        phase,
        `验证未通过:\n${failedCriteria}`,
        projectRoot,
        manifestFilePath,
      )
    }
    logger.info('Verification passed')
  } catch (err) {
    return handlePhaseFailure(
      manifest,
      phase,
      `验证结果校验失败: ${(err as Error).message}`,
      projectRoot,
      manifestFilePath,
    )
  }

  // 9. Merge phase branch → feature branch
  logger.info(
    `Merging ${paths.phaseBranch(planId, phase.slug)} → ${featureBranch}`,
  )
  try {
    // Checkout feature branch in main repo to do the merge
    git.checkout(featureBranch, projectRoot)
    git.mergeNoFf(
      paths.phaseBranch(planId, phase.slug),
      `merge: phase(${phase.slug}) into ${featureBranch}`,
      projectRoot,
    )
  } catch (err) {
    // Abort merge if in progress
    try {
      git.resetHard(projectRoot)
    } catch { /* ok */ }
    return handlePhaseFailure(
      manifest,
      phase,
      `合并冲突或合并失败: ${(err as Error).message}`,
      projectRoot,
      manifestFilePath,
    )
  }

  // 10. Record merge success
  phase.merged = true
  phase.merge_commit_sha = git.revParse('HEAD', projectRoot)
  atomicWriteManifest(manifestFilePath, manifest)

  // 11. Mark completed
  phase.status = 'completed'
  atomicWriteManifest(manifestFilePath, manifest)

  // 12. Cleanup worktree + phase branch
  cleanupWorktreeQuiet(projectRoot, planId, phase.slug)

  logger.info(`Phase ${phase.slug} completed successfully!`)
  return 'completed'
}

/**
 * Handle phase failure: decide between retry and terminal failure.
 */
function handlePhaseFailure(
  manifest: Manifest,
  phase: Phase,
  error: string,
  projectRoot: string,
  manifestFilePath: string,
): 'retry' | 'max-attempts-reached' {
  logger.warn(`Phase ${phase.slug} failed: ${error}`)

  phase.last_error = error

  if (phase.attempts < manifest.max_attempts_per_phase) {
    // Can retry — reset and clean up
    phase.status = 'pending'
    phase.feature_base_sha = null
    phase.phase_head_sha = null
    phase.merged = false
    phase.merge_commit_sha = null
    atomicWriteManifest(manifestFilePath, manifest)

    cleanupWorktreeQuiet(projectRoot, manifest.plan_id, phase.slug)

    logger.info(
      `Phase ${phase.slug}: retrying (${phase.attempts}/${manifest.max_attempts_per_phase})`,
    )
    return 'retry'
  }

  // Terminal failure — preserve scene
  phase.status = 'failed'
  atomicWriteManifest(manifestFilePath, manifest)

  logger.error(
    `Phase ${phase.slug} 连续 ${manifest.max_attempts_per_phase} 次失败`,
  )
  return 'max-attempts-reached'
}

/**
 * Display dry-run output after Session 0.
 */
function displayDryRun(
  manifest: Manifest,
  config: Required<import('./types.js').ProjectConfig>,
): void {
  console.log(`\n[dry-run] 计划: ${manifest.plan_id}`)
  console.log(
    `[dry-run] 提取到 ${manifest.phases.length} 个 phase:\n`,
  )

  const header = `  #  | ${'Slug'.padEnd(20)} | ${'Title'.padEnd(20)} | 验收标准数`
  console.log(header)
  console.log('  ' + '-'.repeat(header.length - 2))

  for (const phase of manifest.phases) {
    const orderStr = String(phase.order).padStart(2)
    const slugStr = phase.slug.padEnd(20)
    const titleStr = phase.title.padEnd(20)
    console.log(
      `  ${orderStr} | ${slugStr} | ${titleStr} | ${phase.acceptance_criteria.length}`,
    )
  }

  // Heuristic warnings on acceptance criteria
  const warnings: string[] = []
  for (const phase of manifest.phases) {
    for (let i = 0; i < phase.acceptance_criteria.length; i++) {
      const criterion = phase.acceptance_criteria[i]
      for (const { pattern, hint } of CRITERIA_WARN_PATTERNS) {
        if (pattern.test(criterion)) {
          warnings.push(
            `  [warn] ${phase.slug} 标准 #${i + 1}: "${criterion}"\n` +
              `         → 可能需要运行时验证（${hint}），验证 Session 只有 Read 权限，建议改写为代码可判断的条件`,
          )
          break // One warning per criterion
        }
      }
    }
  }

  if (warnings.length > 0) {
    console.log('\n[dry-run] 验收标准检查:')
    for (const w of warnings) {
      console.log(w)
    }
  }

  console.log('\n[dry-run] 质量门禁:')
  if (config.quality_gate.typecheck) {
    console.log(`  typecheck: ${config.quality_gate.typecheck}`)
  }
  if (config.quality_gate.test) {
    console.log(`  test: ${config.quality_gate.test}`)
  }

  console.log(
    '\n[dry-run] 未执行任何操作。确认无误后去掉 --dry-run 重新运行。',
  )
}

/**
 * Display token usage summary.
 */
function displayTokenSummary(manifest: Manifest): void {
  if (manifest.total_tokens.input > 0 || manifest.total_tokens.output > 0) {
    console.log(
      `\nToken 使用: input ${manifest.total_tokens.input.toLocaleString()} / ` +
        `output ${manifest.total_tokens.output.toLocaleString()} | ` +
        `预估费用: $${manifest.total_cost_usd.toFixed(2)}`,
    )
  }
}

/**
 * Quietly cleanup a worktree, ignoring errors.
 */
function cleanupWorktreeQuiet(
  projectRoot: string,
  planId: string,
  slug: string,
): void {
  try {
    cleanupWorktree(projectRoot, planId, slug)
  } catch (err) {
    logger.debug(
      `Cleanup failed for ${slug}: ${(err as Error).message}`,
    )
  }
}
