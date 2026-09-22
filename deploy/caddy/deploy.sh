#!/usr/bin/env bash
# Выкатка Caddyfile на прод. Запускается НА СЕРВЕРЕ от root:
#     scp deploy/caddy/{Caddyfile,deploy.sh} alphavps:/tmp/ && ssh alphavps 'bash /tmp/deploy.sh /tmp/Caddyfile'
set -euo pipefail

SRC="${1:-$(dirname "$0")/Caddyfile}"
SECRET=/etc/caddy/secrets/grafana-auth.caddy
LIVE=/etc/caddy/Caddyfile
BAK="/etc/caddy/Caddyfile.bak.$(date +%Y%m%d-%H%M%S)"

[ -f "$SRC" ] || { echo "нет исходника: $SRC"; exit 1; }
[ -f "$SECRET" ] || { echo "нет $SECRET — пароль Grafana не в репозитории, см. README.md"; exit 1; }
# конфиг читает демон под пользователем caddy, а не root: при root:root 600
# validate проходит, а reload падает
sudo -u caddy test -r "$SECRET" || { echo "$SECRET не читается пользователем caddy — chown root:caddy, chmod 640"; exit 1; }

cp -a "$LIVE" "$BAK"
cp "$SRC" "$LIVE"
chown root:root "$LIVE"; chmod 644 "$LIVE"

if ! caddy validate --config "$LIVE" 2>&1 | tail -3; then
  echo "validate упал — откат на $BAK"
  cp -a "$BAK" "$LIVE"
  exit 1
fi

systemctl reload caddy
sleep 2
systemctl is-active caddy
echo "готово, бэкап: $BAK"
