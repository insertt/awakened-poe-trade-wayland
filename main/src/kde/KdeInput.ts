import { EventEmitter } from 'node:events'
import type { KWinController } from './KWinController'
import type { KeyInjector } from './KeyInjector'
import { startEvdev, EV_KEY, EV_REL, REL_WHEEL } from './evdev'
import { uiohookToEvdev, evdevToUiohook, EVDEV_MODIFIERS } from './keymap'

// uiohook-napi EventType values (not imported: importing would load the native addon)
const KEY_PRESSED = 4
const KEY_RELEASED = 5
const MOUSE_PRESSED = 7
const MOUSE_RELEASED = 8
const MOUSE_MOVED = 9
const MOUSE_WHEEL = 11
const WHEEL_VERTICAL = 3

const BTN_LEFT = 0x110
const BTN_RIGHT = 0x111
const BTN_MIDDLE = 0x112
// uiohook button numbers
const BUTTONS: Record<number, number> = { [BTN_LEFT]: 1, [BTN_RIGHT]: 2, [BTN_MIDDLE]: 3 }

type Mod = 'ctrl' | 'shift' | 'alt' | 'meta'

/**
 * KDE Wayland replacement for the parts of `uIOhook` APT uses. Emits
 * uiohook-shaped events and implements `keyTap`/`keyToggle`.
 *
 * - mousemove: pointer position from the KWin tracker script (always available)
 * - everything else, from the best available sources:
 *   1. evdev, if /dev/input is readable (see evdev.ts): sees all input
 *   2. otherwise combined:
 *      - modifier state (Ctrl/Alt/Shift/Meta, incl. keydown/keyup events for
 *        those keys) from KWin's keystate protocol (see keystate.ts). Global,
 *        works with native Wayland and XWayland games. Plasma 6.3+.
 *      - other keys, mouse buttons, wheel from uiohook on XWayland: only for
 *        games running under XWayland, and only while they're focused.
 * - key injection: KWin fake input, or the RemoteDesktop portal (KeyInjector)
 *
 * Mouse coordinates are game-local (see KWinController).
 */
/** Minimal surface of `uIOhook` used as an input source. */
export interface X11Hook {
  on (event: 'keydown' | 'keyup' | 'mousedown' | 'mouseup' | 'wheel' | 'mousemove', cb: (e: any) => void): unknown
}

/** Minimal surface of `WaylandKeyState`. */
export interface KeyStateSource {
  mods: Record<Mod, boolean>
  start (): Promise<number>
  on (event: 'mods', cb: (mods: Record<Mod, boolean>) => void): unknown
  on (event: 'error', cb: (err: Error) => void): unknown
}

// uiohook keycodes reported for modifier key events synthesized from keystate
const MOD_KEYCODES: Record<Mod, number> = { ctrl: 29, shift: 42, alt: 56, meta: 3675 }
const MOD_UIOHOOK_KEYS = new Set([29, 3613, 42, 54, 56, 3640, 3675, 3676])

export class KdeInput extends EventEmitter {
  hasEvdev = false
  hasX11 = false
  hasKeyState = false
  private cursor = { x: 0, y: 0 }
  private held = new Set<number>() // evdev modifier keycodes currently down
  private mods: Record<Mod, boolean> = { ctrl: false, shift: false, alt: false, meta: false }
  private chain: Promise<void> = Promise.resolve()
  private barriers: Array<Promise<unknown>> = []
  private warnedInactive = false

  constructor (
    private controller: KWinController,
    private rd: KeyInjector,
    private log: (msg: string) => void,
    /** starts uiohook against XWayland; throws if that isn't possible */
    private startX11Hook?: () => X11Hook,
    private createKeyState?: () => KeyStateSource
  ) {
    super()
  }

  start () {
    this.controller.events.on('cursor', (p: { x: number, y: number }) => {
      this.cursor = p
      this.emit('mousemove', this.mouseEvent(MOUSE_MOVED, 0))
    })

    void this.rd.start()

    const devices = startEvdev(this.onRaw, this.log)
    this.hasEvdev = devices.length > 0
    if (this.hasEvdev) {
      this.log(`info [KdeInput] Reading input from: ${devices.map(d => d.name).join(', ')}`)
      // "keyboard" devices include the extra interfaces of mice, so a readable one doesn't mean
      // modifiers are visible: always take them from KWin when it can tell (see onRaw)
      this.attachKeyState()
      return
    }

    this.attachKeyState()

    if (this.startX11Hook && process.env.DISPLAY) {
      try {
        this.attachX11(this.startX11Hook())
        this.hasX11 = true
        this.log(`info [KdeInput] Listening to keys/mouse buttons/wheel through XWayland (${process.env.DISPLAY}); ` +
          'only sees games running under XWayland, while they are focused.')
      } catch (e) {
        this.log(`warn [KdeInput] Cannot listen through XWayland: ${(e as Error).message}`)
      }
    }
  }

  /** Modifier state pushed by KWin; works whichever window is focused. */
  private attachKeyState () {
    const ks = this.createKeyState?.()
    if (!ks) return
    ks.start().then((version) => {
      this.hasKeyState = true
      this.log(`info [KdeInput] Modifier keys (Ctrl/Alt/Shift) via KWin keystate protocol v${version}.`)
      this.applyKeyState(ks.mods)
      ks.on('mods', (mods) => this.applyKeyState(mods))
    }, (e: Error) => {
      this.log(`warn [KdeInput] KWin keystate protocol unavailable (${e.message}): ` +
        '"hold key" widgets and Alt to hide the overlay only work for games under XWayland.')
    })
    ks.on('error', (e) => {
      if (!this.hasKeyState) return
      this.hasKeyState = false
      this.mods = { ctrl: false, shift: false, alt: false, meta: false }
      this.log(`warn [KdeInput] Lost KWin keystate connection: ${e.message}`)
    })
  }

  private applyKeyState (next: Record<Mod, boolean>) {
    const prev = this.mods
    this.mods = { ...next }
    for (const mod of ['ctrl', 'shift', 'alt', 'meta'] as Mod[]) {
      if (prev[mod] === next[mod]) continue
      // like uiohook: a modifier's own keydown already has its flag set, its keyup not
      this.emit(next[mod] ? 'keydown' : 'keyup', {
        type: next[mod] ? KEY_PRESSED : KEY_RELEASED,
        time: Date.now(),
        keycode: MOD_KEYCODES[mod],
        ...this.modFlags()
      })
    }
  }

  private attachX11 (hook: X11Hook) {
    let seenEvent = false
    const fromX11 = (e: any) => {
      if (!seenEvent) {
        seenEvent = true
        this.log('debug [KdeInput] XWayland input events are arriving.')
      }
      // libuiohook derives these from the X server's modifier state;
      // KWin's keystate is better (sees modifiers in Wayland windows too)
      if (!this.hasKeyState) {
        this.mods = { ctrl: !!e.ctrlKey, shift: !!e.shiftKey, alt: !!e.altKey, meta: !!e.metaKey }
      }
    }
    // with keystate, modifier key events come from there; don't report them twice
    const isDuplicateModKey = (e: any) => this.hasKeyState && MOD_UIOHOOK_KEYS.has(e.keycode)
    // keycodes are already uiohook's; mouse positions are replaced with KWin's
    // game-local cursor (XWayland's coordinates can be scaled differently)
    hook.on('keydown', (e) => { fromX11(e); if (!isDuplicateModKey(e)) this.emit('keydown', { ...e, ...this.modFlags() }) })
    hook.on('keyup', (e) => { fromX11(e); if (!isDuplicateModKey(e)) this.emit('keyup', { ...e, ...this.modFlags() }) })
    hook.on('mousedown', (e) => { fromX11(e); this.emit('mousedown', { ...this.mouseEvent(MOUSE_PRESSED, e.button), clicks: e.clicks }) })
    hook.on('mouseup', (e) => { fromX11(e); this.emit('mouseup', { ...this.mouseEvent(MOUSE_RELEASED, e.button), clicks: e.clicks }) })
    hook.on('wheel', (e) => {
      fromX11(e)
      this.emit('wheel', { ...this.mouseEvent(MOUSE_WHEEL, 0), amount: e.amount, direction: e.direction, rotation: e.rotation })
    })
    // positions come from KWin; only take the modifier state
    hook.on('mousemove', fromX11)

    // XWayland sees no input while a Wayland window has focus, so a modifier
    // released there would look held forever
    this.controller.events.on('blur', () => {
      if (!this.hasKeyState) this.mods = { ctrl: false, shift: false, alt: false, meta: false }
    })
  }

  getCursorPoint () {
    return { ...this.cursor }
  }

  keyTap (key: number, modifiers: number[] = []) {
    for (const m of modifiers) this.send(m, true)
    this.send(key, true)
    this.send(key, false)
    for (const m of [...modifiers].reverse()) this.send(m, false)
  }

  keyToggle (key: number, toggle: 'down' | 'up') {
    this.send(key, toggle === 'down')
  }

  /** Key events queued after this call wait for `p` (e.g. a clipboard write). */
  barrier (p: Promise<unknown>) {
    this.barriers.push(p)
  }

  /** Resolves when all queued key events were delivered. */
  idle (): Promise<void> {
    return this.chain
  }

  private send (uiohookCode: number, down: boolean) {
    const evdev = uiohookToEvdev(uiohookCode)
    if (evdev === undefined) {
      this.log(`warn [KdeInput] Cannot send key ${uiohookCode}`)
      return
    }
    // capture what this event must wait for *now*, not when the chain gets to it
    const waitFor = [this.controller.focusSettled(), ...this.barriers]
    this.barriers = []

    this.chain = this.chain
      .then(() => Promise.allSettled(waitFor))
      .then(async () => {
        if (!this.rd.isActive) {
          if (!this.warnedInactive) {
            this.warnedInactive = true
            this.log('warn [KdeInput] No way to send keys (KWin fake input / RemoteDesktop portal), key presses are dropped.')
          }
          void this.rd.start()
          return
        }
        this.warnedInactive = false
        await this.rd.key(evdev, down)
      })
      .catch((e) => this.log(`error [KdeInput] ${(e as Error).message}`))
  }

  private onRaw = (type: number, code: number, value: number) => {
    if (type === EV_KEY) {
      const button = BUTTONS[code]
      if (button) {
        if (value === 1) this.emit('mousedown', this.mouseEvent(MOUSE_PRESSED, button))
        else if (value === 0) this.emit('mouseup', this.mouseEvent(MOUSE_RELEASED, button))
        return
      }

      const mod = EVDEV_MODIFIERS[code]
      // keystate already reports modifiers (and their key events)
      if (mod && this.hasKeyState) return
      if (mod) {
        if (value === 0) this.held.delete(code)
        else this.held.add(code)
        this.mods[mod] = [...this.held].some(c => EVDEV_MODIFIERS[c] === mod)
      }

      const keycode = evdevToUiohook(code)
      if (keycode === undefined) return
      // value: 1 press, 2 autorepeat (uiohook reports repeats as keydown too), 0 release
      this.emit(value === 0 ? 'keyup' : 'keydown', {
        type: value === 0 ? KEY_RELEASED : KEY_PRESSED,
        time: Date.now(),
        keycode,
        ...this.modFlags()
      })
    } else if (type === EV_REL && code === REL_WHEEL) {
      this.emit('wheel', {
        ...this.mouseEvent(MOUSE_WHEEL, 0),
        amount: 3,
        direction: WHEEL_VERTICAL,
        // evdev: +1 = away from user (up); uiohook: positive = down
        rotation: -value
      })
    }
  }

  private modFlags () {
    return {
      ctrlKey: this.mods.ctrl,
      shiftKey: this.mods.shift,
      altKey: this.mods.alt,
      metaKey: this.mods.meta
    }
  }

  private mouseEvent (type: number, button: number) {
    return {
      type,
      time: Date.now(),
      x: this.cursor.x,
      y: this.cursor.y,
      button,
      clicks: button ? 1 : 0,
      ...this.modFlags()
    }
  }
}
