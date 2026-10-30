// npm run setup  — create the passphrase + authenticator secret and a starter config
// npm run status — show configuration and connected clients

import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { canonical } from './scope.ts'
import { harnessHome, homePath, loadConfig, saveConfig } from './config.ts'
import { createSecrets, hasSecrets } from './secrets.ts'
import { Store } from './store.ts'

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (hidden) {
      const write = (rl as unknown as { _writeToOutput: (s: string) => void })
      write._writeToOutput = (s: string) => {
        if (s.startsWith(question)) process.stdout.write(question)
        else if (s.includes('\n') || s.includes('\r')) process.stdout.write('\n')
      }
    }
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function setup(): Promise<void> {
  console.log(`harness-mcp setup (data folder: ${harnessHome()})\n`)
  if (hasSecrets()) {
    const again = await ask('Credentials already exist. Replace them? This disconnects nothing until tokens expire. [y/N] ')
    if (again.toLowerCase() !== 'y') return void console.log('Kept existing credentials.')
  }
  let pass = ''
  for (;;) {
    pass = await ask('Choose a passphrase (12+ characters): ', true)
    const confirm = await ask('Repeat passphrase: ', true)
    if (pass.length >= 12 && pass === confirm) break
    console.log('Passphrases must match and be at least 12 characters.\n')
  }
  const { totpSecret, otpauth } = createSecrets(pass)
  console.log(`\nAdd this to your authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…):
  Account: harness-mcp
  Secret key: ${totpSecret}
  Or as a URI: ${otpauth}
Keep it on this PC only — don't paste it into any chat.\n`)

  const config = loadConfig()
  const quick = await ask(`Let harness-mcp start a Cloudflare quick tunnel for you? Its address changes on every start and is shown on the control page. [${config.tunnel.mode === 'quick' ? 'Y/n' : 'y/N'}] `)
  if (quick) config.tunnel.mode = quick.toLowerCase().startsWith('y') ? 'quick' : 'none'
  const url = await ask(`Fixed public URL, only if you have a named tunnel on your own domain (blank = detect automatically) [${config.publicUrl}]: `)
  if (url) config.publicUrl = url === 'auto' ? 'auto' : url.replace(/\/+$/, '').replace(/\/mcp$/, '')
  const ws = await ask('A project folder the agents may work in (absolute path, blank to skip): ')
  if (ws) {
    if (!existsSync(ws)) console.log(`  Note: ${ws} does not exist yet.`)
    const p = canonical(ws)
    if (!config.workspaces.includes(p)) config.workspaces.push(p)
  }
  saveConfig(config)
  console.log(`\nSaved ${homePath('config.json')}. Edit it to add read roots, workspaces, test recipes and allowed commands.
Start the server with: npm start`)
}

function status(): void {
  const config = loadConfig()
  const store = new Store()
  console.log(JSON.stringify({ home: harnessHome(), setUp: hasSecrets(), mode: store.state.mode, publicUrl: config.publicUrl, readRoots: config.readRoots, workspaces: config.workspaces, clients: Object.values(store.state.clients).map((c) => ({ name: c.client_name, origin: c.origin, approved: c.approved, profile: c.profile, lastSeen: c.lastSeen })) }, null, 2))
}

const cmd = process.argv[2]
if (cmd === 'setup') await setup()
else if (cmd === 'status') status()
else console.log('Usage: node src/cli.ts setup | status')
