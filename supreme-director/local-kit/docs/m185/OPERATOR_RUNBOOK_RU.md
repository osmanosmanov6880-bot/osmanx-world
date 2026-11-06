# M185 — инструкция оператора (локальный компьютер)

## Быстрый запуск

1. Распакуйте полный ZIP и установите Python 3.13. Установите пинованную зависимость: `py -3.13 -m pip install -r requirements-m185.txt` (Windows) либо `python3 -m pip install -r requirements-m185.txt` (Linux/macOS, в venv).
2. Запустите `START_OSGARD_M185_WINDOWS.cmd` или `sh START_OSGARD_M185_LINUX_MAC.sh`.
3. Откройте `http://127.0.0.1:8765/`, вставьте уникальный локальный bearer token, напечатанный в терминале. Никогда не публикуйте токен.
4. Вкладка **Evidence reviews** принимает только путь к уже существующему локальному файлу под `runtime/evidence` и точную SHA-256 сумму, затем открывает case. Никаких файлов с паролями/данными клиентов хранить здесь нельзя: SQLite не шифруется.
5. По умолчанию registry ПУСТОЙ: этим намеренно запрещена фиктивная подпись. Для настоящего рецензента нужно получить по отдельному доверенному каналу его Ed25519 public key и роль. Это должна делать ответственная сторона, не сам автор доказательства.

## Однократное доверие к внешнему рецензенту

- Формат внешнего файла реестра: `{"schema":"osgard.m185.trusted-reviewers/1","reviewers":[{"id":"reviewer-01","role":"SECURITY_REVIEWER","ed25519_public_key_b64":"<base64 32-byte public key>"}]}`.
- Начальный `init-review` фиксирует SHA-256 пустого реестра. Пока ещё нет review cases и реальных доверенных ключей, оператор может выполнить `python -m osgard_m185 provision-trust --db runtime/m185_local.sqlite3 --root runtime/evidence --trust /path/externally-approved-reviewers.json --expected-current-sha <hash-from-init-review>`.
- Это **одноразовая** смена пустого реестра. Повторное изменение ключей, автоматическая регистрация через браузер, саморевью и перенос подписи на другой case запрещены.
- Приложение не создает закрытые ключи рецензентов. Получить публичный ключ от проверенного человека, а не изготовить его от имени «независимого ревьюера», — организационная ответственность.

## Подписание рецензентом отдельно от оператора

1. Оператор формирует на вкладке Evidence reviews файл `RVW-..._challenge.json` без закрытых ключей.
2. Независимый рецензент сверяет сам evidence, scope, source hash и причину; на своей машине с отдельным закрытым ключом PEM 0600 выполняет:

```bash
python3 -m osgard_m185 sign-offline --challenge RVW-CASE_challenge.json --private-key /private/reviewer-ed25519.pem --out /private/reviewer-signed.json
```

3. Рецензент передаёт **только подпись base64** из `.signature_b64` авторизованному оператору. Сервер повторно проверяет исходный файл, fingerprint доверенного публичного ключа, Ed25519-подпись и отсутствие второго голоса; только после этого сохраняет `SIGNED_LOCAL_REVIEW`.
4. `PASS_LOCAL_EVIDENCE` означает только совпадение локального artefact с подписью и заявленным описанием, **не оригинальный M181, не продуктовый acceptance и не production GO**.

## Проверка и восстановление

- `python3 -m osgard_m185 doctor --db runtime/m185_local.sqlite3 --root runtime/evidence` обязан дать `LOCAL_INTEGRITY_PASS`.
- Для резервной копии закрыть приложение, сделать SQLite online backup в защищённый каталог и отдельно сохранить файлы `runtime/evidence` и trust registry. Перед возобновлением проверить ключи, SHA и doctor. Старые подписанные решения переносятся только вместе со всеми ссылочными файлами.
- При ошибке `REVIEW_CASE_EVIDENCE_CHANGED_OR_MISSING` никакой ручной правки SHA/SQLite: вернуть точные первоначальные байты или открыть новый case с новым доказательством.
- Не открывать этот локальный сервер через reverse proxy, VPN, Cloudflare Tunnel, SSH forward или публичный адрес.

## Коммерческое внедрение и настоящая система

Код M185 не имеет аутентификации реальных пользователей, сетевой изоляции тенантов, защищённого SSO/MFA, KMS, HSM и настоящего независимого owner-GO. Для production нужен отдельный архитектурный и security-релиз. См. `IMPLEMENTATION_AND_RELEASE_PLAN_RU.md`.
