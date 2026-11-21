# Orcaffein

An [Orca](https://github.com/stablyai/orca) plugin that keeps a MacBook awake with the lid closed
while Orca agents are working, and gives sleep back when they stop. macOS only.

Not made or endorsed by the Orca team.

## What it does

- An agent is `working` in any local Orca workspace (chat or terminal): the Mac stays awake, lid
  closed too.
- No agent has worked for N minutes (default 60): sleep goes back to normal. If the lid is closed
  at that moment, the Mac sleeps right away.
- The Mac is on battery: sleep goes back to normal at once (unless you allow battery).
- `waiting`, `blocked` and `done` agents do not count.
- The plugin stops (Orca quits, plugin disabled or updated): sleep goes back to normal. If Orca
  crashes, a small watchdog process does it within a few seconds.

Status bar: `Awake 3` (agents working), `Idle 12/60m`, `Sleep`, `Paused`, `Setup`, `Agents ?`.
Hover for details. Click to pause or resume; while it shows `Setup`, click to set up.

Palette commands: **Orcaffein: Pause or resume**, **Orcaffein: Check setup** (sudoers, power,
lid, `SleepDisabled`, working agent count).

## Orca's own "Keep computer awake"

Orca has a built-in On / Agent / Off setting. On macOS it uses `caffeinate`, which stops idle
sleep but cannot stop sleep when the lid closes. Orcaffein covers that case. You can use both;
the plugin's **Mode** setting has the same three choices:

| Mode            | Orcaffein                                                        |
| --------------- | ---------------------------------------------------------------- |
| Agent (default) | Awake while an agent works, then for the idle time               |
| On              | Awake whenever on AC power (or always, with battery allowed)     |
| Off             | Never changes sleep                                              |

Plugins cannot read Orca's built-in setting, so set the two separately.

## Why `disablesleep` and sudo

On macOS only `pmset -a disablesleep 1` stops lid-close sleep, and it needs root. The plugin
never asks for a password on its own. It runs `sudo -n` with fixed arguments, and you allow those
exact commands once with a sudoers drop-in. Without it the status bar shows `Setup` and nothing
changes.

## Install

1. Install the plugin: `orca plugin install canhta/orcaffein` (or from Orca's plugin directory),
   and approve the access it asks for.
2. Click **Setup** in the status bar and enter your password in the macOS dialog. This writes
   the sudoers drop-in below, checked with `visudo` first. Once.

Manual setup instead of step 2 (replace `YOUR_USER` with `id -un`):

```sh
echo 'YOUR_USER ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset sleepnow' > /tmp/orcaffein
visudo -cf /tmp/orcaffein
sudo install -m 0440 -o root -g wheel /tmp/orcaffein /etc/sudoers.d/orcaffein
sudo visudo -cf /etc/sudoers.d/orcaffein
rm /tmp/orcaffein
```

or run `./scripts/install-sudoers.sh` from a clone of this repo.

Check: `sudo -n -l /usr/bin/pmset -a disablesleep 1` prints the command and exits 0, or run
**Orcaffein: Check setup** from the command palette.

## What the sudoers line allows

Only these three commands, as root, without a password, for your user:

- `/usr/bin/pmset -a disablesleep 0`
- `/usr/bin/pmset -a disablesleep 1`
- `/usr/bin/pmset sleepnow`

sudoers matches the arguments exactly, so other `pmset` settings still need a password. Any
process running as your user can run these three, so it could keep the Mac awake or put it to
sleep. It cannot do anything else as root.

## Settings

| Setting           | Default                                             |
| ----------------- | --------------------------------------------------- |
| Mode              | Agent                                               |
| Idle minutes      | 60                                                  |
| Poll interval     | 60 s (an agent starting is picked up at once too)   |
| Allow on battery  | Off                                                 |
| Orca CLI path     | `/Applications/Orca.app/Contents/Resources/bin/orca` |

Agents are counted with `orca agent list --state working --json`, which covers chats and
terminals in every local workspace. The last-active time is kept in plugin storage, so restarting
the worker does not reset the idle timer.

## Access it asks for

- `trusted-worker`: a Node process that runs `pmset`, `ioreg`, `sudo -n` and the `orca` CLI
  (always by absolute path, with fixed arguments, never through a shell).
- `settings:own`, `storage:own`: its settings, the last-active time and the pause flag.
- `agent:read`: hear agent status changes, to react before the next poll.

## Heat warning

A closed MacBook running agents in a bag or on a soft surface gets hot. Keep it on a hard surface
with airflow. The battery rule exists so an unplugged Mac goes back to sleep.

## Uninstall

1. Disable or uninstall the plugin in Orca (this restores sleep).
2. Make sure sleep is back to normal: `sudo pmset -a disablesleep 0`. `pmset -g` should not
   list `SleepDisabled 1`.
3. Remove the drop-in: `sudo rm /etc/sudoers.d/orcaffein`.

## Development

```sh
orca plugin types .
npx -p typescript tsc -p .
orca plugin test .
orca plugin check .
orca plugin validate .
```

The policy is a pure function in `src/decide.ts`; system calls sit behind the `System` interface
in `src/system.ts` so tests use a fake.

## License

MIT
