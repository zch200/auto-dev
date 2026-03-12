import { execFile } from 'node:child_process'
import { logger } from './logger.js'

/**
 * Send a macOS system notification via osascript.
 * Falls back silently if osascript is not available.
 */
function sendMacNotification(title: string, message: string): void {
  const script = `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`

  execFile('osascript', ['-e', script], (err) => {
    if (err) {
      logger.debug(`osascript notification failed: ${err.message}`)
    }
  })
}

/**
 * Send terminal bell.
 */
function sendBell(): void {
  process.stdout.write('\x07')
}

/**
 * Notify user of completion or failure.
 * Uses macOS notification + terminal bell.
 */
export function notify(title: string, message: string): void {
  sendBell()
  sendMacNotification(title, message)
  logger.debug(`Notification sent: ${title} - ${message}`)
}

/**
 * Notify successful completion of all phases.
 */
export function notifySuccess(planId: string): void {
  notify(
    'auto-dev: 全部完成',
    `计划 ${planId} 的所有阶段已成功完成`,
  )
}

/**
 * Notify phase failure.
 */
export function notifyFailure(planId: string, slug: string, reason: string): void {
  notify(
    'auto-dev: 执行失败',
    `计划 ${planId} 阶段 ${slug} 失败: ${reason}`,
  )
}

/**
 * Notify preflight health check failure.
 */
export function notifyPreflightFailure(planId: string, slug: string): void {
  notify(
    'auto-dev: 前置检查失败',
    `计划 ${planId} 在 ${slug} 开始前发现 feature 分支不健康`,
  )
}
