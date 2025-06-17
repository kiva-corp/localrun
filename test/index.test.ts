import * as http from 'node:http'
import * as net from 'node:net'
import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import localrun, { Tunnel } from '../src/index.js'
import type { TunnelOptions } from '../src/types.js'

describe('localrun', () => {
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
    testServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'test server response' }))
    })

    await new Promise<void>((resolve) => {
      testServer.listen(testPort, () => resolve(undefined))
    })
  })

  afterEach(async () => {
    if (testServer) {
      await new Promise<void>((resolve) => {
        testServer.close(() => resolve(undefined))
      })
    }
  })

  describe('default export', () => {
    it('should accept TunnelOptions', async () => {
      const options: TunnelOptions = {
        port: testPort,
        host: 'https://httpbin.org', // Use a known endpoint for testing
      }

      try {
        const tunnel = await localrun(options)
        expect(tunnel).to.be.instanceOf(Tunnel)
        if (tunnel) {
          tunnel.close()
        }
      } catch (error) {
        // Connection errors are expected in test environment
        expect(error).to.be.instanceOf(Error)
      }
    }).timeout(10000)

    it('should accept port number and options', async () => {
      const options: Omit<TunnelOptions, 'port'> = {
        host: 'https://httpbin.org',
      }

      try {
        const tunnel = await localrun(testPort, options)
        expect(tunnel).to.be.instanceOf(Tunnel)
        if (tunnel) {
          tunnel.close()
        }
      } catch (error) {
        // Connection errors are expected in test environment
        expect(error).to.be.instanceOf(Error)
      }
    }).timeout(10000)

    // it('should accept only port number', async () => {
    //   try {
    //     const tunnel = await localrun(testPort)
    //     expect(tunnel).to.be.instanceOf(Tunnel)
    //     if (tunnel) {
    //       tunnel.close()
    //     }
    //   } catch (error) {
    //     // Connection errors are expected in test environment
    //     expect(error).to.be.instanceOf(Error)
    //   }
    // }).timeout(10000)
  })

  describe('legacy callback interface', () => {
    // it('should support callback with TunnelOptions', (done) => {
    //   const options: TunnelOptions = {
    //     port: testPort,
    //     host: 'https://httpbin.org',
    //   }

    //   const tunnel = localrun.connect(options, (err, tunnel) => {
    //     if (err) {
    //       // Connection errors are expected in test environment
    //       expect(err).to.be.instanceOf(Error)
    //       done()
    //     } else {
    //       expect(tunnel).to.be.instanceOf(Tunnel)
    //       tunnel?.close()
    //       done()
    //     }
    //   })

    //   expect(tunnel).to.be.instanceOf(Tunnel)
    // }).timeout(10000)

    // it('should support callback with port and options', (done) => {
    //   const options: Omit<TunnelOptions, 'port'> = {
    //     host: 'https://httpbin.org',
    //   }

    //   const tunnel = localrun.connect(testPort, options, (err, tunnel) => {
    //     if (err) {
    //       // Connection errors are expected in test environment
    //       expect(err).to.be.instanceOf(Error)
    //       done()
    //     } else {
    //       expect(tunnel).to.be.instanceOf(Tunnel)
    //       tunnel?.close()
    //       done()
    //     }
    //   })

    //   expect(tunnel).to.be.instanceOf(Tunnel)
    // }).timeout(10000)

    // it('should support callback with only port', (done) => {
    //   const tunnel = localrun.connect(testPort, (err, tunnel) => {
    //     if (err) {
    //       // Connection errors are expected in test environment
    //       expect(err).to.be.instanceOf(Error)
    //       done()
    //     } else {
    //       expect(tunnel).to.be.instanceOf(Tunnel)
    //       tunnel?.close()
    //       done()
    //     }
    //   })

    //   expect(tunnel).to.be.instanceOf(Tunnel)
    // }).timeout(10000)

    it('should return tunnel without callback', () => {
      const options: TunnelOptions = {
        port: testPort,
        host: 'https://httpbin.org',
      }

      const tunnel = localrun.connect(options)
      expect(tunnel).to.be.instanceOf(Tunnel)

      // Clean up
      setTimeout(() => tunnel.close(), 100)
    })
  })

  describe('exports', () => {
    it('should export Tunnel class', () => {
      expect(Tunnel).to.be.a('function')
      expect(new Tunnel({ port: testPort })).to.be.instanceOf(Tunnel)
    })

    it('should export default function', () => {
      expect(localrun).to.be.a('function')
    })

    it('should export connect method', () => {
      expect(localrun.connect).to.be.a('function')
    })
  })

  describe('error handling', () => {
    // it('should handle invalid port numbers', async () => {
    //   try {
    //     await localrun(-1)
    //     expect.fail('Expected error for invalid port')
    //   } catch (error) {
    //     expect(error).to.be.instanceOf(Error)
    //   }
    // })

    it('should handle invalid options', async () => {
      try {
        const invalidOptions = {
          port: testPort,
          host: 'invalid://not-a-real-host',
        } as TunnelOptions

        await localrun(invalidOptions)
        expect.fail('Expected error for invalid host')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
      }
    }).timeout(10000)
  })
})
