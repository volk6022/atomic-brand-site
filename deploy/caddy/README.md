# Caddy — конфигурация прода

Единственный публичный вход на alphavps: TLS, маршруты к сервисам, статика сайта
и панели Radar. Бэкенды слушают только `127.0.0.1`, снаружи к ним хода нет.

| что | где |
| --- | --- |
| живой конфиг | `/etc/caddy/Caddyfile` на alphavps (systemd-сервис `caddy`) |
| истина (этот репозиторий) | `deploy/caddy/Caddyfile` |
| пароль Grafana | `/etc/caddy/secrets/grafana-auth.caddy`, **только на сервере** (`root:caddy 640`) |
| логи доступа | `/var/log/caddy/access.log` (json, ролл 64 МиБ × 6, 14 суток) |

## Почему пароль не здесь

Репозиторий публичный, а `basic_auth argon2id` — это хэш, который перебирается
офлайн. Поэтому блок вынесен в `import /etc/caddy/secrets/grafana-auth.caddy`;
файл создаётся руками. Права — `root:caddy`, `640` на файл и `750` на каталог:
демон читает конфиг уже под пользователем `caddy`, и при `root:root 600` reload
падает (`validate` от root при этом проходит — грабли).

```
mkdir -p /etc/caddy/secrets
caddy hash-password --algorithm argon2id     # спросит пароль, напечатает хэш
cat > /etc/caddy/secrets/grafana-auth.caddy <<'X'
basic_auth argon2id {
	ivan <хэш>
}
X
chown -R root:caddy /etc/caddy/secrets
chmod 750 /etc/caddy/secrets && chmod 640 /etc/caddy/secrets/grafana-auth.caddy
```

## Выкатка

```
scp deploy/caddy/Caddyfile deploy/caddy/deploy.sh alphavps:/tmp/
ssh alphavps 'bash /tmp/deploy.sh /tmp/Caddyfile'
```

Скрипт кладёт бэкап `Caddyfile.bak.<дата>`, подменяет файл, `caddy validate`,
`systemctl reload caddy`; при провале валидации откатывается сам. Reload не рвёт
соединения и не трогает сертификаты.

## Что раздаётся

| хост | что |
| --- | --- |
| `atomic-automation.net` | статика `/var/www/atomic`, `/` → `index.dc.html` |
| `www.*` | 301 на apex |
| `api.*` | `/intel/*` → :8000, `/engage/<client>/*` → :8101–8103, иначе 404 |
| `docs.*` | редирект на `/docs.dc.html` |
| `radar.*` | `/api/*` → :8104 (кроме `/api/v1/ingest/*` → 404), остальное — `/srv/atomic-brand-site` |
| `grafana.*` | basic_auth + :3000 |

**Добавить клиента Engage:** скопировать блок `handle_path /engage/<client>/*`,
порт взять из `fleet_manager/instances/registry.json`, выкатить скриптом выше.
