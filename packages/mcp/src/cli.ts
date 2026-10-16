/**
 * stave-mcp — the process Claude Code launches.
 *
 *   stave-mcp                 run the MCP server on stdio (what Claude Code does)
 *   stave-mcp pairing-code    print the code to paste into Stave → Settings → Claude Code
 *   stave-mcp reset-pairing   make a new code; any paired tab must pair again
 *
 * stdout belongs to the MCP protocol, so everything human-readable while
 * serving goes to stderr (Claude Code keeps it in its MCP logs).
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { StaveBridge } from './bridge'
import { pairingCode, resolveConfig } from './config'
import { SERVER_VERSION, createStaveMcpServer } from './server'

const HELP = `stave-mcp ${SERVER_VERSION} — lets Claude Code edit the songs and visuals in a Stave tab

Usage:
  stave-mcp                 run the MCP server on stdio (Claude Code starts it this way)
  stave-mcp pairing-code    print the pairing code for Stave → Settings → Claude Code
  stave-mcp reset-pairing   replace the pairing code (paired tabs must pair again)

Environment:
  STAVE_MCP_PORT     port on 127.0.0.1 (default 47883)
  STAVE_MCP_ORIGINS  comma-separated pages allowed to connect; "*" as the port
                     means any port (default: https://stave.live, http://localhost:*,
                     http://127.0.0.1:*, http://[::1]:*)
  STAVE_MCP_TOKEN    use this pairing token instead of the saved one
`

function log(message: string): void {
  process.stderr.write(`[stave-mcp] ${message}\n`)
}

async function serve(): Promise<void> {
  const config = resolveConfig()
  const code = pairingCode(config.port, config.token)
  const bridge = new StaveBridge({
    port: config.port,
    token: config.token,
    origins: config.origins,
    serverName: 'stave-mcp',
    serverVersion: SERVER_VERSION,
    log,
  })
  await bridge.start()
  log(`pairing code: ${code}`)

  const server = createStaveMcpServer(bridge, { pairingCode: () => pairingCode(bridge.status().port, config.token) })
  const transport = new StdioServerTransport()

  let closing = false
  const shutdown = async (): Promise<void> => {
    if (closing) return
    closing = true
    await bridge.close().catch(() => {})
    await server.close().catch(() => {})
    process.exit(0)
  }
  transport.onclose = () => void shutdown()
  process.stdin.on('end', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  await server.connect(transport)
}

async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0]
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP)
    return
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${SERVER_VERSION}\n`)
    return
  }
  if (command === 'pairing-code' || command === 'reset-pairing') {
    const config = resolveConfig(process.env, { resetToken: command === 'reset-pairing' })
    process.stdout.write(`${pairingCode(config.port, config.token)}\n`)
    if (config.tokenSource === 'file') process.stderr.write(`(saved in ${config.tokenFile})\n`)
    return
  }
  if (command !== undefined) {
    process.stderr.write(`unknown command "${command}"\n\n${HELP}`)
    process.exit(2)
  }
  await serve()
}

main(process.argv.slice(2)).catch((err) => {
  log(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
