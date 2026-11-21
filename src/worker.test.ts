import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { SetupError, type System } from './system.ts'
import { createWorker } from './worker.ts'

const NOW = 1_800_000_000_000
const MIN = 60_000

type State = {
  working: number | Error
  onAC: boolean
  lid: boolean
  disabled: boolean
  sudo: boolean
  installResult: 'installed' | 'cancelled' | 'failed'
  external: boolean
}

function fakeSystem(initial: Partial<State> = {}) {
  const fake = { powerChanged: null as null | (() => void), cancelled: 0 }
  const state: State = {
    working: 0,
    onAC: true,
    lid: false,
    disabled: false,
    sudo: true,
    installResult: 'installed',
    external: false,
    ...initial
  }
  const calls: string[] = []
  const system: System = {
    supported: true,
    async workingAgents() {
      if (state.working instanceof Error) throw state.working
      return state.working
    },
    async onAC() {
      return state.onAC
    },
    async lidClosed() {
      return state.lid
    },
    async sleepDisabled() {
      return state.disabled
    },
    async setSleepDisabled(value) {
      calls.push(`disablesleep ${value ? 1 : 0}`)
      if (!state.sudo) throw new SetupError('a password is required')
      state.disabled = value
    },
    async sleepNow() {
      calls.push('sleepnow')
    },
    async externalDisplay() {
      return state.external
    },
    async displaySleepNow() {
      calls.push('display off')
    },
    watchPower(onChange) {
      calls.push('power watch')
      fake.powerChanged = onChange
      return {
        stop() {
          calls.push('power unwatch')
          fake.powerChanged = null
        }
      }
    },
    cancelQueries() {
      fake.cancelled++
    },
    async sudoReady() {
      return state.sudo
    },
    async installSudoers() {
      calls.push('install sudoers')
      if (state.installResult === 'installed') state.sudo = true
      return state.installResult
    },
    startWatchdog() {
      calls.push('watchdog start')
    },
    stopWatchdog() {
      calls.push('watchdog stop')
    }
  }
  return { state, calls, system, fake }
}

async function setup(
  opts: {
    state?: Partial<State>
    storage?: Record<string, never | number | boolean>
    settings?: Record<string, never | number | boolean | string>
    now?: () => number
  } = {}
) {
  const fake = fakeSystem(opts.state)
  const w = createWorker({
    system: fake.system,
    now: opts.now ?? (() => NOW),
    startDelayMs: 60 * MIN
  })
  const host = mockHost({ storage: opts.storage ?? {}, settings: opts.settings ?? {} })
  const worker = await mountWorker({ default: w.activate, deactivate: w.deactivate }, { host })
  return { ...fake, w, worker, host }
}

function lastStatus(host: ReturnType<typeof mockHost>): { text?: string; tone?: string } {
  const calls = host.callsOf('statusBar.update')
  return (calls[calls.length - 1] ?? {}) as { text?: string; tone?: string }
}

test('working agents: disable sleep, start watchdog, persist lastActive', async () => {
  const { w, worker, host, calls, state } = await setup({ state: { working: 2 } })
  const d = await w.tick()
  assert.equal(d?.want, 'awake')
  assert.equal(state.disabled, true)
  assert.deepEqual(calls, ['disablesleep 1', 'watchdog start', 'power watch'])
  assert.equal(host.data().storage.lastActive, NOW)
  assert.equal(lastStatus(host).text, 'Awake 2')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
  assert.equal(state.disabled, false, 'deactivate gives sleep back')
})

test('lastActive survives a restart: idle window continues from storage', async () => {
  const { w, worker, host } = await setup({
    state: { disabled: true },
    storage: { lastActive: NOW - 20 * MIN }
  })
  await w.tick()
  assert.equal(lastStatus(host).text, 'Idle 20/60m')
  await worker.deactivate()
})

test('idle expired with lid closed: restore then sleepnow', async () => {
  const { w, worker, calls, state } = await setup({
    state: { disabled: true, lid: true },
    storage: { lastActive: NOW - 61 * MIN }
  })
  await w.tick()
  assert.equal(state.disabled, false)
  assert.deepEqual(calls, ['watchdog stop', 'disablesleep 0', 'sleepnow'])
  await worker.deactivate()
})

test('on battery: restore at once', async () => {
  const { w, worker, state, host } = await setup({
    state: { working: 3, disabled: true, onAC: false }
  })
  await w.tick()
  assert.equal(state.disabled, false)
  assert.equal(lastStatus(host).text, 'Sleep')
  await worker.deactivate()
})

test('missing sudoers: setup needed, never throws', async () => {
  const { w, worker, host, calls } = await setup({ state: { working: 1, sudo: false } })
  await w.tick()
  assert.equal(lastStatus(host).text, 'Setup')
  assert.ok(calls.includes('disablesleep 1'))
  assert.ok(!calls.includes('watchdog start'))
  await worker.deactivate()
})

test('CLI failure does not hold the Mac awake', async () => {
  const { w, worker, host, state } = await setup({
    state: { working: new Error('no orca'), disabled: true }
  })
  await w.tick()
  assert.equal(state.disabled, false)
  assert.equal(lastStatus(host).text, 'Agents ?')
  await worker.deactivate()
})

test('toggle-pause command flips pause and restores sleep', async () => {
  const { worker, host, state } = await setup({ state: { working: 1 } })
  assert.equal(await worker.command('toggle-pause'), 'Orcaffein paused; sleep is normal.')
  assert.equal(host.data().storage.paused, true)
  assert.equal(state.disabled, false)
  assert.equal(lastStatus(host).text, 'Paused')
  assert.equal(await worker.command('toggle-pause'), 'Orcaffein resumed.')
  assert.equal(state.disabled, true)
  await worker.deactivate()
})

test('agent.status.changed working records activity at once', async () => {
  const { worker, host } = await setup()
  await worker.emit('agent.status.changed', {
    workspaceId: null,
    paneKey: 'p1',
    state: 'working',
    receivedAt: NOW
  })
  assert.equal(host.data().storage.lastActive, NOW)
  await worker.deactivate()
})

test('check-setup reports each part', async () => {
  const { worker } = await setup({ state: { working: 2, lid: true } })
  const report = String(await worker.command('check-setup'))
  assert.match(report, /sudoers: ok/)
  assert.match(report, /power: AC/)
  assert.match(report, /lid: closed/)
  assert.match(report, /working agents: 2/)
  await worker.deactivate()
})

test('mode off from settings leaves sleep alone', async () => {
  const { w, worker, state } = await setup({ state: { working: 2 }, settings: { mode: 'off' } })
  await w.tick()
  assert.equal(state.disabled, false)
  await worker.deactivate()
})

test('clicking Setup installs the drop-in, then keeps the Mac awake', async () => {
  const { w, worker, host, state, calls } = await setup({ state: { working: 1, sudo: false } })
  await w.tick()
  assert.equal(lastStatus(host).text, 'Setup')
  assert.equal(await worker.command('toggle-pause'), 'Orcaffein is set up.')
  assert.ok(calls.includes('install sudoers'))
  assert.equal(host.data().storage.paused, undefined, 'did not pause')
  assert.equal(state.disabled, true)
  assert.equal(lastStatus(host).text, 'Awake 1')
  await worker.deactivate()
})

test('cancelling Setup leaves things as they were', async () => {
  const { w, worker, host } = await setup({
    state: { working: 1, sudo: false, installResult: 'cancelled' }
  })
  await w.tick()
  assert.equal(await worker.command('toggle-pause'), 'Setup cancelled.')
  assert.equal(lastStatus(host).text, 'Setup')
  await worker.deactivate()
})

test('agent events trigger a recount only when not already awake', async () => {
  const fake = fakeSystem({ working: 1 })
  let counts = 0
  const count = fake.system.workingAgents
  fake.system.workingAgents = (cli) => {
    counts++
    return count(cli)
  }
  const w = createWorker({
    system: fake.system,
    now: () => NOW,
    startDelayMs: 60 * MIN,
    eventDebounceMs: 5
  })
  const worker = await mountWorker(
    { default: w.activate, deactivate: w.deactivate },
    { host: mockHost({}) }
  )
  const event = (state: 'working' | 'waiting') =>
    worker.emit('agent.status.changed', { workspaceId: null, paneKey: 'p', state, receivedAt: NOW })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

  await event('working')
  await settle()
  assert.equal(counts, 1, 'not awake yet: recount')
  await event('working')
  await event('waiting')
  await settle()
  assert.equal(counts, 1, 'already awake: no recount')
  await worker.deactivate()
})

test('lid closed while awake: built-in display is turned off', async () => {
  const { w, worker, calls } = await setup({ state: { working: 1, lid: true } })
  await w.tick()
  assert.deepEqual(calls, ['disablesleep 1', 'watchdog start', 'display off', 'power watch'])
  await worker.deactivate()
})

test('lid closed with an external monitor: display left alone', async () => {
  const { w, worker, calls } = await setup({ state: { working: 1, lid: true, external: true } })
  await w.tick()
  assert.ok(!calls.includes('display off'))
  await worker.deactivate()
})

test('lid open: display left alone', async () => {
  const { w, worker, calls } = await setup({ state: { working: 1 } })
  await w.tick()
  assert.ok(!calls.includes('display off'))
  await worker.deactivate()
})

test('unplugging while awake rechecks at once and gives sleep back', async () => {
  const { w, worker, state, fake, calls } = await setup({ state: { working: 2, lid: true } })
  await w.tick()
  assert.equal(state.disabled, true)
  state.onAC = false
  fake.powerChanged?.()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(state.disabled, false)
  assert.ok(calls.includes('sleepnow'), 'lid closed: sleeps now')
  assert.ok(calls.includes('power unwatch'), 'watcher stops once sleep is normal')
  await worker.deactivate()
})

test('closing the lid turns the screen off before the next poll', async () => {
  const fakeSys = fakeSystem({ working: 1 })
  const w = createWorker({
    system: fakeSys.system,
    now: () => NOW,
    startDelayMs: 60 * MIN,
    lidCheckMs: 5
  })
  const worker = await mountWorker(
    { default: w.activate, deactivate: w.deactivate },
    { host: mockHost({}) }
  )
  await w.tick()
  assert.ok(!fakeSys.calls.includes('display off'))
  fakeSys.state.lid = true
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.ok(fakeSys.calls.includes('display off'))
  await worker.deactivate()
})

test('the external display check runs once per lid close', async () => {
  const fakeSys = fakeSystem({ working: 1, lid: true })
  let checks = 0
  const check = fakeSys.system.externalDisplay
  fakeSys.system.externalDisplay = () => {
    checks++
    return check()
  }
  const w = createWorker({ system: fakeSys.system, now: () => NOW, startDelayMs: 60 * MIN })
  const worker = await mountWorker(
    { default: w.activate, deactivate: w.deactivate },
    { host: mockHost({}) }
  )
  await w.tick()
  await w.tick()
  assert.equal(checks, 1)
  fakeSys.state.lid = false
  await w.tick()
  fakeSys.state.lid = true
  await w.tick()
  assert.equal(checks, 2)
  await worker.deactivate()
})

test('deactivate cancels running queries and stops the watchers', async () => {
  const { w, worker, fake, calls } = await setup({ state: { working: 1 } })
  await w.tick()
  await worker.deactivate()
  assert.equal(fake.cancelled, 1)
  assert.ok(calls.includes('power unwatch'))
})
