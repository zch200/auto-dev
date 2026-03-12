import { describe, it, expect } from 'vitest'
import { parseSessionOutput, buildClaudeArgs } from '../../src/session.js'

describe('session', () => {
  describe('parseSessionOutput', () => {
    it('should parse valid JSON output with token info', () => {
      const output = JSON.stringify({
        type: 'result',
        result: 'ok',
        session_id: 'test-001',
        cost_usd: 0.05,
        usage: { input_tokens: 1000, output_tokens: 500 },
      })

      const result = parseSessionOutput(output)

      expect(result.tokens.input).toBe(1000)
      expect(result.tokens.output).toBe(500)
      expect(result.costUsd).toBe(0.05)
    })

    it('should return defaults for empty string', () => {
      const result = parseSessionOutput('')

      expect(result.tokens.input).toBe(0)
      expect(result.tokens.output).toBe(0)
      expect(result.costUsd).toBe(0)
    })

    it('should return defaults for invalid JSON', () => {
      const result = parseSessionOutput('not json at all')

      expect(result.tokens.input).toBe(0)
      expect(result.tokens.output).toBe(0)
      expect(result.costUsd).toBe(0)
    })

    it('should handle multiline output and find JSON in last line', () => {
      const output = [
        'Some debug output',
        'More stuff',
        JSON.stringify({
          cost_usd: 0.10,
          usage: { input_tokens: 2000, output_tokens: 1000 },
        }),
      ].join('\n')

      const result = parseSessionOutput(output)

      expect(result.tokens.input).toBe(2000)
      expect(result.tokens.output).toBe(1000)
      expect(result.costUsd).toBe(0.10)
    })

    it('should handle missing usage fields gracefully', () => {
      const output = JSON.stringify({ type: 'result' })

      const result = parseSessionOutput(output)

      expect(result.tokens.input).toBe(0)
      expect(result.tokens.output).toBe(0)
      expect(result.costUsd).toBe(0)
    })

    it('should handle partial usage fields', () => {
      const output = JSON.stringify({
        usage: { input_tokens: 500 },
        cost_usd: 0.02,
      })

      const result = parseSessionOutput(output)

      expect(result.tokens.input).toBe(500)
      expect(result.tokens.output).toBe(0)
      expect(result.costUsd).toBe(0.02)
    })
  })

  describe('buildClaudeArgs', () => {
    it('should build basic args', () => {
      const args = buildClaudeArgs({
        prompt: 'test prompt',
        maxTurns: 10,
        allowedTools: ['Read', 'Write'],
      })

      expect(args).toContain('-p')
      expect(args).toContain('test prompt')
      expect(args).toContain('--output-format')
      expect(args).toContain('json')
      expect(args).toContain('--permission-mode')
      expect(args).toContain('dontAsk')
      expect(args).toContain('--max-turns')
      expect(args).toContain('10')
      expect(args).toContain('--allowedTools')
      expect(args).toContain('Read Write')
    })

    it('should include disallowedTools when provided', () => {
      const args = buildClaudeArgs({
        prompt: 'test',
        maxTurns: 5,
        allowedTools: ['Read'],
        disallowedTools: ['Bash(git push *)', 'Bash(rm -rf *)'],
      })

      expect(args).toContain('--disallowedTools')
      expect(args).toContain('Bash(git push *) Bash(rm -rf *)')
    })

    it('should not include disallowedTools when empty', () => {
      const args = buildClaudeArgs({
        prompt: 'test',
        maxTurns: 5,
        allowedTools: ['Read'],
        disallowedTools: [],
      })

      expect(args).not.toContain('--disallowedTools')
    })

    it('should not include allowedTools when empty', () => {
      const args = buildClaudeArgs({
        prompt: 'test',
        maxTurns: 5,
        allowedTools: [],
      })

      expect(args).not.toContain('--allowedTools')
    })
  })
})
