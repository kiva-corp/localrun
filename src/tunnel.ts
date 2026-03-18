import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import * as zlib from 'node:zlib'
import axios, { type AxiosResponse } from 'axios'
import debug from 'debug'
import WebSocket from 'ws'
import { messageChunker } from './chunk-utils.js'
import { LocalPortConnectionError, type LocalPortErrorCode, type LocalPortValidationResult } from './error.js'
import type { ChunkData, ProxyRequest, ProxyResponse, TunnelInfo, TunnelOptions, WebSocketMessage } from './types.js'

const log = debug('localrun:client')

export class Tunnel extends EventEmitter {
  private options: TunnelOptions
  private tunnelInfo: TunnelInfo | null = null
  private websocket: WebSocket | null = null
  private closed = false
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null
  private localServer: http.Server | https.Server | null = null
  private maxReconnectAttempts = 10
  private reconnectAttempts = 0
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null // 追加
  private reconnectBackoffMultiplier = 1.5 // 追加：指数バックオフ
  private maxReconnectDelay = 30000 // 追加：最大再接続遅延（30秒）

  // サーキットブレーカー関連
  private consecutiveErrors = 0
  private lastErrorTime = 0
  private circuitBreakerThreshold = 5 // 連続エラー数の閾値
  private circuitBreakerCooldown = 30000 // 30秒のクールダウン
  private isCircuitOpen = false

  // ヘルスチェック関連
  private healthCheckCache: { isHealthy: boolean; lastCheck: number; healthPath: string | null } = {
    isHealthy: false,
    lastCheck: 0,
    healthPath: null,
  }
  private healthCheckCacheTTL = 10000 // 10秒間キャッシュ

  constructor(options: TunnelOptions) {
    super()
    this.options = {
      host: 'https://localrun.stream',
      localHost: 'localhost',
      ...options,
    }
  }

  async open(): Promise<TunnelInfo> {
    log('=== Opening tunnel ===')
    log('Options: %o', this.options)

    // Validate local port connectivity first
    const validationResult = await this.validateLocalPort()
    if (!validationResult.success) {
      log('❌ Local port validation failed: %s', validationResult.errorMessage)
      throw LocalPortConnectionError.fromResult(validationResult)
    }
    log('✅ Local port validation successful')

    return new Promise((resolve, reject) => {
      this.initTunnel()
        .then((info) => {
          log('✅ Tunnel initialized successfully')
          log('Tunnel info: %o', info)
          this.tunnelInfo = info

          // Check if tunnel was closed before WebSocket connection
          if (this.closed) {
            log('Tunnel was closed before WebSocket connection, skipping...')
            resolve(info)
            return
          }

          // 少し待ってからWebSocket接続を開始
          log('Starting WebSocket connection in 10ms...')
          setTimeout(() => {
            // Double check if closed during the timeout
            if (!this.closed) {
              this.connectWebSocket()
            }
            resolve(info)
          }, 10)
        })
        .catch((error) => {
          log('❌ Failed to initialize tunnel: %o', error)
          reject(error)
        })
    })
  }

  private async initTunnel(): Promise<TunnelInfo> {
    const endpoint = this.options.subdomain ? `${this.options.host}/api/tunnels` : `${this.options.host}/?new`

    log('requesting tunnel from %s', endpoint)

    try {
      let response: AxiosResponse<{
        id: string
        url: string
        cached_url?: string
        port: number
        message?: string
      }>

      if (this.options.subdomain) {
        // POST request for specific subdomain
        response = await axios.post(
          endpoint,
          {
            subdomain: this.options.subdomain,
          },
          {
            responseType: 'json',
            timeout: 10000,
          },
        )
      } else {
        // GET request for random subdomain
        response = await axios.get(endpoint, {
          responseType: 'json',
          timeout: 10000,
        })
      }

      if (response.status !== 200) {
        throw new Error(response.data?.message || 'localrun server returned an error, please try again')
      }

      const body = response.data
      log('got tunnel information', body)

      return {
        id: body.id,
        url: body.url,
        cachedUrl: body.cached_url || body.url,
        port: body.port,
      }
    } catch (error) {
      log('tunnel server error:', error)
      if (axios.isAxiosError(error)) {
        throw new Error(`Failed to connect to tunnel server: ${error.message}`)
      }
      throw error
    }
  }

  private connectWebSocket(): void {
    if (this.closed || !this.tunnelInfo) {
      log('Cannot connect WebSocket: closed=%s, tunnelInfo=%s', this.closed, !!this.tunnelInfo)
      return
    }

    const wsUrl = this.getWebSocketUrl()
    log('=== Connecting to WebSocket ===')
    log('WebSocket URL: %s', wsUrl)
    log('Tunnel ID: %s', this.tunnelInfo.id)

    // 既存のキープアライブをクリア
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval)
      this.keepAliveInterval = null
    }

    this.websocket = new WebSocket(wsUrl, {
      handshakeTimeout: 10000,
    })

    this.websocket.on('open', () => {
      log('✅ WebSocket connected successfully')
      log('WebSocket readyState: %d', this.websocket?.readyState)
      this.reconnectAttempts = 0 // Reset on successful connection

      if (this.tunnelInfo) {
        this.emit('url', this.tunnelInfo.url)
      }

      // Clear any reconnect timeout
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout)
        this.reconnectTimeout = null
      }

      // キープアライブを開始（30秒間隔）
      this.keepAliveInterval = setInterval(() => {
        this.sendPing()
      }, 30000)
    })

    this.websocket.on('message', (data: WebSocket.Data) => {
      try {
        log('Received WebSocket message: %s', data.toString())
        const message: WebSocketMessage = JSON.parse(data.toString())
        log('Parsed message type: %s', message.type)

        if (message.type === 'request') {
          const requestData = message.data as ProxyRequest
          log('Handling proxy request: %s %s', requestData.method, requestData.path)
          this.handleProxyRequest(requestData)
        } else if (message.type === 'chunk') {
          const chunkData = message.data as ChunkData
          log('Handling chunk: %s (%d/%d)', chunkData.messageId, chunkData.chunkIndex + 1, chunkData.totalChunks)

          const reconstructedMessage = messageChunker.receiveChunk(chunkData)
          if (reconstructedMessage) {
            log('Message reconstructed from chunks: %s', chunkData.messageId)
            if (reconstructedMessage.type === 'request') {
              const requestData = reconstructedMessage.data as ProxyRequest
              log('Handling reconstructed proxy request: %s %s', requestData.method, requestData.path)
              this.handleProxyRequest(requestData)
            }
          }
        } else if (message.type === 'ping') {
          // pingに対してpongで応答
          this.sendPong()
        } else if (message.type === 'pong') {
          // pongを受信（ログのみ）
          log('Received pong from server')
        } else {
          log('Unknown message type: %s', message.type)
        }
      } catch (error) {
        log('websocket message error:', error)
        log('raw message data:', data.toString())
      }
    })

    this.websocket.on('close', (code: number, reason: Buffer) => {
      log('❌ WebSocket disconnected')
      log('Close code: %d', code)
      log('Close reason: %s', reason.toString())
      log('Was closed intentionally: %s', this.closed)
      log('Reconnect attempts: %d/%d', this.reconnectAttempts, this.maxReconnectAttempts)

      this.websocket = null

      // キープアライブをクリア
      if (this.keepAliveInterval) {
        clearInterval(this.keepAliveInterval)
        this.keepAliveInterval = null
      }

      if (!this.closed && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++

        // 指数バックオフで再接続遅延を計算
        const baseDelay = 1000 + Math.random() * 1000 // 1-2秒のベース遅延
        const backoffDelay = baseDelay * this.reconnectBackoffMultiplier ** (this.reconnectAttempts - 1)
        const delay = Math.min(backoffDelay, this.maxReconnectDelay)

        log(
          `Attempting to reconnect in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
        )

        this.reconnectTimeout = setTimeout(() => {
          this.connectWebSocket()
        }, delay)
      } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        log('❌ Maximum reconnection attempts reached')
        this.emit('error', new Error('Maximum reconnection attempts reached'))
      } else {
        log('✅ WebSocket closed intentionally')
        this.emit('close')
      }
    })

    this.websocket.on('error', (error: Error) => {
      log('❌ WebSocket error occurred')
      log('Error details: %o', error)
      log('WebSocket readyState: %d', this.websocket?.readyState || -1)
      this.emit('error', error)
    })
  }

  private getWebSocketUrl(): string {
    if (!this.tunnelInfo) {
      throw new Error('No tunnel info available')
    }

    if (!this.options.host) {
      throw new Error('Host is required')
    }

    const url = new URL(this.options.host)
    const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${url.host}/api/tunnels/${this.tunnelInfo.id}/ws`
  }

  private async handleProxyRequest(request: ProxyRequest): Promise<void> {
    log('=== Handling proxy request ===')
    log('Request ID: %s', request.id)
    log('Method: %s', request.method)
    log('Path: %s', request.path)
    log('Headers: %o', request.headers)

    // サーキットブレーカーのチェック
    if (this.isCircuitBreakerOpen()) {
      log('⚠️ Circuit breaker is open, rejecting request %s', request.id)
      const errorResponse: ProxyResponse = {
        id: request.id,
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          'X-Error-Type': 'circuit-breaker-open',
          'Retry-After': Math.ceil(this.circuitBreakerCooldown / 1000).toString(),
        },
        body: JSON.stringify({
          error: 'Service temporarily unavailable - Local server appears to be down',
          errorType: 'circuit-breaker-open',
          requestId: request.id,
          retryAfterSeconds: Math.ceil(this.circuitBreakerCooldown / 1000),
          timestamp: new Date().toISOString(),
        }),
      }
      this.sendResponse(errorResponse)
      return
    }

    // SSE接続かどうかをチェック（POST リクエストは SSE パスを使わない）
    const isSSERequest = request.method === 'GET' && (
      request.headers.accept?.includes('text/event-stream') ||
      request.path.includes('/sse') ||
      request.headers['cache-control'] === 'no-cache'
    )

    // Emit request event for logging
    this.emit('request', {
      method: request.method,
      path: request.path,
      headers: request.headers,
    })

    try {
      log('Forwarding request %s to local server...', request.id)

      if (isSSERequest) {
        log('🔄 Handling SSE request %s', request.id)
        await this.handleSSERequest(request)
        this.recordSuccess() // SSE接続成功
      } else {
        const response = await this.forwardToLocalServer(request)
        log('Received response from local server for request %s: status %d', request.id, response.status)
        this.recordSuccess() // リクエスト成功
        this.sendResponse(response)
      }
    } catch (error) {
      log('error forwarding request %s:', request.id, error)

      // エラーを記録（サーキットブレーカー用）
      this.recordError()

      // エラーの詳細情報をログに出力
      if (error instanceof Error) {
        log('Error details - Name: %s, Message: %s', error.name, error.message)
        if (error.stack) {
          log('Error stack: %s', error.stack)
        }
      }

      // エラー種別に応じたレスポンス
      let status = 500
      let message = 'Internal Server Error'
      let errorType = 'unknown-error'

      // Check both error message and code
      const errorMessage = error instanceof Error ? error.message : ''
      const errorCode = (error instanceof Error && 'code' in error ? error.code : '') || ''
      const errorStr = `${errorMessage} ${errorCode}`.toLowerCase()

      if (errorStr.includes('timeout') || errorCode === 'ETIMEDOUT') {
        status = 504
        message = 'Gateway Timeout - Local server did not respond in time'
        errorType = 'timeout'
      } else if (errorStr.includes('econnrefused') || errorCode === 'ECONNREFUSED') {
        status = 502
        message = 'Bad Gateway - Local server is not running or not accepting connections'
        errorType = 'connection-refused'
      } else if (errorStr.includes('enotfound') || errorCode === 'ENOTFOUND') {
        status = 502
        message = 'Bad Gateway - Local server host not found'
        errorType = 'host-not-found'
      } else if (errorStr.includes('econnreset') || errorCode === 'ECONNRESET') {
        status = 502
        message = 'Bad Gateway - Connection was reset by local server'
        errorType = 'connection-reset'
      } else if (
        errorStr.includes('enetunreach') ||
        errorStr.includes('ehostunreach') ||
        errorCode === 'ENETUNREACH' ||
        errorCode === 'EHOSTUNREACH'
      ) {
        status = 502
        message = 'Bad Gateway - Local server network unreachable'
        errorType = 'network-unreachable'
      }

      const errorResponse: ProxyResponse = {
        id: request.id,
        status,
        headers: {
          'Content-Type': 'application/json',
          'X-Error-Type': errorType,
          'X-Local-Server': `${this.options.localHost || 'localhost'}:${this.options.port}`,
        },
        body: JSON.stringify({
          error: message,
          errorType,
          requestId: request.id,
          localServer: `${this.options.localHost || 'localhost'}:${this.options.port}`,
          timestamp: new Date().toISOString(),
          details: error instanceof Error ? error.message : String(error),
        }),
      }

      log('Sending error response for request %s (status: %d, type: %s)', request.id, status, errorType)
      this.sendResponse(errorResponse)
    }
  }

  /**
   * ローカルサーバーの接続性をチェック（キャッシュ機能付き）
   */
  private async checkLocalServerConnection(hostname: string, port: number): Promise<boolean> {
    const now = Date.now()

    // キャッシュが有効な場合はキャッシュされた結果を使用
    if (this.healthCheckCache.lastCheck > 0 && now - this.healthCheckCache.lastCheck < this.healthCheckCacheTTL) {
      log('Using cached health check result: %s', this.healthCheckCache.isHealthy ? 'healthy' : 'unhealthy')
      return this.healthCheckCache.isHealthy
    }

    const isHealthy = await this.performHealthCheck(hostname, port)

    // 結果をキャッシュ
    this.healthCheckCache = {
      isHealthy,
      lastCheck: now,
      healthPath: this.healthCheckCache.healthPath,
    }

    return isHealthy
  }

  /**
   * 実際のヘルスチェックを実行
   */
  private async performHealthCheck(hostname: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const protocol = this.options.localHttps ? https : http
      const timeout = 3000 // タイムアウトを短縮（3秒）

      // 既にヘルスパスが分かっている場合はそれを使用
      let checkPath = this.healthCheckCache.healthPath
      if (!checkPath) {
        // 最初の試行では /health を試す
        checkPath = '/health'
      }

      const options = {
        hostname,
        port,
        path: checkPath,
        method: 'HEAD',
        timeout,
      }

      log(
        'Performing health check: %s://%s:%s%s',
        this.options.localHttps ? 'https' : 'http',
        hostname,
        port,
        options.path,
      )

      const req = protocol.request(options, (res) => {
        const statusCode = res.statusCode || 0
        log('Health check response: %d %s', statusCode, res.statusMessage)

        // 200-299の範囲なら正常とみなす
        if (statusCode >= 200 && statusCode < 300) {
          this.healthCheckCache.healthPath = checkPath
          resolve(true)
          return
        }

        // 404やその他のエラーレスポンスで、まだ /health を試していた場合は / で再試行
        if (checkPath === '/health' && !this.healthCheckCache.healthPath) {
          log('Health endpoint not available (%d), trying root path...', statusCode)
          this.tryRootPath(hostname, port, timeout, resolve)
        } else {
          // すでにルートパスを試したか、ルートパスでもエラーの場合
          resolve(false)
        }
      })

      req.on('error', (error) => {
        log('Health check connection error: %s', error.message)

        // 接続エラーで、まだ /health を試していた場合は / で再試行
        if (checkPath === '/health' && !this.healthCheckCache.healthPath) {
          log('Connection error on /health, trying root path...')
          this.tryRootPath(hostname, port, timeout, resolve)
        } else {
          resolve(false)
        }
      })

      req.on('timeout', () => {
        log('Health check timeout on %s', checkPath)
        req.destroy()

        // タイムアウトで、まだ /health を試していた場合は / で再試行
        if (checkPath === '/health' && !this.healthCheckCache.healthPath) {
          log('Timeout on /health, trying root path...')
          this.tryRootPath(hostname, port, timeout, resolve)
        } else {
          resolve(false)
        }
      })

      req.end()
    })
  }

  /**
   * ルートパスでのヘルスチェック
   */
  private tryRootPath(hostname: string, port: number, timeout: number, resolve: (value: boolean) => void): void {
    const protocol = this.options.localHttps ? https : http
    const options = {
      hostname,
      port,
      path: '/',
      method: 'HEAD',
      timeout,
    }

    const fallbackReq = protocol.request(options, (res) => {
      const statusCode = res.statusCode || 0
      log('Root path health check response: %d', statusCode)

      if (statusCode >= 200 && statusCode < 500) {
        // 4xxエラーでもサーバーが動いていることは確認できる
        this.healthCheckCache.healthPath = '/'
        resolve(true)
      } else {
        resolve(false)
      }
    })

    fallbackReq.on('error', (error) => {
      log('Root path health check error: %s', error.message)
      resolve(false)
    })

    fallbackReq.on('timeout', () => {
      log('Root path health check timeout')
      fallbackReq.destroy()
      resolve(false)
    })

    fallbackReq.end()
  }

  private async forwardToLocalServer(request: ProxyRequest, retryCount = 0): Promise<ProxyResponse> {
    const maxRetries = this.options.maxRetries || 2
    const baseTimeout = this.options.timeout || 15000
    const protocol = this.options.localHttps ? https : http
    const port = this.options.port
    const hostname = this.options.localHost || 'localhost'

    log('=== Forwarding to local server ===')
    log('Request ID: %s (attempt %d/%d)', request.id, retryCount + 1, maxRetries + 1)
    log('Target: %s://%s:%s%s', this.options.localHttps ? 'https' : 'http', hostname, port, request.path)
    log('Method: %s, Content-Length: %d', request.method, request.body?.length || 0)

    // 初回リクエストまたは連続エラー後の場合のみサーバー健全性をチェック
    if (retryCount === 0) {
      log('Checking local server connectivity (initial request)...')
      const isConnectable = await this.checkLocalServerConnection(hostname, port)
      if (!isConnectable) {
        const error = new Error(`ECONNREFUSED: Local server at ${hostname}:${port} is not running or not responding`)
        log('❌ Local server connectivity check failed on initial request')
        throw error
      }
      log('✅ Local server is reachable')
    } else if (retryCount >= 3) {
      // 3回目以降のリトライ時のみ再チェック（頻度を下げる）
      log('Rechecking local server connectivity after %d failed attempts...', retryCount)
      const isConnectable = await this.checkLocalServerConnection(hostname, port)
      if (!isConnectable) {
        const error = new Error(`ECONNREFUSED: Local server became unreachable after ${retryCount} attempts`)
        log('❌ Local server connectivity lost during retries')
        throw error
      }
      log('✅ Local server is still reachable, continuing retry')
    }

    return new Promise((resolve, reject) => {
      // SSE接続かどうかをチェック（POST リクエストは SSE パスを使わない）
      const isSSERequest = request.method === 'GET' && (
        request.headers.accept?.includes('text/event-stream') ||
        request.path.includes('/sse') ||
        request.headers['cache-control'] === 'no-cache'
      )

      // 適応的タイムアウト設定
      let timeout = baseTimeout
      if (isSSERequest) {
        timeout = 3600000 // SSE接続は1時間
      } else if (request.path.includes('/api/') && request.method === 'GET') {
        timeout = Math.min(baseTimeout, 60000) // GET API系は短め（60秒）
      } else if (request.path.includes('/upload') || request.method === 'POST' || request.method === 'PUT') {
        timeout = Math.min(baseTimeout * 2, 180000) // アップロード系は最大180秒
      } else if (retryCount > 0) {
        // リトライ時は段階的にタイムアウトを延長（指数バックオフ）
        timeout = Math.min(baseTimeout * 1.5 ** retryCount, 60000)
      }

      // リクエストサイズに基づくタイムアウト調整（より保守的に）
      if (request.body && request.body.length > 50000) {
        // 50KB以上
        const sizeMultiplier = Math.min(1 + request.body.length / 500000, 2) // 最大2倍
        timeout = Math.min(timeout * sizeMultiplier, 180000) // 最大180秒
      }

      const options: http.RequestOptions = {
        hostname,
        port,
        path: request.path,
        method: request.method,
        headers: request.headers,
        timeout,
      }

      if (isSSERequest) {
        log('🔄 SSE connection detected, timeout: %dms', timeout)
      } else {
        log('⏱️ Request timeout set to: %dms', timeout)
      }

      // Handle HTTPS options
      if (this.options.localHttps) {
        log('Using HTTPS for local server connection')
        const httpsOptions = options as https.RequestOptions

        if (this.options.allowInvalidCert) {
          log('Allowing invalid certificates')
          httpsOptions.rejectUnauthorized = false
        } else if (this.options.localCert && this.options.localKey) {
          log('Using provided SSL certificates')
          try {
            httpsOptions.cert = fs.readFileSync(this.options.localCert)
            httpsOptions.key = fs.readFileSync(this.options.localKey)
            if (this.options.localCa) {
              httpsOptions.ca = fs.readFileSync(this.options.localCa)
            }
          } catch (error) {
            log('error reading SSL certificates:', error)
            reject(new Error('Failed to read SSL certificates'))
            return
          }
        }
      }

      log('Creating HTTP request with options: %o', options)

      const req = protocol.request(options, (res: http.IncomingMessage) => {
        log('Received response from local server for request %s: status %d', request.id, res.statusCode)
        const chunks: Buffer[] = []
        let bodySize = 0

        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
          bodySize += chunk.length

          // SSE接続の場合、定期的にチャンクをまとめて送信
          if (isSSERequest) {
            log('SSE chunk received: %d bytes for request %s', chunk.length, request.id)
          }
        })

        res.on('end', () => {
          log('Response body complete for request %s: %d bytes', request.id, bodySize)

          // SSE接続の場合は、既にチャンクを送信済みなので終了処理のみ
          if (isSSERequest) {
            log('SSE connection ended for request %s', request.id)
            return
          }

          const responseHeaders: Record<string, string> = {}
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') {
              responseHeaders[key] = value
            } else if (Array.isArray(value)) {
              responseHeaders[key] = value.join(', ')
            }
          }

          // Combine all chunks into a single buffer
          const bodyBuffer = Buffer.concat(chunks)

          // Check if this is binary content or compressed content
          const contentType = responseHeaders['content-type'] || ''
          const contentEncoding = responseHeaders['content-encoding'] || ''
          const contentLength = bodyBuffer.length

          const isBinary =
            contentType.startsWith('image/') ||
            contentType.startsWith('video/') ||
            contentType.startsWith('audio/') ||
            contentType.includes('application/octet-stream') ||
            contentType.includes('application/pdf')

          // Check if content is compressed (gzip, deflate, br, zstd)
          const isCompressed =
            contentEncoding.includes('gzip') ||
            contentEncoding.includes('deflate') ||
            contentEncoding.includes('br') ||
            contentEncoding.includes('compress') ||
            contentEncoding.includes('zstd')

          // HTML/JavaScript/CSSなどのテキストコンテンツの判定を追加
          const isTextContent =
            contentType.includes('text/') ||
            contentType.includes('application/json') ||
            contentType.includes('application/javascript') ||
            contentType.includes('application/x-javascript') ||
            contentType.includes('text/javascript') ||
            contentType.includes('application/xml') ||
            contentType.includes('application/xhtml+xml')

          log(
            'Response analysis for request %s: content-type=%s, content-encoding=%s, size=%d bytes, isBinary=%s, isCompressed=%s, isTextContent=%s',
            request.id,
            contentType,
            contentEncoding,
            contentLength,
            isBinary,
            isCompressed,
            isTextContent,
          )

          let body: string = ''
          let isBase64 = false

          if (isBinary) {
            // For binary content only, encode as base64
            body = bodyBuffer.toString('base64')
            isBase64 = true
            log('Encoded binary response as base64 for request %s', request.id)
            log('Content-Type: %s, Content-Encoding: %s', contentType, contentEncoding)
            log('Original body size: %d bytes, Base64 size: %d bytes', bodyBuffer.length, body.length)
          } else if (isCompressed && isTextContent) {
            // For compressed text content (HTML, JS, CSS), decompress and send as text
            // This allows Cloudflare Workers to handle compression appropriately
            try {
              let decompressedBuffer: Buffer

              if (contentEncoding.includes('gzip')) {
                decompressedBuffer = zlib.gunzipSync(bodyBuffer)
                log('Decompressed gzip content for request %s', request.id)
              } else if (contentEncoding.includes('br')) {
                decompressedBuffer = zlib.brotliDecompressSync(bodyBuffer)
                log('Decompressed brotli content for request %s', request.id)
              } else if (contentEncoding.includes('deflate')) {
                decompressedBuffer = zlib.inflateSync(bodyBuffer)
                log('Decompressed deflate content for request %s', request.id)
              } else {
                // Unknown compression, send as base64
                log('Unknown compression format %s, sending compressed data as base64', contentEncoding)
                body = bodyBuffer.toString('base64')
                isBase64 = true
                decompressedBuffer = bodyBuffer // Set to avoid undefined access
              }

              if (!isBase64) {
                body = decompressedBuffer.toString('utf8')
                log('Decompressed and converted to UTF-8 for request %s', request.id)
                log(
                  'Original compressed size: %d bytes, decompressed size: %d bytes',
                  bodyBuffer.length,
                  decompressedBuffer.length,
                )
              }
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error)
              log('Failed to decompress content for request %s, sending as base64: %s', request.id, errorMessage)
              body = bodyBuffer.toString('base64')
              isBase64 = true
            }
          } else if (isCompressed && !isTextContent) {
            // For compressed non-text content, encode as base64
            body = bodyBuffer.toString('base64')
            isBase64 = true
            log('Encoded compressed non-text content as base64 for request %s', request.id)
            log('Content-Type: %s, Content-Encoding: %s', contentType, contentEncoding)
            log('Original body size: %d bytes, Base64 size: %d bytes', bodyBuffer.length, body.length)
          } else {
            // For uncompressed text content, use UTF-8
            body = bodyBuffer.toString('utf8')
            log('Using UTF-8 encoding for uncompressed text content for request %s', request.id)
          }

          // HTMLテキストコンテンツの場合、Content-Encodingヘッダーを削除
          if (isCompressed && isTextContent && !isBase64) {
            // 圧縮解除したテキストコンテンツの場合、Content-Encodingヘッダーを削除
            delete responseHeaders['content-encoding']
            delete responseHeaders['content-length'] // サイズが変わったため
            log('Removed content-encoding header after decompression for request %s', request.id)
          }

          const response = {
            id: request.id,
            status: res.statusCode || 200,
            headers: responseHeaders,
            body,
            isBase64,
          }

          log(
            'Local server response for request %s ready: status %d, binary: %s, compressed: %s, headers: %o',
            request.id,
            response.status,
            isBinary,
            isCompressed,
            responseHeaders,
          )
          resolve(response)
        })
      })

      req.on('error', (error: Error) => {
        log('Local server request error for request %s (attempt %d):', request.id, retryCount + 1, error.message)

        // エラー種別を判定
        const isConnectionError =
          error.message.includes('ECONNREFUSED') ||
          error.message.includes('ENOTFOUND') ||
          error.message.includes('ECONNRESET')
        const isNetworkError = error.message.includes('ENETUNREACH') || error.message.includes('EHOSTUNREACH')

        // リトライ可能かどうかを判定
        const shouldRetry = retryCount < maxRetries && (isConnectionError || isNetworkError)

        if (shouldRetry) {
          // 指数バックオフでリトライ間隔を調整
          const backoffDelay = Math.min(1000 * 2 ** retryCount, 5000) // 1秒から最大5秒
          log(
            '🔄 Retrying request %s in %dms (attempt %d/%d) - Error: %s',
            request.id,
            backoffDelay,
            retryCount + 2,
            maxRetries + 1,
            error.message,
          )

          setTimeout(() => {
            this.forwardToLocalServer(request, retryCount + 1)
              .then(resolve)
              .catch(reject)
          }, backoffDelay)
        } else {
          // リトライ不可またはリトライ上限に達した場合
          const errorMessage =
            retryCount >= maxRetries
              ? `Request failed after ${maxRetries + 1} attempts: ${error.message}`
              : `Non-retryable error: ${error.message}`

          log('❌ Giving up on request %s: %s', request.id, errorMessage)
          reject(new Error(errorMessage))
        }
      })

      req.on('timeout', () => {
        log(
          '⏰ Local server request timeout for request %s (attempt %d, timeout: %dms)',
          request.id,
          retryCount + 1,
          timeout,
        )
        req.destroy()

        // タイムアウトの場合もリトライ（但し少し慎重に）
        if (retryCount < maxRetries) {
          // タイムアウト後のバックオフはより長めに
          const timeoutBackoffDelay = Math.min(2000 * 1.5 ** retryCount, 8000) // 2秒から最大8秒
          log(
            '🔄 Retrying request %s after timeout in %dms (attempt %d/%d)',
            request.id,
            timeoutBackoffDelay,
            retryCount + 2,
            maxRetries + 1,
          )

          setTimeout(() => {
            this.forwardToLocalServer(request, retryCount + 1)
              .then(resolve)
              .catch(reject)
          }, timeoutBackoffDelay)
        } else {
          const finalError = new Error(
            `Request timeout after ${maxRetries + 1} attempts. ` +
              `Last attempt timed out after ${timeout}ms. ` +
              `Local server at ${hostname}:${port} may be overloaded or unresponsive.`,
          )
          log('❌ Final timeout for request %s: %s', request.id, finalError.message)
          reject(finalError)
        }
      })

      // Send request body if present
      if (request.body) {
        log('Sending request body for request %s: %d bytes', request.id, request.body.length)
        req.write(request.body)
      }

      log('Sending HTTP request to local server for request %s', request.id)
      req.end()
    })
  }

  private sendResponse(response: ProxyResponse): void {
    log('Attempting to send response for request %s, status: %d', response.id, response.status)

    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      const message: WebSocketMessage = {
        type: 'response',
        data: response,
      }

      try {
        const messageId = messageChunker.generateMessageId()
        const chunkMessages = messageChunker.chunkMessage(message, messageId)

        if (chunkMessages.length === 1) {
          // 分割不要の場合
          const messageString = JSON.stringify(message)
          // log('Sending response message: %s', messageString);
          this.websocket.send(messageString)
          log('Response sent successfully for request %s', response.id)
        } else {
          // 分割が必要な場合
          log('Sending response in %d chunks for request %s', chunkMessages.length, response.id)
          for (const chunkMessage of chunkMessages) {
            const chunkString = JSON.stringify(chunkMessage)
            this.websocket.send(chunkString)
          }
          log('All response chunks sent successfully for request %s', response.id)
        }
      } catch (error) {
        log('error sending response:', error)
      }
    } else {
      log('websocket not available for sending response (readyState: %d)', this.websocket?.readyState || -1)
    }
  }

  private sendPing(): void {
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      try {
        const pingMessage = JSON.stringify({ type: 'ping', timestamp: Date.now() })
        this.websocket.send(pingMessage)
        log('Ping sent to keep connection alive')
      } catch (error) {
        log('Failed to send ping:', error)
      }
    }
  }

  private sendPong(): void {
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      try {
        const pongMessage = JSON.stringify({ type: 'pong', timestamp: Date.now() })
        this.websocket.send(pongMessage)
        log('Pong sent in response to ping')
      } catch (error) {
        log('Failed to send pong:', error)
      }
    }
  }

  close(): void {
    log('closing tunnel')
    this.closed = true

    // サーキットブレーカーをリセット
    this.resetCircuitBreaker()

    // ヘルスチェックキャッシュをクリア
    this.healthCheckCache = {
      isHealthy: false,
      lastCheck: 0,
      healthPath: null,
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval)
      this.keepAliveInterval = null
    }

    if (this.websocket) {
      try {
        // Check if websocket is in a valid state before closing
        const readyState = this.websocket.readyState
        log('WebSocket readyState before close: %d', readyState)

        if (readyState === WebSocket.OPEN || readyState === WebSocket.CONNECTING) {
          // Use async close to avoid synchronous errors
          setTimeout(() => {
            try {
              if (
                this.websocket &&
                (this.websocket.readyState === WebSocket.OPEN || this.websocket.readyState === WebSocket.CONNECTING)
              ) {
                this.websocket.close()
                log('WebSocket closed successfully (async)')
              }
            } catch (asyncError) {
              log('Async WebSocket close error (suppressed):', asyncError)
            }
          }, 0)
          log('WebSocket close scheduled')
        } else {
          log('WebSocket not in closeable state, skipping close')
        }
      } catch (error) {
        log('Error closing websocket:', error)
        // Completely suppress errors in test environments or when running via Mocha
        if (
          typeof process !== 'undefined' &&
          !process.env.npm_lifecycle_event?.includes('test') &&
          !process.env.MOCHA
        ) {
          console.error('WebSocket close error:', error)
        }
      }
    }

    if (this.localServer) {
      this.localServer.close()
      this.localServer = null
    }

    // メッセージチャンカーのクリーンアップ
    messageChunker.clearAllChunks()

    this.emit('close')
  }

  get url(): string | undefined {
    return this.tunnelInfo?.url
  }

  get cachedUrl(): string | undefined {
    return this.tunnelInfo?.cachedUrl
  }

  get clientId(): string | undefined {
    return this.tunnelInfo?.id
  }

  private async handleSSERequest(request: ProxyRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = this.options.localHttps ? https : http
      const port = this.options.port
      const hostname = this.options.localHost || 'localhost'

      log('=== Handling SSE request ===')
      log('Request ID: %s', request.id)
      log('Target: %s://%s:%s%s', this.options.localHttps ? 'https' : 'http', hostname, port, request.path)

      const options: http.RequestOptions = {
        hostname,
        port,
        path: request.path,
        method: request.method,
        headers: request.headers,
        timeout: 300000, // 5分タイムアウト
      }

      // Handle HTTPS options
      if (this.options.localHttps) {
        const httpsOptions = options as https.RequestOptions
        if (this.options.allowInvalidCert) {
          httpsOptions.rejectUnauthorized = false
        } else if (this.options.localCert && this.options.localKey) {
          try {
            httpsOptions.cert = fs.readFileSync(this.options.localCert)
            httpsOptions.key = fs.readFileSync(this.options.localKey)
            if (this.options.localCa) {
              httpsOptions.ca = fs.readFileSync(this.options.localCa)
            }
          } catch (error) {
            log('error reading SSL certificates:', error)
            reject(new Error('Failed to read SSL certificates'))
            return
          }
        }
      }

      const req = protocol.request(options, (res: http.IncomingMessage) => {
        log('SSE connection established for request %s: status %d', request.id, res.statusCode)

        // SSEレスポンスのヘッダーを準備
        const responseHeaders: Record<string, string> = {}
        for (const [key, value] of Object.entries(res.headers)) {
          if (typeof value === 'string') {
            responseHeaders[key] = value
          } else if (Array.isArray(value)) {
            responseHeaders[key] = value.join(', ')
          }
        }

        // SSE開始メッセージを送信（初期ヘッダー情報を含む）
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
          const sseStartMessage = {
            type: 'sse-start' as const,
            data: {
              requestId: request.id,
              status: res.statusCode || 200,
              headers: responseHeaders,
            },
          }

          try {
            this.websocket.send(JSON.stringify(sseStartMessage))
            log('SSE start signal sent for request %s', request.id)
          } catch (error) {
            log('Failed to send SSE start signal for request %s:', request.id, error)
          }
        }

        // ストリーミングデータを受信
        res.on('data', (chunk: Buffer) => {
          const chunkString = chunk.toString('utf8')
          log('SSE chunk received for request %s: %d bytes', request.id, chunk.length)

          if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
            const sseMessage = {
              type: 'sse-chunk' as const,
              data: {
                requestId: request.id,
                chunk: chunkString,
              },
            }

            try {
              this.websocket.send(JSON.stringify(sseMessage))
              log('SSE chunk sent for request %s', request.id)
            } catch (error) {
              log('Failed to send SSE chunk for request %s:', request.id, error)
            }
          }
        })

        res.on('end', () => {
          log('SSE connection ended for request %s', request.id)

          if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
            const endMessage = {
              type: 'sse-end' as const,
              data: {
                requestId: request.id,
                reason: 'stream_ended',
              },
            }

            try {
              this.websocket.send(JSON.stringify(endMessage))
              log('SSE end signal sent for request %s', request.id)
            } catch (error) {
              log('Failed to send SSE end signal for request %s:', request.id, error)
            }
          }

          resolve()
        })

        res.on('error', (error) => {
          log('SSE response error for request %s:', request.id, error)
          reject(error)
        })
      })

      req.on('error', (error: Error) => {
        log('SSE request error for request %s:', request.id, error)
        reject(error)
      })

      req.on('timeout', () => {
        log('SSE request timeout for request %s', request.id)
        req.destroy()
        reject(new Error('SSE Request timeout'))
      })

      // Send request body if present
      if (request.body) {
        log('Sending request body for SSE request %s: %d bytes', request.id, request.body.length)
        req.write(request.body)
      }

      log('Sending SSE request to local server for request %s', request.id)
      req.end()
    })
  }

  /**
   * Graceful shutdown処理
   */
  async gracefulShutdown(): Promise<void> {
    log('Starting graceful shutdown...')

    // 新しい接続を停止
    this.closed = true

    // サーキットブレーカーをリセット
    this.resetCircuitBreaker()

    // ヘルスチェックキャッシュをクリア
    this.healthCheckCache = {
      isHealthy: false,
      lastCheck: 0,
      healthPath: null,
    }

    // チャンカーの統計を取得
    const stats = messageChunker.getStats()
    if (stats.activeChunks > 0) {
      log('Waiting for %d active chunks to complete...', stats.activeChunks)

      // 最大5秒待つ
      const maxWait = 5000
      const startTime = Date.now()

      while (messageChunker.getStats().activeChunks > 0 && Date.now() - startTime < maxWait) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }

    // 通常のクローズ処理
    this.close()
    log('Graceful shutdown completed')
  }

  /**
   * サーキットブレーカーの状態をチェック
   */
  private isCircuitBreakerOpen(): boolean {
    if (!this.isCircuitOpen) return false

    // クールダウン時間が経過したかチェック
    if (Date.now() - this.lastErrorTime > this.circuitBreakerCooldown) {
      log('Circuit breaker cooldown period passed, resetting')
      this.resetCircuitBreaker()
      return false
    }

    return true
  }

  /**
   * エラー発生時にサーキットブレーカーを更新
   */
  private recordError(): void {
    this.consecutiveErrors++
    this.lastErrorTime = Date.now()

    if (this.consecutiveErrors >= this.circuitBreakerThreshold && !this.isCircuitOpen) {
      log('⚠️ Circuit breaker opened due to %d consecutive errors', this.consecutiveErrors)
      this.isCircuitOpen = true
      this.emit('circuit-breaker-open', {
        consecutiveErrors: this.consecutiveErrors,
        cooldownMs: this.circuitBreakerCooldown,
      })
    }
  }

  /**
   * 成功時にサーキットブレーカーをリセット
   */
  private recordSuccess(): void {
    if (this.consecutiveErrors > 0 || this.isCircuitOpen) {
      log('✅ Request succeeded, resetting circuit breaker (was: %d errors)', this.consecutiveErrors)
      this.resetCircuitBreaker()
    }
  }

  /**
   * サーキットブレーカーをリセット
   */
  private resetCircuitBreaker(): void {
    const wasOpen = this.isCircuitOpen
    this.consecutiveErrors = 0
    this.isCircuitOpen = false
    this.lastErrorTime = 0

    if (wasOpen) {
      log('🔧 Circuit breaker reset - ready to accept requests')
      this.emit('circuit-breaker-closed')
    }
  }

  /**
   * TCP 接続をチェック
   */
  private checkTcpConnection(hostname: string, port: number, timeout: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket()

      socket.setTimeout(timeout)

      socket.on('connect', () => {
        log('✅ TCP connection successful')
        socket.destroy()
        resolve(true)
      })

      socket.on('timeout', () => {
        log('❌ TCP connection timeout')
        socket.destroy()
        resolve(false)
      })

      socket.on('error', (error: Error) => {
        log('❌ TCP connection error: %s', error.message)
        socket.destroy()
        resolve(false)
      })

      log('Attempting TCP connection to %s:%d...', hostname, port)
      socket.connect(port, hostname)
    })
  }

  /**
   * ローカルポートの検証
   * セキュリティブロック、サーバー未応答、その他のエラーを特定
   */
  private async validateLocalPort(): Promise<LocalPortValidationResult> {
    const hostname = this.options.localHost || 'localhost'
    const port = this.options.port
    const protocol = this.options.localHttps ? https : http
    const tcpTimeout = 2000
    const httpTimeout = 5000

    log('Validating local port: %s://%s:%d', this.options.localHttps ? 'https' : 'http', hostname, port)

    // Step 1: Check TCP connection
    log('Step 1: Checking TCP connection...')
    const tcpConnected = await this.checkTcpConnection(hostname, port, tcpTimeout)

    if (!tcpConnected) {
      log('❌ TCP connection failed - possible firewall or security block')
      return {
        success: false,
        errorCode: 'SECURITY_BLOCKED',
        errorMessage: `TCP connection timeout. Port ${port} may be blocked by firewall or security software.`,
        host: hostname,
        port,
      }
    }

    // Step 2: HTTP応答チェック
    log('Step 2: Checking HTTP response...')
    return new Promise((resolve) => {
      const options: http.RequestOptions = {
        hostname,
        port,
        path: '/',
        method: 'HEAD',
        timeout: httpTimeout,
      }

      if (this.options.localHttps && this.options.allowInvalidCert) {
        ;(options as https.RequestOptions).rejectUnauthorized = false
      }

      const req = protocol.request(options, () => {
        log('✅ Local port validation successful')
        resolve({ success: true, host: hostname, port })
      })

      req.on('error', (error: NodeJS.ErrnoException) => {
        log('❌ Local port validation failed: %s (%s)', error.message, error.code)
        resolve({
          success: false,
          errorCode: this.mapErrorToCode(error),
          errorMessage: error.message,
          host: hostname,
          port,
        })
      })

      req.on('timeout', () => {
        log('❌ HTTP response timeout - server not responding')
        req.destroy()
        resolve({
          success: false,
          errorCode: 'SERVER_NOT_RESPONDING',
          errorMessage: `HTTP response timeout after ${httpTimeout}ms. Server is running but not responding to requests.`,
          host: hostname,
          port,
        })
      })

      req.end()
    })
  }

  private mapErrorToCode(error: NodeJS.ErrnoException): LocalPortErrorCode {
    switch (error.code) {
      case 'ECONNREFUSED':
        return 'ECONNREFUSED'
      case 'ETIMEDOUT':
        return 'ETIMEDOUT'
      case 'EACCES':
        return 'EACCES'
      case 'EPERM':
        return 'EPERM'
      case 'ENOTFOUND':
        return 'ENOTFOUND'
      case 'ENETUNREACH':
      case 'EHOSTUNREACH':
        return 'ENETUNREACH'
      default:
        return 'UNKNOWN'
    }
  }

  // トンネルの統計情報を取得
  getStats() {
    return {
      isConnected: this.websocket?.readyState === WebSocket.OPEN,
      connectionAttempts: this.reconnectAttempts,
      maxConnectionAttempts: this.maxReconnectAttempts,
      circuitBreaker: {
        isOpen: this.isCircuitOpen,
        consecutiveErrors: this.consecutiveErrors,
        lastErrorTime: this.lastErrorTime,
        threshold: this.circuitBreakerThreshold,
        cooldownMs: this.circuitBreakerCooldown,
      },
      chunker: messageChunker.getStats(),
      localServer: {
        host: this.options.localHost || 'localhost',
        port: this.options.port,
        https: !!this.options.localHttps,
      },
      tunnel: this.tunnelInfo
        ? {
            id: this.tunnelInfo.id,
            url: this.tunnelInfo.url,
          }
        : null,
    }
  }
}
