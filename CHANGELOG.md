# Changelog

## 0.1.1

- Turns the built-in screen off within about 10 seconds of closing the lid. Before, it could stay
  lit under the lid.
- Unplugging the charger with the lid closed puts the Mac to sleep at once, not on the next check.
- One-click setup: click `Setup` in the status bar and enter your Mac password.
- Shorter status bar text: `Awake 3`, `Idle 12/60m`, `Sleep`, `Paused`, `Setup`.
- Uses less CPU: agents are counted once a minute instead of on every status change.
- Stops within Orca's 2-second shutdown window, so sleep is always given back on quit.
- The crash watchdog is now a small shell script (about 2 MB instead of 25 MB).
- Icon, cover image and screenshot for the plugin directory.

## 0.1.0

First release.
