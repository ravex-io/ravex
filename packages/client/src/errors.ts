/** What request methods reject with when the server answers with an error. */
export class ChatRequestError extends Error {
  /** The server's error code, e.g. 'MESSAGE_BLOCKED', 'RATE_LIMIT_EXCEEDED' or 'ROOM_NOT_FOUND'. */
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'ChatRequestError'
    this.code = code
  }
}
