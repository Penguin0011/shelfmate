# NFC inventory implementation plan

## Scope and execution rules

Implement [the approved design](2026-09-15-nfc-inventory-design.md). The repository currently contains design documents only. [Certain] This plan specifies intended work; none of the checks below has passed against an application yet. [Certain]

Use ponytail full: build the smallest complete version, retain trust-boundary validation and recovery, and commit each working milestone. Do not deploy while the target VM and proxy details remain unknown. Work locally through milestone 6 before requiring deployment information. Reuse the existing repository; create an implementation branch when coding starts, without an additional checkout unless concurrent work requires one.

## Stack decision

Use Python 3.12 or newer supported by the selected Django release, Django 5.2 with its latest maintained patch at implementation time, SQLite, Django templates, plain CSS, and small vanilla JavaScript enhancements. Pin actual dependencies when installing; do not assume a patch version from this plan.

Django provides authentication, forms, CSRF protection, and migrations. [Official documentation](https://docs.djangoproject.com/en/5.2/topics/). [Certain] Use these facilities rather than assembling separate equivalents.

Direct dependencies: Django, Pillow for safe image decoding/re-encoding, HTTPX for bounded API requests, Gunicorn for production serving, and WhiteNoise for static assets. Use Python's built-in test/mock facilities through Django's existing test runner. Do not add React, a frontend build pipeline, an AI SDK, Redis, Celery, vector storage, or a generic provider framework.

Deploy one application service using a virtual environment and systemd on the VM. Use systemd timers for draft cleanup and backups. Keep the database on local VM storage, not a network share. Stop writes and back up before schema migrations. Keep database transactions short and perform all remote AI calls outside them.

SQLite is the chosen low-concurrency starting point; revisit PostgreSQL only after measured lock contention or a need for multiple application instances. Mark that ceiling with a `ponytail:` comment in database settings.

## Small file layout

Create files only as their milestone needs them:

```text
manage.py
config/                 # Django settings, URLs, WSGI entry point
inventory/
  models.py             # records and database constraints
  forms.py              # validation and owner review forms
  views.py, urls.py      # household and owner flows
  ai.py                 # two concrete provider calls and shared validation
  drafts.py             # photo lifecycle and transactional save
  tests.py              # focused behavior tests; split only when unwieldy
  migrations/
  management/commands/  # cleanup and consistent database backup
  templates/inventory/
  static/inventory/     # CSS and minimal review/search JavaScript
deploy/                 # systemd service/timers and deployment instructions
docs/plans/
README.md
requirements.txt
.env.example            # names/placeholders only
.gitignore
```

## Milestone 1 — runnable foundation and owner access

**Commit:** `feat: add inventory foundation and owner authentication`

- Create the project and one inventory app. Separate runtime data from source; ignore secrets, SQLite files, draft files, virtual environments, and generated assets.
- Configure settings from environment variables. Fail clearly for missing production secrets. Use an explicit local development mode for HTTP cookies; require HTTPS secure session and CSRF cookies in deployment.
- Use Django's built-in User, database sessions, password hashing, login/logout, and one CLI-created owner account. No signup, password-reset email flow, or exposed generic admin site.
- Require an authenticated active owner/staff account on every owner route. Use POST plus CSRF validation for all mutations, including household flags and AI search.
- Add a base mobile template, owner login, health endpoint, and clear error pages. Escape all item, flag, and model text.
- Add a simple bounded process-local throttle for login attempts, flags, and AI search, with documented single-process scope. Start production with one Gunicorn process and multiple threads. Do not hold the throttle lock while making network requests.

**Check:** Run `python manage.py check` and focused Django tests for anonymous write rejection, owner login/logout, CSRF rejection, and throttle expiry. Verify credentials/session material does not appear in responses or logs.

## Milestone 2 — useful manual inventory and local search

**Commit:** `feat: add numbered boxes and searchable inventory`

- Model Box with a unique immutable positive number, category/name, timestamps, and retirement state. Retain retired numbers; make their old URLs show a retired state rather than a new box. Block retirement until contents are moved or removed.
- Model Item with box FK, name, description, aliases stored as simple text, and timestamps. Represent a group with an ordinary item record, not a separate container hierarchy.
- Add `/`, `/box/<number>`, owner create/edit box forms, and owner item create/edit/move/delete forms. Require a deliberate confirmation for deletion and detect stale edits with the submitted update timestamp.
- Show category then box number. Put owner actions under the overflow menu; use native accessible controls and forms.
- Search locally using bounded query text and case-insensitive matching over names, descriptions, and aliases. Escape LIKE special characters through the ORM. Keep results at item level and display the current box.
- Use responsive CSS with readable spacing, keyboard focus, labeled fields, and no horizontal overflow. Do not expose deployment or AI implementation details in ordinary browsing.

**Check:** Test permanent numbers, grouped-item search, move results, stale edits, escaped content, and anonymous access boundaries. Browser-check search and forms at phone width and desktop width. Verify a renamed box keeps its URL.

## Milestone 3 — household flags and owner inbox

**Commit:** `feat: add household flags and owner review inbox`

- Model Flag with protected box reference, nullable item reference, item-name snapshot, reason enum, optional note/reporter name, status, and timestamps. On item deletion, retain the flag and its snapshot.
- Add box/item flag forms accessible without login, subject to CSRF and basic throttling. Validate that any supplied item belongs to the indicated box.
- Add owner unresolved count, inbox, history, resolve, and dismiss actions. Never mutate contents simply because a flag was submitted.

**Check:** Exercise anonymous flag submission and owner resolution end to end. Test mismatched item/box rejection, unauthorized status changes, and history after item deletion. Verify an owner can correct contents before resolving a report.

## Milestone 4 — durable photo review without an AI dependency

**Commit:** `feat: add temporary photo drafts and batch review`

- Model Draft with UUID, owner, target box, created/expiry timestamps, editable proposed entries, revision, state, and save receipt. Store files outside public static/media paths; serve only through owner-checked endpoints with no-store caching.
- Use a native multi-file input and optional camera capture. Begin with JPEG/PNG, up to four photos, 10 MB each and 25 MB total; bound decoded pixel count and normalized batch bytes. Revisit limits after hosted API testing. Show a useful unsupported-format error, including HEIC conversion guidance, and test real phone capture before acceptance.
- Decode with Pillow, apply orientation, resize to a bounded longest edge, re-encode without metadata, and remove original upload temporaries in a finally block. Do not retain source filenames or EXIF.
- Provide a draft review form with editable name/description/aliases, add/remove rows, and combine suggestions by editing one retained row. Initially populate it manually so the whole save flow can be checked without AI.
- Autosave draft text with a short debounce, a visible saved/error state, and revision checking. Flush pending edits before save/navigation where possible. Warn on unsaved changes; do not claim recovery for unacknowledged keystrokes.
- Flag exact normalized-name matches in the target box as possible duplicates. Let the owner omit or keep the new row; do not silently merge or build fuzzy matching.
- Save with an atomic conditional transition from draft to saved and insert approved items in the same database transaction. Repeated submissions return the existing receipt. Use a uniqueness constraint linking each saved batch row to its draft and row identifier.
- On save/cancel, make photo access unavailable immediately and delete files after commit. Retain cleanup-pending state on failure. A cleanup command must retry deletion and expire abandoned drafts at 24 hours; run it on service startup and every 15 minutes. Document the scheduler interval as the expiry cleanup window.
- Serialize analyze/cancel/save transitions so a late recognition response cannot recreate a saved, cancelled, or expired draft. Clean orphaned temporary uploads too.

**Check:** Test owner-only photo access, spoofed formats, oversize decoding, repeated and concurrent saves, stale revisions, rollback before commit, file-deletion failure, expired drafts, startup cleanup, and a late response after cancellation. Verify that one saved batch yields one set of items and no accessible photos. Use temporary directories/databases; never real household photos in committed fixtures.

## Milestone 5 — NVIDIA recognition and free-router recovery

**Commit:** `feat: add AI photo suggestions with free-router fallback`

- Configure NVIDIA as primary with `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`; use `openrouter/free` as the only backup. Load both API keys server-side.
- Verify the hosted NVIDIA request format from its current API reference and an actual small request. Do not treat self-hosted NIM documentation as proof of hosted limits.
- Implement two explicit HTTP request builders and one shared failover function in `ai.py`. Send encoded image data, never a private LAN URL that the provider cannot fetch.
- Start with a 60-second overall application deadline, at most 30 seconds per provider including response reads, a bounded response size, and one fallback attempt. Enforce the wall-clock deadline beyond individual HTTP read timeouts. Set Gunicorn/proxy timeouts above the application deadline.
- Fallback for connection/timeouts, 429, 5xx, and malformed or schema-invalid output. Surface authentication/configuration failures. Do not fallback on refusals, uncertainty, or legitimate empty results. Retain manual recovery if both providers fail.
- Request only an array of name/description/aliases suggestions. Validate type, maximum rows, field lengths, and strings using ordinary Python and Django form validation. Avoid trusting model-generated confidence numbers.
- Treat photo labels as evidence, not instructions; prohibit invented measurements and current-stock claims from package counts. Keep owner confirmation mandatory.
- Permit only one analysis operation per draft at a time; release database transactions before network calls. Preserve draft edits on retry and request deliberate replacement if there is already reviewed text.
- Record model ID when returned, status, duration, and error category. Do not log payloads. Handle free-router unavailability without any paid escalation.
- Verify NVIDIA and OpenRouter/downstream retention settings before real photo processing and record findings in deployment notes.

**Check:** Mock both services to cover each fallback trigger and non-trigger, malformed data, wall-clock timeout, and draft recovery. Run opt-in live smoke checks separately with non-sensitive images and configured keys. Test multiple free-router requests because the selected model varies. Record recognition misses on representative user batches rather than asserting accuracy from model marketing.

## Milestone 6 — natural-language item finding

**Commit:** `feat: add grounded natural-language inventory search`

- Add the secondary Ask AI action. Reuse the provider failover function with a text-only task.
- Send the question and compact item ID/name/description/aliases; exclude flags, names of reporters, account details, and photo drafts.
- Use initial limits of 500 question characters, 40,000 inventory characters, and bounded result count/output size. These are application limits to validate, not provider guarantees. If exceeded, show a useful limit message and retain local search; do not silently truncate the inventory.
- Require a list of existing IDs with short explanations. Validate IDs, deduplicate, discard unknown/deleted records, and reload current box locations. If all returned IDs are invalid, report a processing error rather than a confirmed no-match.
- Display possible matches and qualified explanations; no compatibility guarantees from incomplete descriptions. A valid empty list is a no-match response.
- Keep this synchronous with a loading state and duplicate-submit prevention. Bound simultaneous AI requests so ordinary browsing retains worker capacity; return a busy state instead of building a queue.

**Check:** Test invented IDs, valid no-match, payload ceiling, escaping, current locations after moves, both-provider failure, concurrency limits, and no internet. Trial questions should include “connect laptop to monitor,” “M3 16 mm screws,” an absent item, and an ambiguous connector.

## Milestone 7 — VM deployment and recovery

**Commit:** `ops: document VM deployment backups and NFC setup`

Before remote actions, obtain the chosen VM/OS and access method, reverse proxy software/address, intended household network access, DNS/TLS ownership, and backup destination. Inspect current state before changing it. Do not infer firewall subnets or credentials.

- Provide a least-privilege systemd service, environment-file example, startup cleanup, and cleanup/backup timers. Use one Gunicorn process with enough threads for bounded AI calls and ordinary browsing; begin with four threads and a two-request AI concurrency cap.
- Bind to the intended private interface and restrict VM ingress to the reverse proxy as appropriate for the verified topology. Trust forwarded HTTPS information only from that proxy, which must strip/replace incoming forwarded headers.
- Set the production host and CSRF origin to `box.clouddev.dad`, debug off, secure cookies, static asset serving, upload body limits, and aligned timeouts. Verify Django deployment checks against the actual settings.
- Implement a SQLite online-backup command using Python's backup API, not a live database-file copy. Remove temporary draft payloads from the backup while preserving saved-batch receipts and foreign-key integrity; sanitize/vacuum the backup so removed draft text is not retained in free pages. Exclude all photo files. Back up required configuration separately with restrictive permissions.
- Choose a daily schedule and retention only once backup storage is known. Test restoration into a separate data directory, including migrations and owner access. Keep a release rollback procedure; do not reverse incompatible migrations blindly.
- Document writing `https://box.clouddev.dad/box/<number>` as an NFC URL record with a phone tag writer. No in-browser NFC writing feature. Write one pilot tag before labeling the collection.
- Test on the actual household phone through household Wi-Fi and the proxy. Check that unintended external access is absent according to the agreed network boundary.

**Check:** Run `python manage.py check --deploy`, complete the design's acceptance journeys, restart the service, exercise the timers, verify photo deletion, restore a backup, and tap the pilot tag. Record local proof separately from real phone/proxy/VM proof.

## Verification and commit discipline

For each milestone: inspect `git status` and `git diff`, run the smallest relevant checks, stage only its files, inspect `git diff --cached`, run `git diff --cached --check`, and make the named logical commit. Do not commit credentials, user photos, runtime databases, or local environment files.

Use `python manage.py test inventory` for the focused behavior suite and `python manage.py makemigrations --check --dry-run` once models exist. Add tests for failure-prone behavior, not trivial field declarations. Broaden to browser and live-provider checks at the milestones that require them. Do not label a mocked or local check as deployment proof.

## Completion boundary

Planning is complete when this document is reviewed and committed. Application implementation remains separate. [Certain] VM, proxy, backup, provider-account, and phone verification require live details not yet supplied. [Certain] Begin coding with milestone 1 when requested; the earlier milestones do not depend on choosing the VM.

## Implementation update — 2026-09-15

The live NVIDIA API returned HTTP 410 for Nemotron Nano 12B v2 VL, reporting retirement on August 26, 2026. [Certain] Use `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`, which is listed by the authenticated models endpoint and supports image input in [NVIDIA’s current API example](https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning). [Certain] Initial replacement calls returned HTTP 503 capacity errors; a subsequent direct synthetic-image check returned a valid structured result. OpenRouter free-router and automatic-path synthetic-image checks also passed. [Certain] Real household recognition quality and iPhone behavior remain unverified. [Certain]

The user requested backend completion while visual design is pending. [Certain] Implement JSON endpoints first; defer templates, styling, and browser autosave wiring until that design arrives. Preserve the approved workflows and permanent box URLs.
