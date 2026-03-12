import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Phase, Manifest } from './types.js'
import * as git from './git.js'

const PROMPTS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'prompts')

function readTemplate(templateName: string): string {
  const templatePath = path.join(PROMPTS_DIR, templateName)
  return fs.readFileSync(templatePath, 'utf-8')
}

function replaceVars(template: string, vars: Record<string, string>): string {
  let result = template
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value)
  }
  return result
}

/**
 * Build the completed phases summary for context.
 * For each completed phase: title, summary, and diff stat.
 */
function buildCompletedPhasesSummary(
  manifest: Manifest,
  projectRoot: string,
): string {
  const completed = manifest.phases.filter((p) => p.status === 'completed')
  if (completed.length === 0) {
    return '(无已完成的阶段)'
  }

  const parts: string[] = []
  for (const phase of completed) {
    let diffInfo = ''
    if (phase.feature_base_sha && phase.merge_commit_sha) {
      try {
        diffInfo = git.diffStat(
          phase.feature_base_sha,
          phase.merge_commit_sha,
          projectRoot,
        )
      } catch {
        diffInfo = '(无法获取 diff 信息)'
      }
    }

    parts.push(
      `### Phase ${phase.order}: ${phase.title} [${phase.slug}]\n` +
        `${phase.summary}\n` +
        (diffInfo ? `\n变更统计:\n\`\`\`\n${diffInfo}\n\`\`\`\n` : ''),
    )
  }

  return parts.join('\n')
}

/**
 * Format acceptance criteria as a markdown list.
 */
function formatCriteria(criteria: string[]): string {
  return criteria.map((c) => `- ${c}`).join('\n')
}

/**
 * Build Session 0 (init) prompt.
 */
export function buildInitPrompt(
  planDocContent: string,
  candidatePath: string,
): string {
  const template = readTemplate('init.md')
  return replaceVars(template, {
    plan_doc_content: planDocContent,
    candidate_path: candidatePath,
  })
}

/**
 * Build Phase execution prompt (first attempt).
 */
export function buildPhasePrompt(
  phase: Phase,
  manifest: Manifest,
  planDocContent: string,
  projectRoot: string,
): string {
  const template = readTemplate('phase.md')
  return replaceVars(template, {
    plan_doc_content: planDocContent,
    order: String(phase.order),
    title: phase.title,
    slug: phase.slug,
    summary: phase.summary,
    acceptance_criteria: formatCriteria(phase.acceptance_criteria),
    completed_phases_summary: buildCompletedPhasesSummary(manifest, projectRoot),
  })
}

/**
 * Build Phase retry prompt (carries failure context).
 */
export function buildPhaseRetryPrompt(
  phase: Phase,
  manifest: Manifest,
  planDocContent: string,
  projectRoot: string,
): string {
  const template = readTemplate('phase-retry.md')
  return replaceVars(template, {
    last_error: phase.last_error || '(无错误信息)',
    plan_doc_content: planDocContent,
    order: String(phase.order),
    title: phase.title,
    slug: phase.slug,
    summary: phase.summary,
    acceptance_criteria: formatCriteria(phase.acceptance_criteria),
    completed_phases_summary: buildCompletedPhasesSummary(manifest, projectRoot),
  })
}

/**
 * Build Verification session prompt.
 */
export function buildVerificationPrompt(
  phase: Phase,
  verificationBundlePath: string,
  verificationPath: string,
): string {
  const template = readTemplate('verification.md')
  return replaceVars(template, {
    title: phase.title,
    slug: phase.slug,
    acceptance_criteria: formatCriteria(phase.acceptance_criteria),
    verification_bundle_path: verificationBundlePath,
    verification_path: verificationPath,
  })
}
