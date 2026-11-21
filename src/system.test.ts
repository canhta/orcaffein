import { assert, test } from 'orca/testing'
import {
  countWorking,
  parseLidClosed,
  parseOnAC,
  parseSleepDisabled,
  sudoersEntry,
  hasExternalDisplay,
  parsePowerSource
} from './system.ts'

test('SleepDisabled is read from pmset -g, absent means 0', () => {
  assert.equal(parseSleepDisabled(' standby 1\n SleepDisabled\t\t1\n sleep 1'), true)
  assert.equal(parseSleepDisabled(' SleepDisabled 0\n'), false)
  assert.equal(parseSleepDisabled(' standby 1\n sleep 1 (sleep prevented by powerd)\n'), false)
})

test('power source from pmset -g batt', () => {
  assert.equal(parseOnAC("Now drawing from 'AC Power'\n -InternalBattery-0 100%; charged"), true)
  assert.equal(
    parseOnAC("Now drawing from 'Battery Power'\n -InternalBattery-0 80%; discharging"),
    false
  )
})

test('lid state from ioreg', () => {
  assert.equal(
    parseLidClosed('  "AppleClamshellCausesSleep" = No\n  "AppleClamshellState" = Yes'),
    true
  )
  assert.equal(parseLidClosed('"AppleClamshellState" = No'), false)
  assert.throws(() => parseLidClosed('nothing'))
})

test('countWorking keeps only working agents', () => {
  const json = JSON.stringify({
    ok: true,
    result: {
      agents: [{ state: 'working' }, { state: 'waiting' }, { state: 'working' }, { state: 'done' }]
    }
  })
  assert.equal(countWorking(json), 2)
  assert.throws(() => countWorking('{"ok":false}'))
})

test('sudoers entry allows exactly the three pmset commands', () => {
  assert.equal(
    sudoersEntry('alice'),
    'alice ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset sleepnow'
  )
  assert.throws(() => sudoersEntry('bob ALL=(ALL) ALL'))
})

test('external display detection from system_profiler', () => {
  const internal = { spdisplays_connection_type: 'spdisplays_internal' }
  const hdmi = { spdisplays_connection_type: 'spdisplays_hdmi' }
  assert.equal(
    hasExternalDisplay(JSON.stringify({ SPDisplaysDataType: [{ spdisplays_ndrvs: [internal] }] })),
    false
  )
  assert.equal(
    hasExternalDisplay(
      JSON.stringify({ SPDisplaysDataType: [{ spdisplays_ndrvs: [internal, hdmi] }] })
    ),
    true
  )
  assert.equal(
    hasExternalDisplay(JSON.stringify({ SPDisplaysDataType: [{ spdisplays_ndrvs: [hdmi] }] })),
    true
  )
})

test('power source lines from pmset -g pslog', () => {
  assert.equal(parsePowerSource("Now drawing from 'AC Power'"), 'AC Power')
  assert.equal(parsePowerSource("Now drawing from 'Battery Power'"), 'Battery Power')
  assert.equal(parsePowerSource(' -InternalBattery-0 (id=1)\t100%; charged'), null)
})
