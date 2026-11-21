#!/bin/bash
# Installs the sudoers drop-in Orcaffein needs. Run it yourself, once:
#   ./scripts/install-sudoers.sh
# It asks for your password (sudo), validates the file with visudo, and only then installs it.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS only." >&2
  exit 1
fi

user="$(id -un)"
if [[ ! "$user" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Unexpected user name: $user" >&2
  exit 1
fi

target="/etc/sudoers.d/orcaffein"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

cat > "$tmp" <<EOF
# Orcaffein (https://github.com/canhta/orcaffein): toggle lid-closed sleep without a password.
$user ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset sleepnow
EOF

/usr/sbin/visudo -cf "$tmp"
sudo /usr/bin/install -m 0440 -o root -g wheel "$tmp" "$target"
sudo /usr/sbin/visudo -cf "$target"
echo "Installed $target"
echo "Check: sudo -n -l /usr/bin/pmset -a disablesleep 1"
