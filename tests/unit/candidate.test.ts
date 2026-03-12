import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { validateCandidate, CandidateError } from '../../src/candidate.js'

const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'candidates')

function loadFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf-8'))
}

describe('candidate validation', () => {
  describe('valid candidates', () => {
    it('should accept valid candidate with multiple phases', () => {
      const raw = loadFixture('valid.json')
      const candidate = validateCandidate(raw)
      expect(candidate.phases).toHaveLength(2)
      expect(candidate.phases[0].slug).toBe('db-schema')
      expect(candidate.phases[0].order).toBe(1)
      expect(candidate.phases[0].acceptance_criteria).toHaveLength(2)
      expect(candidate.phases[1].slug).toBe('backend-api')
    })
  })

  describe('structural errors', () => {
    it('should reject non-object', () => {
      expect(() => validateCandidate(null)).toThrow(CandidateError)
      expect(() => validateCandidate([])).toThrow(CandidateError)
      expect(() => validateCandidate('string')).toThrow(CandidateError)
    })

    it('should reject missing phases', () => {
      expect(() => validateCandidate({})).toThrow('phases')
    })

    it('should reject empty phases array', () => {
      const raw = loadFixture('invalid-empty-phases.json')
      expect(() => validateCandidate(raw)).toThrow('must not be empty')
    })
  })

  describe('slug validation', () => {
    it('should reject invalid slug format', () => {
      const raw = loadFixture('invalid-bad-slug.json')
      expect(() => validateCandidate(raw)).toThrow('slug')
    })

    it('should reject empty slug', () => {
      expect(() =>
        validateCandidate({
          phases: [{
            slug: '',
            order: 1,
            title: 'T',
            summary: 'S',
            acceptance_criteria: ['C'],
          }],
        }),
      ).toThrow('slug')
    })

    it('should accept valid slug formats', () => {
      const candidate = validateCandidate({
        phases: [{
          slug: 'a',
          order: 1,
          title: 'T',
          summary: 'S',
          acceptance_criteria: ['C'],
        }],
      })
      expect(candidate.phases[0].slug).toBe('a')
    })
  })

  describe('order validation', () => {
    it('should reject duplicate order', () => {
      const raw = loadFixture('invalid-duplicate-order.json')
      expect(() => validateCandidate(raw)).toThrow('Duplicate order')
    })

    it('should reject non-integer order', () => {
      expect(() =>
        validateCandidate({
          phases: [{
            slug: 'a',
            order: 1.5,
            title: 'T',
            summary: 'S',
            acceptance_criteria: ['C'],
          }],
        }),
      ).toThrow('positive integer')
    })

    it('should reject zero order', () => {
      expect(() =>
        validateCandidate({
          phases: [{
            slug: 'a',
            order: 0,
            title: 'T',
            summary: 'S',
            acceptance_criteria: ['C'],
          }],
        }),
      ).toThrow('positive integer')
    })
  })

  describe('field validation', () => {
    it('should reject missing title', () => {
      expect(() =>
        validateCandidate({
          phases: [{
            slug: 'a',
            order: 1,
            summary: 'S',
            acceptance_criteria: ['C'],
          }],
        }),
      ).toThrow('title')
    })

    it('should reject empty summary', () => {
      expect(() =>
        validateCandidate({
          phases: [{
            slug: 'a',
            order: 1,
            title: 'T',
            summary: '  ',
            acceptance_criteria: ['C'],
          }],
        }),
      ).toThrow('summary')
    })

    it('should reject empty acceptance_criteria array', () => {
      expect(() =>
        validateCandidate({
          phases: [{
            slug: 'a',
            order: 1,
            title: 'T',
            summary: 'S',
            acceptance_criteria: [],
          }],
        }),
      ).toThrow('non-empty array')
    })

    it('should reject empty string in acceptance_criteria', () => {
      expect(() =>
        validateCandidate({
          phases: [{
            slug: 'a',
            order: 1,
            title: 'T',
            summary: 'S',
            acceptance_criteria: ['Valid', ''],
          }],
        }),
      ).toThrow('non-empty string')
    })
  })

  describe('runtime fields', () => {
    it('should reject runtime fields', () => {
      const raw = loadFixture('invalid-runtime-fields.json')
      expect(() => validateCandidate(raw)).toThrow('运行时字段')
    })

    it('should reject merged field', () => {
      expect(() =>
        validateCandidate({
          phases: [{
            slug: 'a',
            order: 1,
            title: 'T',
            summary: 'S',
            acceptance_criteria: ['C'],
            merged: false,
          }],
        }),
      ).toThrow('运行时字段')
    })
  })

  describe('cross-phase constraints', () => {
    it('should reject duplicate slugs', () => {
      expect(() =>
        validateCandidate({
          phases: [
            { slug: 'same', order: 1, title: 'A', summary: 'A', acceptance_criteria: ['A'] },
            { slug: 'same', order: 2, title: 'B', summary: 'B', acceptance_criteria: ['B'] },
          ],
        }),
      ).toThrow('Duplicate slug')
    })
  })
})
