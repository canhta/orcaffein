// Everything that touches the Mac lives behind this interface, so the worker and its tests can
// swap in a fake. The real one runs fixed binaries with fixed argument arrays: never a shell.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { userInfo } from 'node:os'

export interface System {
  readonly supported: boolean
  /** Working agents across all local workspaces, chats and terminals. Throws when unknown. */
  workingAgents(cliPath: string): Promise<number>
  onAC(): Promise<boolean>
  lidClosed(): Promise<boolean>
  sleepDisabled(): Promise<boolean>
  /** `sudo -n pmset -a disablesleep 0|1`. Rejects with SetupError when sudo refuses. */
  setSleepDisabled(disabled: boolean): Promise<void>
  /** `sudo -n pmset sleepnow`. */
  sleepNow(): Promise<void>
  /** Whether sudo allows all three commands without a password (`sudo -n -l <cmd>`). */
  sudoReady(): Promise<boolean>
  /** Installs the sudoers drop-in through macOS's admin password dialog. */
  installSudoers(): Promise<'installed' | 'cancelled' | 'failed'>
  /** A detached process that restores sleep if this worker dies without deactivate(). */
  startWatchdog(): void
  stopWatchdog(): void
}

export class SetupError extends Error {
  readonly code = 'setup_required'
}

const PMSET = '/usr/bin/pmset'
const SUDO = '/usr/bin/sudo'
const IOREG = '/usr/sbin/ioreg'
// Workers get an allowlisted environment; give children a fixed, minimal one.
const CHILD_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' }

export const SUDOERS_FILE = '/etc/sudoers.d/orcaffein'

export function sudoersEntry(user: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(user)) throw new Error(`unexpected user name: ${user}`)
  return `${user} ALL=(root) NOPASSWD: ${PMSET} -a disablesleep 0, ${PMSET} -a disablesleep 1, ${PMSET} sleepnow`
}

// Runs as root after the user enters their password in macOS's own dialog. The entry arrives
// as argv (no interpolation into the script); root writes a temp file in /etc/sudoers.d,
// checks it with visudo, and only then moves it into place.
export const INSTALL_SCRIPT = [
  'on run argv',
  'set entry to item 1 of argv',
  'set t to "/etc/sudoers.d/.orcaffein.tmp"',
  'do shell script "umask 0337; /bin/rm -f " & t & "; printf \'%s\\n\' " & quoted form of entry & " > " & t & " && /usr/sbin/chown root:wheel " & t & " && /usr/sbin/visudo -cf " & t & " && /bin/mv -f " & t & " ' + SUDOERS_FILE + ' || { /bin/rm -f " & t & "; exit 1; }" with prompt "Orcaffein needs your password once to keep the Mac awake with the lid closed while agents work." with administrator privileges',
  'end run'
]

export const SUDO_COMMANDS: readonly (readonly string[])[] = [
  [PMSET, '-a', 'disablesleep', '0'],
  [PMSET, '-a', 'disablesleep', '1'],
  [PMSET, 'sleepnow']
]

type Run = { ok: boolean; stdout: string; stderr: string }

function run(file: string, args: readonly string[], timeout = 10_000, env?: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024, env: env ?? CHILD_ENV }, (error, stdout, stderr) =>
        resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      )
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: (error as Error).message })
    }
  })
}

export function parseSleepDisabled(pmsetG: string): boolean {
  // `pmset -g` prints the line only when it is set.
  return /^\s*SleepDisabled\s+1\b/m.test(pmsetG)
}

export function parseOnAC(pmsetBatt: string): boolean {
  return /'AC Power'/.test(pmsetBatt) || /AC Power/.test(pmsetBatt.split('\n')[0] ?? '')
}

export function parseLidClosed(ioreg: string): boolean {
  const match = /"AppleClamshellState"\s*=\s*(Yes|No)/.exec(ioreg)
  if (!match) throw new Error('AppleClamshellState not found')
  return match[1] === 'Yes'
}

export function countWorking(json: string): number {
  const parsed = JSON.parse(json) as { ok?: boolean; result?: { agents?: { state?: string }[] } }
  if (parsed.ok !== true || !Array.isArray(parsed.result?.agents)) {
    throw new Error('unexpected orca agent list output')
  }
  return parsed.result.agents.filter((agent) => agent?.state === 'working').length
}

export function macSystem(): System {
  let watchdog: ChildProcess | null = null

  async function sudo(args: readonly string[]): Promise<void> {
    const result = await run(SUDO, ['-n', ...args], 1_500)
    if (!result.ok) {
      throw new SetupError(result.stderr.trim() || `sudo -n ${args.join(' ')} failed`)
    }
  }

  return {
    supported: process.platform === 'darwin',

    async workingAgents(cliPath) {
      if (!cliPath.startsWith('/')) throw new Error('Orca CLI path must be absolute')
      // The CLI finds the running Orca through HOME; pass only what it needs.
      const home = process.env.HOME
      const result = await run(cliPath, ['agent', 'list', '--state', 'working', '--json'], 15_000,
        home ? { ...CHILD_ENV, HOME: home } : CHILD_ENV)
      if (!result.ok) throw new Error(result.stderr.trim() || 'orca agent list failed')
      return countWorking(result.stdout)
    },

    async onAC() {
      const result = await run(PMSET, ['-g', 'batt'])
      if (!result.ok) throw new Error('pmset -g batt failed')
      return parseOnAC(result.stdout)
    },

    async lidClosed() {
      const result = await run(IOREG, ['-r', '-k', 'AppleClamshellState', '-d', '1'])
      if (!result.ok) throw new Error('ioreg failed')
      return parseLidClosed(result.stdout)
    },

    async sleepDisabled() {
      const result = await run(PMSET, ['-g'])
      if (!result.ok) throw new Error('pmset -g failed')
      return parseSleepDisabled(result.stdout)
    },

    setSleepDisabled(disabled) {
      return sudo([PMSET, '-a', 'disablesleep', disabled ? '1' : '0'])
    },

    sleepNow() {
      return sudo([PMSET, 'sleepnow'])
    },

    async sudoReady() {
      for (const command of SUDO_COMMANDS) {
        // `-l <command>` only asks whether it is allowed; nothing runs.
        const result = await run(SUDO, ['-n', '-l', ...command], 3_000)
        if (!result.ok) return false
      }
      return true
    },

    async installSudoers() {
      let entry: string
      try {
        entry = sudoersEntry(userInfo().username)
      } catch {
        return 'failed'
      }
      const args = INSTALL_SCRIPT.flatMap((line) => ['-e', line])
      // No timeout to speak of: the person may take a while to type the password.
      const result = await run('/usr/bin/osascript', [...args, entry], 300_000)
      if (result.ok) return 'installed'
      return /-128|cancel/i.test(result.stderr) ? 'cancelled' : 'failed'
    },

    startWatchdog() {
      if (watchdog) return
      try {
        const script = fileURLToPath(new URL('./watchdog.mjs', import.meta.url))
        const child = spawn(process.execPath, [script, String(process.pid)], {
          detached: true,
          stdio: 'ignore',
          env: { ...CHILD_ENV, ELECTRON_RUN_AS_NODE: '1' }
        })
        child.unref()
        watchdog = child
      } catch {
        watchdog = null
      }
    },

    stopWatchdog() {
      try {
        watchdog?.kill('SIGTERM')
      } catch {
        // already gone
      }
      watchdog = null
    }
  }
}
