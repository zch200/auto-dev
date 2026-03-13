import { execFileSync } from 'node:child_process'

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
}

function gitExec(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...GIT_ENV },
  }).trim()
}

export function revParse(ref: string, cwd: string): string {
  return gitExec(['rev-parse', ref], cwd)
}

export function gitCommonDir(cwd: string): string {
  return gitExec(['rev-parse', '--git-common-dir'], cwd)
}

export function branchExists(branchName: string, cwd: string): boolean {
  try {
    gitExec(['rev-parse', '--verify', `refs/heads/${branchName}`], cwd)
    return true
  } catch {
    return false
  }
}

export function createBranch(branchName: string, startPoint: string, cwd: string): void {
  gitExec(['branch', branchName, startPoint], cwd)
}

export function deleteBranch(branchName: string, cwd: string): void {
  try {
    gitExec(['branch', '-D', branchName], cwd)
  } catch {
    // Branch may not exist, silently ignore
  }
}

export function checkout(branchName: string, cwd: string): void {
  gitExec(['checkout', branchName], cwd)
}

export function mergeNoFf(branchName: string, message: string, cwd: string): void {
  gitExec(['merge', '--no-ff', branchName, '-m', message], cwd)
}

export function isAncestor(commitA: string, commitB: string, cwd: string): boolean {
  try {
    gitExec(['merge-base', '--is-ancestor', commitA, commitB], cwd)
    return true
  } catch {
    return false
  }
}

export function mergeBase(commitA: string, commitB: string, cwd: string): string {
  return gitExec(['merge-base', commitA, commitB], cwd)
}

export function diffStat(fromRef: string, toRef: string, cwd: string): string {
  return gitExec(['diff', '--stat', `${fromRef}..${toRef}`], cwd)
}

export function diffNameStatus(fromRef: string, toRef: string, cwd: string): string {
  return gitExec(['diff', '--name-status', `${fromRef}..${toRef}`], cwd)
}

export function diffNumstat(fromRef: string, toRef: string, cwd: string): string {
  return gitExec(['diff', '--numstat', `${fromRef}..${toRef}`], cwd)
}

export function diffFile(
  fromRef: string,
  toRef: string,
  filePath: string,
  cwd: string,
): string {
  return gitExec(['diff', `${fromRef}..${toRef}`, '--', filePath], cwd)
}

export function changedFiles(fromRef: string, toRef: string, cwd: string): string[] {
  const output = gitExec(['diff', '--name-only', `${fromRef}..${toRef}`], cwd)
  if (!output) return []
  return output.split('\n').filter(Boolean)
}

export function hasUncommittedChanges(cwd: string): boolean {
  const status = gitExec(['status', '--porcelain'], cwd)
  return status.length > 0
}

export function hasTrackedChanges(cwd: string): boolean {
  // Check for tracked modifications (staged or unstaged)
  const diff = gitExec(['diff', '--name-only', 'HEAD'], cwd)
  const staged = gitExec(['diff', '--cached', '--name-only'], cwd)
  return diff.length > 0 || staged.length > 0
}

export function getUntrackedFiles(cwd: string): string[] {
  const output = gitExec(['ls-files', '--others', '--exclude-standard'], cwd)
  if (!output) return []
  return output.split('\n').filter(Boolean)
}

export function addAll(cwd: string): void {
  gitExec(['add', '-A'], cwd)
}

export function commit(message: string, cwd: string): void {
  gitExec(['commit', '-m', message], cwd)
}

export function resetHard(cwd: string): void {
  gitExec(['reset', '--hard'], cwd)
}

export function cleanForce(cwd: string): void {
  gitExec(['clean', '-fd'], cwd)
}

export function addWorktree(
  worktreePath: string,
  branchName: string,
  startPoint: string,
  cwd: string,
): void {
  gitExec(['worktree', 'add', worktreePath, '-b', branchName, startPoint], cwd)
}

export function removeWorktree(worktreePath: string, cwd: string): void {
  try {
    gitExec(['worktree', 'remove', worktreePath, '--force'], cwd)
  } catch {
    // Worktree may not exist or already removed
  }
}

export function listWorktrees(cwd: string): string[] {
  const output = gitExec(['worktree', 'list', '--porcelain'], cwd)
  const lines = output.split('\n')
  const paths: string[] = []
  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      paths.push(line.slice('worktree '.length))
    }
  }
  return paths
}

export function logOneline(
  ref: string,
  count: number,
  cwd: string,
): string {
  return gitExec(['log', ref, `--oneline`, `-${count}`], cwd)
}

export function findMergeCommit(
  featureBranch: string,
  featureBaseSha: string,
  cwd: string,
): string | null {
  try {
    const output = gitExec(
      ['log', featureBranch, '--ancestry-path', `^${featureBaseSha}`, '-1', '--format=%H'],
      cwd,
    )
    return output || null
  } catch {
    return null
  }
}

export function currentBranch(cwd: string): string {
  return gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
}

export function isCleanTree(cwd: string): boolean {
  // Check tracked modifications
  if (hasTrackedChanges(cwd)) return false
  // Check untracked non-ignored files
  const untracked = getUntrackedFiles(cwd)
  return untracked.length === 0
}
