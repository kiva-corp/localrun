export interface TunnelOptions {
  port: number
  host?: string
  subdomain?: string
  localHost?: string
  localHttps?: boolean
  localCert?: string
  localKey?: string
  localCa?: string
  allowInvalidCert?: boolean
  timeout?: number
  maxRetries?: number
}

export interface TunnelInfo {
  id: string
  url: string
  cachedUrl?: string
  port: number
}

export interface ProxyRequest {
  id: string
  method: string
  path: string
  headers: Record<string, string>
  body?: string
}

export interface ProxyResponse {
  id: string
  status: number
  headers: Record<string, string>
  body: string
  isBase64?: boolean
}

export interface WebSocketMessage {
  type: 'request' | 'response' | 'chunk' | 'chunk_complete' | 'sse-start' | 'sse-chunk' | 'sse-end' | 'ping' | 'pong'
  data?: ProxyRequest | ProxyResponse | ChunkData | SSEStartData | SSEChunkData | SSEEndData | PingData
  timestamp?: number
}

export interface PingData {
  timestamp: number
}

export interface SSEStartData {
  requestId: string
  status: number
  headers: Record<string, string>
  path?: string
  sessionId?: string
}

export interface SSEChunkData {
  requestId: string
  chunk: string
}

export interface SSEEndData {
  requestId: string
  reason?: string
}

export interface ChunkData {
  messageId: string
  chunkIndex: number
  totalChunks: number
  chunk: string
  originalType: 'request' | 'response'
}
