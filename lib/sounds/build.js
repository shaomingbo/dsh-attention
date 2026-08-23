import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { wavBufferFor } from './render.js'

const here = dirname(fileURLToPath(import.meta.url))

await mkdir(here, { recursive: true })
await writeFile(join(here, 'approval.wav'), wavBufferFor('approval'))
await writeFile(join(here, 'completed.wav'), wavBufferFor('completed'))
