import { describe, it, expect } from 'vitest'
import { greet } from './index.js'

describe('greet', () => {
  it('should greet by name', () => {
    expect(greet('World')).toBe('Hello, World!')
  })
})
