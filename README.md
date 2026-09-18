# Household box inventory

A small Django + SQLite app for a home inventory kept in numbered boxes. Each box carries an NFC
tag that opens its page. Household members browse, search and flag items without an account; the
owner signs in to manage boxes, add items by hand, from photos or by talking (AI recognition into a
reviewable draft), and run an AI-assisted search. The AI calls go to Fireworks, Gemini or OpenRouter
via their OpenAI-compatible endpoints; leave every key empty and the app works without them.

## Run locally

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env          # then set SECRET_KEY to a long random value
chmod 600 .env
.venv/bin/python manage.py migrate
.venv/bin/python manage.py createsuperuser
.venv/bin/python manage.py runserver 127.0.0.1:8000
```

Python 3.12+ is needed for the pinned Django. The owner account must be active and staff, which
`createsuperuser` gives you. `npm install` is only needed for the browser test suite.

## Configuration

Settings come from the process environment, or from a local `.env` (never committed; process
environment wins). `.env.example` documents them all. The ones that matter:

| Variable | Purpose |
|---|---|
| `SECRET_KEY` | Required. Django refuses to start without it. |
| `DEBUG` | `1` for local development only. `0` turns on secure cookies, HTTPS redirect and HSTS. |
| `ALLOWED_HOSTS` | Comma-separated hostnames the app answers for. |
| `CSRF_TRUSTED_ORIGINS` | Public origin(s) such as `https://inventory.example.com`, required behind a TLS proxy. |
| `TRUST_PROXY` | `1` only when a reverse proxy in front of the app rewrites `X-Forwarded-Proto` and `X-Forwarded-For`. Enables the proxy SSL header and per-client throttling by forwarded address. |
| `DATA_DIR` | Where the SQLite database and temporary draft photos live (default `./data`, mode 0700). |
| `FIREWORKS_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` | AI providers, tried in that order. Empty keys are skipped. |
| `*_MODEL`, `AI_*` | Model names, token cap, timeouts and search budget; see `config/settings.py`. |

## Deploying

`deploy/` holds systemd units for gunicorn and a 15-minute draft-cleanup timer. They expect the code
in `/opt/inventory`, data in `/var/lib/inventory` and secrets in `/etc/inventory.env`, which must
also set `FORWARDED_ALLOW_IPS=<proxy ip>,127.0.0.1` (read by gunicorn) and `TRUST_PROXY=1` when a
reverse proxy terminates TLS. Run `manage.py collectstatic` on every release: production serves
static files through WhiteNoise from `staticfiles/`. `handoff.md` records the deployment procedure,
the AI timeout stack and the invariants that are easy to break.

## API contract for the UI

All request/response bodies are JSON except multipart photo uploads. Fetch `GET /api/session/` first, retain the cookie, and send its `csrfToken` as `X-CSRFToken` on every POST. After login, use the newly returned token. Treat all returned text as text, never HTML. Owner routes require an active staff session; household visitors have no account.

| Method / route | Access | Input / purpose |
|---|---|---|
| GET `/health/` | Household | Process health |
| GET `/api/session/` | Household | CSRF token and owner status |
| POST `/api/login/` | Household | `username`, `password` |
| POST `/api/logout/` | Household | End session |
| GET `/box/12` | Household | Server-rendered box page at its permanent NFC URL |
| GET `/api/search/?q=M3` | Household | Local name/description/alias search |
| POST `/api/search/ai/` | Household | `question`; possible matches with current box locations |
| POST `/api/boxes/create/` | Owner | Positive `number`, `category`; restores an archived number (200), creates a fresh number (201), rejects an active duplicate (409) |
| POST `/api/boxes/12/edit/` | Owner | `revision`, `category`, optional boolean `retired`; number cannot change |
| POST `/api/items/create/` | Owner | `box` number, `name`, optional `description`, `aliases` strings |
| POST `/api/items/7/edit/` | Owner | Same fields plus `revision`, or `revision` and `delete:true` |
| POST `/api/items/bulk/` | Owner | Move or delete selected items with per-item revisions |
| POST `/api/boxes/12/flags/` | Household | `reason`: missing/taken/moved/other; optional `item` ID, `note`, `reporter` |
| POST `/api/flags/7/` | Owner | `status`: resolved/dismissed |
| POST `/api/boxes/12/drafts/` | Owner | Multipart: repeated `photos` files and/or a `transcript` field (at least one) |
| GET `/api/drafts/` | Owner | Recoverable open drafts |
| GET `/api/drafts/<uuid>/` | Owner | Entries, revision, photo URLs, exact-name duplicate hints |
| POST `/api/drafts/<uuid>/` | Owner | `revision`, `entries` array; each row has name/description/aliases |
| POST `/api/drafts/<uuid>/analyze/` | Owner | `revision`; `replace:true` required if entries already exist |
| POST `/api/drafts/<uuid>/save/` | Owner | `revision`; returns saved item IDs, repeated save returns same receipt |
| POST `/api/drafts/<uuid>/cancel/` | Owner | Close draft and delete photos |
| GET `/api/drafts/<uuid>/photos/0/` | Owner | Private no-store JPEG while draft remains open/unexpired |

Use strict JSON numbers for IDs/revisions and booleans for switches. Stale box/item edits return 409; invalid draft revisions return 400 with an explanatory message. Expected error statuses: 400 invalid input, 403 owner/CSRF failure, 404 missing record, 409 conflict, 429 throttling, 502 invalid AI matches, 503 AI unavailable. Django 403/404 responses may be HTML: the client must handle non-JSON errors.

Archived boxes appear in an owner-only list on the home page. Restore one there, or use its number when creating a box. Reuse preserves the existing record, NFC URL, and flag history; archiving requires empty contents.

Box create/edit accepts optional `location` (free text, up to 120 characters). Omitting it on edit preserves the location; an empty string clears it. Owner forms suggest locations currently assigned to boxes. Locations appear in box lists, details, and search results.

The index offers two searches, chosen explicitly: keyword (the default, hits `/api/search/` and is instant) and smart search (`/api/search/ai/`, seconds). The URL keeps the original `mode=name` / `mode=ai` values. A smart search that is unavailable still falls back to keyword search; a keyword search that finds nothing offers to escalate. A result links to its box carrying `?q=` and `?mode=`, so the box's back arrow returns to the results rather than the index. Smart results are cached in `sessionStorage` for that return. Cached IDs/revisions are checked against current inventory; box details are refreshed and changed or missing items trigger a new smart search.

## Photos and AI

Snap an item keeps its camera input attached to the page and offers Choose from Photos as an
alternative. After capture, browser conversion has a 15-second ceiling; unsupported/stalled decoding
falls back to the original file and server-side JPEG/PNG/HEIC decoding, subject to the 10 MB limit.
Upload/session checks have a 60-second ceiling, refresh CSRF after camera return, and keep the
selected photo available for retry or sign-in without a page reload. A per-photo `upload_id` UUID
returns the existing owner draft after an uncertain response instead of creating a duplicate.
The selected file is held in page memory only; reloading or the OS discarding the tab loses it.


Accept 1–4 JPEG, PNG, or HEIC photos, at most 10 MB each/25 MB total, bounded decoded pixels and 8 MB normalized output. The browser and server independently resize and re-encode uploads as RGB JPEG with metadata removed.

Photo save/cancel makes files inaccessible immediately. Files are removed after commit; failed deletion is retried. Draft expiry is 24 hours, with cleanup every 15 minutes when the supplied timer is installed. Never serve the draft directory from the reverse proxy. Backups exclude photo files and remove temporary draft payloads, including transcripts and owner notes. Save/cancel/expiry also clears these source fields in the database; cleanup scrubs previously closed drafts. Existing backup files are not rewritten.

Recognition and AI search use the same configurable provider chain and validated response schemas. Large inventories are cut to a bounded candidate set by local term matching before the search model reranks them, so search cost does not grow with the number of items. Results require owner review, with Fireworks first, then configured Gemini and OpenRouter fallbacks. See `handoff.md` for provider ordering, timeout constraints, failure semantics, and measured behavior.

Provider processing is external even though the inventory is local. Local deletion does not prove provider deletion. Provider/account-specific retention has not been established for real household images.

## Checks

```sh
.venv/bin/python manage.py check
.venv/bin/python manage.py test inventory
.venv/bin/python manage.py makemigrations --check --dry-run
.venv/bin/python manage.py cleanup_drafts
.venv/bin/python scripts/check_concurrent_save.py
npm install && npm run test:ui          # Playwright against a local Chrome
# Explicit live requests to the configured providers, using a generated non-sensitive label image:
.venv/bin/python manage.py check_ai --provider fireworks
.venv/bin/python manage.py check_ai --provider gemini
.venv/bin/python manage.py check_ai --provider openrouter
.venv/bin/python manage.py check_ai --provider auto
```

Owner-only `POST /api/items/bulk/` accepts `{"action":"delete"|"move", "items":[{"id":n,"revision":n}], "box":n}` and applies the selection atomically.

## Operations and licensing

`handoff.md` covers backup and restore, the AI timeout stack, and the invariants that are easy to
break. Third-party assets are listed in `THIRD_PARTY_NOTICES.md`. A local `pre-commit` hook that
blocks committed credentials is configured in `.pre-commit-config.yaml`.
