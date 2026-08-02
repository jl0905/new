# Price Guessing Game — Frontend/Backend Data Contract

**Status:** Draft v0.1
**Scope:** Defines the HTTP contract between the web client and the game backend. Google Maps ingestion is described only where it constrains the contract; the frontend never talks to Google directly.

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
  "dish_name": "Tonkotsu Ramen",
  "image": {
    "url": "https://cdn.<domain>/i/9f3a2c/1200.webp",
    "srcset": [
      { "url": "https://cdn.<domain>/i/9f3a2c/600.webp",  "width": 600 },
      { "url": "https://cdn.<domain>/i/9f3a2c/1200.webp", "width": 1200 },
      { "url": "https://cdn.<domain>/i/9f3a2c/2000.webp", "width": 2000 }
    ],
    "blurhash": "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
    "aspect_ratio": 1.333,
    "attribution": {
      "text": "Photo by A. Nguyen via Google Maps",
      "source": "google_maps",
      "source_url": "https://maps.google.com/?cid=1234567890"
    }
  },
  "restaurant": {
    "name": "Ichiban Noodle House",
    "city": "Seattle",
    "region": "WA",
    "country": "US",
    "price_level": 2,
    "cuisine_tags": ["japanese", "ramen"]
  },
  "currency": "USD",
  "guess_bounds": { "min_minor": 100, "max_minor": 10000 },
  "captured_at": "2025-11-02T00:00:00Z"
}
```

**Field notes**

- `image.blurhash` and `aspect_ratio` exist so the client can reserve layout space and avoid CLS. Both are always present.
- `attribution` **MUST** be rendered visibly adjacent to the photo. This is a Google Maps platform requirement, not a nicety.
- `guess_bounds` drives slider min/max. Server-supplied so the difficulty curve stays server-owned.
- `price_level` is Google's 0–4 coarse bucket, exposed as a soft hint. `null` when unknown.
- `captured_at` is when the price was observed, not when the row was written. Renders as "price as of …".
- **`price` is absent from this projection.** Its absence is the contract.

### 3.2 `RevealedItem` (post-guess projection)

Returned only in a guess response or a completed round summary. Superset of `Item`:

```json
{
  "item_id": "itm_9f3a2c",
  "actual_price": { "amount_minor": 1450, "currency": "USD" },
  "price_confidence": "high",
  "price_source": "menu_photo_ocr",
  "percentile_context": {
    "cheaper_than_pct": 62,
    "peer_group": "ramen_in_seattle"
  }
}
```

- `price_confidence`: `high` | `medium` | `low`. Client SHOULD badge non-`high` items so users understand a surprising answer.
- `price_source`: `menu_photo_ocr` | `place_details` | `user_review_text` | `manual_curation`.

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

- All images are served from our CDN, never hotlinked from Google. Ingestion caches and re-encodes to WebP/AVIF within Google Maps Platform caching terms.
- The client requests the smallest `srcset` entry that satisfies the layout; it MUST NOT construct CDN URLs by string manipulation.
- Attribution text MUST be rendered on the same screen as the photo, legibly, before and after the guess.
- If an image 404s, the client SHOULD call `POST /v1/items/{item_id}/report` with `reason: "image_broken"` and request a replacement item via `POST /v1/rounds/{round_id}/skip`. A skipped item scores zero and does not count against accuracy.

---

## 7. Data Freshness & Quality

Ingestion guarantees the client can rely on:

- Every `Item` has a non-null `dish_name`, a reachable image, and a price with `price_confidence ≥ low`.
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
2. **Anti-cheat depth.** Restaurant name + dish name make the answer googleable in ~15s. Options: hide restaurant name until reveal, or accept it as a soft-cheat and lean on time pressure. Needs a product decision before the contract for `Item` freezes.
3. **Realtime/multiplayer.** Nothing here is WebSocket-shaped. If head-to-head is on the roadmap, the round resource should be designed for it now rather than bolted on.
4. **Google Maps ToS.** Photo caching duration and attribution placement need a legal read before launch.
