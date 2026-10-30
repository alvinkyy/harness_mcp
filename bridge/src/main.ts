import { start } from './app.ts'
import { harnessHome, loadConfig } from './config.ts'
import { hasSecrets, migrateSecrets } from './secrets.ts'

if (!hasSecrets()) {
  console.error('harness-mcp is not set up yet. Run: npm run setup')
  process.exit(1)
}

try {
  if (migrateSecrets()) console.log('secrets.json is now encrypted with Windows DPAPI (readable only by this Windows user on this PC).')
} catch (e) {
  console.error(`Could not read secrets.json: ${(e as Error).message}\nRun npm run setup to create new credentials.`)
  process.exit(1)
}

const config = loadConfig()
const running = await start(config)
console.log(`harness-mcp running
  MCP endpoint (point the tunnel here): http://127.0.0.1:${config.mcpPort}/mcp
  Address for chat apps:                ${config.publicUrl === 'auto' ? (config.tunnel.mode === 'quick' ? 'starting a quick tunnel — see the control page' : 'taken from your tunnel — see the control page') : config.publicUrl + '/mcp'}
  Control page (this PC only):          http://127.0.0.1:${config.controlPort}/
  Workspaces: ${config.workspaces.join(', ') || '(none — edit ' + harnessHome() + '\\config.json)'}`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await running.close()
    process.exit(0)
  })
}
