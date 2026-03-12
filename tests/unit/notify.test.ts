import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'

// Mock child_process.execFile
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: Function) => cb(null)),
  execFileSync: vi.fn(),
}))

import { notify, notifySuccess, notifyFailure, notifyPreflightFailure } from '../../src/notify.js'

describe('notify', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
  })

  describe('notify', () => {
    it('should send terminal bell', () => {
      notify('Test Title', 'Test message')

      expect(stdoutSpy).toHaveBeenCalledWith('\x07')
    })

    it('should call osascript for macOS notification', () => {
      notify('Test Title', 'Test message')

      expect(execFile).toHaveBeenCalledWith(
        'osascript',
        expect.arrayContaining(['-e']),
        expect.any(Function),
      )
    })

    it('should escape quotes in notification message', () => {
      notify('Test "Title"', 'Message with "quotes"')

      const callArgs = vi.mocked(execFile).mock.calls[0]
      const script = callArgs[1]![1] as string
      expect(script).toContain('\\"')
    })
  })

  describe('notifySuccess', () => {
    it('should include plan id in notification', () => {
      notifySuccess('v2.1.0')

      expect(stdoutSpy).toHaveBeenCalledWith('\x07')
      const callArgs = vi.mocked(execFile).mock.calls[0]
      const script = callArgs[1]![1] as string
      expect(script).toContain('v2.1.0')
      expect(script).toContain('全部完成')
    })
  })

  describe('notifyFailure', () => {
    it('should include plan id, slug and reason', () => {
      notifyFailure('v2.1.0', 'db-schema', 'L2 test failed')

      const callArgs = vi.mocked(execFile).mock.calls[0]
      const script = callArgs[1]![1] as string
      expect(script).toContain('v2.1.0')
      expect(script).toContain('db-schema')
    })
  })

  describe('notifyPreflightFailure', () => {
    it('should include plan id and slug', () => {
      notifyPreflightFailure('v2.1.0', 'backend-api')

      const callArgs = vi.mocked(execFile).mock.calls[0]
      const script = callArgs[1]![1] as string
      expect(script).toContain('v2.1.0')
      expect(script).toContain('backend-api')
    })
  })

  describe('graceful degradation', () => {
    it('should not throw when osascript fails', () => {
      vi.mocked(execFile).mockImplementation(
        (_cmd: any, _args: any, cb: any) => {
          cb(new Error('osascript not found'))
          return undefined as any
        },
      )

      expect(() => {
        notify('Title', 'Message')
      }).not.toThrow()
    })
  })
})
