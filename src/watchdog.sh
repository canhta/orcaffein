#!/bin/sh
# Started by the worker while it keeps the Mac awake. If the worker dies without cleaning up
# (Orca crashed or was force-quit), turn sleep back on. The worker kills this script itself
# after a normal stop.
pid="$1"
case "$pid" in ''|*[!0-9]*) exit 2 ;; esac
while kill -0 "$pid" 2>/dev/null; do /bin/sleep 2; done
exec /usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0
