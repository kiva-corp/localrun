// テストセットアップファイル
// WebSocketエラーなどの非同期エラーをキャッチして抑制

const originalConsoleError = console.error

// エラー抑制用のフィルター
function shouldSuppressError(error) {
  const errorString = String(error)
  return (
    errorString.includes('Unexpected server response: 404') ||
    errorString.includes('ECONNREFUSED') ||
    errorString.includes('WebSocket') ||
    errorString.includes('getaddrinfo ENOTFOUND') ||
    errorString.includes('connect ECONNREFUSED')
  )
}

// グローバルエラーハンドラー
process.on('uncaughtException', (error) => {
  if (shouldSuppressError(error.message || error)) {
    console.log(`[SETUP] Suppressing expected error: ${error.message || error}`)
    return
  }

  // 他のエラーは通常通り処理
  console.error('Uncaught Exception:', error)
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  if (shouldSuppressError(reason)) {
    console.log(`[SETUP] Suppressing expected rejection: ${reason}`)
    return
  }

  // 他のエラーは通常通り処理
  console.error('Unhandled Rejection:', reason)
  process.exit(1)
})

// コンソールエラーもフィルタリング
console.error = function (...args) {
  const message = args.join(' ')
  if (shouldSuppressError(message)) {
    console.log(`[SETUP] Suppressing error log: ${message}`)
    return
  }
  originalConsoleError.apply(console, args)
}

console.log('[SETUP] Test error suppression enabled')
