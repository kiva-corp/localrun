import { expect } from 'chai'
import { describe, it } from 'mocha'

// Simple functional tests without complex typing issues
describe('Functional Tests', () => {
  describe('MessageChunker functionality', () => {
    it('should be able to import MessageChunker', async () => {
      const { MessageChunker } = await import('../src/chunk-utils.js')
      const chunker = new MessageChunker()
      expect(chunker).to.be.an('object')
      expect(chunker.generateMessageId).to.be.a('function')
    })

    it('should generate unique message IDs', async () => {
      const { MessageChunker } = await import('../src/chunk-utils.js')
      const chunker = new MessageChunker()
      const id1 = chunker.generateMessageId()
      const id2 = chunker.generateMessageId()
      expect(id1).to.not.equal(id2)
      expect(typeof id1).to.equal('string')
      expect(typeof id2).to.equal('string')
    })

    it('should detect if chunking is needed', async () => {
      const { MessageChunker } = await import('../src/chunk-utils.js')
      const chunker = new MessageChunker()

      const smallMessage = 'Hello, World!'
      expect(chunker.needsChunking(smallMessage)).to.be.false

      const largeMessage = 'a'.repeat(1024 * 1024 + 1) // > 1MB
      expect(chunker.needsChunking(largeMessage)).to.be.true
    })
  })

  describe('Tunnel functionality', () => {
    it('should be able to import Tunnel', async () => {
      const { Tunnel } = await import('../src/tunnel.js')
      expect(Tunnel).to.be.a('function')
    })

    it('should create tunnel with basic options', async () => {
      const { Tunnel } = await import('../src/tunnel.js')
      const tunnel = new Tunnel({ port: 3000 })
      expect(tunnel).to.be.an('object')
      expect(tunnel.getStats).to.be.a('function')
      tunnel.close()
    })

    it('should return statistics', async () => {
      const { Tunnel } = await import('../src/tunnel.js')
      const tunnel = new Tunnel({ port: 3000 })
      const stats = tunnel.getStats()
      expect(stats).to.have.property('isConnected', false)
      expect(stats).to.have.property('localServer')
      expect(stats.localServer).to.have.property('port', 3000)
      tunnel.close()
    })
  })

  describe('Main module functionality', () => {
    it('should export default function', async () => {
      const localrunModule = await import('../src/index.js')
      expect(localrunModule.default).to.be.a('function')
      expect(localrunModule.Tunnel).to.be.a('function')
    })
  })

  describe('Type definitions', () => {
    it('should have type exports available', async () => {
      // This just tests that the modules can be imported without error
      try {
        await import('../src/types.js')
        // If we get here without error, types are available
        expect(true).to.be.true
      } catch (error) {
        expect.fail(`Types should be importable: ${error}`)
      }
    })
  })
})
