// Phase status lifecycle: pending → running → completed | failed
export type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface Phase {
  slug: string
  order: number
  title: string
  summary: string
  acceptance_criteria: string[]
  status: PhaseStatus
  attempts: number
  last_error: string | null
  feature_base_sha: string | null
  phase_head_sha: string | null
  merged: boolean
  merge_commit_sha: string | null
}

export interface QualityGate {
  typecheck?: string
  test?: string
}

export interface TokenUsage {
  input: number
  output: number
}

export interface Manifest {
  plan_id: string
  plan_doc: string
  plan_doc_hash: string
  feature_branch: string
  base_branch: string
  quality_gate: QualityGate
  setup_commands: string[]
  session_timeout_minutes: number
  setup_timeout_minutes: number
  gate_timeout_minutes: number
  max_attempts_per_phase: number
  max_turns: number
  total_tokens: TokenUsage
  total_cost_usd: number
  phases: Phase[]
  created_at: string
  last_updated: string
}

export interface ProjectConfig {
  base_branch: string
  quality_gate: QualityGate
  setup_commands?: string[]
  session_timeout_minutes?: number
  setup_timeout_minutes?: number
  gate_timeout_minutes?: number
  max_attempts_per_phase?: number
  max_turns?: number
}

export interface CandidatePhase {
  slug: string
  order: number
  title: string
  summary: string
  acceptance_criteria: string[]
}

export interface Candidate {
  phases: CandidatePhase[]
}

export interface RunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  signal: NodeJS.Signals | null
}

export interface LockOwner {
  pid: number
  started_at: string
}

export interface VerificationCriterion {
  description: string
  met: boolean
  evidence: string
}

export interface VerificationResult {
  criteria: VerificationCriterion[]
  overall: 'pass' | 'fail'
}

export const EXIT_CODES = {
  SUCCESS: 0,
  PHASE_FAILED: 1,
  CONFIG_ERROR: 2,
  LOCK_CONFLICT: 3,
  CLAUDE_UNAVAILABLE: 4,
} as const

export const DEFAULTS = {
  SESSION_TIMEOUT_MINUTES: 20,
  SETUP_TIMEOUT_MINUTES: 5,
  GATE_TIMEOUT_MINUTES: 10,
  MAX_ATTEMPTS_PER_PHASE: 3,
  MAX_TURNS: 200,
  VERIFICATION_TIMEOUT_MS: 5 * 60 * 1000,
  BUNDLE_TIMEOUT_MS: 60 * 1000,
  PREFLIGHT_TIMEOUT_MS: 30 * 1000,
  MAX_SESSION0_ATTEMPTS: 2,
  SESSION0_MAX_TURNS: 10,
  VERIFICATION_MAX_TURNS: 10,
} as const

export const PLAN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
