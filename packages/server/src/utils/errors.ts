export const ErrorCodes = {
  AUTH_FAILED: 'AUTH_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  VALIDATION: 'VALIDATION_ERROR',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  MESSAGE_TOO_LONG: 'MESSAGE_TOO_LONG',
  RATE_LIMIT: 'RATE_LIMIT_EXCEEDED',
  MUTED: 'USER_MUTED',
  INTERNAL: 'INTERNAL_ERROR',
  SOCKET_ERROR: 'SOCKET_ERROR',
} as const

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

export class ChatError extends Error {
  readonly code: ErrorCode
  readonly details?: unknown

  constructor(message: string, code: ErrorCode = ErrorCodes.INTERNAL, details?: unknown) {
    super(message)
    this.name = 'ChatError'
    this.code = code
    this.details = details
  }
}
