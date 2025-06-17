import * as http from 'node:http'
import * as net from 'node:net'
import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { Tunnel } from '../src/tunnel.js'
import type { TunnelOptions } from '../src/types.js'

describe('Tunnel', () => {
  let tunnel: Tunnel
  let testServer: http.Server
  let testPort: number

  // Helper function to find an available port
  const findAvailablePort = (): Promise<number> => {
    return new Promise((resolve, reject) => {
      const server = net.createServer()
      server.listen(0, () => {
        const address = server.address()
        if (address && typeof address === 'object') {
          const port = address.port
          server.close(() => resolve(port))
        } else {
          reject(new Error('Failed to get port'))
        }
      })
    })
  }

  beforeEach(async () => {
    testPort = await findAvailablePort()

    // Create a simple test HTTP server
    testServer = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
      } else if (req.url === '/echo') {
        let body = ''
        req.on('data', (chunk) => {
          body += chunk.toString()
        })
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              method: req.method,
              url: req.url,
              headers: req.headers,
              body: body || null,
            }),
          )
        })
      } else if (req.url === '/delay') {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ message: 'delayed response' }))
        }, 100)
      } else if (req.url === '/error') {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal Server Error' }))
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not Found' }))
      }
    })

    await new Promise<void>((resolve) => {
      testServer.listen(testPort, () => resolve())
    })
  })

  afterEach(async () => {
    if (tunnel) {
      tunnel.close()
    }
    if (testServer) {
      await new Promise<void>((resolve) => {
        testServer.close(() => resolve())
      })
    }
  })

  describe('constructor', () => {
    it('should create tunnel with default options', () => {
      const options: TunnelOptions = { port: testPort }
      tunnel = new Tunnel(options)

      expect(tunnel).to.be.instanceOf(Tunnel)
      expect(tunnel.url).to.be.undefined
      expect(tunnel.clientId).to.be.undefined
    })

    it('should create tunnel with custom options', () => {
      const options: TunnelOptions = {
        port: testPort,
        host: 'https://custom.example.com',
        subdomain: 'mysubdomain',
        localHost: '127.0.0.1',
        timeout: 30000,
        maxRetries: 5,
      }
      tunnel = new Tunnel(options)

      expect(tunnel).to.be.instanceOf(Tunnel)
    })
  })

  describe('getStats', () => {
    it('should return tunnel statistics', () => {
      const options: TunnelOptions = { port: testPort }
      tunnel = new Tunnel(options)

      const stats = tunnel.getStats()

      expect(stats).to.have.property('isConnected', false)
      expect(stats).to.have.property('connectionAttempts', 0)
      expect(stats).to.have.property('maxConnectionAttempts', 10)
      expect(stats).to.have.property('circuitBreaker')
      expect(stats.circuitBreaker).to.have.property('isOpen', false)
      expect(stats.circuitBreaker).to.have.property('consecutiveErrors', 0)
      expect(stats).to.have.property('chunker')
      expect(stats).to.have.property('localServer')
      expect(stats.localServer).to.have.property('host', 'localhost')
      expect(stats.localServer).to.have.property('port', testPort)
      expect(stats.localServer).to.have.property('https', false)
      expect(stats).to.have.property('tunnel', null)
    })
  })

  describe('gracefulShutdown', () => {
    it('should perform graceful shutdown', async () => {
      const options: TunnelOptions = { port: testPort }
      tunnel = new Tunnel(options)

      // gracefulShutdown should complete without throwing
      await tunnel.gracefulShutdown()
      // If we reach here, the shutdown completed successfully
    })
  })

  describe('close', () => {
    it('should close tunnel properly', () => {
      const options: TunnelOptions = { port: testPort }
      tunnel = new Tunnel(options)

      let closeCalled = false
      tunnel.on('close', () => {
        closeCalled = true
      })

      tunnel.close()

      expect(closeCalled).to.be.true
    })
  })

  // describe('open', () => {
  //   it('should fail to open tunnel with invalid host', async () => {
  //     const options: TunnelOptions = {
  //       port: testPort,
  //       host: 'https://invalid.nonexistent.domain.example',
  //     }
  //     tunnel = new Tunnel(options)

  //     try {
  //       await tunnel.open()
  //       expect.fail('Expected tunnel.open() to throw an error')
  //     } catch (error) {
  //       expect(error).to.be.instanceOf(Error)
  //     }
  //   }).timeout(10000)

  //   it('should fail to open tunnel with invalid port', async () => {
  //     const invalidPort = 99999
  //     const options: TunnelOptions = {
  //       port: invalidPort,
  //       host: 'https://httpbin.org', // Use a known working host
  //     }
  //     tunnel = new Tunnel(options)

  //     try {
  //       await tunnel.open()
  //       expect.fail('Expected tunnel.open() to throw an error')
  //     } catch (error) {
  //       expect(error).to.be.instanceOf(Error)
  //     }
  //   }).timeout(10000)
  // })

  describe('event handling', () => {
    it('should emit events properly', (done) => {
      const options: TunnelOptions = { port: testPort }
      tunnel = new Tunnel(options)

      let eventCount = 0
      const expectedEvents = ['close']

      expectedEvents.forEach((eventName) => {
        tunnel.on(eventName, () => {
          eventCount++
          if (eventCount === expectedEvents.length) {
            done()
          }
        })
      })

      tunnel.close()
    })

    // it('should handle error events', (done) => {
    //   const options: TunnelOptions = { port: testPort }
    //   tunnel = new Tunnel(options)

    //   tunnel.on('error', (error) => {
    //     expect(error).to.be.instanceOf(Error)
    //     done()
    //   })

    //   // Simulate an error by trying to connect to invalid host
    //   tunnel.open().catch(() => {
    //     // Error is expected and will be emitted
    //   })
    // }).timeout(5000)
  })

  describe('HTTPS options', () => {
    it('should handle HTTPS options correctly', () => {
      const options: TunnelOptions = {
        port: testPort,
        localHttps: true,
        localCert: '/path/to/cert.pem',
        localKey: '/path/to/key.pem',
        localCa: '/path/to/ca.pem',
        allowInvalidCert: false,
      }
      tunnel = new Tunnel(options)

      const stats = tunnel.getStats()
      expect(stats.localServer.https).to.be.true
    })

    it('should handle invalid certificate options', () => {
      const options: TunnelOptions = {
        port: testPort,
        localHttps: true,
        allowInvalidCert: true,
      }
      tunnel = new Tunnel(options)

      const stats = tunnel.getStats()
      expect(stats.localServer.https).to.be.true
    })
  })

  describe('timeout and retry options', () => {
    it('should respect timeout options', () => {
      const options: TunnelOptions = {
        port: testPort,
        timeout: 5000,
        maxRetries: 3,
      }
      tunnel = new Tunnel(options)

      // Tunnel should be created with the specified options
      expect(tunnel).to.be.instanceOf(Tunnel)
    })
  })

  describe('subdomain handling', () => {
    it('should handle subdomain option', () => {
      const options: TunnelOptions = {
        port: testPort,
        subdomain: 'testsubdom',
      }
      tunnel = new Tunnel(options)

      expect(tunnel).to.be.instanceOf(Tunnel)
    })
  })
})
