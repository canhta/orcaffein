// Polls agents, power and lid, asks decide() what to do, applies it, and updates the status bar.
// On stop, and on any error, sleep goes back to normal.
import type { OrcaWorkerApi } from 'orca/worker'
import { clampSettings, decide, type Decision, type Settings } from './decide.ts'
import { macSystem, SetupError, type System } from './system.ts'

const ITEM = 'state'
const LAST_ACTIVE = 'lastActive'
const PAUSED = 'paused'
const DEFAULT_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'
// Let a watchdog left by a crashed worker fire before this one takes over.
const START_DELAY_MS = 3_000
const EVENT_DEBOUNCE_MS = 1_500
// While the Mac is held awake: how often to look at the lid, so the screen goes off soon after
// it closes. ioreg takes ~15 ms.
const LID_CHECK_MS = 10_000

// Orca's IPC channel keeps the worker alive; timers must not (tests would never exit).
function unref(timer: unknown): void {
  ;(timer as { unref?: () => void } | null)?.unref?.()
}

export type WorkerOptions = {
  system: System
  now?: () => number
  startDelayMs?: number
  eventDebounceMs?: number
  lidCheckMs?: number
}

export function createWorker({
  system,
  now = Date.now,
  startDelayMs = START_DELAY_MS,
  eventDebounceMs = EVENT_DEBOUNCE_MS,
  lidCheckMs = LID_CHECK_MS
}: WorkerOptions) {
  let orca: OrcaWorkerApi | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<Decision | null> | null = null
  let again = false
  let stopped = false
  let setupOk = true
  let pollSeconds = 60
  let last: Decision | null = null
  let lastLogged = ''
  // Only while the Mac is held awake: a power-source watcher and a quick lid check.
  let power: { stop(): void } | null = null
  let lidTimer: ReturnType<typeof setInterval> | null = null
  let lid: boolean | null = null
  // Whether a monitor is attached, checked once per lid close (system_profiler is slow).
  let external: boolean | null = null
  const disposables: { dispose(): void }[] = []

  async function readSettings(): Promise<{
    settings: Settings
    pollSeconds: number
    cliPath: string
  }> {
    const raw = (await orca!.settings.get()) as Record<string, unknown>
    const poll = Number(raw.pollSeconds)
    const cli =
      typeof raw.orcaCliPath === 'string' && raw.orcaCliPath.startsWith('/')
        ? raw.orcaCliPath
        : DEFAULT_CLI
    return {
      settings: clampSettings(raw),
      pollSeconds: Number.isFinite(poll) ? Math.min(600, Math.max(15, Math.round(poll))) : 60,
      cliPath: cli
    }
  }

  async function show(status: {
    text: string
    tone: string
    icon: string
    tooltip: string
  }): Promise<void> {
    const line = `status: ${status.text} | ${status.tooltip}`
    if (line !== lastLogged) {
      lastLogged = line
      orca?.log(line)
    }
    try {
      await orca?.host.call('statusBar.update', {
        id: ITEM,
        text: status.text,
        tone: status.tone as 'neutral',
        icon: status.icon as 'zap',
        tooltip: status.tooltip
      })
    } catch (error) {
      orca?.log(`statusBar.update failed: ${(error as Error).message}`)
    }
  }

  function watch(on: boolean): void {
    if (on && !stopped) {
      // Unplugging must not wait for the next poll: a closed Mac on battery should sleep now.
      power ??= system.watchPower(() => void tick())
      if (!lidTimer) {
        lidTimer = setInterval(async () => {
          if (running) return
          const now = await system.lidClosed().catch(() => null)
          if (now !== null && lid !== null && now !== lid) void tick()
        }, lidCheckMs)
        unref(lidTimer)
      }
    } else {
      power?.stop()
      power = null
      if (lidTimer) clearInterval(lidTimer)
      lidTimer = null
    }
  }

  async function restore(): Promise<void> {
    watch(false)
    system.stopWatchdog()
    try {
      await system.setSleepDisabled(false)
    } catch (error) {
      if (error instanceof SetupError) setupOk = false
      orca?.log(`restore failed: ${(error as Error).message}`)
    }
  }

  const settle = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null)

  async function tickOnce(): Promise<Decision | null> {
    if (!orca || stopped) return null
    if (!system.supported) {
      await show({
        text: 'macOS only',
        tone: 'warning',
        icon: 'warning',
        tooltip: 'Orcaffein works only on macOS.'
      })
      return null
    }
    try {
      const config = await readSettings()
      if (config.pollSeconds !== pollSeconds) {
        pollSeconds = config.pollSeconds
        schedulePoll()
      }
      if (!setupOk) setupOk = await system.sudoReady()
      const [working, onAC, lidClosed, sleepDisabled, lastActive, paused] = await Promise.all([
        system.workingAgents(config.cliPath).catch((error: Error) => {
          orca?.log(`agent count failed: ${error.message}`)
          return null
        }),
        settle(system.onAC()),
        settle(system.lidClosed()),
        settle(system.sleepDisabled()),
        orca.storage.get(LAST_ACTIVE),
        orca.storage.get(PAUSED)
      ])
      lid = lidClosed
      if (lidClosed !== true) external = null
      const inputs = {
        working,
        onAC,
        lidClosed,
        sleepDisabled,
        now: now(),
        lastActive: typeof lastActive === 'number' ? lastActive : null,
        paused: paused === true,
        setupOk,
        settings: config.settings
      }
      const decision = decide(inputs)
      if (decision.lastActive !== null && decision.lastActive !== inputs.lastActive) {
        await orca.storage.set(LAST_ACTIVE, decision.lastActive)
      }
      await apply(decision)
      // apply() may have just found the sudoers drop-in missing (or present).
      last = setupOk === inputs.setupOk ? decision : decide({ ...inputs, setupOk })
      watch(last.want === 'awake' && setupOk)
      await show(last.status)
      return last
    } catch (error) {
      orca.log(`tick failed: ${(error as Error).message}`)
      await restore()
      await show({
        text: 'Error',
        tone: 'danger',
        icon: 'error',
        tooltip: `Orcaffein hit an error and gave sleep back: ${(error as Error).message}`
      })
      return null
    }
  }

  async function apply(decision: Decision): Promise<void> {
    if (decision.want === 'awake') {
      if (decision.apply === 'set-awake') {
        try {
          await system.setSleepDisabled(true)
          setupOk = true
        } catch (error) {
          if (!(error instanceof SetupError)) throw error
          setupOk = false
          return
        }
      }
      system.startWatchdog()
      // With sleep disabled the built-in screen stays lit under a closed lid.
      if (decision.displayOff) {
        if (external === null) external = await system.externalDisplay()
        if (!external) await system.displaySleepNow()
      }
      return
    }
    if (decision.apply === 'set-normal') await restore()
    else system.stopWatchdog()
    if (decision.sleepNow) {
      try {
        await system.sleepNow()
      } catch (error) {
        orca?.log(`sleepnow failed: ${(error as Error).message}`)
      }
    }
  }

  function tick(): Promise<Decision | null> {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      let result: Decision | null
      do {
        again = false
        result = await tickOnce()
      } while (again && !stopped)
      return result
    })().finally(() => {
      running = null
    })
    return running
  }

  function schedulePoll(): void {
    if (pollTimer) clearInterval(pollTimer)
    if (stopped) return
    pollTimer = setInterval(() => void tick(), pollSeconds * 1000)
    unref(pollTimer)
  }

  function soon(delay = eventDebounceMs): void {
    if (pendingTimer || stopped) return
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      void tick()
    }, delay)
    unref(pendingTimer)
  }

  async function checkSetup(): Promise<string> {
    const config = await readSettings()
    const [sudo, onAC, lid, disabled, working] = await Promise.all([
      settle(system.sudoReady()),
      settle(system.onAC()),
      settle(system.lidClosed()),
      settle(system.sleepDisabled()),
      settle(system.workingAgents(config.cliPath))
    ])
    setupOk = sudo === true
    void tick()
    const fmt = (v: unknown, yes: string, no: string) => (v === null ? 'unknown' : v ? yes : no)
    return [
      `sudoers: ${sudo ? 'ok' : 'missing. Click the Setup item in the status bar.'}`,
      `power: ${fmt(onAC, 'AC', 'battery')}`,
      `lid: ${fmt(lid, 'closed', 'open')}`,
      `SleepDisabled: ${fmt(disabled, '1', '0')}`,
      `working agents: ${working ?? `unknown (CLI ${config.cliPath})`}`,
      `mode: ${config.settings.mode}, idle ${config.settings.idleMinutes}m, poll ${config.pollSeconds}s, battery ${config.settings.allowOnBattery ? 'allowed' : 'not allowed'}`
    ].join('\n')
  }

  return {
    activate(api: OrcaWorkerApi): void {
      orca = api
      stopped = false
      api.commands.register('toggle-pause', async () => {
        // Clicking "Setup" sets it up instead of pausing.
        if (system.supported && !setupOk && !(setupOk = await system.sudoReady())) {
          const result = await system.installSudoers()
          setupOk = result === 'installed' && (await system.sudoReady())
          await tick()
          if (setupOk) return 'Orcaffein is set up.'
          return result === 'cancelled'
            ? 'Setup cancelled.'
            : 'Setup failed. See github.com/canhta/orcaffein#install'
        }
        const paused = (await api.storage.get(PAUSED)) === true
        await api.storage.set(PAUSED, !paused)
        await tick()
        return paused ? 'Orcaffein resumed.' : 'Orcaffein paused; sleep is normal.'
      })
      api.commands.register('check-setup', () => checkSetup())
      disposables.push(
        api.events.on('agent.status.changed', async (event) => {
          // Only a start matters right away; stops are handled by the idle timer and the poll.
          if (event.state !== 'working') return
          await api.storage.set(LAST_ACTIVE, now())
          if (last?.want !== 'awake') soon()
        }),
        api.settings.onDidChange(() => soon(0))
      )
      void (async () => {
        try {
          const config = await readSettings()
          pollSeconds = config.pollSeconds
        } catch {
          // keep the default
        }
        setupOk = system.supported ? await system.sudoReady().catch(() => false) : false
        schedulePoll()
        soon(startDelayMs)
      })()
    },

    async deactivate(): Promise<void> {
      stopped = true
      if (pollTimer) clearInterval(pollTimer)
      if (pendingTimer) clearTimeout(pendingTimer)
      pollTimer = pendingTimer = null
      for (const d of disposables.splice(0)) d.dispose()
      watch(false)
      // Orca allows 2 s to stop: don't wait on a slow `orca agent list`.
      system.cancelQueries()
      await running?.catch(() => null)
      // Skip sudo when sleep is already normal (keeps the log clean without the drop-in).
      if (system.supported && (await system.sleepDisabled().catch(() => null)) !== false)
        await restore()
      else system.stopWatchdog()
      orca = null
    },

    tick,
    get last() {
      return last
    }
  }
}

const worker = createWorker({ system: macSystem() })

export default function activate(orca: OrcaWorkerApi): void {
  worker.activate(orca)
}

export function deactivate(): Promise<void> {
  return worker.deactivate()
}
