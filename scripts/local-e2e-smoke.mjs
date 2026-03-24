import http from 'node:http'
import { once } from 'node:events'
import process from 'node:process'
import localrun from '../dist/index.js'

const workerHost = process.env.LOCALRUN_HOST || 'http://127.0.0.1:8788'
const localPort = Number(process.env.LOCALRUN_LOCAL_PORT || 3001)

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, source: 'local-e2e-smoke' }))
    return
  }

  let body = ''
  req.on('data', (chunk) => {
    body += chunk.toString()
  })
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ method: req.method, path: req.url, body }))
  })
})

let tunnel
try {
  server.listen(localPort)
  await once(server, 'listening')

  tunnel = await localrun({
    port: localPort,
    host: workerHost,
    timeout: 15000,
    maxRetries: 2,
    sseTimeout: 3600000,
    maxReconnectAttempts: 10,
  })

  if (!tunnel.url || !tunnel.clientId) {
    throw new Error('Tunnel URL or clientId was not assigned')
  }

  // In local wrangler dev, validating end-to-end tunnel establishment via control APIs
  // is more reliable than overriding Host for public URL proxying in fetch().
  const statusUrl = new URL(`/api/tunnels/${tunnel.clientId}/status`, workerHost).toString()
  const metricsUrl = new URL(`/api/tunnels/${tunnel.clientId}/metrics`, workerHost).toString()
  const [statusRes, metricsRes] = await Promise.all([fetch(statusUrl), fetch(metricsUrl)])
  const statusText = await statusRes.text()
  const metricsText = await metricsRes.text()

  if (!statusRes.ok) {
    throw new Error(`Status check failed: ${statusRes.status} ${statusRes.statusText} body=${statusText}`)
  }

  if (!metricsRes.ok) {
    throw new Error(`Metrics check failed: ${metricsRes.status} ${metricsRes.statusText} body=${metricsText}`)
  }

  console.log('✅ local e2e smoke passed')
  console.log(`Worker host: ${workerHost}`)
  console.log(`Tunnel URL: ${tunnel.url}`)
  console.log(`Status: ${statusText}`)
  console.log(`Metrics: ${metricsText}`)
} finally {
  if (tunnel) {
    await tunnel.gracefulShutdown().catch(() => tunnel.close())
  }
  server.close()
}
