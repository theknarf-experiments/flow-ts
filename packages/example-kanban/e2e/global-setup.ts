// Spawn the WebTransport sync hub for the test run. It listens on
// QUIC/UDP only, which Playwright's webServer readiness probe (TCP)
// can't detect — so we watch its stdout for the "listening" line
// instead. If port 4433 is already taken we assume a dev server is
// running and reuse it, mirroring webServer's reuseExistingServer.

import { type ChildProcess, spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

export default async function globalSetup(): Promise<() => void> {
  const proc: ChildProcess = spawn('pnpm', ['exec', 'tsx', 'src/server/main.ts'], {
    cwd: PKG_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  await new Promise<void>((resolve, reject) => {
    let output = ''
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(
      () => done(() => reject(new Error(`sync server did not start:\n${output}`))),
      30_000,
    )
    const onData = (d: Buffer) => {
      output += d.toString()
      if (output.includes('listening on')) done(resolve)
      if (output.includes('EADDRINUSE')) {
        console.log('[e2e] port 4433 in use — reusing the running sync server')
        done(resolve)
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('exit', (code) => {
      if (!output.includes('EADDRINUSE'))
        done(() => reject(new Error(`sync server exited with ${code}:\n${output}`)))
    })
  })

  return () => {
    proc.kill()
  }
}
