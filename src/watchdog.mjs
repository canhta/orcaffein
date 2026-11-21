// Started detached by the worker while it holds the Mac awake. If the worker dies without
// running deactivate() (Orca crashed or was force-quit), give sleep back. The worker stops this
// process with SIGTERM once it has restored sleep itself.
import { execFile } from 'node:child_process'

const pid = Number(process.argv[2])
if (!Number.isInteger(pid) || pid <= 1) process.exit(2)

function alive() {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

process.on('SIGTERM', () => process.exit(0))

const timer = setInterval(() => {
  if (alive()) return
  clearInterval(timer)
  execFile(
    '/usr/bin/sudo',
    ['-n', '/usr/bin/pmset', '-a', 'disablesleep', '0'],
    { timeout: 5000, env: { PATH: '/usr/bin:/bin' } },
    () => process.exit(0)
  )
}, 2000)
