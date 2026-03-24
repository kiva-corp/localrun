import * as child_process from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as http from 'node:http'
import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

describe('CLI (lr.ts)', () => {
  const cliPath = path.join(process.cwd(), 'dist', 'bin', 'lr.js')
  let testProcess: child_process.ChildProcess | null = null

  function spawnCli(args: string[], options: child_process.SpawnOptions = {}) {
    return child_process.spawn('node', [cliPath, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options,
    })
  }

  function waitForClose(child: child_process.ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
  }

  function collectOutput(child: child_process.ChildProcess) {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (data) => {
      stdout += data.toString()
    })
    child.stderr?.on('data', (data) => {
      stderr += data.toString()
    })
    return {
      getStdout: () => stdout,
      getStderr: () => stderr,
    }
  }

  function waitForStdoutContains(child: child_process.ChildProcess, expected: string, timeoutMs = 2000): Promise<void> {
    return new Promise((resolve, reject) => {
      let output = ''
      const onData = (data: Buffer) => {
        output += data.toString()
        if (output.includes(expected)) {
          cleanup()
          resolve()
        }
      }
      const onClose = () => {
        cleanup()
        reject(new Error(`Process closed before stdout contained "${expected}". Output:\n${output}`))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`Timed out waiting for stdout to contain "${expected}". Output:\n${output}`))
      }, timeoutMs)

      const cleanup = () => {
        clearTimeout(timer)
        child.stdout?.off('data', onData)
        child.off('close', onClose)
      }

      child.stdout?.on('data', onData)
      child.once('close', onClose)
    })
  }

  async function terminateAndWait(child: child_process.ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
    if (child.killed || child.exitCode !== null) {
      return waitForClose(child)
    }
    child.kill(signal)
    return waitForClose(child)
  }

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
    it('should show help when --help is provided', async () => {
      const process = spawnCli(['--help'])
      const output = collectOutput(process)
      const { code } = await waitForClose(process)
      expect(code).to.equal(0)
      expect(output.getStdout()).to.include('Usage: lr --port')
      expect(output.getStdout()).to.include('--port')
      expect(output.getStdout()).to.include('--host')
      expect(output.getStdout()).to.include('--subdomain')
    }).timeout(5000)

    it('should show version when --version is provided', async () => {
      const process = spawnCli(['--version'])
      const output = collectOutput(process)
      const { code } = await waitForClose(process)
      expect(code).to.equal(0)
      expect(output.getStdout().trim()).to.match(/^\d+\.\d+\.\d+/)
    }).timeout(5000)

    it('should fail when no port is provided', async () => {
      const process = spawnCli([])
      const output = collectOutput(process)
      const { code } = await waitForClose(process)
      expect(code).to.not.equal(0)
      expect(output.getStderr()).to.include('Missing required argument')
    }).timeout(5000)

    it('should fail with invalid subdomain', async () => {
      const process = spawnCli(['--port', '3000', '--subdomain', 'invalid-subdomain'])
      const output = collectOutput(process)
      const { code } = await waitForClose(process)
      expect(code).to.not.equal(0)
      expect(output.getStderr()).to.include('Subdomain must be alphanumeric and exactly 10 characters')
    }).timeout(5000)

    it('should accept valid arguments', async () => {
      const childProcess = spawnCli(['--port', '99999', '--host', 'https://httpbin.org', '--timeout', '1000'])
      const output = collectOutput(childProcess)
      await waitForStdoutContains(childProcess, 'Starting localrun client')
      await terminateAndWait(childProcess)
      expect(output.getStdout()).to.include('Starting localrun client')
    }).timeout(5000)
  })

  describe('HTTPS certificate validation', () => {
    it('should fail when HTTPS is enabled but cert files are missing', async () => {
      const process = spawnCli([
        '--port',
        '3000',
        '--local-https',
        '--local-cert',
        '/nonexistent/cert.pem',
        '--local-key',
        '/nonexistent/key.pem',
      ])
      const output = collectOutput(process)
      const { code } = await waitForClose(process)
      expect(code).to.equal(1)
      expect(output.getStderr()).to.include('Cannot access SSL certificate files')
    }).timeout(5000)

    it('should accept allow-invalid-cert flag', async () => {
      const process = spawnCli(['--port', '99999', '--local-https', '--allow-invalid-cert', '--timeout', '1000'])
      const output = collectOutput(process)
      await waitForStdoutContains(process, 'Starting localrun client')
      await terminateAndWait(process)
      expect(output.getStdout()).to.include('Starting localrun client')
    }).timeout(5000)
  })

  describe('environment variables', () => {
    it('should accept environment variables', async () => {
      const env = {
        ...global.process.env,
        LR_PORT: '3000', // Use LR_PORT with LR_ prefix
        LR_HOST: 'https://httpbin.org', // Use LR_HOST with LR_ prefix
        LR_TIMEOUT: '1000', // Use LR_TIMEOUT with LR_ prefix
      }

      const childProcess = spawnCli([], {
        env,
      })

      const output = collectOutput(childProcess)
      await waitForStdoutContains(childProcess, 'Starting localrun client')
      await terminateAndWait(childProcess)
      expect(output.getStdout()).to.include('Starting localrun client')
    }).timeout(5000)
  })

  describe('debug mode', () => {
    it('should enable debug logging when DEBUG env var is set', async () => {
      const env = {
        ...global.process.env,
        DEBUG: 'localrun:*',
      }

      const childProcess = spawnCli(['--port', '99999', '--timeout', '1000'], {
        env,
      })

      const output = collectOutput(childProcess)
      await waitForStdoutContains(childProcess, 'Debug logging enabled')
      await terminateAndWait(childProcess)
      expect(output.getStdout()).to.include('Debug logging enabled')
    }).timeout(5000)
  })

  describe('signal handling', () => {
    it('should handle SIGINT gracefully', async () => {
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('ok')
      })
      await new Promise<void>((resolve) => server.listen(0, resolve))
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0

      const childProcess = spawnCli(['--port', String(port), '--host', 'http://10.255.255.1'])
      const output = collectOutput(childProcess)

      await waitForStdoutContains(childProcess, 'Starting localrun client')
      const { code, signal } = await terminateAndWait(childProcess, 'SIGINT')

      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })

      expect([0, null]).to.include(code)
      expect([null, 'SIGINT']).to.include(signal)
      expect(output.getStdout()).to.include('Starting localrun client')
    }).timeout(5000)
  })

  describe('argument parsing edge cases', () => {
    it('should handle numeric arguments correctly', async () => {
      const process = spawnCli([
        '--port',
        '8080',
        '--timeout',
        '5000',
        '--max-retries',
        '3',
        '--max-reconnect-attempts',
        '100',
        '--sse-timeout',
        '7200000',
      ])
      const output = collectOutput(process)
      await waitForStdoutContains(process, 'Starting localrun client')
      await terminateAndWait(process)
      expect(output.getStdout()).to.include('Starting localrun client')
    }).timeout(5000)

    it('should handle boolean flags correctly', async () => {
      const process = spawnCli(['--port', '8080', '--print-requests', '--open'])
      const output = collectOutput(process)
      await waitForStdoutContains(process, 'Starting localrun client')
      await terminateAndWait(process)
      expect(output.getStdout()).to.include('Starting localrun client')
    }).timeout(5000)
  })
})
