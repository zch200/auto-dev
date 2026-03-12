import * as fs from 'node:fs'
import * as path from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
}

function timestamp(): string {
  return new Date().toISOString()
}

function formatMessage(level: LogLevel, msg: string): string {
  return `[${timestamp()}] [${LEVEL_LABEL[level]}] ${msg}`
}

export class Logger {
  private logFilePath: string | null = null
  private consoleLevel: LogLevel = 'info'

  init(logFilePath: string): void {
    this.logFilePath = logFilePath
    const dir = path.dirname(logFilePath)
    fs.mkdirSync(dir, { recursive: true })
  }

  setConsoleLevel(level: LogLevel): void {
    this.consoleLevel = level
  }

  debug(msg: string): void {
    this.write('debug', msg)
  }

  info(msg: string): void {
    this.write('info', msg)
  }

  warn(msg: string): void {
    this.write('warn', msg)
  }

  error(msg: string): void {
    this.write('error', msg)
  }

  private write(level: LogLevel, msg: string): void {
    const formatted = formatMessage(level, msg)

    // Always write to file at debug level
    if (this.logFilePath) {
      try {
        fs.appendFileSync(this.logFilePath, formatted + '\n')
      } catch {
        // Silently ignore file write errors
      }
    }

    // Write to console based on console level
    if (LEVEL_RANK[level] >= LEVEL_RANK[this.consoleLevel]) {
      if (level === 'error') {
        process.stderr.write(formatted + '\n')
      } else {
        process.stdout.write(formatted + '\n')
      }
    }
  }
}

// Singleton logger instance
export const logger = new Logger()
