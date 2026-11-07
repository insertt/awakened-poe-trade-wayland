import path from 'path'
import { spawn } from 'child_process'
import { BrowserWindow, dialog, shell, Menu, WebContents } from 'electron'
import { OVERLAY_WINDOW_OPTS } from 'electron-overlay-window'
import { overlayBackend } from './overlay-controller'
import { useKWin } from '../kde'
import { OVERLAY_TITLE } from '../kde/KWinController'
import type { ServerEvents } from '../server'
import type { Logger } from '../RemoteLogger'
import type { GameWindow } from './GameWindow'

export class OverlayWindow {
  public isInteractable = false
  public wasUsedRecently = true
  private window?: BrowserWindow
  private overlayKey: string = 'Shift + Space'
  private isOverlayKeyUsed = false

  constructor (
    private server: ServerEvents,
    private logger: Logger,
    private poeWindow: GameWindow,
  ) {
    this.server.onEventAnyClient('OVERLAY->MAIN::focus-game', this.assertGameActive)
    this.poeWindow.on('active-change', this.handlePoeWindowActiveChange)
    this.poeWindow.onAttach(this.handleOverlayAttached)

    this.server.onEventAnyClient('CLIENT->MAIN::used-recently', (e) => {
      this.wasUsedRecently = e.isOverlay
    })

    if (process.argv.includes('--no-overlay')) return

    this.window = new BrowserWindow({
      icon: path.join(__dirname, process.env.STATIC!, 'icon.png'),
      ...OVERLAY_WINDOW_OPTS,
      // Electron 43+ rounds frameless windows on Linux; that would clip widgets in the corners
      ...(process.platform === 'linux' ? { roundedCorners: false, skipTaskbar: true } : {}),
      // KWin sets the geometry of the overlay, so it must not be fixed-size
      ...(useKWin ? { resizable: true, skipTaskbar: true, title: OVERLAY_TITLE } : {}),
      width: 800,
      height: 600,
      webPreferences: {
        allowRunningInsecureContent: false,
        webviewTag: true,
        spellcheck: false,
        // the KWin backend minimizes the overlay while the game isn't focused; a throttled
        // renderer then reacts late the first time it is shown again
        backgroundThrottling: !useKWin
      }
    })

    this.window.setMenu(Menu.buildFromTemplate([
      { role: 'editMenu' },
      { role: 'reload' },
      { role: 'toggleDevTools' }
    ]))

    if (useKWin) {
      // KWin script identifies the overlay by its (constant) title
      this.window.on('page-title-updated', (e) => e.preventDefault())
    }
    this.window.webContents.on('before-input-event', this.handleExtraCommands)
    this.window.webContents.on('did-attach-webview', (_, webviewWebContents) => {
      webviewWebContents.on('before-input-event', this.handleExtraCommands)
    })

    this.window.webContents.setWindowOpenHandler((details) => {
      this.openInBrowser(details.url)
      return { action: 'deny' }
    })
  }

  private openInBrowser (url: string) {
    if (!/^https?:\/\//i.test(url)) return

    if (process.platform !== 'linux') {
      shell.openExternal(url).catch((err) => {
        this.logger.write(`error [OverlayWindow] shell.openExternal failed: ${err}`)
      })
      return
    }

    // shell.openExternal() runs xdg-open with our environment and reports success even if
    // xdg-open fails. On KDE without KDE_SESSION_VERSION it falls back to the removed
    // `kfmclient`, so run it ourselves with a sanitized environment.
    const env = { ...process.env }
    // AppImage overrides these, which can break xdg-open and the browser it launches
    delete env.LD_LIBRARY_PATH
    delete env.LD_PRELOAD
    if (useKWin || /kde/i.test(env.XDG_CURRENT_DESKTOP ?? '')) {
      env.KDE_SESSION_VERSION ||= '6'
    }
    spawn('xdg-open', [url], { env, detached: true, stdio: 'ignore' })
      .on('error', (e) => this.logger.write(`error [OverlayWindow] xdg-open failed: ${e}`))
      .on('exit', (code) => {
        if (code) this.logger.write(`error [OverlayWindow] xdg-open exited with code ${code}`)
      })
      .unref()
  }

  loadAppPage (port: number) {
    const url = process.env.VITE_DEV_SERVER_URL ||
      `http://localhost:${port}/index.html`

    if (!this.window) {
      shell.openExternal(url)
      return
    }

    if (process.env.VITE_DEV_SERVER_URL) {
      this.window.loadURL(url)
      this.window.webContents.openDevTools({ mode: 'detach', activate: false })
    } else {
      this.window.loadURL(url)
    }
  }

  assertOverlayActive = () => {
    if (!this.isInteractable) {
      this.isInteractable = true
      overlayBackend.activateOverlay()
      this.poeWindow.isActive = false
    }
  }

  assertGameActive = () => {
    if (this.isInteractable) {
      this.isInteractable = false
      overlayBackend.focusTarget()
      this.poeWindow.isActive = true
    }
  }

  toggleActiveState = () => {
    this.isOverlayKeyUsed = true
    if (this.isInteractable) {
      this.assertGameActive()
    } else {
      this.assertOverlayActive()
    }
  }

  updateOpts (overlayKey: string, windowTitle: string) {
    this.overlayKey = overlayKey
    this.poeWindow.attach(this.window, windowTitle)
  }

  private handleExtraCommands = (event: Electron.Event, input: Electron.Input) => {
    if (input.type !== 'keyDown') return

    let { code, control: ctrlKey, shift: shiftKey, alt: altKey } = input

    if (code.startsWith('Key')) {
      code = code.slice('Key'.length)
    } else if (code.startsWith('Digit')) {
      code = code.slice('Digit'.length)
    }

    if (shiftKey && altKey) code = `Shift + Alt + ${code}`
    else if (ctrlKey && shiftKey) code = `Ctrl + Shift + ${code}`
    else if (ctrlKey && altKey) code = `Ctrl + Alt + ${code}`
    else if (altKey) code = `Alt + ${code}`
    else if (ctrlKey) code = `Ctrl + ${code}`
    else if (shiftKey) code = `Shift + ${code}`

    switch (code) {
      case 'Escape':
      case 'Ctrl + W': {
        event.preventDefault()
        process.nextTick(this.assertGameActive)
        break
      }
      case this.overlayKey: {
        event.preventDefault()
        process.nextTick(this.toggleActiveState)
        break
      }
    }
  }

  private handleOverlayAttached = (hasAccess?: boolean) => {
    if (hasAccess === false) {
      this.logger.write('error [Overlay] PoE is running with administrator rights')

      dialog.showErrorBox(
        'PoE window - No access',
        // ----------------------
        'Path of Exile is running with administrator rights.\n' +
        '\n' +
        'You need to restart Awakened PoE Trade with administrator rights.'
      )
    } else {
      this.server.sendEventTo('broadcast', {
        name: 'MAIN->OVERLAY::overlay-attached',
        payload: undefined
      })
    }
  }

  private handlePoeWindowActiveChange = (isActive: boolean) => {
    if (isActive && this.isInteractable) {
      this.isInteractable = false
    }
    this.server.sendEventTo('broadcast', {
      name: 'MAIN->OVERLAY::focus-change',
      payload: {
        game: isActive,
        overlay: this.isInteractable,
        usingHotkey: this.isOverlayKeyUsed
      }
    })
    this.isOverlayKeyUsed = false
  }
}
