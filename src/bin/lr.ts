#!/usr/bin/env node

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import openurl from 'openurl'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import localrun from '../index.js'

// Get package.json version (ESM compatible)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const packagePath = path.join(__dirname, '..', '..', 'package.json')
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
const { version } = packageJson

const args = yargs(hideBin(process.argv))
  .usage('Usage: lr --port [num] <options>')
  .env('LR') // Use LR_ prefix for environment variables
  .option('p', {
    alias: 'port',
    describe: 'Internal HTTP server port',
    type: 'number',
    demandOption: true,
  })
  .option('h', {
    alias: 'host',
    describe: 'Upstream server providing forwarding',
    default: 'https://localrun.stream',
    type: 'string',
  })
  .option('s', {
    alias: 'subdomain',
    describe: 'Request this subdomain (alphanumeric, exactly 10 characters)',
    type: 'string',
    coerce: (subdomain: string) => {
      if (subdomain && (!/^[a-zA-Z0-9]+$/.test(subdomain) || subdomain.length !== 10)) {
        throw new Error('Subdomain must be alphanumeric and exactly 10 characters')
      }
      return subdomain
    },
  })
  .option('l', {
    alias: 'local-host',
    describe: 'Tunnel traffic to this host instead of localhost, override Host header to this host',
    type: 'string',
  })
  .option('local-https', {
    describe: 'Tunnel traffic to a local HTTPS server',
    type: 'boolean',
  })
  .option('local-cert', {
    describe: 'Path to certificate PEM file for local HTTPS server',
    type: 'string',
  })
  .option('local-key', {
    describe: 'Path to certificate key file for local HTTPS server',
    type: 'string',
  })
  .option('local-ca', {
    describe: 'Path to certificate authority file for self-signed certificates',
    type: 'string',
  })
  .option('allow-invalid-cert', {
    describe: 'Disable certificate checks for your local HTTPS server (ignore cert/key/ca options)',
    type: 'boolean',
  })
  .option('timeout', {
    describe: 'Request timeout in milliseconds (default: 15000)',
    type: 'number',
    default: 15000,
  })
  .option('max-retries', {
    describe: 'Maximum number of retry attempts for failed requests (default: 2)',
    type: 'number',
    default: 2,
  })
  .options('o', {
    alias: 'open',
    describe: 'Opens the tunnel URL in your browser',
    type: 'boolean',
  })
  .option('print-requests', {
    describe: 'Print basic request info',
    type: 'boolean',
  })
  .help('help', 'Show this help and exit')
  .version(version)

function formatTimestamp(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19)
}

function formatRequestLog(info: { method: string; path: string; headers?: Record<string, string> }): string {
  const timestamp = formatTimestamp()
  const userAgent = info.headers?.['user-agent'] || 'Unknown'
  const shortUserAgent = userAgent.length > 50 ? `${userAgent.substring(0, 47)}...` : userAgent

  return `[${timestamp}] ${info.method.padEnd(4)} ${info.path} - ${shortUserAgent}`
}

;(async () => {
  const argv = await args.argv

  // Validate SSL certificate options
  if (argv['local-https'] && !argv['allow-invalid-cert']) {
    if (!argv['local-cert'] || !argv['local-key']) {
      console.error(
        'Error: When using --local-https, you must specify --local-cert and --local-key, or use --allow-invalid-cert',
      )
      process.exit(1)
    }

    // Check if certificate files exist
    try {
      fs.accessSync(argv['local-cert'] as string, fs.constants.R_OK)
      fs.accessSync(argv['local-key'] as string, fs.constants.R_OK)

      if (argv['local-ca']) {
        fs.accessSync(argv['local-ca'] as string, fs.constants.R_OK)
      }
    } catch (error) {
      console.error('Error: Cannot access SSL certificate files:', error)
      process.exit(1)
    }
  }

  console.log(`🔄 Starting localrun client v${version}`)

  if (argv.subdomain) {
    console.log(`Requesting subdomain: ${argv.subdomain}`)
  }

  // Enable debug logging if DEBUG environment variable is set
  if (process.env.DEBUG) {
    console.log(`Debug logging enabled: ${process.env.DEBUG}`)
  }

  try {
    const tunnel = await localrun(argv.port as number, {
      host: argv.host as string,
      subdomain: argv.subdomain as string,
      localHost: argv['local-host'] as string,
      localHttps: argv['local-https'] as boolean,
      localCert: argv['local-cert'] as string,
      localKey: argv['local-key'] as string,
      localCa: argv['local-ca'] as string,
      allowInvalidCert: argv['allow-invalid-cert'] as boolean,
      timeout: argv.timeout as number,
      maxRetries: argv['max-retries'] as number,
    })

    tunnel.on('url', (url: string) => {
      console.log('\n✅ Tunnel established!')
      console.log(`🌐 Public URL: ${url}`)
      console.log(
        `🏠 Local URL:  http${argv['local-https'] ? 's' : ''}://${argv['local-host'] || 'localhost'}:${argv.port}`,
      )
      console.log('\nPress Ctrl+C to stop the tunnel\n')

      if (argv.open) {
        console.log('Opening URL in browser...')
        openurl.open(url)
      }
    })

    if (argv['print-requests']) {
      tunnel.on('request', (info: { method: string; path: string; headers?: Record<string, string> }) => {
        console.log(formatRequestLog(info))
      })
    }

    // Graceful shutdown handlers
    let isShuttingDown = false
    const connectionStartTime = Date.now()

    tunnel.on('url', () => {
      const connectionTime = Date.now() - connectionStartTime
      console.log(`⏱️ Connection established in ${connectionTime}ms`)
    })

    tunnel.on('close', () => {
      if (!isShuttingDown) {
        console.log('\n❌ Tunnel closed')
      }
    })

    tunnel.on('error', (err: Error) => {
      if (isShuttingDown) return

      console.error('\n❌ Tunnel error:', err.message)
      if (process.env.DEBUG) {
        console.error('Error stack:', err.stack)
      }

      // エラーの種類に応じて詳細なメッセージを表示
      if (err.message.includes('ECONNREFUSED')) {
        console.error('💡 Connection refused. Check if your local server is running on port', argv.port)
      } else if (err.message.includes('ENOTFOUND')) {
        console.error('💡 DNS resolution failed. Check your network connectivity.')
      } else if (err.message.includes('timeout')) {
        console.error('💡 Request timeout. Try increasing the timeout value with --timeout option.')
      } else if (err.message.includes('Maximum reconnection attempts')) {
        console.error('💡 Connection lost. The tunnel service may be temporarily unavailable.')
      }

      console.error('💡 Troubleshooting tips:')
      console.error('   1. Check if your local server is running on port', argv.port)
      console.error('   2. Verify network connectivity')
      console.error('   3. Try running with DEBUG=localrun:* for detailed logs')
      console.error('   4. Consider adjusting timeout settings')
      process.exit(1)
    })

    const shutdown = async () => {
      if (isShuttingDown) return
      isShuttingDown = true

      console.log('\n🛑 Shutting down tunnel...')

      try {
        // Graceful shutdownを試行
        if (tunnel.gracefulShutdown) {
          await tunnel.gracefulShutdown()
        } else {
          tunnel.close()
        }
        console.log('✅ Tunnel closed gracefully')
      } catch (error) {
        console.error('❌ Error during shutdown:', error)
        tunnel.close()
      }

      // Pause stdin to prevent read errors during shutdown
      process.stdin.pause()
      setTimeout(() => process.exit(0), 1000)
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)

    // Handle stdin errors gracefully
    process.stdin.on('error', (err) => {
      // Ignore EIO errors during shutdown
      const nodeError = err as NodeJS.ErrnoException
      if (nodeError.code !== 'EIO') {
        console.error('Stdin error:', err)
      }
    })

    // Keep the process alive
    process.stdin.resume()
  } catch (error) {
    console.error('❌ Failed to start tunnel:')
    if (error instanceof Error) {
      console.error(`   ${error.message}`)
    } else {
      console.error(`   ${error}`)
    }
    process.exit(1)
  }
})()
