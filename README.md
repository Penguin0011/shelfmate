# Box inventory backend

Django/SQLite backend for personal inventory, household viewing/flags, temporary photo review, and NVIDIA AI with `openrouter/free` fallback. The responsive UI follows the supplied warm-paper mockup, with real owner sign-in, inventory search, flags, and photo review. The application is deployed on the Ubuntu VM at 10.0.0.21, behind https://box.clouddev.dad/. [Certain]

## Run locally

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env  # only for a fresh setup; do not overwrite existing credentials
chmod 600 .env
# Set a random SECRET_KEY and DEBUG=1 in .env.
.venv/bin/python manage.py migrate
.venv/bin/python manage.py createsuperuser
.venv/bin/python manage.py runserver 127.0.0.1:8000
```

Use Python 3.12+ compatible with the pinned Django version. The owner must be active and staff. Never commit `.env`, photos, or databases. Local credentials are not copied by Git. Set DEBUG=0 for deployment; never expose the development server.

## API contract for the UI

All request/response bodies are JSON except multipart photo uploads. Fetch `GET /api/session/` first, retain the cookie, and send its `csrfToken` as `X-CSRFToken` on every POST. After login, use the newly returned token. Treat all returned text as text, never HTML. Owner routes require an active staff session; household visitors have no account.

| Method / route | Access | Input / purpose |
|---|---|---|
| GET `/health/` | Household | Process health |
| GET `/api/session/` | Household | CSRF token and owner status |
| POST `/api/login/` | Household | `username`, `password` |
| POST `/api/logout/` | Household | End session |
| GET `/api/boxes/` | Household | Active box numbers/categories/revisions |
| GET `/box/12` | Household | Server-rendered box page at its permanent NFC URL |
| GET `/api/boxes/12/` | Household | Flat contents and current box details as JSON |
| GET `/api/search/?q=M3` | Household | Local name/description/alias search |
| POST `/api/search/ai/` | Household | `question`; possible matches with current box locations |
| POST `/api/boxes/create/` | Owner | Positive `number`, `category` |
| POST `/api/boxes/12/edit/` | Owner | `revision`, `category`, optional boolean `retired`; number cannot change |
| POST `/api/items/create/` | Owner | `box` number, `name`, optional `description`, `aliases` strings |
| POST `/api/items/7/edit/` | Owner | Same fields plus `revision`, or `revision` and `delete:true` |
| POST `/api/boxes/12/flags/` | Household | `reason`: missing/taken/moved/other; optional `item` ID, `note`, `reporter` |
| GET `/api/flags/` | Owner | Inbox/history and unresolved count |
| POST `/api/flags/7/` | Owner | `status`: resolved/dismissed |
| POST `/api/boxes/12/drafts/` | Owner | Multipart repeated `photos` files |
| GET `/api/drafts/` | Owner | Recoverable open drafts |
| GET `/api/drafts/<uuid>/` | Owner | Entries, revision, photo URLs, exact-name duplicate hints |
| POST `/api/drafts/<uuid>/` | Owner | `revision`, `entries` array; each row has name/description/aliases |
| POST `/api/drafts/<uuid>/analyze/` | Owner | `revision`; `replace:true` required if entries already exist |
| POST `/api/drafts/<uuid>/save/` | Owner | `revision`; returns saved item IDs, repeated save returns same receipt |
| POST `/api/drafts/<uuid>/cancel/` | Owner | Close draft and delete photos |
| GET `/api/drafts/<uuid>/photos/0/` | Owner | Private no-store JPEG while draft remains open/unexpired |

Use strict JSON numbers for IDs/revisions and booleans for switches. Stale box/item edits return 409; invalid draft revisions return 400 with an explanatory message. Expected error statuses: 400 invalid input, 403 owner/CSRF failure, 404 missing record, 409 conflict, 429 throttling, 502 invalid AI matches, 503 AI unavailable. Django 403/404 responses may be HTML: the client must handle non-JSON errors.

## Photos and AI

Accept 1–4 JPEG/PNG photos, at most 10 MB each/25 MB total, bounded decoded pixels and 8 MB normalized output. Uploads are re-encoded as RGB JPEG with metadata removed. HEIC is currently rejected with conversion guidance; actual iPhone Safari capture remains to be verified. [Certain]

Photo save/cancel makes files inaccessible immediately. Files are removed after commit; failed deletion is retried. Draft expiry is 24 hours, with cleanup every 15 minutes when the supplied timer is installed. Never serve the draft directory from the reverse proxy. Backups exclude photo files and remove temporary draft payloads.

NVIDIA uses `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`; OpenRouter uses `openrouter/free`. Each provider has a 30-second wall-clock limit, with a 60-second overall bound and two concurrent AI operations per process. Recoverable errors trigger one fallback; refusals, access/configuration errors, and valid no-match results do not. Results always require validation and photo suggestions require owner review. Missing free capacity never escalates to a paid OpenRouter model.

Provider processing is external even though the inventory is local. Local deletion does not prove provider deletion. Provider/account-specific retention has not been established for real household images. [Certain]

## Checks

```sh
.venv/bin/python manage.py check
.venv/bin/python manage.py test inventory
.venv/bin/python manage.py makemigrations --check --dry-run
.venv/bin/python manage.py cleanup_drafts
.venv/bin/python scripts/check_concurrent_save.py
# Explicit live requests using generated non-sensitive label images:
.venv/bin/python manage.py check_ai --provider nvidia
.venv/bin/python manage.py check_ai --provider openrouter
.venv/bin/python manage.py check_ai --provider auto
```

## Deployment and backups

Use the systemd examples only after choosing the VM and inspecting the proxy/network configuration. Install under `/opt/inventory`, create an unprivileged `inventory` user, and place runtime data at `/var/lib/inventory`. Set `DATA_DIR=/var/lib/inventory`, DEBUG=0, production secrets, and ALLOWED_HOSTS=box.clouddev.dad in a mode-0600 `/etc/inventory.env`. Systemd loads the root-readable environment file for both the application and cleanup service. Keep code read-only to the service account.

The deployed service binds port 80 on VM interfaces using CAP_NET_BIND_SERVICE while running as the inventory account. Restrict ingress to the reverse proxy before starting it. Set TRUST_PROXY=1 only when that proxy strips/replaces forwarded protocol headers and direct untrusted ingress is blocked. Terminate valid HTTPS at the proxy; forward the original Host header. Set a 26 MB upload limit and a proxy response timeout above 75 seconds. Ensure intended household Wi-Fi can resolve and reach `box.clouddev.dad`; do not assume server-network access works from phones.

Run migrations after stopping writes and making a backup. Run `collectstatic --noinput` and `check --deploy` using production settings. Install the cleanup timer. No backup timer is enabled until a destination/retention policy is chosen.

```sh
.venv/bin/python manage.py backup_inventory /secure/backups/inventory-YYYY-MM-DD.sqlite3
```

The destination must not exist. The command uses SQLite's backup API, removes draft payloads and sessions, preserves saved receipts, vacuums, and checks integrity. Keep configuration/secrets in a separate protected backup. To test restoration: stop the test instance, copy the backup to a separate DATA_DIR as `inventory.sqlite3`, point a fresh instance there, run integrity/migration checks, log in again, and confirm box URLs/items/flags. Do not overwrite the running source database or serve the restore test publicly.

## Pending acceptance

- Native iPhone Safari camera/HEIC behavior and physical device testing.
- Real household recognition quality and free-router consistency.
- Physical NFC-tag verification; VM/proxy/HTTPS access has been verified from the workstation.
- Production backup destination, schedule, retention, and remote restoration.

## Verification snapshot — 2026-09-15

The backend behavior suite, real-file two-process save check, and SQLite backup/restore integrity check passed locally. Direct synthetic-image requests to NVIDIA Nemotron 3 Nano Omni and OpenRouter free router returned valid structured results; the automatic path also passed. [Certain] NVIDIA initially returned capacity errors, so this is proof of working integration, not guaranteed availability or household-item accuracy. [Certain]

The originally planned NVIDIA model returned HTTP 410 retirement and was replaced with the configurable NVIDIA_MODEL default above. [Certain] Production Django checks report only optional HSTS subdomain/preload warnings; leave those domain-wide choices to verified deployment. [Certain]

## Interface and browser checks

The interface uses the supplied HTML as a visual reference: warm paper backgrounds, dark rules, condensed labels, colored dots, and geometric footer shapes. The bundled Archivo fonts are extracted from that supplied reference and served locally; no external font service or prototype runtime is required. [Certain] The original mockup remains unchanged. [Certain]

All inventory and permissions come from the backend. New installations start empty. Owner dialogs support creating boxes, editing/moving/deleting items, photo uploads, and flag resolution. Photo review supports manual editing, removal, combining entries, revisioned autosave, and recoverable failures.

Run `node scripts/check_ui.cjs` with Playwright available (set PLAYWRIGHT_MODULE to its module path if needed) and Google Chrome installed. The script creates a temporary database and local server, exercises household/owner/photo journeys, mocks only AI recognition, and deletes its test data afterward. It never writes test entries into the actual inventory database. [Certain]

## Current deployment

- VM: `box@10.0.0.21`, Ubuntu 22.04.5; isolated Python 3.12.14 under `/opt/inventory-python`. [Certain]
- Proxy target: **HTTP `10.0.0.21:80`**; site: **https://box.clouddev.dad/**. [Certain]
- Application: `/opt/inventory`; runtime data: `/var/lib/inventory`; root-readable production environment: `/etc/inventory.env`. [Certain]
- `inventory.service` and `inventory-cleanup.timer` start on boot. Port 80 allows the proxy at `10.0.0.6`; SSH remains allowed. [Certain]
- Initial owner username: `owner`. Generated credentials are in the ignored local `data/deploy/owner-login.json`, mode 0600. No credentials are committed. [Certain]

To inspect the service, use `systemctl status inventory.service` and `journalctl -u inventory.service`. To run maintenance commands, use a root shell, export variables from `/etc/inventory.env`, change to `/opt/inventory`, and invoke `.venv/bin/python manage.py ...`. Do not print the environment.

The 20-test suite passed on the VM. The real HTTPS page, assets, owner login/logout, and flag inbox were verified through the proxy using a mobile-width browser. [Certain] This does not replace physical iPhone/NFC testing or verify access from outside the local network.
