import http from 'node:http'
import { once } from 'node:events'
import process from 'node:process'
import localrun from '../dist/index.js'

const workerHost = process.env.LOCALRUN_HOST || 'http://127.0.0.1:8788'
const workerBaseDomain = process.env.LOCALRUN_BASE_DOMAIN || 'localrun.stream'
const localPort = Number(process.env.LOCALRUN_LOCAL_PORT || 3002)
const binaryPayload = Buffer.from([0x00, 0x01, 0x02, 0x7f, 0x80, 0xfe, 0xff])

const readAllBuffer = async (res) => {
  const chunks = []
  for await (const c of res) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  return Buffer.concat(chunks)
}

const readAll = async (res) => (await readAllBuffer(res)).toString('utf8')

const waitForSseData = (res, timeoutMs, expectedText) =>
  new Promise((resolve, reject) => {
    let accumulated = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('SSE data timeout'))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timer)
      res.off('data', onData)
      res.off('error', onError)
    }

    const onError = (err) => {
      cleanup()
      reject(err)
    }

    const onData = (chunk) => {
      accumulated += chunk.toString('utf8')
      if (expectedText ? accumulated.includes(expectedText) : accumulated.includes('data:')) {
        cleanup()
        resolve(accumulated)
      }
    }

    res.on('data', onData)
    res.on('error', onError)
  })

const waitForTunnelOnline = async (tunnelId, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fetch(new URL(`/api/tunnels/${tunnelId}/status`, workerHost))
    if (res.ok) {
      const status = await res.json()
      if (status?.online && (status?.connected_sockets || 0) > 0) {
        return
      }
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Timed out waiting for tunnel ${tunnelId} to become online`)
}

const requestViaTunnel = (
  method,
  path,
  tunnelId,
  {
    headers = {},
    body,
    timeoutMs = 10000,
    expectSseChunk = false,
    expectedSseText,
    returnBuffer = false,
    targetHost = '127.0.0.1',
  } = {},
) =>
  new Promise((resolve, reject) => {
    const upstream = new URL(workerHost)
    const mergedHeaders = {
      ...headers,
      'x-localrun-tunnel-id': tunnelId,
    }
    const req = http.request(
      {
        host: upstream.hostname,
        port: Number(upstream.port || 80),
        method,
        path,
        timeout: timeoutMs,
        headers: mergedHeaders,
        lookup: (...args) => {
          const opts = args.length >= 3 ? args[1] : undefined
          const cb = args[args.length - 1]
          if (opts && typeof opts === 'object' && opts.all) {
            cb(null, [{ address: targetHost, family: 4 }])
            return
          }
          cb(null, targetHost, 4)
        },
      },
      async (res) => {
        try {
          if (expectSseChunk) {
            const sseData = await waitForSseData(res, 7000, expectedSseText)
            resolve({ status: res.statusCode || 0, headers: res.headers, text: sseData })
            req.destroy()
            return
          }

          if (returnBuffer) {
            const data = await readAllBuffer(res)
            resolve({ status: res.statusCode || 0, headers: res.headers, data })
            return
          }

          const text = await readAll(res)
          resolve({ status: res.statusCode || 0, headers: res.headers, text })
        } catch (e) {
          reject(e)
        }
      },
    )

    req.on('timeout', () => req.destroy(new Error('request timeout')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })

const localApp = http.createServer((req, res) => {
  if (req.url === '/plain') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('plain-ok')
    return
  }

  if (req.url === '/html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><body><h1>html-ok</h1></body></html>')
    return
  }

  if (req.url === '/binary') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(binaryPayload)
    return
  }

  if (req.url === '/binary-echo' && req.method === 'POST') {
    const chunks = []
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'x-binary-length': String(body.length),
      })
      res.end(body)
    })
    return
  }

  if (req.url === '/sse') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.end('event: sse-ok\ndata: sse-ok\n\n')
    return
  }

  if (req.url === '/sse-binary' && req.method === 'POST') {
    const chunks = []
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const isValid = body.equals(binaryPayload)
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.end(`event: sse-binary-ok\ndata: ${isValid ? 'sse-binary-ok' : 'sse-binary-ng'}\n\n`)
    })
    return
  }

  if (req.url === '/mcp' && req.method === 'POST') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.end('event: streamable-http-ok\ndata: streamable-http-ok\n\n')
    return
  }

  if (req.url === '/mcp-binary' && req.method === 'POST') {
    const chunks = []
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const isValid = body.equals(binaryPayload)
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.end(
        `event: streamable-http-binary-ok\ndata: ${isValid ? 'streamable-http-binary-ok' : 'streamable-http-binary-ng'}\n\n`,
      )
    })
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not-found')
})

let tunnel
try {
  localApp.listen(localPort)
  await once(localApp, 'listening')

  tunnel = await localrun({
    port: localPort,
    host: workerHost,
    timeout: 15000,
    sseTimeout: 3600000,
    maxReconnectAttempts: 10,
  })

  if (!tunnel.clientId) {
    throw new Error('Tunnel clientId missing')
  }

  const tunnelHost = `${tunnel.clientId}.${workerBaseDomain}`
  await waitForTunnelOnline(tunnel.clientId, 15000)

  const plain = await requestViaTunnel('GET', '/plain', tunnel.clientId)
  if (plain.status !== 200 || !plain.text.includes('plain-ok')) {
    throw new Error(`plain failed: status=${plain.status} body=${plain.text}`)
  }

  const html = await requestViaTunnel('GET', '/html', tunnel.clientId)
  if (html.status !== 200 || !html.text.includes('html-ok')) {
    throw new Error(`html failed: status=${html.status} body=${html.text}`)
  }

  const binary = await requestViaTunnel('GET', '/binary', tunnel.clientId, {
    returnBuffer: true,
  })
  const binaryContentType = String(binary.headers['content-type'] || '').toLowerCase()
  if (
    binary.status !== 200 ||
    !binaryContentType.includes('application/octet-stream') ||
    !Buffer.isBuffer(binary.data) ||
    !binary.data.equals(binaryPayload)
  ) {
    throw new Error(
      `binary failed: status=${binary.status} content-type=${binaryContentType} body=${Buffer.isBuffer(binary.data) ? binary.data.toString('hex') : String(binary.data)}`,
    )
  }

  const binaryEcho = await requestViaTunnel('POST', '/binary-echo', tunnel.clientId, {
    headers: { 'content-type': 'application/octet-stream' },
    body: binaryPayload,
    returnBuffer: true,
  })
  const binaryEchoContentType = String(binaryEcho.headers['content-type'] || '').toLowerCase()
  if (
    binaryEcho.status !== 200 ||
    !binaryEchoContentType.includes('application/octet-stream') ||
    !Buffer.isBuffer(binaryEcho.data) ||
    !binaryEcho.data.equals(binaryPayload)
  ) {
    throw new Error(
      `binary-echo failed: status=${binaryEcho.status} content-type=${binaryEchoContentType} body=${Buffer.isBuffer(binaryEcho.data) ? binaryEcho.data.toString('hex') : String(binaryEcho.data)}`,
    )
  }

  const sse = await requestViaTunnel('GET', '/sse', tunnel.clientId, {
    headers: { accept: 'text/event-stream', 'cache-control': 'no-cache' },
    timeoutMs: 30000,
    expectSseChunk: true,
    expectedSseText: 'sse-ok',
  })
  if (sse.status !== 200 || !sse.text.includes('sse-ok')) {
    throw new Error(`sse failed: status=${sse.status} chunk=${sse.text}`)
  }

  const sseBinary = await requestViaTunnel('POST', '/sse-binary', tunnel.clientId, {
    headers: {
      accept: 'text/event-stream',
      'cache-control': 'no-cache',
      'content-type': 'application/octet-stream',
    },
    timeoutMs: 30000,
    body: binaryPayload,
    expectSseChunk: true,
    expectedSseText: 'sse-binary-ok',
  })
  if (sseBinary.status !== 200 || !sseBinary.text.includes('sse-binary-ok')) {
    throw new Error(`sse-binary failed: status=${sseBinary.status} chunk=${sseBinary.text}`)
  }

  const streamable = await requestViaTunnel('POST', '/mcp', tunnel.clientId, {
    headers: {
      accept: 'text/event-stream',
      'cache-control': 'no-cache',
      'content-type': 'application/json',
    },
    timeoutMs: 30000,
    body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'ping' }),
    expectSseChunk: true,
    expectedSseText: 'streamable-http-ok',
  })
  if (streamable.status !== 200 || !streamable.text.includes('streamable-http-ok')) {
    throw new Error(`streamable-http failed: status=${streamable.status} chunk=${streamable.text}`)
  }

  const streamableBinary = await requestViaTunnel('POST', '/mcp-binary', tunnel.clientId, {
    headers: {
      accept: 'text/event-stream',
      'cache-control': 'no-cache',
      'content-type': 'application/octet-stream',
    },
    timeoutMs: 30000,
    body: binaryPayload,
    expectSseChunk: true,
    expectedSseText: 'streamable-http-binary-ok',
  })
  if (streamableBinary.status !== 200 || !streamableBinary.text.includes('streamable-http-binary-ok')) {
    throw new Error(`streamable-http-binary failed: status=${streamableBinary.status} chunk=${streamableBinary.text}`)
  }

  console.log('✅ local e2e content smoke passed')
  console.log(`worker: ${workerHost}`)
  console.log(`subdomain: ${tunnelHost}`)
  console.log(`url: ${tunnel.url}`)
} finally {
  if (tunnel) {
    await tunnel.gracefulShutdown().catch(() => tunnel.close())
  }
  localApp.close()
}
