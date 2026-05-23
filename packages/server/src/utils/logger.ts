// type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const prefix = '[ravex]'

let debugEnabled = false

export const logger = {
  setDebug(enabled: boolean) {
    debugEnabled = enabled
  },

  debug(...args: unknown[]) {
    if (debugEnabled) console.debug(prefix, ...args)
  },

  info(...args: unknown[]) {
    console.info(prefix, ...args)
  },

  warn(...args: unknown[]) {
    console.warn(prefix, ...args)
  },

  error(...args: unknown[]) {
    console.error(prefix, ...args)
  },
}
