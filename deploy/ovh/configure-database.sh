#!/bin/sh
# Explicit fresh-host installation, not a general migration/upgrade command.
set -eu
test "$(id -u)" = 0
test ! -e /etc/kavosh-one-tls
test "$(runuser -u postgres -- psql -X -At -d postgres -c "SELECT count(*) FROM pg_database WHERE datname NOT IN ('postgres','template0','template1')")" = 0
install -d -o root -g postgres -m 750 /etc/kavosh-one-tls
openssl req -x509 -newkey rsa:3072 -nodes -days 365 -sha256 \
 -subj /CN=KavoshOneLocalPostgres \
 -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost' \
 -addext 'extendedKeyUsage=serverAuth' \
 -keyout /etc/kavosh-one-tls/server.key -out /etc/kavosh-one-tls/server.crt 2>/dev/null
chown root:postgres /etc/kavosh-one-tls/server.key
chmod 640 /etc/kavosh-one-tls/server.key
chmod 644 /etc/kavosh-one-tls/server.crt
# The certificate is public; only its containing directory needs traversal by
# the application. The private key remains root/postgres only.
chmod 755 /etc/kavosh-one-tls
cp -p /etc/postgresql/18/main/pg_hba.conf /etc/postgresql/18/main/pg_hba.before-kavosh-one
install -o postgres -g postgres -m 640 /srv/kavosh-one/deploy/pg_hba.conf /etc/postgresql/18/main/pg_hba.conf
node /srv/kavosh-one/deploy/configure-postgres.mjs
systemctl restart postgresql@18-main
systemctl is-active postgresql@18-main
