/** Render short UI chimes in the OpenCode / Codex register: soft bells, not system alerts. */

export const SAMPLE_RATE = 44_100

export const CHIMES = {
  approval: {
    gain: 0.34,
    notes: [
      { freq: 784, start: 0, duration: 0.18 },
      { freq: 1175, start: 0.12, duration: 0.28 },
    ],
  },
  completed: {
    gain: 0.3,
    notes: [
      { freq: 659, start: 0, duration: 0.14 },
      { freq: 784, start: 0.09, duration: 0.16 },
      { freq: 988, start: 0.2, duration: 0.32 },
    ],
  },
}

export function chimeKind(kind) {
  return kind === 'completed' ? 'completed' : 'approval'
}

function sampleNote(freq, time, duration, peak) {
  if (time < 0 || time > duration) return 0
  const attack = Math.min(0.012, duration * 0.18)
  const envelope = time < attack
    ? time / attack
    : Math.exp(-5.2 * ((time - attack) / Math.max(0.001, duration - attack)))
  const fundamental = Math.sin(2 * Math.PI * freq * time)
  const harmonic = 0.22 * Math.sin(2 * Math.PI * freq * 2 * time)
  const sub = 0.08 * Math.sin(2 * Math.PI * freq * 0.5 * time)
  return peak * envelope * (fundamental + harmonic + sub)
}

export function renderChimePcm(kind) {
  const spec = CHIMES[chimeKind(kind)]
  const length = Math.ceil((Math.max(...spec.notes.map((note) => note.start + note.duration)) + 0.04) * SAMPLE_RATE)
  const samples = new Float64Array(length)
  for (let index = 0; index < length; index += 1) {
    const time = index / SAMPLE_RATE
    let value = 0
    for (const note of spec.notes) {
      value += sampleNote(note.freq, time - note.start, note.duration, spec.gain)
    }
    samples[index] = Math.max(-1, Math.min(1, value))
  }
  return samples
}

export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const dataSize = samples.length * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(Math.round(samples[index] * 32767), 44 + index * 2)
  }
  return buffer
}

export function wavBufferFor(kind) {
  return encodeWav(renderChimePcm(kind))
}
