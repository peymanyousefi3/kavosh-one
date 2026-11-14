#!/bin/bash
# Fixed local cluster, password-free export; no network or user switching.
set -euo pipefail
umask 077
test "$(id -un)" = postgres
test "$(/usr/bin/psql -X -At -d postgres -c "SELECT count(*) FROM pg_database WHERE datname NOT IN ('kavosh_one','postgres','template0','template1')")" = 0
/usr/bin/pg_dumpall --roles-only --no-role-passwords --no-password --host=/var/run/postgresql --port=5432 > /run/kavosh-one-role-export/roles.sql.next
mv -- /run/kavosh-one-role-export/roles.sql.next /run/kavosh-one-role-export/roles.sql
