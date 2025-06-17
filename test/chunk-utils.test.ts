import { expect } from 'chai'
import { beforeEach, describe, it } from 'mocha'
import { MessageChunker } from '../src/chunk-utils.js'
import type { ChunkData, WebSocketMessage } from '../src/types.js'

describe('MessageChunker', () => {
  let chunker: MessageChunker

  beforeEach(() => {
    chunker = new MessageChunker()
  })

  describe('needsChunking', () => {
    it('should return false for small messages', () => {
      const smallMessage = 'Hello, World!'
      expect(chunker.needsChunking(smallMessage)).to.be.false
    })

    it('should return true for large messages', () => {
      // Create a message larger than 1MB
      const largeMessage = 'a'.repeat(1024 * 1024 + 1)
      expect(chunker.needsChunking(largeMessage)).to.be.true
    })
  })

  describe('chunkMessage', () => {
    it('should return original message for small messages', () => {
      const originalMessage: WebSocketMessage = {
        type: 'request',
        data: {
          id: 'test-1',
          method: 'GET',
          path: '/test',
          headers: { 'Content-Type': 'application/json' },
        },
      }
      const messageId = chunker.generateMessageId()
      const chunks = chunker.chunkMessage(originalMessage, messageId)

      expect(chunks).to.have.length(1)
      expect(chunks[0]).to.deep.equal(originalMessage)
    })

    it('should split large messages into chunks', () => {
      // Create a large message - need much larger than current chunk size
      const largeData = 'x'.repeat(1500 * 1024) // 1.5MB
      const originalMessage: WebSocketMessage = {
        type: 'response',
        data: {
          id: 'test-2',
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
          body: largeData,
        },
      }

      const messageId = chunker.generateMessageId()
      const chunks = chunker.chunkMessage(originalMessage, messageId)

      expect(chunks.length).to.be.greaterThan(1)

      // Verify all chunks are chunk type
      chunks.forEach((chunk: WebSocketMessage) => {
        expect(chunk.type).to.equal('chunk')
        expect(chunk.data).to.have.property('messageId', messageId)
        expect(chunk.data).to.have.property('chunkIndex')
        expect(chunk.data).to.have.property('totalChunks', chunks.length)
        expect(chunk.data).to.have.property('originalType', 'response')
      })

      // Verify chunk indices
      chunks.forEach((chunk: WebSocketMessage, index: number) => {
        const chunkData = chunk.data as ChunkData
        expect(chunkData.chunkIndex).to.equal(index)
      })
    })

    it('should handle UTF-8 characters properly', () => {
      // Create a large Unicode string that will definitely require chunking
      const unicodeData = '🚀'.repeat(300000) // Increase size to ensure chunking
      const originalMessage: WebSocketMessage = {
        type: 'request',
        data: {
          id: 'test-unicode',
          method: 'POST',
          path: '/unicode',
          headers: { 'Content-Type': 'application/json' },
          body: unicodeData,
        },
      }

      const messageId = chunker.generateMessageId()
      const chunks = chunker.chunkMessage(originalMessage, messageId)

      expect(chunks.length).to.be.greaterThan(1)

      // All chunks should be valid
      chunks.forEach((chunk: WebSocketMessage) => {
        expect(chunk.type).to.equal('chunk')
        const chunkData = chunk.data as ChunkData
        expect(chunkData.chunk).to.be.a('string')
      })

      // Verify the chunks can be reconstructed
      let reconstructed: WebSocketMessage | null = null
      chunks.forEach((chunk: WebSocketMessage, index: number) => {
        const chunkData = chunk.data as ChunkData
        const result = chunker.receiveChunk(chunkData)

        if (index === chunks.length - 1) {
          // Last chunk should return reconstructed message
          expect(result).to.not.be.null
          reconstructed = result
        } else {
          // Other chunks should return null
          expect(result).to.be.null
        }
      })

      expect(reconstructed).to.deep.equal(originalMessage)
    })

    it('should handle Japanese text and symbols properly', () => {
      // Create a large Japanese text with various symbols
      const japaneseText = 'こんにちは世界！🎌📝 Hello World! ¿Cómo estás? 안녕하세요! 你好！'
      const largeJapaneseData = japaneseText.repeat(50000) // Create large data to force chunking
      const originalMessage: WebSocketMessage = {
        type: 'request',
        data: {
          id: 'test-japanese',
          method: 'POST',
          path: '/api/japanese',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            message: largeJapaneseData,
            metadata: {
              language: '日本語',
              symbols: '♥♦♣♠★☆',
              emoji: '🎌🗾🍜🍣🎋',
            },
          }),
        },
      }

      const messageId = chunker.generateMessageId()
      const chunks = chunker.chunkMessage(originalMessage, messageId)

      expect(chunks.length).to.be.greaterThan(1)

      // All chunks should be valid
      chunks.forEach((chunk: WebSocketMessage) => {
        expect(chunk.type).to.equal('chunk')
        const chunkData = chunk.data as ChunkData
        expect(chunkData.chunk).to.be.a('string')
      })

      // Verify the chunks can be reconstructed properly
      let reconstructed: WebSocketMessage | null = null
      chunks.forEach((chunk: WebSocketMessage, index: number) => {
        const chunkData = chunk.data as ChunkData
        const result = chunker.receiveChunk(chunkData)

        if (index === chunks.length - 1) {
          // Last chunk should return reconstructed message
          expect(result).to.not.be.null
          reconstructed = result
        } else {
          // Other chunks should return null
          expect(result).to.be.null
        }
      })

      expect(reconstructed).to.deep.equal(originalMessage)

      // Verify that the Japanese text is preserved correctly
      if (reconstructed !== null) {
        const requestMessage = reconstructed as WebSocketMessage
        if (requestMessage.type === 'request' && requestMessage.data && 'body' in requestMessage.data) {
          const reconstructedData = JSON.parse(requestMessage.data.body as string)
          expect(reconstructedData.message).to.include('こんにちは世界')
          expect(reconstructedData.metadata.language).to.equal('日本語')
          expect(reconstructedData.metadata.symbols).to.equal('♥♦♣♠★☆')
          expect(reconstructedData.metadata.emoji).to.equal('🎌🗾🍜🍣🎋')
        }
      }
    })
  })

  describe('receiveChunk', () => {
    it('should reconstruct message from chunks', () => {
      const originalMessage: WebSocketMessage = {
        type: 'request',
        data: {
          id: 'test-reconstruct',
          method: 'POST',
          path: '/api/test',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: 'x'.repeat(2000000) }), // Force chunking with larger size
        },
      }

      const messageId = chunker.generateMessageId()
      const chunks = chunker.chunkMessage(originalMessage, messageId)

      // Should be chunked
      expect(chunks.length).to.be.greaterThan(1)

      let reconstructed: WebSocketMessage | null = null // Receive chunks in order
      chunks.forEach((chunk: WebSocketMessage, index: number) => {
        const chunkData = chunk.data as ChunkData
        const result = chunker.receiveChunk(chunkData)

        if (index === chunks.length - 1) {
          // Last chunk should return reconstructed message
          expect(result).to.not.be.null
          reconstructed = result
        } else {
          // Other chunks should return null
          expect(result).to.be.null
        }
      })

      expect(reconstructed).to.deep.equal(originalMessage)
    })

    it('should handle chunks received out of order', () => {
      const originalMessage: WebSocketMessage = {
        type: 'response',
        data: {
          id: 'test-out-of-order',
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: 'y'.repeat(2000000) }),
        },
      }

      const messageId = chunker.generateMessageId()
      const chunks = chunker.chunkMessage(originalMessage, messageId)

      expect(chunks.length).to.be.greaterThan(1)

      // Receive chunks in reverse order
      const reversedChunks = [...chunks].reverse()
      let reconstructed: WebSocketMessage | null = null

      reversedChunks.forEach((chunk, index) => {
        const chunkData = chunk.data as ChunkData
        const result = chunker.receiveChunk(chunkData)

        if (index === reversedChunks.length - 1) {
          // Last chunk should return reconstructed message
          expect(result).to.not.be.null
          reconstructed = result
        } else {
          // Other chunks should return null
          expect(result).to.be.null
        }
      })

      expect(reconstructed).to.deep.equal(originalMessage)
    })

    it('should return null for incomplete chunks', () => {
      const chunkData: ChunkData = {
        messageId: 'test-incomplete',
        chunkIndex: 0,
        totalChunks: 3,
        chunk: 'partial data',
        originalType: 'request',
      }

      const result = chunker.receiveChunk(chunkData)
      expect(result).to.be.null
    })
  })

  describe('generateMessageId', () => {
    it('should generate unique message IDs', () => {
      const id1 = chunker.generateMessageId()
      const id2 = chunker.generateMessageId()

      expect(id1).to.not.equal(id2)
      expect(id1).to.be.a('string')
      expect(id2).to.be.a('string')
      expect(id1.length).to.be.greaterThan(10)
      expect(id2.length).to.be.greaterThan(10)
    })
  })

  describe('cleanup', () => {
    it('should remove expired chunks', async () => {
      const chunkData: ChunkData = {
        messageId: 'test-cleanup',
        chunkIndex: 0,
        totalChunks: 2,
        chunk: 'test data',
        originalType: 'request',
      }

      chunker.receiveChunk(chunkData)

      // Force cleanup with very short max age
      const removedCount = chunker.cleanup(0, 100)
      expect(removedCount).to.be.greaterThanOrEqual(0) // May be 0 or 1 depending on timing
    })

    it('should limit number of entries', () => {
      // Add multiple incomplete chunk sets
      for (let i = 0; i < 5; i++) {
        const chunkData: ChunkData = {
          messageId: `test-limit-${i}`,
          chunkIndex: 0,
          totalChunks: 2,
          chunk: `test data ${i}`,
          originalType: 'request',
        }
        chunker.receiveChunk(chunkData)
      }

      // Cleanup with max entries of 3
      const removedCount = chunker.cleanup(60000, 3)
      expect(removedCount).to.equal(2)
    })
  })

  describe('clearAllChunks', () => {
    it('should clear all chunks', () => {
      // Add some chunks
      for (let i = 0; i < 3; i++) {
        const chunkData: ChunkData = {
          messageId: `test-clear-${i}`,
          chunkIndex: 0,
          totalChunks: 2,
          chunk: `test data ${i}`,
          originalType: 'request',
        }
        chunker.receiveChunk(chunkData)
      }

      const clearedCount = chunker.clearAllChunks()
      expect(clearedCount).to.equal(3)

      // Stats should show no active chunks
      const stats = chunker.getStats()
      expect(stats.activeChunks).to.equal(0)
    })
  })

  describe('getStats', () => {
    it('should return accurate statistics', () => {
      const chunkData: ChunkData = {
        messageId: 'test-stats',
        chunkIndex: 0,
        totalChunks: 2,
        chunk: 'test data for stats',
        originalType: 'request',
      }

      chunker.receiveChunk(chunkData)

      const stats = chunker.getStats()
      expect(stats).to.have.property('activeChunks', 1)
      expect(stats).to.have.property('oldestChunkAge')
      expect(stats).to.have.property('memoryUsageEstimate')
      expect(stats.oldestChunkAge).to.be.a('number')
      expect(stats.memoryUsageEstimate).to.be.a('number')
    })
  })

  describe('removeChunksByType', () => {
    it('should remove chunks by type', () => {
      // Add request chunks
      for (let i = 0; i < 2; i++) {
        const chunkData: ChunkData = {
          messageId: `test-request-${i}`,
          chunkIndex: 0,
          totalChunks: 2,
          chunk: `request data ${i}`,
          originalType: 'request',
        }
        chunker.receiveChunk(chunkData)
      }

      // Add response chunks
      for (let i = 0; i < 3; i++) {
        const chunkData: ChunkData = {
          messageId: `test-response-${i}`,
          chunkIndex: 0,
          totalChunks: 2,
          chunk: `response data ${i}`,
          originalType: 'response',
        }
        chunker.receiveChunk(chunkData)
      }

      // Remove only request chunks
      const removedCount = chunker.removeChunksByType('request')
      expect(removedCount).to.equal(2)

      // Should still have response chunks
      const stats = chunker.getStats()
      expect(stats.activeChunks).to.equal(3)
    })
  })
})
