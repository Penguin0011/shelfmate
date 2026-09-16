# Handoff — Household Index

Django/SQLite home inventory. Household members browse and flag items; the owner signs in to
manage boxes, add items from photos via AI recognition, and search. Live at
<https://box.clouddev.dad/>; the deployed revision is recorded in `/opt/inventory/REVISION`.

`README.md` is the reference for architecture and the API contract. This file covers the things
that are not obvious from reading the code, and that cost real time to discover.

---

## Where it runs

| | |
|---|---|
| VM | `box@10.0.0.21`, Ubuntu 22.04 |
| App | `/opt/inventory` (root-owned, **not a git checkout**) |
| Runtime data | `/var/lib/inventory` (db, draft photos), owned by `inventory` |
| Secrets | `/etc/inventory.env`, mode 0600, root-only |
| Service | `inventory.service` — gunicorn, 1 worker / 4 threads, binds :80 |
| Proxy | NGINX Proxy Manager at `10.0.0.6`, terminates TLS, forwards to `10.0.0.21:80` |
| Backups | `/var/backups/inventory/` |

Everything on the VM needs `sudo`. Inspect with `systemctl status inventory` and
`journalctl -u inventory`.

---

## Deploying

**`/opt/inventory` is not a git checkout.** There is no `.git`; code arrives as a tar copy and the
deployed commit is recorded in `/opt/inventory/REVISION`. `git pull` on the VM is not an option.

**Diff `REVISION` against local `HEAD` before you deploy.** It can lag by more than the change you
intend to ship. It once read four commits behind, so a deploy meant as a one-line AI fix also
carried an undeployed feature and its schema migration. Know your real scope first.

```sh
git log --oneline $(ssh box@10.0.0.21 cat /opt/inventory/REVISION)..HEAD
```

Then, as root on the VM:

```sh
# 1. back up first — this integrity-checks the copy
set -a; . /etc/inventory.env; set +a
cd /opt/inventory
.venv/bin/python manage.py backup_inventory /var/backups/inventory/pre-<name>-$(date +%Y%m%d-%H%M%S).sqlite3

# 2. ship tracked files only: git archive excludes .env, data/ and the db by construction
#    (built and scp'd from the dev machine: git archive --format=tar HEAD > deploy.tar)
tar -xf /tmp/deploy.tar -C /opt/inventory
chown -R root:root /opt/inventory/{inventory,config,deploy,scripts,manage.py,README.md,requirements.txt}
echo <commit> > /opt/inventory/REVISION

# 3. migrate, collect static, sanity check
.venv/bin/python manage.py migrate --noinput
.venv/bin/python manage.py collectstatic --noinput
.venv/bin/python manage.py check --deploy          # 2 HSTS warnings are expected and accepted

# 4. only if deploy/inventory.service changed
cp /opt/inventory/deploy/inventory.service /etc/systemd/system/ && systemctl daemon-reload

systemctl restart inventory
```

The backup destination must not exist. The command uses SQLite's backup API, removes temporary
draft payloads and sessions, preserves saved receipts, vacuums, and checks integrity. Restore into
a separate `DATA_DIR` and verify migrations, login, box URLs, items, and flags; never overwrite the
running source database for a restore test.

### Two traps

**`collectstatic` is mandatory for any UI change.** Production serves `/static/` from
`/opt/inventory/staticfiles` via WhiteNoise. Copying code and restarting ships backend changes
while leaving the **old JS and CSS live**. Local `runserver` hides this, because `DEBUG=1` serves
assets straight from the app directory. Verify afterwards by fetching the real URL and grepping
for something new:

```sh
curl -s https://box.clouddev.dad/static/inventory/app.js | grep -c <new-symbol>
```

**The venv has no pip.** `/opt/inventory/.venv` was built by `uv` (see `pyvenv.cfg`), and `uv`
is not installed on the box. Installing a dependency fails twice before this becomes clear:

```sh
/opt/inventory/.venv/bin/python -m ensurepip --upgrade
/opt/inventory/.venv/bin/python -m pip install --only-binary=:all: -r requirements.txt
```

`--only-binary=:all:` matters for native wheels like `pillow-heif` — there is no compiler or
libheif headers on the VM, so a source fallback fails slowly instead of immediately.

---

## The AI pipeline

Photo recognition (`inventory/ai_views.py: analyze`) and AI search (`: search`) both go through
`inventory/ai.py: complete`, which walks a provider chain **fastest-first**:

| order | provider | model | notes |
|---|---|---|---|
| 1 | Fireworks | `accounts/fireworks/models/deepseek-v4p1-flash` | paid tier. Vision-capable, 1M context. Real-photo latency **not yet measured** — the synthetic check ran 9–27 s wall clock, which is not comparable to the figures below |
| 2 | Gemini | `gemini-3.1-flash-lite` | ~5–7 s. OpenAI-compatible endpoint, so no separate client |
| 3 | OpenRouter | `dots-studio/dots-3-note-preview:free` | ~15–40 s |
| 4 | NVIDIA | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | a *reasoning* model; measured **130 s** on a real 2-photo batch |

Fireworks leads on **reliability, not latency** — it is the one paid account in the chain, and the
free tiers below it fail regularly (see below). Gemini is still faster on a good day, so it stays
directly behind. NVIDIA is last deliberately: a 130 s attempt in front would consume the budget and
starve the providers behind it. Every model is env-swappable (`FIREWORKS_MODEL`, `GEMINI_MODEL`,
`OPENROUTER_MODEL`, `NVIDIA_MODEL`) — this matters, because `:free` models get rate-limited and
retired. DeepSeek ships text-only variants too; `deepseek-v4p1-flash` is pinned because recognition
sends photos and a text-only model would burn the first attempt on every one of them.

A provider with **no key configured is skipped**, not fatal. `request()` raises `AIError` for a
missing key and `AIError` is deliberately non-retryable, so calling it with an empty key would
abort the whole chain rather than falling through.

### Failure semantics — the one rule to preserve

```
Retryable   → try the next provider   (429, 5xx, timeouts, unparseable output)
AIError     → try the next provider   (400 bad params, 401/403 stale key, 404 retired model)
Refused     → STOP, do not fall through
```

`Refused` is raised only for a content refusal or a `content_filter` finish. It must not fall
through, because the other providers would likely refuse the same input and trying each in turn
amounts to shopping for a compliant model. That intent used to be carried by the exception simply
being non-retryable, which conflated *"the model declined this content"* with *"this provider
could not serve us"* — and meant a single 404 killed the entire request. **If you touch this, keep
the two separate.**

### The timeout stack

Every layer must stay ordered, or raising one gets silently capped by the next:

```
provider (60s) < provider+grace (75s) < total (150s) < analyzing lock (170s)
    < gunicorn --timeout (200s) < proxy_read_timeout (300s)
```

The proxy is the real ceiling. Past its timeout the client gets a gateway 504 whose body is not
JSON, so the app's graceful "your draft is preserved" message is lost and the UI shows a generic
error instead. `proxy_read_timeout`/`proxy_send_timeout` are set to 300 s in NGINX Proxy Manager
under the proxy host's **Advanced** tab. Raise that first, then the layers below it.

> Not yet proven end to end: a normal Gemini response finishes in ~6 s and never approaches 300 s.
> The setting is insurance for a slow failover. The first genuinely slow fallback will exercise it.

### Free tiers run out

The three fallbacks are on free tiers and all three fail regularly and simultaneously — which is
why Fireworks was added in front on a paid key:

- OpenRouter: ~50 requests/day without credits. **$10 of credit raises this to 1000/day** and is
  the cheapest reliability improvement available.
- Gemini: transient `503 high demand`.
- NVIDIA: `503 Worker local total request limit reached`.

This is not a bug, and the chain handles it — when all of them are down the request fails cleanly in
~6 s with the draft preserved. Budget verification runs accordingly; it is easy to exhaust a day's
quota while testing.

---

## Invariants that bite

**`Invalid` subclasses `ValueError`.** Any `except ValueError` sweep silently swallows every
specific error message raised inside it. This caused every photo upload failure — wrong format,
too many megapixels, corrupt file — to report the same misleading "use JPEG or PNG". If you add a
broad exception clause, re-raise `Invalid` before it.

**Validation truncates nothing.** `validation.py: entries()` raises `Invalid` if a description
exceeds 2000 chars or aliases exceed 1000, and `ai.suggestions()` rejects >20 aliases or any alias
over 200 chars. Exceeding any of them **discards the entire AI response** and burns a failover.
The recognition prompt states limits inside those caps (1800 / 900) for exactly this reason — if
you make the prompt more verbose, keep the stated limits below the hard caps.

**`finish_reason: length` discards everything too.** `AI_MAX_TOKENS` is 32000 because a real
verbose batch reaches ~23,000. Truncation is not graceful degradation; the whole answer is thrown
away.

**AI search sends the entire inventory as context.** Descriptions are verbose by design (~500
chars each), so the payload grows fast. `AI_SEARCH_BUDGET` (300,000 chars) is sized for the
**smallest** context in the chain, not Gemini's 1M. Over budget it degrades in stages — trim
descriptions to 300 chars, then drop to name+aliases, then refuse — rather than failing outright.
A flat refusal would have disabled search after roughly one box.

**Photos are normalised server-side and in the browser.** The client shrinks to 1536 px JPEG
before upload (`toUploadableJpeg` in `app.js`), which is what makes HEIC and 48 MP phone photos
work. The server still normalises independently: it is the trust boundary and the only path when
JavaScript is off. `Image.MAX_IMAGE_PIXELS` is 60M because a 48 MP iPhone frame is 48.8M and the
old 25M cap rejected every full-resolution photo regardless of format.

**EXIF orientation must be baked in at decode.** Canvas output carries no EXIF, so
`createImageBitmap(file, {imageOrientation: 'from-image'})` is load-bearing. Get it wrong and
portrait photos upload sideways with no error.

**Bulk item operations are all-or-nothing.** `POST /api/items/bulk/` checks a `revision` per item
and returns 409 without changing anything if any is stale. SQLite has no `SELECT FOR UPDATE`
(`has_select_for_update` is `False`); the connection runs in `transaction_mode: IMMEDIATE`, which
takes the write lock at `BEGIN` and serialises concurrent batches instead.

**A box cannot be archived while it holds items** (`box_edit`). Bulk delete is how you empty one.

---

## Local development

```sh
cp .env.example .env     # fill in SECRET_KEY and at least one AI key
.venv/bin/python manage.py migrate
npm install
.venv/bin/python manage.py test
npm run test:ui                          # requires Chrome
.venv/bin/python manage.py runserver
```

`manage.py check_ai --provider fireworks|gemini|openrouter|nvidia|auto` makes a real API call against a
generated label image. Useful for confirming a key or model works; it does **not** represent real
photo load — a synthetic 640×320 image is ~316 prompt tokens against ~3,500 for two real photos,
so it under-tests both latency and output shape. Measure with real photos before drawing
conclusions about either.

Never commit `.env`, `data/`, or photos.

---

## Open items

1. **Existing items have terse descriptions.** Items saved before the verbose prompt landed have
   ~60-char descriptions; new recognitions produce ~500. Search quality is uneven until those
   boxes are re-recognised from photos. No migration path — it needs new photos.
2. **OpenRouter credit.** See above; $10 takes the daily cap from ~50 to 1000.
3. **Proxy timeout unverified.** See the timeout stack section.
4. **Untracked in the working tree:** `Home Inventory mockup.html` (the original design reference).
   It is not committed.
