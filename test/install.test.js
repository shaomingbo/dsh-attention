import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  applyManifest,
  DEFAULT_SOURCE,
  describeStatus,
  PACKAGE_NAME,
  parseArgs,
  removeManifest,
  run,
} from '../bin/install.js'

test('parseArgs accepts profile and source overrides', () => {
  assert.deepEqual(parseArgs([]), { command: 'install', profile: 'web', source: DEFAULT_SOURCE })
  assert.deepEqual(parseArgs(['--profile', 'lab', '--source', 'link:../dsh-attention']), {
    command: 'install',
    profile: 'lab',
    source: 'link:../dsh-attention',
  })
  assert.throws(() => parseArgs(['--nope']), /unknown argument/)
})

test('parseArgs accepts install, status, and uninstall commands', () => {
  assert.equal(parseArgs(['status']).command, 'status')
  assert.equal(parseArgs(['uninstall']).command, 'uninstall')
  assert.equal(parseArgs(['install']).command, 'install')
  assert.equal(parseArgs([]).command, 'install')
  assert.throws(() => parseArgs(['status', 'install']), /unexpected argument/)
})

test('applyManifest is idempotent and keeps existing bundles', () => {
  const first = applyManifest({
    dependencies: { 'dsh-file-picker': 'link:/tmp/picker' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', 'dsh-file-picker'] } },
  }, 'link:/tmp/attention')
  const second = applyManifest(first, 'github:shaomingbo/dsh-attention#v0.1.3')
  assert.equal(first.dependencies[PACKAGE_NAME], 'link:/tmp/attention')
  assert.deepEqual(first.dsh.profile.bundles, [
    '@deepseek-ai/dsh-web-app',
    'dsh-file-picker',
    PACKAGE_NAME,
  ])
  assert.equal(second.dsh.profile.bundles.filter((name) => name === PACKAGE_NAME).length, 1)
  assert.equal(second.dependencies[PACKAGE_NAME], 'github:shaomingbo/dsh-attention#v0.1.3')
})

test('removeManifest strips the dependency and bundle entry, and is idempotent', () => {
  const installed = applyManifest({
    dependencies: { 'dsh-file-picker': 'link:/tmp/picker' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', 'dsh-file-picker'] } },
  }, DEFAULT_SOURCE)
  const removed = removeManifest(installed)
  assert.ok(!('dsh-attention' in removed.dependencies))
  assert.equal(removed.dependencies['dsh-file-picker'], 'link:/tmp/picker')
  assert.deepEqual(removed.dsh.profile.bundles, ['@deepseek-ai/dsh-web-app', 'dsh-file-picker'])
  const again = removeManifest(removed)
  assert.deepEqual(again, removed)
  assert.deepEqual(removeManifest({}), {})
})

test('describeStatus reports dependency and bundle membership', () => {
  assert.deepEqual(describeStatus({}), { installed: false, source: null, bundled: false })
  assert.deepEqual(
    describeStatus({ dependencies: { [PACKAGE_NAME]: DEFAULT_SOURCE } }),
    { installed: false, source: DEFAULT_SOURCE, bundled: false },
  )
  const installed = applyManifest({}, DEFAULT_SOURCE)
  assert.deepEqual(describeStatus(installed), { installed: true, source: DEFAULT_SOURCE, bundled: true })
})

async function makeProfile() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-attention-test-'))
  const profileDir = join(home, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } },
  }, null, 2)}\n`)
  return { home, profileDir }
}

test('install, repeat install, status, and uninstall work end to end', async () => {
  const { home, profileDir } = await makeProfile()
  try {
    const packagePath = join(profileDir, 'package.json')
    const installedCalls = []
    const installDeps = async (dir) => { installedCalls.push(dir) }

    await run([], { home, installDeps })
    let manifest = JSON.parse(await readFile(packagePath, 'utf8'))
    assert.equal(describeStatus(manifest).installed, true)
    assert.equal(installedCalls.length, 1)

    await run(['--source', 'link:/tmp/attention'], { home, installDeps })
    manifest = JSON.parse(await readFile(packagePath, 'utf8'))
    assert.equal(manifest.dependencies[PACKAGE_NAME], 'link:/tmp/attention')
    assert.equal(manifest.dsh.profile.bundles.filter((n) => n === PACKAGE_NAME).length, 1)
    assert.equal(installedCalls.length, 2)

    await run(['status'], { home, installDeps })
    assert.equal(process.exitCode, undefined)
    process.exitCode = undefined

    await run(['uninstall'], { home, installDeps })
    manifest = JSON.parse(await readFile(packagePath, 'utf8'))
    assert.equal(describeStatus(manifest).installed, false)
    assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-web-app'])

    await run(['uninstall'], { home, installDeps })
    manifest = JSON.parse(await readFile(packagePath, 'utf8'))
    assert.equal(describeStatus(manifest).installed, false)
    assert.equal(installedCalls.length, 3)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('uninstall on a never-installed profile is a no-op', async () => {
  const { home, profileDir } = await makeProfile()
  try {
    const packagePath = join(profileDir, 'package.json')
    const before = await readFile(packagePath, 'utf8')
    let called = false
    await run(['uninstall'], { home, installDeps: async () => { called = true } })
    assert.equal(called, false)
    assert.equal(await readFile(packagePath, 'utf8'), before)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('install restores the manifest when dependency installation fails', async () => {
  const { home, profileDir } = await makeProfile()
  try {
    const packagePath = join(profileDir, 'package.json')
    const before = await readFile(packagePath, 'utf8')
    await assert.rejects(
      () => run([], {
        home,
        installDeps: async () => { throw new Error('pnpm boom') },
      }),
      /pnpm boom/,
    )
    assert.equal(await readFile(packagePath, 'utf8'), before)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('uninstall restores the manifest when dependency installation fails', async () => {
  const { home, profileDir } = await makeProfile()
  try {
    const packagePath = join(profileDir, 'package.json')
    await run([], { home, installDeps: async () => {} })
    const installed = await readFile(packagePath, 'utf8')
    await assert.rejects(
      () => run(['uninstall'], {
        home,
        installDeps: async () => { throw new Error('pnpm boom') },
      }),
      /pnpm boom/,
    )
    assert.equal(await readFile(packagePath, 'utf8'), installed)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a malformed profile manifest fails without being modified', async () => {
  const { home, profileDir } = await makeProfile()
  try {
    const packagePath = join(profileDir, 'package.json')
    await writeFile(packagePath, '{ not json')
    for (const argv of [[], ['status'], ['uninstall']]) {
      await assert.rejects(() => run(argv, { home, installDeps: async () => {} }), SyntaxError)
    }
    assert.equal(await readFile(packagePath, 'utf8'), '{ not json')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('invalid arguments are rejected', async () => {
  const { home } = await makeProfile()
  try {
    for (const argv of [['--nope'], ['status', 'install'], ['--profile']]) {
      await assert.rejects(() => run(argv, { home, installDeps: async () => {} }))
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the CLI entry runs when launched through a symlinked temp path', async () => {
  // Regression: Node resolves the ESM entry to its realpath (/private/var/…),
  // so a naive argv[1] comparison made main() silently skip on macOS temp dirs.
  const { home } = await makeProfile()
  try {
    const entry = fileURLToPath(new URL('../bin/install.js', import.meta.url))
    const child = spawnSync(process.execPath, [entry, 'status'], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: home },
      cwd: home,
    })
    assert.equal(child.status, 1, `expected status exit 1, got ${child.status}; stdout: ${child.stdout}`)
    assert.match(child.stdout, /not installed/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
