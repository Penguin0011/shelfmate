# NFC household inventory — version-one design

## Status and purpose

The user approved the version-one scope and requested OpenRouter as an AI backup. [Certain]

Build a mobile-friendly website for a personal inventory that household members can search, view, and flag. Optimize for finding objects and maintaining useful approximate contents, rather than exact stock accounting. The initial expectation is fewer than 200 entries, with room for more detailed records and growth. [Certain]

All behavior below is a design requirement, not a claim of implemented or verified functionality.

## Hosting and access

- Run one application on a VM on the server network; defer the specific VM and frontend framework until implementation planning.
- Route `https://box.clouddev.dad` through the existing reverse proxy to the application VM. Keep access restricted to the intended home networks.
- Verify household Wi-Fi DNS resolution, HTTPS, phone-to-proxy access, and proxy-to-VM access before acceptance.
- Provide shared household access without login for browsing, searching, and flagging.
- Require owner authentication for every editing endpoint, not just the visibility of menu controls. Use a secure owner session and protect mutations against cross-site requests.
- Store API credentials only on the server, outside Git. Do not expose them in browser responses or logs.
- Use a local database and separate temporary photo storage. Back up the database and required configuration; exclude photo drafts and test restoration.
- Prefer SQLite as the implementation default for this single-instance application; confirm the choice during implementation planning.

## Boxes, tags, and items

- Give each outer box a permanent unique number written visibly on its NFC label.
- Encode a permanent URL such as `https://box.clouddev.dad/box/12` into the tag. Renaming a category or moving hosting must preserve the box URL. Never silently reuse a retired box number.
- Keep contents flat. Do not model inner containers or compartments.
- Display category before number: **Drone parts · Box 12**.
- Let an item represent an individual component or a group/assortment using the same record structure.
- Store an item name, short description, optional search aliases, and its box ID. Include confirmed model numbers, sizes, or visible specifications in the description.
- Do not require quantities, track individual borrowing, or claim that the home location proves current presence.
- Support owner-only manual creation, correction, deletion, and movement between boxes.
- For an assortment, keep one entry such as “M3 screw, nut, and washer assortment,” describing approved sizes and accessory types. Do not interpret original package counts as current stock.

## Main screens

### Household homepage

Lead with **Find an item**, followed by a browsable box list. Search results show item name, description, and category followed by box number. Open the corresponding box from each result.

### Box page

Show category and box number, a contents list, and a prominent **Flag a change** button. Allow flags for specific items as well. Keep **Add items from photos**, **Add manually**, and **Edit box** inside an owner-only overflow menu. Do not retain a permanent item photo gallery.

### Owner flag inbox

Show an unresolved count to the signed-in owner. Accept a reason such as “Couldn’t find it,” “I took it,” or “Put it somewhere else,” plus an optional note and reporter name. Store box ID, optional item ID, timestamps, and status. A flag must not change inventory automatically.

Link reports to the relevant inventory. Allow the owner to edit inventory and resolve the flag, or dismiss it. Keep resolved and dismissed reports as simple history, preserving enough context if the original item is later deleted.

## Batch photo entry and deletion

1. The owner opens a box’s menu and chooses **Add items from photos**.
2. Capture or upload photos of items laid out visibly for that batch.
3. Create an owner-only temporary draft; resize images, remove unnecessary metadata, and enforce upload size/type/count limits.
4. Send photos to the primary AI provider to propose names, descriptions, and aliases. Ask for broad names when uncertain; do not invent exact specifications or quantities.
5. Show photos beside editable suggestions. Support adding missed items, removing mistakes, combining suggestions into an assortment, and correcting details.
6. Save only the approved entries in a single transaction. Prevent duplicate insertion on repeated submission. Identify possible matches with existing entries for review rather than silently merging them.
7. Delete local draft photos after successful saving or cancellation. Expire abandoned drafts and their photos after 24 hours. Retry failed cleanup and recover expired drafts on startup as well as on a schedule.

Keep a failed recognition draft available for retry or manual entry until it expires. Provide an explicit failure state. A provider result is always a draft, never a direct inventory write.

Local deletion does not establish deletion from an AI provider’s systems. Provider retention policies and account settings remain unverified. [Certain] Before live photo use, verify and document NVIDIA and OpenRouter/downstream-provider retention behavior; do not promise zero external retention.

## AI providers and fallback

Use one small server-side AI integration for photo suggestions and natural-language search. Keep provider endpoint, model, and key configurable; avoid an agent framework or a general provider-routing system.

- **Primary:** NVIDIA hosted API, initially `nvidia/nemotron-nano-12b-v2-vl`.
- **Backup:** OpenRouter Free Models Router, model ID `openrouter/free`, for both photo recognition and AI search. Do not add a paid fallback.
- The free router selects from available free models and filters for required capabilities, including image understanding. Its selected model can vary between requests. [OpenRouter free router documentation](https://openrouter.ai/docs/cookbook/get-started/free-models-router-playground). [Certain] Send actual image inputs for photo requests and validate every response; record the returned model ID when available. Treat unavailable compatible models or exhausted free quotas as fallback failure and offer manual recovery.
- Attempt OpenRouter once after a NVIDIA connection failure, timeout, rate limit, or server error, or an unusable structured response. Use a bounded total request deadline.
- Do not switch providers merely because identification is uncertain or a search returns no match. Do not bypass a safety refusal. Surface authentication/configuration errors to the owner for repair.
- Validate both providers’ outputs with the same application schema. Do not assume either provider guarantees schema compliance.
- If both fail, preserve the draft and offer manual entry or retry. Keep local search functional.
- Record minimal operational metadata such as provider, model, duration, and error category; do not log images, secrets, or full inventory payloads.
- Explain in owner setup that automatic fallback may send photos or search questions and inventory descriptions to OpenRouter and its selected downstream provider.

NVIDIA documents multi-image reasoning and visual Q&A for the selected primary model. [NVIDIA API reference](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-nano-12b-v2-vl). [Certain]

OpenRouter documents image input through chat completions, including base64 uploads for private images; image limits vary by model/provider. [OpenRouter image inputs](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding). [Certain]

OpenRouter’s own model fallback feature operates within its API. [OpenRouter fallback documentation](https://openrouter.ai/docs/guides/routing/model-fallbacks). [Certain] Implement the NVIDIA-to-OpenRouter transition in this application; an OpenRouter model list alone is not that cross-service transition.

Neither model quality nor account access, latency, pricing, or quotas has been tested for this application. [Certain]

## Search

- Run ordinary search locally over names, descriptions, and aliases.
- Provide a secondary **Ask AI** action for natural-language questions.
- For the initial inventory, send the question plus compact item IDs and approved details to the AI provider. Exclude reporter information and flag history.
- Request existing item IDs and brief match explanations. Reject unknown IDs and resolve current item details and box locations from the database before rendering.
- Label uncertain suitability **Possible match**. Do not assert connector compatibility or remaining stock without supporting saved details.
- Permit a genuine no-match result. Treat user questions and inventory descriptions as data; give the model no tools or mutation permissions.
- Put a payload/token budget on requests. If exceeded, retain local search and show the limitation rather than silently searching an arbitrary subset. Reconsider retrieval/indexing when measured size or latency warrants it.
- Apply basic request limits to household AI search and flag submission.

## Minimal data records

- **Box:** immutable ID/number, category/name, timestamps.
- **Item:** immutable ID, box ID, name, description, aliases, timestamps.
- **Flag:** ID, box reference, optional item reference, display context, reason, optional note/name, status, timestamps.
- **Photo draft:** ID, owner association, target box, temporary file references, proposed entries, expiry, save status.
- **Owner authentication/session:** store credentials using established password hashing and session mechanisms; choose the specific library with the application stack.

Keep save idempotency state long enough to recognize a repeated batch submission without retaining its photos.

## Acceptance checks

1. Tap a real NFC tag on a household phone; follow DNS, HTTPS, reverse proxy, and VM routing to the correct box.
2. Find a named PC component through local search and a listed screw size within an assortment.
3. Test natural-language questions against representative inventory, including ambiguous compatibility, absent items, and invented returned IDs.
4. Review representative photos of drone parts, labeled screw kits, connectors, and PC components; assess omissions and unsupported specificity for both providers.
5. Confirm household visitors can view/flag but cannot call owner mutation endpoints.
6. Submit, resolve, and dismiss flags, including a flag whose item is subsequently deleted.
7. Save a batch twice and verify one insertion; test database failure before saving and cleanup failure after saving.
8. Verify photo cleanup after save, cancel, expiry, and application restart, including absence from logs and backups.
9. Simulate primary-provider failure and confirm one fallback attempt. Simulate both providers failing and recover by manual entry.
10. Disconnect internet access and verify local browsing, search, flags, and manual edits.
11. Back up and restore the inventory, confirming stable box URLs and contents.

## Boundaries and remaining implementation decisions

Exclude native apps, offline synchronization, inner-container tracking, exact stock accounting, automated borrowing, external notifications, permanent photos, multi-household accounts, and a separate semantic-search service from version one.

Resolve the VM/OS, application framework, reverse-proxy configuration, owner authentication implementation, NFC writing procedure, backup destination/schedule, provider retention settings, and request limits during implementation planning. Test the free router across multiple requests because the selected model may change. No deployment or runtime verification has occurred. [Certain]
