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
.venv/bin/python manage.py collectstatic --clear --noinput
.venv/bin/python manage.py check --deploy          # 2 HSTS warnings are expected and accepted

# 4. only if deploy/inventory.service changed
cp /opt/inventory/deploy/inventory.service /etc/systemd/system/ && systemctl daemon-reload

systemctl restart inventory
# systemd Type=simple may report started before Gunicorn opens its listener.
curl --retry 8 --retry-connrefused --retry-delay 1 -fsS \
  -H 'Host: box.clouddev.dad' -H 'X-Forwarded-Proto: https' http://127.0.0.1/health/
```

The backup destination must not exist. The command uses SQLite's backup API, removes temporary
draft payloads and sessions, including transcript/context, preserves saved receipts, vacuums, and checks integrity. Restore into
a separate `DATA_DIR` and verify migrations, login, box URLs, items, and flags; never overwrite the
running source database for a restore test.

### Two traps

**`collectstatic --clear` is mandatory for a release or rollback.**
Restoring an older archive restores older source timestamps: without clearing, collectstatic can
leave newer JS/CSS behind. Stop the service before restoring code, rebuild assets, then start it.
 Production serves `/static/` from
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

Recognition and smart search use `inventory/ai.py:complete`. `providers()` is the shared
configuration for runtime calls and the `check_ai` diagnostic:

| order | provider | default model |
|---|---|---|
| 1 | Fireworks | `accounts/fireworks/models/glm-5p3-flash` |
| 2 | Gemini | `gemini-3.1-flash-lite` |
| 3 | OpenRouter | `dots-studio/dots-3-note-preview:free` |

Only configured providers are attempted. Fireworks leads for reliability and uses the configured
paid account; there is no NVIDIA path. Search uses a cheaper Fireworks model,
`accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b` (`FIREWORKS_SEARCH_MODEL`, pinned in
`/etc/inventory.env`). Recognition sends `reasoning_effort=high` by default;
search sends no reasoning effort unless explicitly configured. The two Fireworks model/effort
settings are independent. Empty reasoning-effort environment values omit that parameter.
Provider model availability and account billing must be checked with the provider when changing them.

### Response and failure handling

- Valid JSON (optionally inside a code fence) is schema-validated.
- Trailing prose is rejected, because it may qualify the answer. It is never silently discarded.
- Malformed envelopes, transport failures, truncated output and schema failures try the next provider.
- Provider rejection (including bad credentials or a retired model) also permits fallback.
- Content refusal or `content_filter` stops the chain.
- A valid empty array is an answer, not a provider failure.

Recognition validates a whole batch: one over-limit field rejects the response and leaves the old
draft intact if no provider succeeds. We deliberately do not truncate fields or silently omit items.
Search keeps up to 20 valid rows, then intersects IDs with the submitted/current inventory.

### Time budgets

`AI_PROVIDER_TIMEOUT` defaults to 120 seconds, with a 15-second transport allowance.
`AI_TOTAL_TIMEOUT` defaults to 150 seconds. Each attempt reserves up to 30 seconds for every
configured provider still behind it (less if the remaining total is smaller).
With three configured providers, a slow first attempt receives at most 90 seconds, leaving
30 seconds each for the two fallbacks. A fast failure makes its unused budget available downstream.

The draft lease is total+20 seconds; Gunicorn is configured with `--timeout 200` and the reverse
proxy has historically been configured for 300-second read/send timeouts. HTTPX read/write
limits are inactivity limits, with wall-clock checks on received chunks and after the response;
these checks are not an interruptible global deadline during a blocked socket operation.
Do not claim the proxy timeout is verified without inspecting the proxy itself.

Use `manage.py check_ai --provider auto` for one synthetic, non-sensitive recognition request.
Individual provider checks are available for fireworks, gemini and openrouter. A successful
synthetic request proves connectivity and schema handling, not real-photo accuracy or all fallbacks.

---

## Invariants that bite

**A running analysis owns the draft's `revision`.** `ai_views.analyze` writes its result with
`Draft.objects.filter(..., revision=draft.revision).update(...)` — the revision the *run started
with*. Anything that bumps `revision` while a run is in flight makes that filter match zero rows,
so the recognition is discarded and the 409 goes to a client that has usually navigated away. The
owner sees nothing; the entries simply never appear.

That is why the side paths deliberately do **not** bump it. `draft_views.meta` writes `box` and
`context` with a bare `.update()`, and `analyze` writes `context` in the same `save()` as the
analysis lock. Both are *expected* to happen mid-run: filing the draft and leaving a note are the
two things the owner is meant to do while waiting, which is why `disable()` exempts anything inside
`.filing` from the lock the entry fields get. `drafts.update()` bumps revision because an entry
edit genuinely should invalidate a result computed from older entries. If you add another field the
owner can change while recognition runs, it belongs in `meta`, not in `entries`.

A note written *during* a run does not retroactively apply to it — the prompt was already sent. It
is saved to the draft so the retry it enables needs no typing.

**`Invalid` subclasses `ValueError`.** Any `except ValueError` sweep silently swallows every
specific error message raised inside it. This caused every photo upload failure — wrong format,
too many megapixels, corrupt file — to report the same misleading "use JPEG or PNG". If you add a
broad exception clause, re-raise `Invalid` before it.

**Server validation truncates nothing; the UI refuses over-limit merges.** `validation.py: entries()` raises `Invalid` if a description
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
The UI does not claim every description was read when this budget strips descriptions.

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

`manage.py check_ai --provider fireworks|gemini|openrouter|auto` makes a real API call against a
generated label image. Useful for confirming a key or model works; it does **not** represent real
photo load — a synthetic 640×320 image is ~316 prompt tokens against ~3,500 for two real photos,
so it under-tests both latency and output shape. Measure with real photos before drawing
conclusions about either.

Never commit `.env`, `data/`, or photos.

---

## Open items

1. **Description standard changed on 2026-09-17.** The recognition prompt no longer states a
   length target (a target got padded with origin, warnings and button labels) and carries a
   NOISE RULE instead. `manage.py rewrite_descriptions` brings model-written items onto the new
   standard without photos: dry run by default, `--apply` writes and bumps item revisions.
   Hand-typed descriptions (no draft reference) are never touched. Run it after the deploy.
2. **Provider quotas.** Confirm current account limits with the provider before changing fallback policy.
3. **Proxy timeout unverified.** See the timeout stack section.
4. **Untracked in the working tree:** `Home Inventory mockup.html` (the original design reference).
   It is not committed.

## September 17 reliability changes

Camera investigation targeted iPhone/Comet. Before changes, 24-hour application logs showed one
403 and three 201 responses for `/api/drafts/new/`; this is evidence of a rejected request, not
proof of the cause of every silent camera return. The old camera input was detached and its
browser-decode failure path aborted without trying the server's HEIC decoder.

Snap now uses persistent inputs, focus/visibility recovery when files are present without change,
a bounded browser conversion attempt, server decoding fallback, refreshed session/CSRF, and a
visible retry that reuses a client UUID. Retry identity is restricted to the draft owner; an active
upload owns its UUID directory so concurrent attempts cannot overwrite it. Native camera behavior
on the user's iPhone/Comet is not reproducible in desktop browser automation.

The browser regression suite includes over-limit merge preservation, current-location cache
restoration, decoder rejection/stall, missing change events, a lost successful upload response,
and a stalled network request. Run the suite before release; do not interpret these simulations
as a physical iPhone camera acceptance test.
