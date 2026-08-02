# Price Guess — prototype

Guess what a dish costs from its photo. Server owns the round and the scoring; the
client never sees a price until it has guessed. See `docs/api-contract.md`.

## Run

```
node server/index.mjs        # → http://localhost:8787
```

No dependencies, Node 18+.

## Adding a restaurant

**Use the HAR route.** It captures the menu API responses, which tie dish, price and
photo together at the source — no photo has to be matched to a dish by hand — and it
embeds the image bytes, so nothing has to be fetched afterwards.

1. Open the restaurant's Grubhub page in Chrome or Edge, **F12** → **Network**.
2. Tick **Preserve log**, filter **Fetch/XHR**.
3. **Reload** the page with DevTools open.
4. **Scroll the entire menu** — a photo your browser never rendered isn't in the capture.
5. Download icon → **Export HAR**. Save into `pages/`.
6. Also do a plain **Ctrl+S** save of the page into `pages/` — the HAR has no cuisine
   field, and the saved HTML's JSON-LD does. Optional; without it the game labels
   dishes by menu category instead.

```
node scripts/ingest-har.mjs pages/<capture>.har
```

Each restaurant becomes its own `data/pools/<slug>.json`. The server unions every
pool file at startup, so adding a restaurant is just adding a file.

`scripts/ingest-saved-page.mjs` is the older saved-page path. It survives because it
handles captures taken without DevTools, but it recovers far fewer dishes and needs
hand-linking in `scripts/curation.json`. Prefer the HAR.

⚠️ **HAR files contain your session cookies.** They're gitignored. Don't share them.

## Layout

| Path | Role |
|---|---|
| `pages/` | Raw captures. Ingest input, never served. |
| `scripts/ingest-har.mjs` | HAR → pool. The good path. |
| `scripts/ingest-saved-page.mjs` | Saved page → pool. Fallback. |
| `scripts/curation.json` | Hand-assigned photo↔dish links for the fallback path. |
| `data/pools/*.json` | One pool per restaurant, prices included. Never sent to a client wholesale. |
| `public/img/` | Re-hosted photos. The only ingested asset the client sees. |
| `server/index.mjs` | API + static host. Scoring and pool composition live here. |
| `web/` | Client. No scoring logic by design. |

## Pool composition

Ingestion emits everything it can read; the server decides what's worth guessing
(`server/index.mjs`, top of file). Currently it drops items under $3.00, drinks and
condiments, and dishes duplicated across menu categories. It prints what it excluded
on startup — if a restaurant looks thin, that's the first thing to read.

## Current pool

| Restaurant | Playable | Source |
|---|---|---|
| Taco Rock (Alexandria, VA) | 69 | HAR |
| Grill Kabob (Springfield, VA) | 5 | saved page |

The contrast is the argument for the HAR route: same platform, same effort, 99 menu
items recovered with 74 photos versus 37 items with 6 photos.

Before serving this publicly, read Open Question 4 in the contract.
