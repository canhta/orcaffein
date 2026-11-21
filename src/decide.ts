// The whole policy as one pure function: no I/O, no clocks. The worker gathers the inputs,
// calls decide(), and applies what comes back.

export type Mode = 'agent' | 'on' | 'off'

export type Settings = {
  mode: Mode
  idleMinutes: number
  allowOnBattery: boolean
}

export const DEFAULT_SETTINGS: Settings = { mode: 'agent', idleMinutes: 60, allowOnBattery: false }

export type Inputs = {
  /** Agents in the `working` state across all workspaces; null when they could not be counted. */
  working: number | null
  /** null when the power source could not be read; treated as battery (fail safe). */
  onAC: boolean | null
  /** null when unknown; never triggers an immediate sleep. */
  lidClosed: boolean | null
  /** Current `SleepDisabled`; null when unknown. */
  sleepDisabled: boolean | null
  now: number
  /** Last time an agent was seen working (ms epoch), persisted across worker restarts. */
  lastActive: number | null
  paused: boolean
  /** False when the sudoers drop-in is missing: the plugin can never hold the Mac awake. */
  setupOk: boolean
  settings: Settings
}

export type Reason =
  | 'paused'
  | 'off'
  | 'battery'
  | 'working'
  | 'idle'
  | 'always'
  | 'expired'
  | 'no-activity'

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
export type Icon = 'zap' | 'pause' | 'warning' | 'check' | 'error'

export type Status = { text: string; tone: Tone; icon: Icon; tooltip: string }

export type Decision = {
  /** awake: `disablesleep 1`; normal: `disablesleep 0`. */
  want: 'awake' | 'normal'
  /** Run `pmset sleepnow` after restoring sleep (lid closed and we were holding it awake). */
  sleepNow: boolean
  /** Lid closed while kept awake: turn the built-in display off, or it stays lit under the lid. */
  displayOff: boolean
  /** Only set `disablesleep` when the current value differs (or is unknown). */
  apply: 'set-awake' | 'set-normal' | 'none'
  lastActive: number | null
  reason: Reason
  status: Status
}

const MINUTE = 60_000

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function clampSettings(raw: Partial<Record<keyof Settings, unknown>>): Settings {
  const mode = raw.mode === 'on' || raw.mode === 'off' || raw.mode === 'agent' ? raw.mode : 'agent'
  const idle = Number(raw.idleMinutes)
  return {
    mode,
    idleMinutes: Number.isFinite(idle) ? Math.min(1440, Math.max(1, Math.round(idle))) : 60,
    allowOnBattery: raw.allowOnBattery === true
  }
}

export function decide(input: Inputs): Decision {
  const { settings, now } = input
  const working = input.working ?? 0
  const lastActive = working > 0 ? now : input.lastActive
  const onAC = input.onAC === true
  const idleMs = settings.idleMinutes * MINUTE

  let want: Decision['want'] = 'normal'
  let reason: Reason

  if (input.paused) {
    reason = 'paused'
  } else if (settings.mode === 'off') {
    reason = 'off'
  } else if (!onAC && !settings.allowOnBattery) {
    reason = 'battery'
  } else if (settings.mode === 'on') {
    want = 'awake'
    reason = 'always'
  } else if (working > 0) {
    want = 'awake'
    reason = 'working'
  } else if (lastActive !== null && now - lastActive < idleMs && now >= lastActive) {
    want = 'awake'
    reason = 'idle'
  } else {
    reason = lastActive === null ? 'no-activity' : 'expired'
  }

  // Without the drop-in we cannot hold the Mac awake; restoring is still attempted (it fails
  // harmlessly), so the decision stays the same and only the status changes.
  const apply: Decision['apply'] =
    want === 'awake'
      ? input.sleepDisabled === true
        ? 'none'
        : 'set-awake'
      : input.sleepDisabled === false
        ? 'none'
        : 'set-normal'

  // Giving sleep back with the lid shut does not put the Mac to sleep by itself: do it now, but
  // only when we were holding it awake and know the lid is closed.
  const sleepNow = want === 'normal' && input.sleepDisabled === true && input.lidClosed === true

  const displayOff = want === 'awake' && input.lidClosed === true

  return {
    want,
    sleepNow,
    displayOff,
    apply,
    lastActive,
    reason,
    status: statusFor(input, reason, working, lastActive)
  }
}

function statusFor(
  input: Inputs,
  reason: Reason,
  working: number,
  lastActive: number | null
): Status {
  const base = baseStatus(input, reason, working, lastActive)
  if (input.setupOk || reason === 'paused' || reason === 'off') return base
  return {
    text: 'Setup',
    tone: 'danger',
    icon: 'warning',
    tooltip: `Not set up, sleep is unchanged (would be: ${base.text}). Click to set up; macOS asks for your password.`
  }
}

// Status bar text stays a word or two; the tooltip carries the detail.
function baseStatus(
  input: Inputs,
  reason: Reason,
  working: number,
  lastActive: number | null
): Status {
  const unknownAgents =
    input.working === null && reason !== 'paused' && reason !== 'off' && reason !== 'battery'
  const cli = unknownAgents ? ' Could not count agents: check the Orca CLI path setting.' : ''
  switch (reason) {
    case 'paused':
      return {
        text: 'Paused',
        tone: 'neutral',
        icon: 'pause',
        tooltip: 'Paused, sleep is normal. Click to resume.'
      }
    case 'off':
      return {
        text: 'Sleep',
        tone: 'neutral',
        icon: 'check',
        tooltip: 'Mode is Off, sleep is normal.'
      }
    case 'battery':
      return {
        text: 'Sleep',
        tone: 'neutral',
        icon: 'check',
        tooltip: 'On battery, sleep is normal.'
      }
    case 'always':
      return {
        text: 'Awake',
        tone: 'success',
        icon: 'zap',
        tooltip: 'Mode is On: awake on AC, lid closed too. Click to pause.'
      }
    case 'working':
      return {
        text: `Awake ${working}`,
        tone: 'success',
        icon: 'zap',
        tooltip: `${plural(working, 'agent')} working: awake, lid closed too. Click to pause.`
      }
    case 'idle': {
      const idle = Math.floor((input.now - (lastActive ?? input.now)) / MINUTE)
      const total = input.settings.idleMinutes
      return {
        text: `Idle ${idle}/${total}m`,
        tone: unknownAgents ? 'warning' : 'accent',
        icon: unknownAgents ? 'warning' : 'zap',
        tooltip: `No agent working for ${idle} min, sleep returns at ${total} min.${cli} Click to pause.`
      }
    }
    default:
      return {
        text: unknownAgents ? 'Agents ?' : 'Sleep',
        tone: unknownAgents ? 'warning' : 'neutral',
        icon: unknownAgents ? 'warning' : 'check',
        tooltip: `No agent working, sleep is normal.${cli}`
      }
  }
}
