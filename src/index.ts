import { LocalPortConnectionError, type LocalPortErrorCode, type LocalPortValidationResult } from './error.js'
import { Tunnel } from './tunnel.js'
import type { TunnelInfo, TunnelOptions } from './types.js'

export { Tunnel, LocalPortConnectionError }
export type { TunnelInfo, TunnelOptions, LocalPortErrorCode, LocalPortValidationResult }

/**
 * Create a localrun connection
 */
export function localrun(options: TunnelOptions): Promise<Tunnel>

export function localrun(port: number, options?: Omit<TunnelOptions, 'port'>): Promise<Tunnel>

export function localrun(
  optionsOrPort: TunnelOptions | number,
  options?: Omit<TunnelOptions, 'port'>,
): Promise<Tunnel> {
  const finalOptions: TunnelOptions =
    typeof optionsOrPort === 'number' ? { port: optionsOrPort, ...options } : optionsOrPort

  const client = new Tunnel(finalOptions)
  return client.open().then(() => client)
}

// Default export for backward compatibility
export default localrun

// Legacy callback-style interface
localrun.connect = (
  optionsOrPort: TunnelOptions | number,
  optionsOrCallback?: Omit<TunnelOptions, 'port'> | ((err: Error | null, tunnel?: Tunnel) => void),
  callback?: (err: Error | null, tunnel?: Tunnel) => void,
): Tunnel => {
  let finalOptions: TunnelOptions
  let finalCallback: ((err: Error | null, tunnel?: Tunnel) => void) | undefined

  if (typeof optionsOrPort === 'number') {
    if (typeof optionsOrCallback === 'function') {
      finalOptions = { port: optionsOrPort }
      finalCallback = optionsOrCallback
    } else {
      finalOptions = { port: optionsOrPort, ...optionsOrCallback }
      finalCallback = callback
    }
  } else {
    finalOptions = optionsOrPort
    finalCallback = optionsOrCallback as ((err: Error | null, tunnel?: Tunnel) => void) | undefined
  }

  const client = new Tunnel(finalOptions)

  if (finalCallback) {
    client
      .open()
      .then(() => finalCallback(null, client))
      .catch((err) => finalCallback(err))
  } else {
    client.open().catch((err) => client.emit('error', err))
  }

  return client
}
