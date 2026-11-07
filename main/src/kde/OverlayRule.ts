import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as dbus from 'dbus-next'
import { getBus } from './bus'
import { OVERLAY_TITLE } from './KWinController'

const execFileAsync = promisify(execFile)

/**
 * A KWin window rule that puts the overlay in the "critical notification" layer,
 * added while the app runs and removed on quit.
 *
 * Why: KWin stacks the *active fullscreen* window (the game) in ActiveLayer,
 * above "keep above" windows like the overlay, so widgets shown while the game
 * keeps focus (e.g. the Ctrl+D price check) are hidden behind it. KWin scripts
 * can only read a window's layer; window rules are the supported way to set it.
 *
 * KWin treats every group in kwinrulesrc (except [General] and "$..." metadata)
 * as a rule, so adding/removing our own group is enough. The group is written
 * with KDE's `kwriteconfig6` (KConfig locking/escaping), then KWin is told to
 * reload, which re-evaluates rules for open windows.
 */
const RULE_GROUP = 'awakened-poe-trade-overlay'

const RULE: Record<string, string> = {
  Description: 'Awakened PoE Trade overlay (managed by the app while it runs)',
  title: OVERLAY_TITLE,
  titlematch: '1', // Rules::ExactMatch
  layer: 'critical-notification',
  layerrule: '2', // Rules::Force
  // no taskbar entry: the app lives in the tray (the KWin script also sets this, but only once it matches the window)
  skiptaskbar: 'true',
  skiptaskbarrule: '2'
}

export class OverlayRule {
  constructor (
    private log: (msg: string) => void,
    private kwriteconfig = 'kwriteconfig6'
  ) {}

  async add () {
    try {
      for (const [key, value] of Object.entries(RULE)) {
        await this.write(['--key', key, value])
      }
      await reconfigureKWin()
      this.log('info [KWin] Window rule added: overlay stays above the fullscreen game.')
    } catch (e) {
      this.log(`warn [KWin] Cannot add the overlay window rule (${(e as Error).message}); ` +
        'widgets that keep the game focused (Ctrl+D price check) will be hidden behind a fullscreen game.')
    }
  }

  async remove () {
    try {
      // KConfig drops a group once it has no keys left
      for (const key of Object.keys(RULE)) {
        await this.write(['--key', key, '--delete'])
      }
      await reconfigureKWin()
    } catch (e) {
      this.log(`warn [KWin] Cannot remove the overlay window rule: ${(e as Error).message}`)
    }
  }

  private async write (args: string[]) {
    await execFileAsync(this.kwriteconfig, ['--file', 'kwinrulesrc', '--group', RULE_GROUP, ...args], { timeout: 5000 })
  }
}

/** org.kde.KWin /KWin reconfigure: reloads KWin's config incl. window rules. */
async function reconfigureKWin () {
  const bus = await getBus()
  // declared NoReply: don't wait for an answer that never comes
  bus.send(new dbus.Message({
    destination: 'org.kde.KWin',
    path: '/KWin',
    interface: 'org.kde.KWin',
    member: 'reconfigure',
    flags: dbus.MessageFlag.NO_REPLY_EXPECTED
  }))
}
