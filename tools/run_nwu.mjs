import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cliPath = join(
  projectRoot,
  'deepseek-harness-master',
  'deepseek-harness-master',
  'apps',
  'cli',
  'lib',
  'bin.js',
)
const templatePath = join(projectRoot, 'nwu.cordis.yml')

const replacements = new Map([
  ['__NWU_GEORAG_PLUGIN__', pathToFileURL(join(projectRoot, 'dsh-georag', 'src', 'index.js')).href],
  ['__NWU_INTAKE_PLUGIN__', pathToFileURL(join(projectRoot, 'dsh-nwu-intake', 'src', 'index.js')).href],
])

let overlay = readFileSync(templatePath, 'utf8')
for (const [placeholder, value] of replacements) {
  if (!overlay.includes(placeholder)) throw new Error(`Missing overlay placeholder: ${placeholder}`)
  overlay = overlay.replaceAll(placeholder, value)
}

const tempDirectory = mkdtempSync(join(tmpdir(), 'nwu-'))
const overlayPath = join(tempDirectory, 'nwu.cordis.yml')
writeFileSync(overlayPath, overlay, 'utf8')

const args = process.argv.slice(2)
const command = args.shift() ?? 'web'
const child = spawn(process.execPath, [cliPath, command, '--patch', overlayPath, ...args], {
  cwd: projectRoot,
  stdio: 'inherit',
})

const cleanup = () => rmSync(tempDirectory, { recursive: true, force: true })
child.once('error', (error) => {
  cleanup()
  throw error
})
child.once('exit', (code, signal) => {
  cleanup()
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
