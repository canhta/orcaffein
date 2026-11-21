import { assert, test } from 'orca/testing'
import { clampSettings, decide, DEFAULT_SETTINGS, type Inputs } from './decide.ts'

const MIN = 60_000
const NOW = 1_800_000_000_000

function input(over: Partial<Inputs> = {}): Inputs {
  return {
    working: 0,
    onAC: true,
    lidClosed: false,
    sleepDisabled: false,
    now: NOW,
    lastActive: null,
    paused: false,
    setupOk: true,
    settings: DEFAULT_SETTINGS,
    ...over
  }
}

test('working agents keep the Mac awake and refresh lastActive', () => {
  const d = decide(input({ working: 3 }))
  assert.equal(d.want, 'awake')
  assert.equal(d.apply, 'set-awake')
  assert.equal(d.lastActive, NOW)
  assert.equal(d.status.text, 'Awake 3')
})

test('one agent reads singular in the tooltip', () => {
  assert.match(decide(input({ working: 1 })).status.tooltip, /^1 agent working/)
})

test('already awake: nothing to apply', () => {
  assert.equal(decide(input({ working: 1, sleepDisabled: true })).apply, 'none')
})

test('within the idle window: stay awake and show idle time', () => {
  const d = decide(input({ lastActive: NOW - 12 * MIN - 30_000, sleepDisabled: true }))
  assert.equal(d.want, 'awake')
  assert.equal(d.apply, 'none')
  assert.equal(d.status.text, 'Idle 12/60m')
})

test('idle window over, lid open: restore, no sleepnow', () => {
  const d = decide(input({ lastActive: NOW - 60 * MIN, sleepDisabled: true }))
  assert.equal(d.want, 'normal')
  assert.equal(d.apply, 'set-normal')
  assert.equal(d.sleepNow, false)
  assert.equal(d.reason, 'expired')
  assert.equal(d.status.text, 'Sleep')
})

test('idle window over, lid closed: restore and sleep now', () => {
  const d = decide(input({ lastActive: NOW - 61 * MIN, sleepDisabled: true, lidClosed: true }))
  assert.equal(d.apply, 'set-normal')
  assert.equal(d.sleepNow, true)
})

test('lid closed but we were not holding it awake: no sleepnow', () => {
  const d = decide(input({ lastActive: NOW - 61 * MIN, sleepDisabled: false, lidClosed: true }))
  assert.equal(d.sleepNow, false)
  assert.equal(d.apply, 'none')
})

test('battery wins over working agents', () => {
  const d = decide(input({ working: 2, onAC: false, sleepDisabled: true, lidClosed: true }))
  assert.equal(d.want, 'normal')
  assert.equal(d.reason, 'battery')
  assert.equal(d.sleepNow, true)
  assert.equal(d.lastActive, NOW, 'activity is still recorded')
})

test('unknown power counts as battery', () => {
  assert.equal(decide(input({ working: 1, onAC: null })).reason, 'battery')
})

test('allowOnBattery keeps it awake on battery', () => {
  const d = decide(
    input({ working: 1, onAC: false, settings: { ...DEFAULT_SETTINGS, allowOnBattery: true } })
  )
  assert.equal(d.want, 'awake')
})

test('paused restores sleep', () => {
  const d = decide(input({ working: 2, paused: true, sleepDisabled: true }))
  assert.equal(d.want, 'normal')
  assert.equal(d.status.text, 'Paused')
})

test('mode off never holds the Mac awake', () => {
  const d = decide(input({ working: 2, settings: { ...DEFAULT_SETTINGS, mode: 'off' } }))
  assert.equal(d.want, 'normal')
  assert.equal(d.reason, 'off')
})

test('mode on stays awake on AC without agents', () => {
  const d = decide(input({ settings: { ...DEFAULT_SETTINGS, mode: 'on' } }))
  assert.equal(d.want, 'awake')
  assert.equal(d.status.text, 'Awake')
})

test('unknown SleepDisabled is restored when normal', () => {
  assert.equal(decide(input({ sleepDisabled: null })).apply, 'set-normal')
})

test('unknown agent count does not hold awake on its own and shows a warning', () => {
  const d = decide(input({ working: null }))
  assert.equal(d.want, 'normal')
  assert.equal(d.status.text, 'Agents ?')
  assert.equal(d.status.tone, 'warning')
})

test('unknown agent count keeps a running idle window', () => {
  const d = decide(input({ working: null, lastActive: NOW - 5 * MIN }))
  assert.equal(d.want, 'awake')
  assert.equal(d.status.tone, 'warning')
})

test('missing sudoers shows setup needed', () => {
  const d = decide(input({ working: 1, setupOk: false }))
  assert.equal(d.status.text, 'Setup')
  assert.equal(d.status.tone, 'danger')
})

test('missing sudoers is not shown while paused', () => {
  assert.equal(decide(input({ setupOk: false, paused: true })).status.text, 'Paused')
})

test('a lastActive in the future does not hold the Mac awake', () => {
  assert.equal(decide(input({ lastActive: NOW + 10 * MIN })).want, 'normal')
})

test('clampSettings fills defaults and clamps', () => {
  assert.deepEqual(clampSettings({}), DEFAULT_SETTINGS)
  assert.deepEqual(clampSettings({ mode: 'bogus', idleMinutes: 0, allowOnBattery: 'yes' }), {
    mode: 'agent',
    idleMinutes: 1,
    allowOnBattery: false
  })
  assert.equal(clampSettings({ idleMinutes: 99999 }).idleMinutes, 1440)
})

test('setup-needed tooltip does not claim the Mac is kept awake', () => {
  const tip = decide(input({ working: 3, setupOk: false })).status.tooltip
  assert.ok(!/awake, lid closed/.test(tip))
  assert.match(tip, /sleep is unchanged \(would be: Awake 3\)/)
})
