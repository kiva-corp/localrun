import { expect } from 'chai'
import { describe, it } from 'mocha'
import type {
  ChunkData,
  PingData,
  ProxyRequest,
  ProxyResponse,
  SSEChunkData,
  SSEEndData,
  SSEStartData,
  TunnelInfo,
  TunnelOptions,
  WebSocketMessage,
} from '../src/types.js'

describe('Types', () => {
  describe('TunnelOptions', () => {
    it('should accept minimal options', () => {
      const options: TunnelOptions = {
        port: 3000,
      }

      expect(options.port).to.equal(3000)
    })

    it('should accept full options', () => {
      const options: TunnelOptions = {
        port: 3000,
        host: 'https://example.com',
        subdomain: 'mysubdomain',
        localHost: '127.0.0.1',
        localHttps: true,
        localCert: '/path/to/cert.pem',
        localKey: '/path/to/key.pem',
        localCa: '/path/to/ca.pem',
        allowInvalidCert: true,
        timeout: 30000,
        maxRetries: 5,
      }

      expect(options.port).to.equal(3000)
      expect(options.host).to.equal('https://example.com')
      expect(options.subdomain).to.equal('mysubdomain')
      expect(options.localHost).to.equal('127.0.0.1')
      expect(options.localHttps).to.be.true
      expect(options.localCert).to.equal('/path/to/cert.pem')
      expect(options.localKey).to.equal('/path/to/key.pem')
      expect(options.localCa).to.equal('/path/to/ca.pem')
      expect(options.allowInvalidCert).to.be.true
      expect(options.timeout).to.equal(30000)
      expect(options.maxRetries).to.equal(5)
    })
  })

  describe('TunnelInfo', () => {
    it('should define tunnel information structure', () => {
      const info: TunnelInfo = {
        id: 'tunnel-123',
        url: 'https://abc123.localrun.stream',
        cachedUrl: 'https://cached.localrun.stream',
        port: 3000,
      }

      expect(info.id).to.equal('tunnel-123')
      expect(info.url).to.equal('https://abc123.localrun.stream')
      expect(info.cachedUrl).to.equal('https://cached.localrun.stream')
      expect(info.port).to.equal(3000)
    })

    it('should work without optional cachedUrl', () => {
      const info: TunnelInfo = {
        id: 'tunnel-456',
        url: 'https://def456.localrun.stream',
        port: 8080,
      }

      expect(info.id).to.equal('tunnel-456')
      expect(info.url).to.equal('https://def456.localrun.stream')
      expect(info.cachedUrl).to.be.undefined
      expect(info.port).to.equal(8080)
    })
  })

  describe('ProxyRequest', () => {
    it('should define request structure', () => {
      const request: ProxyRequest = {
        id: 'req-123',
        method: 'GET',
        path: '/api/test',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'test-agent',
        },
      }

      expect(request.id).to.equal('req-123')
      expect(request.method).to.equal('GET')
      expect(request.path).to.equal('/api/test')
      expect(request.headers['Content-Type']).to.equal('application/json')
      expect(request.body).to.be.undefined
    })

    it('should include optional body', () => {
      const request: ProxyRequest = {
        id: 'req-456',
        method: 'POST',
        path: '/api/create',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'test' }),
      }

      expect(request.body).to.be.a('string')
      if (request.body) {
        expect(JSON.parse(request.body)).to.deep.equal({ name: 'test' })
      }
    })
  })

  describe('ProxyResponse', () => {
    it('should define response structure', () => {
      const response: ProxyResponse = {
        id: 'req-123',
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ success: true }),
      }

      expect(response.id).to.equal('req-123')
      expect(response.status).to.equal(200)
      expect(response.headers['Content-Type']).to.equal('application/json')
      expect(response.body).to.be.a('string')
      expect(response.isBase64).to.be.undefined
    })

    it('should support base64 encoding flag', () => {
      const response: ProxyResponse = {
        id: 'req-456',
        status: 200,
        headers: {
          'Content-Type': 'image/png',
        },
        body: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
        isBase64: true,
      }

      expect(response.isBase64).to.be.true
    })
  })

  describe('WebSocketMessage', () => {
    it('should support request message type', () => {
      const proxyRequest: ProxyRequest = {
        id: 'req-123',
        method: 'GET',
        path: '/test',
        headers: {},
      }

      const message: WebSocketMessage = {
        type: 'request',
        data: proxyRequest,
        timestamp: Date.now(),
      }

      expect(message.type).to.equal('request')
      expect(message.data).to.deep.equal(proxyRequest)
      expect(message.timestamp).to.be.a('number')
    })

    it('should support response message type', () => {
      const proxyResponse: ProxyResponse = {
        id: 'req-123',
        status: 200,
        headers: {},
        body: 'response body',
      }

      const message: WebSocketMessage = {
        type: 'response',
        data: proxyResponse,
      }

      expect(message.type).to.equal('response')
      expect(message.data).to.deep.equal(proxyResponse)
      expect(message.timestamp).to.be.undefined
    })

    it('should support chunk message type', () => {
      const chunkData: ChunkData = {
        messageId: 'msg-123',
        chunkIndex: 0,
        totalChunks: 3,
        chunk: 'chunk data',
        originalType: 'request',
      }

      const message: WebSocketMessage = {
        type: 'chunk',
        data: chunkData,
      }

      expect(message.type).to.equal('chunk')
      expect(message.data).to.deep.equal(chunkData)
    })

    it('should support ping/pong message types', () => {
      const pingData: PingData = {
        timestamp: Date.now(),
      }

      const pingMessage: WebSocketMessage = {
        type: 'ping',
        data: pingData,
      }

      const pongMessage: WebSocketMessage = {
        type: 'pong',
        data: pingData,
      }

      expect(pingMessage.type).to.equal('ping')
      expect(pongMessage.type).to.equal('pong')
      expect(pingMessage.data).to.deep.equal(pingData)
      expect(pongMessage.data).to.deep.equal(pingData)
    })

    it('should support SSE message types', () => {
      const sseStart: SSEStartData = {
        requestId: 'req-123',
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }

      const sseChunk: SSEChunkData = {
        requestId: 'req-123',
        chunk: 'data: test event\n\n',
      }

      const sseEnd: SSEEndData = {
        requestId: 'req-123',
        reason: 'client_disconnect',
      }

      const startMessage: WebSocketMessage = {
        type: 'sse-start',
        data: sseStart,
      }

      const chunkMessage: WebSocketMessage = {
        type: 'sse-chunk',
        data: sseChunk,
      }

      const endMessage: WebSocketMessage = {
        type: 'sse-end',
        data: sseEnd,
      }

      expect(startMessage.type).to.equal('sse-start')
      expect(chunkMessage.type).to.equal('sse-chunk')
      expect(endMessage.type).to.equal('sse-end')
      expect(startMessage.data).to.deep.equal(sseStart)
      expect(chunkMessage.data).to.deep.equal(sseChunk)
      expect(endMessage.data).to.deep.equal(sseEnd)
    })
  })

  describe('ChunkData', () => {
    it('should define chunk structure', () => {
      const chunk: ChunkData = {
        messageId: 'msg-123',
        chunkIndex: 2,
        totalChunks: 5,
        chunk: 'chunk content',
        originalType: 'response',
      }

      expect(chunk.messageId).to.equal('msg-123')
      expect(chunk.chunkIndex).to.equal(2)
      expect(chunk.totalChunks).to.equal(5)
      expect(chunk.chunk).to.equal('chunk content')
      expect(chunk.originalType).to.equal('response')
    })
  })

  describe('SSE Data Types', () => {
    it('should define SSEStartData structure', () => {
      const sseStart: SSEStartData = {
        requestId: 'sse-req-123',
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      }

      expect(sseStart.requestId).to.equal('sse-req-123')
      expect(sseStart.status).to.equal(200)
      expect(sseStart.headers['Content-Type']).to.equal('text/event-stream')
    })

    it('should define SSEChunkData structure', () => {
      const sseChunk: SSEChunkData = {
        requestId: 'sse-req-123',
        chunk: 'event: message\ndata: {"type":"update","value":42}\n\n',
      }

      expect(sseChunk.requestId).to.equal('sse-req-123')
      expect(sseChunk.chunk).to.contain('event: message')
      expect(sseChunk.chunk).to.contain('data: {"type":"update","value":42}')
    })

    it('should define SSEEndData structure', () => {
      const sseEnd: SSEEndData = {
        requestId: 'sse-req-123',
        reason: 'timeout',
      }

      expect(sseEnd.requestId).to.equal('sse-req-123')
      expect(sseEnd.reason).to.equal('timeout')
    })

    it('should allow SSEEndData without reason', () => {
      const sseEnd: SSEEndData = {
        requestId: 'sse-req-456',
      }

      expect(sseEnd.requestId).to.equal('sse-req-456')
      expect(sseEnd.reason).to.be.undefined
    })
  })

  describe('PingData', () => {
    it('should define ping data structure', () => {
      const ping: PingData = {
        timestamp: 1640995200000,
      }

      expect(ping.timestamp).to.equal(1640995200000)
      expect(ping.timestamp).to.be.a('number')
    })
  })
})
