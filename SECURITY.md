# Security

Orcaffein asks for your Mac password once. This page lists everything that password allows and
everything the plugin runs.

## What runs as root

Setup shows the standard macOS password dialog (`osascript ... with administrator privileges`).
Orcaffein never sees the password. As root, setup does only this:

1. Writes one line to `/etc/sudoers.d/.orcaffein.tmp` with mode 0440, owned by root.
2. Checks it with `visudo -cf`. If the check fails, it deletes the file and stops.
3. Moves it to `/etc/sudoers.d/orcaffein`.

The line lets your user run three commands as root without a password:

```
/usr/bin/pmset -a disablesleep 0
/usr/bin/pmset -a disablesleep 1
/usr/bin/pmset sleepnow
```

sudo matches the arguments exactly, so other `pmset` options and other commands still need a
password. Any program running as your user can also run these three. The worst it can do with
them is keep the Mac awake or put it to sleep.

The code is in [`src/system.ts`](src/system.ts) (`INSTALL_SCRIPT`, `sudoersEntry`).

## What runs without root

All by absolute path, with fixed arguments, never through a shell string:

| Command | Why |
| --- | --- |
| `/Applications/Orca.app/.../bin/orca agent list --state working --json` | Count working agents |
| `/usr/bin/pmset -g`, `-g batt`, `-g pslog` | Read sleep setting and power source |
| `/usr/sbin/ioreg -r -k AppleClamshellState -d 1` | Read lid state |
| `/usr/sbin/system_profiler SPDisplaysDataType -json` | Check for an external monitor |
| `/usr/bin/pmset displaysleepnow` | Turn the screen off under a closed lid |
| `/usr/bin/sudo -n -l <command>` | Check setup without running anything |
| `/bin/sh src/watchdog.sh <pid>` | Give sleep back if Orca crashes |

No network requests and no telemetry. Apart from the sudoers rule above, it writes no files.

## Removing access

```sh
sudo pmset -a disablesleep 0
sudo rm /etc/sudoers.d/orcaffein
```

## Reporting a problem

Open an issue at https://github.com/canhta/orcaffein/issues. For anything you would rather not
post in public, use GitHub's private vulnerability reporting on this repository.
