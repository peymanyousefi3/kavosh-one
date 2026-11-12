#!/bin/sh
set -eu
test "$(id -u)" = 0
test "$(uname -m)" = x86_64
test ! -e /opt/kavosh-one-tools
task_directory=$(mktemp -d /var/tmp/kavosh-one-tools.XXXXXXXX)
chmod 700 "$task_directory"
cd "$task_directory"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-time 120 https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-amd64.tar.gz -o age.tar.gz
printf '%s\n' 'cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10  age.tar.gz' | sha256sum --check --strict
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-time 120 https://downloads.rclone.org/v1.75.2/rclone-v1.75.2-linux-amd64.zip -o rclone.zip
printf '%s\n' '349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702  rclone.zip' | sha256sum --check --strict
tar -xzf age.tar.gz age/age age/age-keygen
unzip -q rclone.zip rclone-v1.75.2-linux-amd64/rclone
install -d -o root -g root -m 755 /opt/kavosh-one-tools
install -o root -g root -m 755 age/age age/age-keygen rclone-v1.75.2-linux-amd64/rclone /opt/kavosh-one-tools/
/opt/kavosh-one-tools/age --version
/opt/kavosh-one-tools/rclone version
# Keep the verified download artifacts for this installation's provenance.
printf 'Verified vendor downloads retained at %s\n' "$task_directory"
