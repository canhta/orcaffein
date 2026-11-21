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
}

function fakeSystem(initial: Partial<State> = {}) {
  const state: State = { working: 0, onAC: true, lid: false, disabled: false, sudo: true, installResult: 'installed', ...initial }
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
  return { state, calls, system }
}

async function setup(opts: { state?: Partial<State>; storage?: Record<string, never | number | boolean>; settings?: Record<string, never | number | boolean | string>; now?: () => number } = {}) {
  const fake = fakeSystem(opts.state)
  const w = createWorker({ system: fake.system, now: opts.now ?? (() => NOW), startDelayMs: 60 * MIN })
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
  assert.deepEqual(calls, ['disablesleep 1', 'watchdog start'])
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
  const { w, worker, state, host } = await setup({ state: { working: 3, disabled: true, onAC: false } })
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
  const { w, worker, host, state } = await setup({ state: { working: new Error('no orca'), disabled: true } })
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
  const { w, worker, host } = await setup({ state: { working: 1, sudo: false, installResult: 'cancelled' } })
  await w.tick()
  assert.equal(await worker.command('toggle-pause'), 'Setup cancelled.')
  assert.equal(lastStatus(host).text, 'Setup')
  await worker.deactivate()
})
