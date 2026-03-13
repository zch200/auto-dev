import { describe, it, expect } from 'vitest'
import { capitalize, reverse } from './string-utils.js'

describe('capitalize', () => {
  it('should capitalize first letter', () => {
    expect(capitalize('hello')).toBe('Hello')
  })

  it('should handle empty string', () => {
    expect(capitalize('')).toBe('')
  })

  it('should lowercase remaining letters', () => {
    expect(capitalize('hELLO')).toBe('Hello')
  })
})

describe('reverse', () => {
  it('should reverse a string', () => {
    expect(reverse('hello')).toBe('olleh')
  })

  it('should handle empty string', () => {
    expect(reverse('')).toBe('')
  })

  it('should handle single character', () => {
    expect(reverse('a')).toBe('a')
  })
})
