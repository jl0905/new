# Price Guessing Game — Frontend/Backend Data Contract

**Status:** Draft v0.2
**Scope:** Defines the HTTP contract between the web client and the game backend. Ingestion is described only where it constrains the contract; the frontend never talks to an upstream source directly.

**v0.2 changes.** The first real pool comes from delivery-platform menu pages, not Google Maps. Menu pages give an exact price, a dish name, a description, and a photo already associated with the dish — strictly better than Google's `price_level` bucket plus an unlabelled photo. The contract changes that follow from this are marked **[v0.2]** below.

---

## 1. Principles

1. **The client never sees the answer before it guesses.** Price is withheld from item payloads until the guess is submitted. Scoring is computed server-side. This is non-negotiable — it is the entire integrity of the game.
2. **The frontend is a rendering layer over a server-owned round.** The server decides which items appear, in what order, and what a "good" guess is. The client submits intent (a guess) and renders results.
3. **Ingestion is invisible to the contract.** Whether an item came from Google Maps, a manual upload, or a future partner feed, the client sees one normalized `Item` shape.
4. **Everything is versioned and paginated-by-token.** No offset pagination, no unversioned breaking changes.
5. **Currency and locale are explicit.** Prices are integer minor units plus an ISO 4217 code. Never floats, never bare numbers.

---

## 2. Conventions

| Aspect | Rule |
|---|---|
| Base URL | `https://api.<domain>/v1` |
| Transport | HTTPS only, HTTP/2 |
| Encoding | `application/json; charset=utf-8` |
| Case | `snake_case` keys |
| Timestamps | RFC 3339 UTC, e.g. `2026-08-02T17:04:11Z` |
| IDs | Opaque strings, ≤64 chars, URL-safe. Clients MUST NOT parse them. |
| Money | `{ "amount_minor": 1450, "currency": "USD" }` → $14.50 |
| Versioning | Path-based major (`/v1`). Additive changes are non-breaking; clients MUST ignore unknown fields. |
| Auth | `Authorization: Bearer <jwt>` on all endpoints except `POST /sessions` |
| Idempotency | `Idempotency-Key` header on all mutating requests; server replays the original response for 24h |
| Request tracing | Server returns `X-Request-Id`; client logs it with any error report |

---

## 3. Core Resources

### 3.1 `Item` (pre-guess projection)

The unit of gameplay: one dish, one photo, one hidden price.

```json
{
  "item_id": "itm_9f3a2c",
  "dish_name": "Chicken Kabob Platter",
  "description": "Grilled chicken breast served with fresh baked bread, steamed basmati rice and salad.",
  "image": {
    "url": "https://cdn.<domain>/i/9f3a2c/1200.webp",
    "srcset": [
      { "url": "https://cdn.<domain>/i/9f3a2c/600.webp",  "width": 600 },
      { "url": "https://cdn.<domain>/i/9f3a2c/1200.webp", "width": 1200 }
    ],
    "aspect_ratio": 1.0,
    "attribution": {
      "text": "Menu photo via Grubhub — Grill Kabob",
      "source": "grubhub",
      "source_url": "https://www.grubhub.com/restaurant/.../1185488"
    }
  },
  "restaurant": {
    "city": "Springfield",
    "region": "VA",
    "country": "US",
    "cuisine_tags": ["afghan", "middle eastern"]
  },
  "currency": "USD",
  "guess_bounds": { "min_minor": 600, "max_minor": 3500 },
  "captured_at": "2026-08-02T18:08:31Z"
}
```

**Field notes**

- **[v0.2] `description`** is the merchant's own menu copy. It arrives free with menu ingestion and is the single best difficulty lever we have — "served with rice and salad" tells a player this is a platter, not a side.
- **[v0.2] `restaurant.name` is absent from this projection**, and moves to `RevealedItem`. Dish name + restaurant name makes the answer searchable in about fifteen seconds (Open Question 2). Cuisine and city survive because they are what makes the guess *possible* without making it *lookup-able*.
- **[v0.2] `restaurant.price_level` is gone.** It was a Google artifact. Menu ingestion has no equivalent, and a coarse bucket derived from a menu we already priced exactly is a hint about our own answer.
- **[v0.2] `image.blurhash` is dropped**; `aspect_ratio` remains and is still always present. Blurhash requires decoding the image during ingestion for a placeholder the client shows for ~100ms against a CDN-cached asset. `aspect_ratio` alone reserves layout space and prevents CLS, which was the actual requirement.
- **[v0.2] `guess_bounds` is pool-wide, not per-item**, and identical across every item in a round. Per-item bounds derived from the item's own price leak the answer — a slider capped at $18 tells the player the dish is not $30. Bounds are computed once from the whole playable pool.
- `attribution` **MUST** be rendered visibly adjacent to the photo, before and after the guess.
- `captured_at` is when the price was observed, not when the row was written. Renders as "price as of …".
- **`price` is absent from this projection.** Its absence is the contract.

### 3.2 `RevealedItem` (post-guess projection)

Returned only in a guess response or a completed round summary. Superset of `Item`:

```json
{
  "item_id": "itm_9f3a2c",
  "actual_price": { "amount_minor": 1559, "currency": "USD" },
  "price_confidence": "high",
  "price_source": "delivery_platform_menu",
  "restaurant_name": "Grill Kabob",
  "percentile_context": {
    "cheaper_than_pct": 62,
    "peer_group": "kabob_in_northern_virginia"
  }
}
```

- **[v0.2] `restaurant_name`** — withheld pre-guess, revealed here. The client renders it in the reveal panel next to `captured_at`.
- `price_confidence`: `high` | `medium` | `low`. Client SHOULD badge non-`high` items so users understand a surprising answer.
- **[v0.2] `price_confidence` now folds in photo-linkage risk, not just price risk.** A menu price is exact by construction; the uncertainty moved to *which dish this photo shows*. An item whose photo the source page itself tied to the dish is `high`. An item whose photo a human assigned by looking at it is capped at that human's confidence. This matters because a mislinked photo produces a *confidently wrong* answer, which is worse for the game than a fuzzy one.
- **[v0.2] `price_source`**: `delivery_platform_menu` | `chain_menu_api` | `menu_photo_ocr` | `user_review_text` | `manual_curation`. `place_details` is removed — Google Places never returned dish-level prices, so no item could ever have carried it.
- **[v0.2] `image_link_method`**: `source_api` | `inline` | `curation`. How this photo came to be associated with this dish. `source_api` means the upstream menu response stated the association itself and the item is `high` confidence by construction; `curation` means a human decided it and confidence is capped at what that human claimed. This field exists so a bad pool can be diagnosed without re-running ingestion.

### 3.3 `Round`

```json
{
  "round_id": "rnd_c81b4d",
  "mode": "classic",
  "item_count": 5,
  "current_index": 0,
  "items": [ /* Item[] — pre-guess projection */ ],
  "score": { "total": 0, "max_possible": 5000 },
  "expires_at": "2026-08-02T18:04:11Z",
  "seed": "2026-08-02"
}
```

- `items` is delivered **whole** at round start so the client can prefetch images. Safe because prices are withheld.
- `seed` is present only for daily/shared modes; it is what makes a result shareable and comparable.
- A round is dead after `expires_at`; guesses against it return `410 round_expired`.

---

## 4. Endpoints

### `POST /v1/sessions`
Creates an anonymous session; upgradeable later to an account.

**Request**
```json
{ "locale": "en-US", "preferred_currency": "USD", "device_id": "dev_..." }
```

**Response `201`**
```json
{
  "session_id": "ses_...",
  "access_token": "eyJ...",
  "expires_in": 3600,
  "refresh_token": "rft_...",
  "player": { "player_id": "ply_...", "display_name": "Guest-4821", "is_anonymous": true }
}
```

---

### `POST /v1/rounds`
Starts a round.

**Request**
```json
{
  "mode": "classic",
  "filters": { "country": "US", "cuisine_tags": ["japanese"], "city": "Seattle" },
  "item_count": 5
}
```

- `mode`: `classic` (random) | `daily` (fixed by UTC date, one attempt per player) | `themed`.
- `filters` are advisory. If the pool is too thin the server widens them and reports what it did:

**Response `201`** → `Round`, plus:
```json
{ "filters_applied": { "country": "US", "cuisine_tags": [] },
  "filters_relaxed": ["cuisine_tags"] }
```

The client MUST surface `filters_relaxed` ("not enough Japanese dishes in Seattle — widened to all cuisines"). Silently ignoring a filter is worse than refusing it.

**Errors**
- `409 daily_already_played` — includes `{ "existing_round_id": "...", "next_available_at": "..." }`
- `422 insufficient_pool` — even after relaxation, fewer than `item_count` items exist.

---

### `POST /v1/rounds/{round_id}/guesses`
The one call that matters.

**Request**
```json
{
  "item_id": "itm_9f3a2c",
  "guess": { "amount_minor": 1200, "currency": "USD" },
  "elapsed_ms": 8412
}
```

**Response `200`**
```json
{
  "item_id": "itm_9f3a2c",
  "guess": { "amount_minor": 1200, "currency": "USD" },
  "revealed": { /* RevealedItem */ },
  "result": {
    "points": 812,
    "max_points": 1000,
    "error_ratio": -0.1724,
    "error_band": "close",
    "streak": 3
  },
  "round_progress": { "current_index": 1, "item_count": 5, "score_total": 2431 },
  "next_item_id": "itm_44b1e0"
}
```

- `error_ratio` = `(guess − actual) / actual`. Signed: negative means the player under-guessed. The client renders direction ("you lowballed it by 17%") from the sign; it does not recompute the number.
- `error_band`: `exact` | `close` | `fair` | `way_off`. Server-owned thresholds so tuning scoring never requires a client release.
- `points` is authoritative. The client MUST NOT implement its own scoring formula — not even for optimistic UI. Show a spinner instead of a number you might have to retract.
- `elapsed_ms` is client-reported and treated as untrusted telemetry; it may feed a time bonus but is server-clamped.

**Errors**
- `409 already_guessed` — idempotent replay returns the original result body, not an error, when `Idempotency-Key` matches.
- `410 round_expired`
- `422 guess_out_of_bounds` — outside `guess_bounds`.

---

### `GET /v1/rounds/{round_id}`
Resume/rehydrate after refresh or reconnect. Returns the `Round` with already-guessed items upgraded to `RevealedItem` and un-guessed items still withheld. This endpoint is what makes the game survive a page reload.

---

### `POST /v1/rounds/{round_id}/complete`
Finalizes. Response:

```json
{
  "round_id": "rnd_c81b4d",
  "score": { "total": 3980, "max_possible": 5000, "accuracy_pct": 79.6 },
  "items": [ /* RevealedItem[] with each guess attached */ ],
  "percentile_vs_players": 68,
  "share_payload": {
    "text": "Price Guess 2026-08-02 — 3980/5000 🟩🟩🟨🟩🟥",
    "url": "https://<domain>/d/2026-08-02"
  }
}
```

`share_payload` is server-generated so share strings stay consistent across web, future mobile, and OG images.

---

### `GET /v1/leaderboards/{scope}`
`scope` ∈ `daily` | `weekly` | `all_time`. Cursor-paginated:

```json
{
  "entries": [
    { "rank": 1, "player_id": "ply_...", "display_name": "noodlehead", "score": 4820 }
  ],
  "viewer_entry": { "rank": 1442, "score": 3980 },
  "next_cursor": "eyJvIjoyNX0",
  "generated_at": "2026-08-02T17:00:00Z"
}
```

`viewer_entry` is always included even when off-page — otherwise the client makes a second request every time.

---

## 5. Errors

Uniform envelope. HTTP status carries the class; `code` carries the meaning.

```json
{
  "error": {
    "code": "guess_out_of_bounds",
    "message": "Guess must be between $1.00 and $100.00.",
    "field": "guess.amount_minor",
    "retryable": false,
    "request_id": "req_8812fa"
  }
}
```

- `message` is human-readable, localized per session `locale`, and safe to display.
- Clients switch on `code`, never on `message`.
- `429` includes `Retry-After` and `retryable: true`.
- `5xx` responses are retryable with exponential backoff + jitter; mutating retries MUST reuse the original `Idempotency-Key`.

| Status | Codes |
|---|---|
| 400 | `malformed_request` |
| 401 | `token_expired`, `token_invalid` |
| 403 | `forbidden` |
| 404 | `round_not_found`, `item_not_found` |
| 409 | `already_guessed`, `daily_already_played` |
| 410 | `round_expired` |
| 422 | `guess_out_of_bounds`, `insufficient_pool` |
| 429 | `rate_limited` |
| 503 | `upstream_unavailable` |

---

## 6. Images & Attribution

- **[v0.2]** Photos come from merchant menu listings on delivery platforms. These are typically supplied by the restaurant, which makes the merchant — not the platform — the party whose permission actually matters. Attribution names both the platform and the restaurant (`"Menu photo via Grubhub — Grill Kabob"`), and links back to the source listing.
- **[v0.2]** Ingestion is snapshot-based, not crawl-based: a saved page is parsed offline. There is no automated traffic against the source platform, which is what keeps the prototype defensible. Scaling this is a licensing conversation, not an engineering one — see Open Question 4.
- All images are served from our CDN, never hotlinked from the source platform. Ingestion re-encodes to WebP/AVIF.
- The client requests the smallest `srcset` entry that satisfies the layout; it MUST NOT construct CDN URLs by string manipulation.
- Attribution text MUST be rendered on the same screen as the photo, legibly, before and after the guess.
- If an image 404s, the client SHOULD call `POST /v1/items/{item_id}/report` with `reason: "image_broken"` and request a replacement item via `POST /v1/rounds/{round_id}/skip`. A skipped item scores zero and does not count against accuracy.

---

## 7. Data Freshness & Quality

Ingestion guarantees the client can rely on:

- Every `Item` has a non-null `dish_name`, a reachable image, and a price with `price_confidence ≥ low`.
- **[v0.2] Pool composition is applied at serve time, not at ingest time.** Ingestion emits every dish it can read, prices included; the server decides what is worth guessing — currently a price floor, a drinks/condiments exclusion, and de-duplication of dishes that appear under several menu categories. Keeping the rejects in the pool file rather than discarding them at ingest means re-tuning the game does not mean re-capturing every restaurant.
- **[v0.2] A priced dish with no confidently-linked photo is not an `Item`.** Menu ingestion recovers far more prices than photos — a snapshot yielding 37 priced dishes may yield only 5 usable pairs, because the source page lazy-loads images and virtualizes the list. Unpaired prices are retained in the ingest output for later linkage but never enter the pool. Pool size is therefore governed by photo coverage, not price coverage; that ratio is the number to watch when scaling.
- Prices older than 18 months are excluded from `classic` and `daily` pools.
- `captured_at` is never in the future and never older than the source observation.
- Items reported by ≥N players are quarantined automatically and disappear from future rounds.

The frontend surfaces staleness ("price as of Nov 2025") but never filters on it — pool composition is a server concern.

---

## 8. Caching

| Endpoint | Policy |
|---|---|
| `GET /rounds/{id}` | `no-store` (contains hidden state) |
| CDN images | `public, max-age=31536000, immutable` (content-hashed URLs) |
| `GET /leaderboards/*` | `public, max-age=30, stale-while-revalidate=120` |
| All mutations | `no-store` |

---

## 9. Open Questions

1. **Multi-currency rounds.** Should a round ever mix currencies? Current contract allows it per-item, but the UI cost is real. Recommendation: enforce single-currency rounds in v1 and revisit.
2. ~~**Anti-cheat depth.**~~ **Resolved in v0.2:** restaurant name is withheld until reveal. Cheap to do, costs the player nothing they need, and it was going to get harder to change later.
3. **Realtime/multiplayer.** Nothing here is WebSocket-shaped. If head-to-head is on the roadmap, the round resource should be designed for it now rather than bolted on.
4. **Source rights.** ⚠️ **Blocker on public launch, not on prototyping.** Delivery-platform ToS prohibit automated collection and redistribution of listing content. A one-off manual snapshot used privately is a different posture from a public game serving those photos, and the second needs either a licensed menu feed or direct merchant permission. Recommendation: keep the current pipeline for prototyping, and treat "which upstream do we actually have rights to" as the gating decision before any public round is served.
5. **[v0.2] Single-restaurant pools.** With one restaurant the game degenerates: a player learns that platters cluster at $13–19 and stops looking at the photo. Multiple restaurants and price tiers are a gameplay requirement, not a scale nicety.
6. **[v0.2] Photo-linkage at scale.** Hand-assigning photos to dishes does not survive past a few restaurants. If snapshot ingestion continues, linkage needs to come from a source that emits the association directly, or from an image classifier scored against the menu's own dish names.
