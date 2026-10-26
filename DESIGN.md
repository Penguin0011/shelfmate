# Shelfmate: The household register

## Brief and scope
An existing Django inventory for household members and the owner. The job is to locate things in numbered boxes and keep that record accurate. Keep the framework, API, permissions, NFC URLs, photo drafts, voice input and forms. English; dark mode only. Sample preview records are fictional fixtures in a separate temporary database (placeholder: true); live content comes from Django, not invented marketing metrics.

## Three territories
Scores are original / fit / feasible / portable (1 to 5; low portability is better).

1. Household register: editorial type, numbered directory, one optical search lens. Anchor: physical numbered storage boxes and remembered contents. Signature: searching through smoked glass. Emotion: composed and useful. Screenshot: masthead, true counts and numbered rows. Score: 4 / 5 / 5 / 2.
2. Shelf elevation: columns that map boxes to architectural bays. Anchor: physical shelves. Signature: expanding a shelf bay. Emotion: spatial calm. Screenshot: a wall of boxes. Score: 4 / 3 / 3 / 3. Rejected because shelf coordinates are not in the existing data.
3. Keeper's journal: dated entries with material textures. Anchor: inventory changes over time. Signature: the latest entry unfolds. Emotion: personal and tactile. Screenshot: latest changes arranged as a journal. Score: 4 / 3 / 3 / 3. Rejected because a reliable event timeline would require backend work.

## Concept card
Idea: A household register that puts remembered things back within reach.
Metaphor: An editorial index viewed through smoked glass.
Signature: A single refractive search surface using dashersw/liquid-glass-js's actual Container shader, with native form controls above it.
Emotion: Quiet clarity, rather than a product launch.
Motion verb: slide into the register.
Screenshot: Newsreader masthead beside real household counts, a glass search lens and a location directory.

## System
Palette: ground #101113; ink #f0efed; muted #b3b5bb; line #ffffff26; accent #d7dce5; curtain #060810. Background mixes graphite with subdued petrol and plum at the outer edges. Inspired by the charcoal atmospheric background and open data columns observed at https://dash.clouddev.dad/.
Type: existing self-hosted Archivo for UI; self-hosted Google Newsreader 400 for whole editorial headings (OFL retained). Fluid headline 43–108px, tracking -.045em, leading .9–.97. Body 16px/1.5; metadata 12–14px. Native mobile data labels 12px minimum.
Grid: max 1360px, 48px desktop outside gutter; masthead 1fr/320px; directory 76px/1fr/1.1fr/115px with 20px gaps. Mobile 20px gutter; composed headline/count split and two-column directory rows. Physical box numbers are identifiers, not decoration.
Shape: open rows and fine rules, 7px utility controls, 16px optical lens. No rounded card grid.
Motion: power3.out; 350ms row text/arrow travel and flooding row field, 650ms initial type settlement, one GSAP ticker owns the lens renderer. Native scrolling retained for this utility app; no scroll smoothing, page loader, pinned sections or perpetual background animation. Still at rest is intentional: reading and finding items takes priority. Lens pauses offscreen, while the document is hidden, and is removed under reduced motion or failed WebGL.

Composition:
```
Brand                  Inventory / Inbox                   Household note
-----------------------------------------------------------------------
Editorial title                                        True box count
Two-line utility description                           Items / locations
-----------------------------------------------------------------------
Search prompt                                           Keyword / Smart
[              single smoked-glass search surface                  → ]
-----------------------------------------------------------------------
Collection                                              New box (owner)
Location name                                           Number of boxes
Box ID   Category and count     Specific contents        Last updated
-----------------------------------------------------------------------
Entries                  Last change                     Flags or boxes
NFC guidance                                             Session action
```
Inner pages retain navigation, large editorial category heading and clear item actions. A matching 404 returns to the register. No public sitemap, structured marketing data, invented canonical domain or social preview: this is a private household tool, deliberately noindex/nofollow.

Genericness test: rejected the previous gradient hero planet, single italic word, equal rounded cards and decorative slogan labels. The hierarchy now depends on Shelfmate's actual box numbers, locations, permissions and contents. Removed the orbital illustration as the weakest accessory.

## Integration and checks
Scope: shared template and theme, small visual driver, vendored glass Container and GSAP, licensed font, branded 404, browser checks. No schema/API/data changes. Glass samples only a generated decorative texture and does not copy document content. CSS is the fallback; native controls work without visual scripts or WebGL.
QA evidence and independent critic results are added after each pass. Production QA uses collectstatic and WhiteNoise with DEBUG=0 and HTTPS redirect/secure-cookie settings disabled only in a temporary local QA settings module.


## Review pass 1 and steering
Independent critic: Design 7.4, Usability 7.0, Creativity 6.8, Content 7.5; weighted 7.15. Fixes: label-content mismatch on brand; overly tall phone introduction and cramped summary; full-page screenshot background boundary. All three addressed in pass 2 (matching brand accessible name, compressed masthead and a single count label on phones, document-height atmospheric layers).

User steering: make the orb a voice-search tap target and loading indicator, and inspect the dashboard repository's actual multicolor palette. Source verified through GitHub: Penguin0011/home-dashboard/frontend/day-palette.mjs. DAY uses #93c5fd, #c4b5fd, #f9a8d4; GOLDEN uses #f7b267, #e8a3c4, #c4b5fd; DUSK uses #f08a5d, #d9628a, #7c5cc4. Shelfmate mixes those colors at low opacity on its dark ground. It deliberately does not introduce weather-dependent sunrise/sunset transitions.

Orb signature: native existing voice-search button, now a 92px optical tap target, plus a type-search fallback when recognition is unavailable. Existing speech capture, start/stop, smart-mode selection, maxlength and query submission are reused. Actual aria-busy state owns searching feedback; overlapping requests cannot clear a newer search's busy state. Listening/searching accelerate the same GSAP clock; idle is a low-amplitude lighting drift. Orb and glass pause offscreen or when hidden; reduced motion keeps the visible stationary control and removes GL. This replaces the earlier entirely still-at-rest decision.

Pass 2 checks: axe zero violations on home, box and 404; no desktop/mobile overflow, visible reduced-motion content, skip link first, no JavaScript errors. Native search works after simulated WebGL context loss. Full browser workflow suite including the new orb start/stop regression passes. First throttled run was below budget (4.7s LCP, ~20 FPS in this software-rendered environment); changed procedural SVG grain to a small raster texture, disabled GL and backdrop blur below 900px, and kept the native CSS lens fallback. Desktop shader redraws only on resize, never on every scroll frame. Real phone performance remains to be verified.

Final independent critic: Design 7.5, Usability 7.0, Creativity 6.8, Content 7.4; weighted 7.19. The requested design is implemented, but an 8/10 award-readiness claim is not justified. Remaining priority is real-device mobile profiling. Four-times CPU-throttled software-browser measurement after raster/mobile fallback was 3300ms LCP, CLS 0, 17.85 FPS. Subsequent change removes per-frame layout reads from orb visibility tracking using IntersectionObserver and promotes the static background layers; its actual device benefit is not claimed without measurement. Full production screenshots, reduced-motion states, focus, hover and axe evidence are in the ignored .shots/ directory.

Run: set local SECRET_KEY and DEBUG=1, then `.venv/Scripts/python manage.py runserver` on Windows (use `.venv/bin/python` on Unix). Existing production deploy/ and README.md instructions still apply; run collectstatic when deploying. No deployment was performed. No new product data or user accounts were added to the real database.
