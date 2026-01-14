/**
 * Error codes for local port connection failures
 */
export type LocalPortErrorCode =
  | 'ECONNREFUSED' // Connection refused - server not running or port not open
  | 'ETIMEDOUT' // Connection timeout - server not responding within time limit
  | 'SECURITY_BLOCKED' // Blocked by firewall or security software
  | 'SERVER_NOT_RESPONDING' // Server running but not responding to HTTP requests
  | 'EACCES' // Permission denied - insufficient privileges to access port
  | 'EPERM' // Operation not permitted - system-level restriction
  | 'ENOTFOUND' // Host not found - DNS resolution failed
  | 'ENETUNREACH' // Network unreachable - routing or network connectivity issue
  | 'UNKNOWN' // Unknown or unclassified error

/**
 * Result of local port validation check
 */
export interface LocalPortValidationResult {
  success: boolean
  errorCode?: LocalPortErrorCode
  errorMessage?: string
  host: string
  port: number
}

export class LocalPortConnectionError extends Error {
  public readonly code: LocalPortErrorCode
  public readonly host: string
  public readonly port: number

  constructor(code: LocalPortErrorCode, host: string, port: number, message: string) {
    super(message)
    this.name = 'LocalPortConnectionError'
    this.code = code
    this.host = host
    this.port = port
  }

  static fromResult(result: LocalPortValidationResult): LocalPortConnectionError {
    const messages: Record<LocalPortErrorCode, string> = {
      ECONNREFUSED: `Connection refused. The local server at ${result.host}:${result.port} is not running.`,
      ETIMEDOUT: `Connection timed out. The local server at ${result.host}:${result.port} is not responding.`,
      SECURITY_BLOCKED: `Connection blocked. Port ${result.port} appears to be blocked by firewall or security software. Check your firewall settings and ensure port ${result.port} is allowed.`,
      SERVER_NOT_RESPONDING: `Server not responding. The local server at ${result.host}:${result.port} is running but not responding to HTTP requests. The server may be overloaded or hung.`,
      EACCES: `Permission denied. Cannot access port ${result.port}. Try using a port above 1024.`,
      EPERM: `Operation not permitted. Cannot connect to ${result.host}:${result.port}.`,
      ENOTFOUND: `Host not found. Cannot resolve hostname '${result.host}'.`,
      ENETUNREACH: `Network unreachable. Cannot reach ${result.host}:${result.port}.`,
      UNKNOWN: `Unknown error connecting to ${result.host}:${result.port}: ${result.errorMessage}`,
    }
    const errorCode = result.errorCode ?? 'UNKNOWN'
    return new LocalPortConnectionError(errorCode, result.host, result.port, messages[errorCode])
  }
}
