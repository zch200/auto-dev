import type { Candidate, CandidatePhase } from './types.js'
import { SLUG_PATTERN } from './types.js'

export class CandidateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CandidateError'
  }
}

const RUNTIME_FIELDS = ['status', 'attempts', 'merged', 'last_error',
  'feature_base_sha', 'phase_head_sha', 'merge_commit_sha'] as const

function validatePhase(phase: unknown, index: number): CandidatePhase {
  if (typeof phase !== 'object' || phase === null || Array.isArray(phase)) {
    throw new CandidateError(`phases[${index}]: must be an object`)
  }

  const obj = phase as Record<string, unknown>
  const errors: string[] = []

  // Check for runtime fields that shouldn't be present
  for (const field of RUNTIME_FIELDS) {
    if (field in obj) {
      errors.push(`phases[${index}]: 不允许包含运行时字段 "${field}"`)
    }
  }

  // slug
  if (!('slug' in obj) || typeof obj.slug !== 'string' || obj.slug === '') {
    errors.push(`phases[${index}].slug: must be a non-empty string`)
  } else if (!SLUG_PATTERN.test(obj.slug)) {
    errors.push(
      `phases[${index}].slug: "${obj.slug}" 不匹配模式 ${SLUG_PATTERN.source}（需小写英文+短横线）`,
    )
  }

  // order
  if (!('order' in obj) || typeof obj.order !== 'number' || !Number.isInteger(obj.order) || obj.order < 1) {
    errors.push(`phases[${index}].order: must be a positive integer`)
  }

  // title
  if (!('title' in obj) || typeof obj.title !== 'string' || obj.title.trim() === '') {
    errors.push(`phases[${index}].title: must be a non-empty string`)
  }

  // summary
  if (!('summary' in obj) || typeof obj.summary !== 'string' || obj.summary.trim() === '') {
    errors.push(`phases[${index}].summary: must be a non-empty string`)
  }

  // acceptance_criteria
  if (!('acceptance_criteria' in obj)) {
    errors.push(`phases[${index}].acceptance_criteria: missing`)
  } else if (!Array.isArray(obj.acceptance_criteria) || obj.acceptance_criteria.length === 0) {
    errors.push(`phases[${index}].acceptance_criteria: must be a non-empty array`)
  } else {
    for (let i = 0; i < obj.acceptance_criteria.length; i++) {
      const c = obj.acceptance_criteria[i]
      if (typeof c !== 'string' || c.trim() === '') {
        errors.push(`phases[${index}].acceptance_criteria[${i}]: must be a non-empty string`)
      }
    }
  }

  if (errors.length > 0) {
    throw new CandidateError(errors.join('\n'))
  }

  return {
    slug: obj.slug as string,
    order: obj.order as number,
    title: obj.title as string,
    summary: obj.summary as string,
    acceptance_criteria: obj.acceptance_criteria as string[],
  }
}

export function validateCandidate(raw: unknown): Candidate {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CandidateError('Candidate must be a JSON object')
  }

  const obj = raw as Record<string, unknown>

  if (!('phases' in obj) || !Array.isArray(obj.phases)) {
    throw new CandidateError('Candidate must contain a "phases" array')
  }

  if (obj.phases.length === 0) {
    throw new CandidateError('phases array must not be empty')
  }

  const phases: CandidatePhase[] = []
  const allErrors: string[] = []

  for (let i = 0; i < obj.phases.length; i++) {
    try {
      phases.push(validatePhase(obj.phases[i], i))
    } catch (err) {
      if (err instanceof CandidateError) {
        allErrors.push(err.message)
      } else {
        throw err
      }
    }
  }

  if (allErrors.length > 0) {
    throw new CandidateError(allErrors.join('\n'))
  }

  // Cross-phase constraints
  const slugs = new Set<string>()
  const orders = new Set<number>()

  for (const phase of phases) {
    if (slugs.has(phase.slug)) {
      throw new CandidateError(`Duplicate slug: "${phase.slug}"`)
    }
    slugs.add(phase.slug)

    if (orders.has(phase.order)) {
      throw new CandidateError(`Duplicate order: ${phase.order}`)
    }
    orders.add(phase.order)
  }

  return { phases }
}
