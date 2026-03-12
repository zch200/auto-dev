import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

/**
 * Creates an executable mock Claude CLI script in a temp directory.
 * The script behavior is controlled by the MOCK_CLAUDE_BEHAVIOR env var.
 *
 * Behaviors:
 * - "session0-success": writes a valid candidate.json
 * - "phase-success": creates files + git commit
 * - "phase-no-commit": creates files but doesn't commit
 * - "verify-pass": writes passing verification.json
 * - "verify-fail": writes failing verification.json
 * - "timeout": sleeps indefinitely
 * - "crash": exit 1
 * - "ok": responds with "ok" (for preflight)
 */
export interface MockClaude {
  binPath: string
  dir: string
  cleanup: () => void
}

export interface MockClaudeSequence extends MockClaude {
  sequenceFile: string
  counterFile: string
}

export function createMockClaude(): MockClaude {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-claude-'))
  const binPath = path.join(dir, 'claude')

  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const behavior = process.env.MOCK_CLAUDE_BEHAVIOR || 'ok';
const candidatePath = process.env.MOCK_CANDIDATE_PATH || '';
const verificationPath = process.env.MOCK_VERIFICATION_PATH || '';
const worktreePath = process.env.MOCK_WORKTREE_PATH || process.cwd();

// Parse -p prompt from args
let prompt = '';
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '-p') {
    prompt = process.argv[i + 1] || '';
    break;
  }
}

const result = {
  type: 'result',
  result: 'ok',
  session_id: 'mock-session-001',
  cost_usd: 0.01,
  usage: { input_tokens: 100, output_tokens: 50 },
  is_error: false,
};

switch (behavior) {
  case 'session0-success':
    if (candidatePath) {
      fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
      fs.writeFileSync(candidatePath, JSON.stringify({
        phases: [
          {
            slug: 'db-schema',
            order: 1,
            title: 'Database Schema',
            summary: 'Create DB schema',
            acceptance_criteria: ['Schema file exists'],
          },
        ],
      }));
    }
    console.log(JSON.stringify(result));
    break;

  case 'phase-success': {
    const { execSync } = require('child_process');
    const testFile = path.join(worktreePath, 'new-file.ts');
    fs.writeFileSync(testFile, 'export const x = 1;');
    execSync('git add -A && git commit -m "phase work"', {
      cwd: worktreePath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      },
    });
    console.log(JSON.stringify(result));
    break;
  }

  case 'phase-no-commit': {
    const testFile = path.join(worktreePath, 'uncommitted.ts');
    fs.writeFileSync(testFile, 'export const y = 2;');
    console.log(JSON.stringify(result));
    break;
  }

  case 'verify-pass':
    if (verificationPath) {
      fs.mkdirSync(path.dirname(verificationPath), { recursive: true });
      fs.writeFileSync(verificationPath, JSON.stringify({
        criteria: [{ description: 'Test', met: true, evidence: 'Found' }],
        overall: 'pass',
      }));
    }
    console.log(JSON.stringify(result));
    break;

  case 'verify-fail':
    if (verificationPath) {
      fs.mkdirSync(path.dirname(verificationPath), { recursive: true });
      fs.writeFileSync(verificationPath, JSON.stringify({
        criteria: [{ description: 'Test', met: false, evidence: 'Not found' }],
        overall: 'fail',
      }));
    }
    console.log(JSON.stringify(result));
    break;

  case 'timeout':
    // Sleep indefinitely
    setInterval(() => {}, 1000000);
    break;

  case 'crash':
    result.is_error = true;
    result.result = 'error';
    console.log(JSON.stringify(result));
    process.exit(1);
    break;

  case 'ok':
  default:
    console.log(JSON.stringify(result));
    break;
}
`

  fs.writeFileSync(binPath, script, { mode: 0o755 })

  const cleanup = () => {
    fs.rmSync(dir, { recursive: true, force: true })
  }

  return { binPath, dir, cleanup }
}

/**
 * Creates a mock Claude CLI that uses a sequence file for behaviors.
 * Each call reads the next behavior from the sequence.
 * Paths (candidate, verification) are auto-extracted from the prompt.
 */
export function createMockClaudeWithSequence(
  behaviors: string[],
): MockClaudeSequence {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-claude-seq-'))
  const binPath = path.join(dir, 'claude')
  const sequenceFile = path.join(dir, 'sequence.json')
  const counterFile = path.join(dir, 'counter')

  fs.writeFileSync(sequenceFile, JSON.stringify(behaviors))
  fs.writeFileSync(counterFile, '0')

  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Read sequence and counter
const seqFile = ${JSON.stringify(sequenceFile)};
const ctrFile = ${JSON.stringify(counterFile)};

const behaviors = JSON.parse(fs.readFileSync(seqFile, 'utf-8'));
const counter = parseInt(fs.readFileSync(ctrFile, 'utf-8'), 10);
fs.writeFileSync(ctrFile, String(counter + 1));

const behavior = behaviors[counter] || 'ok';

// Parse -p prompt from args
let prompt = '';
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '-p') {
    prompt = process.argv[i + 1] || '';
    break;
  }
}

// Auto-extract paths from prompt (stop at Chinese comma or space)
let candidatePath = '';
const candidateMatch = prompt.match(/输出一个 JSON 文件到\\s+(\\/[^\\s，,]+)/);
if (candidateMatch) candidatePath = candidateMatch[1];

let verificationPath = '';
const verifyMatch = prompt.match(/输出 JSON 到\\s+(\\/[^\\s，,]+)/);
if (verifyMatch) verificationPath = verifyMatch[1];

const worktreePath = process.cwd();

const result = {
  type: 'result',
  result: 'ok',
  session_id: 'mock-session-' + counter,
  cost_usd: 0.01,
  usage: { input_tokens: 100, output_tokens: 50 },
  is_error: false,
};

switch (behavior) {
  case 'session0-success':
    if (candidatePath) {
      fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
      fs.writeFileSync(candidatePath, JSON.stringify({
        phases: [
          {
            slug: 'test-feature',
            order: 1,
            title: 'Test Feature',
            summary: 'Implement test feature',
            acceptance_criteria: ['Feature file exists'],
          },
        ],
      }));
    }
    console.log(JSON.stringify(result));
    break;

  case 'session0-two-phases':
    if (candidatePath) {
      fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
      fs.writeFileSync(candidatePath, JSON.stringify({
        phases: [
          {
            slug: 'phase-a',
            order: 1,
            title: 'Phase A',
            summary: 'First phase',
            acceptance_criteria: ['Phase A done'],
          },
          {
            slug: 'phase-b',
            order: 2,
            title: 'Phase B',
            summary: 'Second phase',
            acceptance_criteria: ['Phase B done'],
          },
        ],
      }));
    }
    console.log(JSON.stringify(result));
    break;

  case 'phase-success': {
    const { execSync } = require('child_process');
    const testFile = path.join(worktreePath, 'feature-' + counter + '.ts');
    fs.writeFileSync(testFile, 'export const x = ' + counter + ';');
    execSync('git add -A && git commit -m "phase(' + counter + '): implement feature"', {
      cwd: worktreePath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      },
    });
    console.log(JSON.stringify(result));
    break;
  }

  case 'phase-no-commit': {
    const testFile2 = path.join(worktreePath, 'uncommitted-' + counter + '.ts');
    fs.writeFileSync(testFile2, 'export const y = ' + counter + ';');
    console.log(JSON.stringify(result));
    break;
  }

  case 'verify-pass':
    if (verificationPath) {
      fs.mkdirSync(path.dirname(verificationPath), { recursive: true });
      fs.writeFileSync(verificationPath, JSON.stringify({
        criteria: [{ description: 'Feature file exists', met: true, evidence: 'Found feature file' }],
        overall: 'pass',
      }));
    }
    console.log(JSON.stringify(result));
    break;

  case 'verify-fail':
    if (verificationPath) {
      fs.mkdirSync(path.dirname(verificationPath), { recursive: true });
      fs.writeFileSync(verificationPath, JSON.stringify({
        criteria: [{ description: 'Feature file exists', met: false, evidence: 'Not found' }],
        overall: 'fail',
      }));
    }
    console.log(JSON.stringify(result));
    break;

  case 'crash':
    result.is_error = true;
    result.result = 'error';
    console.log(JSON.stringify(result));
    process.exit(1);
    break;

  case 'ok':
  default:
    console.log(JSON.stringify(result));
    break;
}
`

  fs.writeFileSync(binPath, script, { mode: 0o755 })

  const cleanup = () => {
    fs.rmSync(dir, { recursive: true, force: true })
  }

  return { binPath, dir, cleanup, sequenceFile, counterFile }
}
