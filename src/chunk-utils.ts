import type { ChunkData, WebSocketMessage } from './types.js'

// Cloudflare WorkersのWebSocketメッセージサイズ制限 (1MB)
const MAX_MESSAGE_SIZE = 1024 * 1024 // 1MB
const CHUNK_SIZE = 768 * 1024 // 768KB

/**
 * UTF-8セーフな文字列分割
 * マルチバイト文字の境界を考慮して分割する
 */
function safeStringChunk(str: string, maxBytes: number): string[] {
  const chunks: string[] = []
  const encoder = new TextEncoder()

  let currentIndex = 0

  while (currentIndex < str.length) {
    // 残りの文字列が制限内の場合はそのまま追加
    const remaining = str.substring(currentIndex)
    const remainingBytes = encoder.encode(remaining)
    if (remainingBytes.length <= maxBytes) {
      chunks.push(remaining)
      break
    }

    // バイナリサーチで最適な文字数を見つける
    let left = 1
    let right = Math.min(str.length - currentIndex, maxBytes)
    let bestLength = 1

    while (left <= right) {
      const mid = Math.floor((left + right) / 2)
      const testChunk = str.substring(currentIndex, currentIndex + mid)
      const encoded = encoder.encode(testChunk)

      if (encoded.length <= maxBytes) {
        bestLength = mid
        left = mid + 1
      } else {
        right = mid - 1
      }
    }

    // チャンクを作成して追加
    const chunk = str.substring(currentIndex, currentIndex + bestLength)
    chunks.push(chunk)
    currentIndex += bestLength

    // 安全チェック：進歩がない場合（理論的には発生しないはず）
    if (bestLength === 0) {
      // 単一文字でも制限を超える場合は、その文字をスキップ
      // または例外を投げる
      throw new Error(`Single character exceeds maxBytes limit: ${maxBytes}`)
    }
  }

  return chunks
}

export class MessageChunker {
  private chunks: Map<
    string,
    {
      chunks: string[]
      totalChunks: number
      originalType: 'request' | 'response'
      receivedChunks: number
      createdAt: number
    }
  > = new Map()

  /**
   * メッセージが分割が必要かチェック
   */
  needsChunking(message: string): boolean {
    return new TextEncoder().encode(message).length > MAX_MESSAGE_SIZE
  }
  /**
   * メッセージを分割（UTF-8セーフ）
   */
  chunkMessage(originalMessage: WebSocketMessage, messageId: string): WebSocketMessage[] {
    const messageString = JSON.stringify(originalMessage)

    if (!this.needsChunking(messageString)) {
      return [originalMessage]
    }

    // UTF-8セーフな分割を使用
    const chunks: string[] = safeStringChunk(messageString, CHUNK_SIZE)

    const totalChunks = chunks.length
    const chunkMessages: WebSocketMessage[] = []

    for (let i = 0; i < chunks.length; i++) {
      const chunkData: ChunkData = {
        messageId,
        chunkIndex: i,
        totalChunks,
        chunk: chunks[i],
        originalType: originalMessage.type as 'request' | 'response',
      }

      chunkMessages.push({
        type: 'chunk',
        data: chunkData,
      })
    }

    return chunkMessages
  }

  /**
   * チャンクを受信して復元
   */
  receiveChunk(chunkData: ChunkData): WebSocketMessage | null {
    const { messageId, chunkIndex, totalChunks, chunk, originalType } = chunkData

    // 定期的にクリーンアップを実行（10回に1回）
    if (Math.random() < 0.1) {
      this.cleanup()
    }

    if (!this.chunks.has(messageId)) {
      this.chunks.set(messageId, {
        chunks: new Array(totalChunks),
        totalChunks,
        originalType,
        receivedChunks: 0,
        createdAt: Date.now(),
      })
    }

    const messageInfo = this.chunks.get(messageId)
    if (!messageInfo) {
      console.error('Message info not found for chunk')
      return null
    }

    messageInfo.chunks[chunkIndex] = chunk
    messageInfo.receivedChunks++ // すべてのチャンクが揃ったかチェック
    if (messageInfo.receivedChunks === totalChunks) {
      try {
        // チャンクを結合（Base64デコードなし）
        const combinedString = messageInfo.chunks.join('')

        console.log(`Attempting to reconstruct message ${messageId}, combinedString length: ${combinedString.length}`)

        // 元のメッセージを復元
        const originalMessage: WebSocketMessage = JSON.parse(combinedString)

        // クリーンアップ
        this.chunks.delete(messageId)

        // console.log(`✅ Successfully reconstructed message ${messageId}`)
        return originalMessage
      } catch (error) {
        console.error('Failed to reconstruct message:', error)
        console.error('Combined string length:', messageInfo.chunks.join('').length)
        console.error('Total chunks received:', messageInfo.receivedChunks)
        console.error('Expected chunks:', totalChunks)
        console.error(
          'Individual chunk lengths:',
          messageInfo.chunks.map((c, i) => `${i}: ${c ? c.length : 'null'}`),
        )
        this.chunks.delete(messageId)
        return null
      }
    }

    return null // まだすべてのチャンクが揃っていない
  }

  /**
   * 古いチャンクをクリーンアップ (メモリリーク防止)
   * @param maxAge 最大保持時間（ミリ秒）デフォルト30秒
   * @param maxEntries 最大エントリ数 デフォルト100
   */
  cleanup(maxAge = 30000, maxEntries = 100): number {
    const now = Date.now()
    let removedCount = 0
    const entriesToRemove: string[] = []

    // 期限切れのエントリを特定
    for (const [messageId, messageInfo] of this.chunks.entries()) {
      const age = now - messageInfo.createdAt
      if (age > maxAge) {
        entriesToRemove.push(messageId)
      }
    }

    // 期限切れエントリを削除
    for (const messageId of entriesToRemove) {
      this.chunks.delete(messageId)
      removedCount++
    }

    // エントリ数が上限を超えている場合、古いものから削除
    if (this.chunks.size > maxEntries) {
      const sortedEntries = Array.from(this.chunks.entries()).sort(([, a], [, b]) => a.createdAt - b.createdAt)

      const excessCount = this.chunks.size - maxEntries
      for (let i = 0; i < excessCount; i++) {
        const [messageId] = sortedEntries[i]
        this.chunks.delete(messageId)
        removedCount++
      }
    }

    if (removedCount > 0) {
      console.log(`Cleaned up ${removedCount} expired chunk entries. Remaining: ${this.chunks.size}`)
    }

    return removedCount
  }

  /**
   * 強制的にすべてのチャンクをクリアする
   */
  clearAllChunks(): number {
    const count = this.chunks.size
    this.chunks.clear()
    if (count > 0) {
      console.log(`Forcefully cleared ${count} chunk entries`)
    }
    return count
  }

  /**
   * メッセージIDを生成
   */
  generateMessageId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
  }

  /**
   * 特定のメッセージタイプのチャンクを削除
   */
  removeChunksByType(type: 'request' | 'response'): number {
    let removedCount = 0
    const entriesToRemove: string[] = []

    for (const [messageId, messageInfo] of this.chunks.entries()) {
      if (messageInfo.originalType === type) {
        entriesToRemove.push(messageId)
      }
    }

    for (const messageId of entriesToRemove) {
      this.chunks.delete(messageId)
      removedCount++
    }

    if (removedCount > 0) {
      console.log(`Removed ${removedCount} ${type} chunk entries`)
    }

    return removedCount
  }

  /**
   * チャンク管理の統計情報を取得
   */
  getStats(): {
    activeChunks: number
    oldestChunkAge: number
    memoryUsageEstimate: number
  } {
    const now = Date.now()
    let oldestAge = 0
    let totalMemory = 0

    for (const [messageId, messageInfo] of this.chunks.entries()) {
      const age = now - messageInfo.createdAt
      oldestAge = Math.max(oldestAge, age)

      // メモリ使用量の概算（文字列長 × 2バイト + オーバーヘッド）
      const messageIdSize = messageId.length * 2
      const chunksSize = messageInfo.chunks.reduce((sum, chunk) => {
        return sum + (chunk ? chunk.length * 2 : 0)
      }, 0)
      totalMemory += messageIdSize + chunksSize + 100 // オーバーヘッド概算
    }

    return {
      activeChunks: this.chunks.size,
      oldestChunkAge: oldestAge,
      memoryUsageEstimate: totalMemory,
    }
  }
}

export const messageChunker = new MessageChunker()
