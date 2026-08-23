#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_NAME = 'dsh-attention'
export const DEFAULT_SOURCE = 'github:shaomingbo/dsh-attention#v0.1.0'

export function parseArgs(argv) {
  const result = { profile: 'web', source: process.env.DSH_ATTENTION_SOURCE || DEFAULT_SOURCE }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') result.profile = argv[++index]
    else if (arg === '--source') result.source = argv[++index]
    else if (arg === '--help' || arg === '-h') result.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!result.profile || !result.source) throw new Error('--profile and --source require values')
  return result
}

export function applyManifest(manifest, source) {
  const next = {
    ...manifest,
    dependencies: { ...(manifest.dependencies ?? {}) },
    dsh: {
      ...(manifest.dsh ?? {}),
      profile: {
        ...(manifest.dsh?.profile ?? {}),
        bundles: [...(manifest.dsh?.profile?.bundles ?? [])],
      },
    },
  }
  next.dependencies[PACKAGE_NAME] = source
  if (!next.dsh.profile.bundles.includes(PACKAGE_NAME)) {
    next.dsh.profile.bundles.push(PACKAGE_NAME)
  }
  return next
}

function runInstall(profileDir) {
  const attempts = [
    ['pnpm', ['install', '--ignore-scripts']],
    ['corepack', ['pnpm', 'install', '--ignore-scripts']],
  ]
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { cwd: profileDir, stdio: 'inherit' })
    if (!result.error && result.status === 0) return
    if (result.error?.code !== 'ENOENT') {
      throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
    }
  }
  throw new Error('pnpm is unavailable; install pnpm or enable it with corepack')
}

async function atomicWrite(path, content) {
  const temp = `${path}.dsh-attention.tmp`
  try {
    await writeFile(temp, content, 'utf8')
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(`Usage: ${PACKAGE_NAME} [--profile web] [--source ${DEFAULT_SOURCE}]\n\nInstalls the attention bundle into a DSH profile.`)
    return
  }

  const home = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
  const profileDir = join(home, 'profiles', options.profile)
  const packagePath = join(profileDir, 'package.json')
  const original = await readFile(packagePath, 'utf8')
  const next = applyManifest(JSON.parse(original), options.source)
  await atomicWrite(packagePath, `${JSON.stringify(next, null, 2)}\n`)
  try {
    runInstall(profileDir)
  } catch (error) {
    await atomicWrite(packagePath, original)
    throw error
  }

  console.log(`\nInstalled ${PACKAGE_NAME} into ${profileDir}`)
  console.log('Restart DSH and hard-refresh the Web page so the attention bundle enters the boot graph.')
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invoked) {
  main().catch((error) => {
    const script = fileURLToPath(import.meta.url)
    console.error(`${script}: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
