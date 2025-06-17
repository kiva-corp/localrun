import * as child_process from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

describe('CLI (lr.ts)', () => {
  const cliPath = path.join(process.cwd(), 'dist', 'bin', 'lr.js')
  let testProcess: child_process.ChildProcess | null = null

  beforeEach(() => {
    // Ensure the CLI is built
    if (!fs.existsSync(cliPath)) {
      throw new Error(`CLI not built. Run 'npm run build' first. Expected: ${cliPath}`)
    }
  })

  afterEach(() => {
    if (testProcess) {
      testProcess.kill('SIGTERM')
      testProcess = null
    }
  })

  describe('command line arguments', () => {
    it('should show help when --help is provided', (done) => {
      const process = child_process.spawn('node', [cliPath, '--help'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let output = ''
      process.stdout.on('data', (data) => {
        output += data.toString()
      })

      process.on('close', (code) => {
        expect(code).to.equal(0)
        expect(output).to.include('Usage: lr --port')
        expect(output).to.include('--port')
        expect(output).to.include('--host')
        expect(output).to.include('--subdomain')
        done()
      })
    }).timeout(5000)

    it('should show version when --version is provided', (done) => {
      const process = child_process.spawn('node', [cliPath, '--version'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let output = ''
      process.stdout.on('data', (data) => {
        output += data.toString()
      })

      process.on('close', (code) => {
        expect(code).to.equal(0)
        expect(output.trim()).to.match(/^\d+\.\d+\.\d+/)
        done()
      })
    }).timeout(5000)

    it('should fail when no port is provided', (done) => {
      const process = child_process.spawn('node', [cliPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let errorOutput = ''
      process.stderr.on('data', (data) => {
        errorOutput += data.toString()
      })

      process.on('close', (code) => {
        expect(code).to.not.equal(0)
        expect(errorOutput).to.include('Missing required argument')
        done()
      })
    }).timeout(5000)

    it('should fail with invalid subdomain', (done) => {
      const process = child_process.spawn('node', [cliPath, '--port', '3000', '--subdomain', 'invalid-subdomain'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let errorOutput = ''
      process.stderr.on('data', (data) => {
        errorOutput += data.toString()
      })

      process.on('close', (code) => {
        expect(code).to.not.equal(0)
        expect(errorOutput).to.include('Subdomain must be alphanumeric and exactly 10 characters')
        done()
      })
    }).timeout(5000)

    it('should accept valid arguments', (done) => {
      // Use a non-existent port to quickly fail the connection
      const childProcess = child_process.spawn(
        'node',
        [cliPath, '--port', '99999', '--host', 'https://httpbin.org', '--timeout', '1000'],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )

      let output = ''

      childProcess.stdout.on('data', (data) => {
        output += data.toString()
      })

      childProcess.stderr.on('data', (_data) => {
        // Ignore stderr for this test
      })

      // Kill the process after a short time since we expect it to fail
      setTimeout(() => {
        childProcess.kill('SIGTERM')
      }, 2000)

      childProcess.on('close', () => {
        // Should start and show the starting message
        expect(output).to.include('Starting localrun client')
        done()
      })
    }).timeout(5000)
  })

  describe('HTTPS certificate validation', () => {
    it('should fail when HTTPS is enabled but cert files are missing', (done) => {
      const process = child_process.spawn(
        'node',
        [
          cliPath,
          '--port',
          '3000',
          '--local-https',
          '--local-cert',
          '/nonexistent/cert.pem',
          '--local-key',
          '/nonexistent/key.pem',
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )

      let errorOutput = ''
      process.stderr.on('data', (data) => {
        errorOutput += data.toString()
      })

      process.on('close', (code) => {
        expect(code).to.equal(1)
        expect(errorOutput).to.include('Cannot access SSL certificate files') // Match actual error message
        done()
      })
    }).timeout(5000)

    it('should accept allow-invalid-cert flag', (done) => {
      const process = child_process.spawn(
        'node',
        [cliPath, '--port', '99999', '--local-https', '--allow-invalid-cert', '--timeout', '1000'],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )

      let output = ''
      process.stdout.on('data', (data) => {
        output += data.toString()
      })

      // Kill the process after a short time
      setTimeout(() => {
        process.kill('SIGTERM')
      }, 2000)

      process.on('close', () => {
        expect(output).to.include('Starting localrun client')
        done()
      })
    }).timeout(5000)
  })

  describe('environment variables', () => {
    it('should accept environment variables', (done) => {
      const env = {
        ...global.process.env,
        LR_PORT: '3000', // Use LR_PORT with LR_ prefix
        LR_HOST: 'https://httpbin.org', // Use LR_HOST with LR_ prefix
        LR_TIMEOUT: '1000', // Use LR_TIMEOUT with LR_ prefix
      }

      const childProcess = child_process.spawn('node', [cliPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      })

      let output = ''
      childProcess.stdout.on('data', (data) => {
        output += data.toString()
      })

      // Kill the process after a short time
      setTimeout(() => {
        childProcess.kill('SIGTERM')
      }, 2000)

      childProcess.on('close', () => {
        expect(output).to.include('Starting localrun client')
        done()
      })
    }).timeout(5000)
  })

  describe('debug mode', () => {
    it('should enable debug logging when DEBUG env var is set', (done) => {
      const env = {
        ...global.process.env,
        DEBUG: 'localrun:*',
      }

      const childProcess = child_process.spawn('node', [cliPath, '--port', '99999', '--timeout', '1000'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      })

      let output = ''
      childProcess.stdout.on('data', (data) => {
        output += data.toString()
      })

      // Kill the process after a short time
      setTimeout(() => {
        childProcess.kill('SIGTERM')
      }, 2000)

      childProcess.on('close', () => {
        expect(output).to.include('Debug logging enabled')
        done()
      })
    }).timeout(5000)
  })

  describe('signal handling', () => {
    it('should handle SIGINT gracefully', (done) => {
      const childProcess = child_process.spawn('node', [cliPath, '--port', '99999', '--timeout', '1000'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      // Send SIGINT after a short delay
      setTimeout(() => {
        childProcess.kill('SIGINT')
      }, 1000)

      childProcess.on('close', (code) => {
        // Should exit gracefully (code 0 or exit due to signal)
        expect([0, null]).to.include(code)
        done()
      })
    }).timeout(5000)
  })

  describe('argument parsing edge cases', () => {
    it('should handle numeric arguments correctly', (done) => {
      const process = child_process.spawn(
        'node',
        [cliPath, '--port', '8080', '--timeout', '5000', '--max-retries', '3'],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )

      let output = ''
      process.stdout.on('data', (data) => {
        output += data.toString()
      })

      setTimeout(() => {
        process.kill('SIGTERM')
      }, 1000)

      process.on('close', () => {
        expect(output).to.include('Starting localrun client')
        done()
      })
    }).timeout(5000)

    it('should handle boolean flags correctly', (done) => {
      const process = child_process.spawn('node', [cliPath, '--port', '8080', '--print-requests', '--open'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let output = ''
      process.stdout.on('data', (data) => {
        output += data.toString()
      })

      setTimeout(() => {
        process.kill('SIGTERM')
      }, 1000)

      process.on('close', () => {
        expect(output).to.include('Starting localrun client')
        done()
      })
    }).timeout(5000)
  })
})
