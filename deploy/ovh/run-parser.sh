#!/bin/sh
# Credential-free native parser only. No host network, exposed port or host
# filesystem except its own private socket directory. Tags name tested sources.
set -eu
test "$(id -u)" = 0
test "$#" = 1
task_kind=$1
case "$task_kind" in
 image|pdf) task_uid=10002; task_tmp=16m; task_init= ;;
 video) task_uid=10003; task_tmp=160m; task_init=--init ;;
 *) exit 64 ;;
esac
task_image=localhost/kavosh-one-$task_kind:e0fa615
# Tested PR merge a04355d has exactly the 65a9efc source tree. Keep the
# unchanged PDF/video runtimes on their existing pins; never retag e0fa615.
if [ "$task_kind" = image ]; then
 task_image=localhost/kavosh-one-image:a04355d4a1c5c25974fd0e7d7f10fc9b7b030537
fi
task_socket=/run/kavosh-one-parser-$task_kind
test -d "$task_socket"
test ! -L "$task_socket"
chown "$task_uid:10001" "$task_socket"
chmod 0750 "$task_socket"
exec /usr/bin/podman run --name "kavosh-one-parser-$task_kind" \
 --cidfile "/run/kavosh-one-parser-$task_kind-control/container.cid" \
 --pull=never --network=none --read-only --cap-drop=ALL \
 --security-opt=no-new-privileges --security-opt=apparmor=kavosh-one-parser \
 --memory=1g --memory-swap=1g --cpus=0.5 --pids-limit=64 \
 --user "$task_uid:10001" --mount "type=bind,source=$task_socket,target=/run/kavosh-$task_kind" \
 --mount "type=tmpfs,target=/tmp,tmpfs-size=$task_tmp,tmpfs-mode=0700,U=true,noexec,nosuid,nodev" \
 --entrypoint /usr/bin/env $task_init "$task_image" \
 -i NODE_ENV=production TZ=UTC PATH=/usr/bin:/bin /usr/bin/node "scripts/$task_kind-validator-service.js"
