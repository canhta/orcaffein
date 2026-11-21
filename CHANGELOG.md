# Changelog

## 0.1.0

- Keeps a Mac awake with the lid closed while Orca agents work (`pmset -a disablesleep` through
  a narrow sudoers drop-in), and gives sleep back after an idle timeout, on battery, on pause,
  or when the plugin stops. A watchdog restores sleep if Orca crashes.
- Agent / On / Off modes, idle minutes, poll interval, allow on battery.
- Status bar item (`Awake 3`, `Idle 12/60m`, `Sleep`, `Paused`, `Setup`); click to pause, or
  to set up via the macOS password dialog.
- Palette command to check setup.
