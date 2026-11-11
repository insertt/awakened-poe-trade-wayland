import fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Optional passive keyboard/mouse listener reading /dev/input/event*.
 *
 * Wayland has no API for observing global input, so this is the only way to see
 * held modifiers (Alt-to-hide, "hold Ctrl" widgets), Ctrl+wheel stash scrolling
 * and mouse clicks while the game has focus. It needs read access to the input
 * devices (usually: user in the `input` group). We never ask for that access;
 * if the devices aren't readable this listener stays off and those features
 * are unavailable. Note: that access lets any process of the user read all
 * keystrokes, which is why it isn't set up automatically.
 *
 * Each device is read by its own `cat` child process; we read its stdout pipe.
 * Async fs reads would each hold a libuv threadpool thread forever and starve
 * other fs work, and blocking reads in worker threads hang app exit: Node
 * joins workers on teardown, but a worker blocked in read() on a quiet device
 * (e.g. a mouse's keyboard interface) never gets to notice it should stop.
 * A child process is killed instead, and the signal interrupts its read().
 */

export const EV_KEY = 1
export const EV_REL = 2
export const REL_WHEEL = 8

export interface InputDevice { path: string, name: string, kind: 'keyboard' | 'mouse' }

/** Parse /proc/bus/input/devices and pick keyboards and mice. */
function findDevices (procText: string): InputDevice[] {
  const out: InputDevice[] = []
  for (const block of procText.split(/\n\s*\n/)) {
    const name = /^N: Name="(.*)"$/m.exec(block)?.[1] ?? ''
    const handlers = /^H: Handlers=(.*)$/m.exec(block)?.[1].trim().split(/\s+/) ?? []
    const event = handlers.find(h => /^event\d+$/.test(h))
    if (!event) continue
    const keyBits = /^B: KEY=(.*)$/m.exec(block)?.[1].trim().split(/\s+/) ?? []
    // bitmap words are printed most-significant first; KEY_A (30) is in the last word
    const lastWord = keyBits.length ? BigInt('0x' + keyBits[keyBits.length - 1]) : 0n
    const hasKeyA = (lastWord & (1n << 30n)) !== 0n
    if (handlers.includes('kbd') && hasKeyA) {
      out.push({ path: `/dev/input/${event}`, name, kind: 'keyboard' })
    } else if (handlers.some(h => /^mouse\d+$/.test(h))) {
      out.push({ path: `/dev/input/${event}`, name, kind: 'mouse' })
    }
  }
  return out
}

/** Decode `struct input_event` records (64-bit layout, 24 bytes each). */
function decodeEvents (buf: Buffer, length: number): number[] {
  const out: number[] = []
  for (let off = 0; off + 24 <= length; off += 24) {
    const type = buf.readUInt16LE(off + 16)
    const code = buf.readUInt16LE(off + 18)
    const value = buf.readInt32LE(off + 20)
    if (type === EV_KEY || (type === EV_REL && code === REL_WHEEL)) out.push(type, code, value)
  }
  return out
}

export type RawHandler = (type: number, code: number, value: number) => void

/** Starts readers for all readable keyboards/mice. Returns the devices in use. */
export function startEvdev (onEvent: RawHandler, log: (msg: string) => void): InputDevice[] {
  if (process.arch !== 'x64' && process.arch !== 'arm64') return []
  let devices: InputDevice[]
  try {
    devices = findDevices(fs.readFileSync('/proc/bus/input/devices', 'utf8'))
  } catch { return [] }

  const readable = devices.filter(d => {
    try { fs.accessSync(d.path, fs.constants.R_OK); return true } catch { return false }
  })
  const children: ChildProcess[] = []
  for (const dev of readable) {
    const child = spawn('cat', [dev.path], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    // pipe chunks aren't aligned to 24-byte records; keep the partial tail
    let rest: Buffer = Buffer.alloc(0)
    child.stdout!.on('data', (chunk: Buffer) => {
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk
      const whole = buf.length - (buf.length % 24)
      const ev = decodeEvents(buf, whole)
      rest = buf.subarray(whole)
      for (let i = 0; i < ev.length; i += 3) onEvent(ev[i], ev[i + 1], ev[i + 2])
    })
    let stderr = ''
    child.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (e) => log(`warn [evdev] ${dev.name}: ${e.message}`))
    child.on('exit', (code, signal) => {
      if (signal === 'SIGTERM') return // killed by us on exit
      log(`warn [evdev] ${dev.name}: reader exited (${signal ?? `code ${code}`}) ${stderr.trim()}`)
    })
  }
  // children aren't killed with us; a leftover `cat` would linger until the
  // device's next event (then die of SIGPIPE)
  process.on('exit', () => { for (const c of children) c.kill('SIGTERM') })
  return readable
}
