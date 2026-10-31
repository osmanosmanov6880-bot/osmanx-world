# osmanx.world

Статический сайт-портфолио. После настройки VPS каждый push в `main` выкладывает содержимое в `/var/www/osmanx.world`.

## Одноразовая подготовка VPS

Подключись по SSH к выбранному свободному VPS и выполни блок ниже от root. Он создаёт отдельного пользователя деплоя, папку сайта и Nginx-конфигурацию; текущие сайты и службы не трогает.

```bash
set -euo pipefail
apt-get update
apt-get install -y nginx rsync
id -u deploy-osmanx >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy-osmanx
install -d -o deploy-osmanx -g www-data -m 2755 /var/www/osmanx.world
cat >/etc/nginx/sites-available/osmanx.world <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name osmanx.world www.osmanx.world;
    root /var/www/osmanx.world;
    index index.html;
    location / {
        try_files $uri $uri/ =404;
    }
    location ~* \.(?:css|js|png|jpg|jpeg|gif|svg|webp|ico)$ {
        expires 7d;
        add_header Cache-Control "public";
        try_files $uri =404;
    }
}
NGINX
ln -sfn /etc/nginx/sites-available/osmanx.world /etc/nginx/sites-enabled/osmanx.world
nginx -t
systemctl reload nginx
```

Затем создай отдельную пару SSH-ключей на своём компьютере для GitHub Actions. Публичный ключ добавь в `/home/deploy-osmanx/.ssh/authorized_keys` на сервере. Закрытый ключ внеси в GitHub → Settings → Secrets and variables → Actions как `DEPLOY_KEY`. Создай там же секреты:

- `DEPLOY_HOST` — IP выбранного VPS
- `DEPLOY_USER` — `deploy-osmanx`
- `DEPLOY_KNOWN_HOSTS` — проверенная запись SSH host key с сервера

Закрытый ключ и пароли не добавляй в репозиторий и не отправляй в чат. Сверь host key отпечаток по панели провайдера перед добавлением.

## DNS Cloudflare

Когда nginx готов, создай DNS-записи:

- `A` — имя `@` → IPv4 выбранного VPS
- `A` — имя `www` → тот же IPv4

На время первой проверки поставь проксирование Cloudflare в режим DNS only. После проверки сайта можно включить прокси. Удали/замени только старые записи для этих имён; остальные DNS-записи домена не трогай.

## TLS

После того как DNS указывает на VPS, настрой сертификат Let’s Encrypt (например, Certbot с Nginx) и проверь HTTPS. Не включай режим Cloudflare Full (strict), пока на origin-сервере не установлен действующий сертификат.

## Автодеплой

Workflow `.github/workflows/deploy.yml` запускается при push в `main` или вручную. Он использует закреплённый SSH host key, проверяет соединение, затем синхронизирует статический сайт. Текущая конфигурация синхронизирует только `index.html` и `assets/`; `--delete` ограничен каталогом сайта.

Если сайт на сервере уже обслуживает другой процесс или веб-сервер, сначала остановись и проверь его конфигурацию. Не запускай подготовительный блок повторно до понимания текущего состояния VPS.
