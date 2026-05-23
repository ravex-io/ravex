const DEFAULT_MAX_MESSAGES = 60
const DEFAULT_WINDOW_MS = 60_000
const SWEEP_INTERVAL_MS = 60_000

export interface RateLimitConfig {
  /** Max messages per window per user. Default: 60 */
  maxMessages?: number
  /** Window size in ms. Default: 60000 (1 minute) */
  windowMs?: number
  /** Typing event throttle ms. Default: 300 */
  typingThrottle?: number
}

export class RateLimiter {
  private readonly max: number
  private readonly window: number
  private readonly windows = new Map<string, number[]>()
  private readonly mutes = new Map<string, number>()
  private readonly sweepInterval: ReturnType<typeof setInterval>

  constructor(config: RateLimitConfig = {}) {
    this.max = config.maxMessages ?? DEFAULT_MAX_MESSAGES
    this.window = config.windowMs ?? DEFAULT_WINDOW_MS

    this.sweepInterval = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
  }

  checkMessage(userId: string): boolean {
    const now = Date.now()
    const cutoff = now - this.window

    let timestamps = this.windows.get(userId) ?? []
    timestamps = timestamps.filter(t => t > cutoff)
    timestamps.push(now)
    this.windows.set(userId, timestamps)

    return timestamps.length <= this.max
  }

  mute(userId: string, roomId: string, durationMs: number): void {
    this.mutes.set(`${userId}:${roomId}`, Date.now() + durationMs)
  }

  unmute(userId: string, roomId: string): void {
    this.mutes.delete(`${userId}:${roomId}`)
  }

  isMuted(userId: string, roomId: string): boolean {
    const expiresAt = this.mutes.get(`${userId}:${roomId}`)
    if (!expiresAt) return false
    if (Date.now() > expiresAt) {
      this.mutes.delete(`${userId}:${roomId}`)
      return false
    }
    return true
  }

  private sweep(): void {
    const now = Date.now()
    const cutoff = now - this.window

    for (const [key, expiresAt] of this.mutes) {
      if (now > expiresAt) this.mutes.delete(key)
    }

    for (const [userId, timestamps] of this.windows) {
      const filtered = timestamps.filter(t => t > cutoff)
      if (filtered.length === 0) this.windows.delete(userId)
      else this.windows.set(userId, filtered)
    }
  }

  destroy(): void {
    clearInterval(this.sweepInterval)
  }
}
