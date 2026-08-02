// Price Guessing Game — prototype backend.
// Zero dependencies, in-memory rounds. Implements the subset of docs/api-contract.md
// the game actually needs, with the one non-negotiable intact: the client never
// receives a price before it has guessed, and scoring happens here.
//
//   node server/index.mjs   →  http://localhost:8787

import { createServer } from 'node:http'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { extname, join, normalize, resolve, dirname } from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT || 8787)

// §7: pool composition is a server concern. Ingestion emits everything it can read;
// these rules decide what is actually worth guessing.
const MIN_PLAYABLE_MINOR = 300 // below this it's a condiment, not a dish
const NOT_A_DISH = /\b(water|soda|coke|sprite|juice|bottled|can|drink|beverage|side sauce|extra)\b/i

const POOL_DIR = join(ROOT, 'data', 'pools')
const pools = readdirSync(POOL_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(POOL_DIR, f), 'utf8')))

const rejected = { cheap: 0, not_a_dish: 0, low_confidence: 0, duplicate: 0 }
const seen = new Set()
const PLAYABLE = pools.flatMap((p) => p.items).filter((i) => {
  if (!['high', 'medium', 'low'].includes(i.price_confidence)) return ++rejected.low_confidence && false
  if (i.actual_price.amount_minor < MIN_PLAYABLE_MINOR) return ++rejected.cheap && false
  if (NOT_A_DISH.test(i.dish_name)) return ++rejected.not_a_dish && false
  // The same dish often appears in several menu categories under distinct ids.
  const key = `${i.restaurant.name}|${i.dish_name}|${i.actual_price.amount_minor}`
  if (seen.has(key)) return ++rejected.duplicate && false
  seen.add(key)
  return true
})

if (!PLAYABLE.length) throw new Error(`no playable items in ${POOL_DIR} — run an ingest script first`)

// Pool-wide and identical for every item: bounds derived from an item's own price
// would leak the answer.
const BOUNDS = (() => {
  const prices = PLAYABLE.map((i) => i.actual_price.amount_minor)
  return {
    min_minor: Math.max(100, Math.floor((Math.min(...prices) * 0.5) / 100) * 100),
    max_minor: Math.ceil((Math.max(...prices) * 1.5) / 100) * 100,
  }
})()

const sessions = new Map() // token -> { player_id }
const rounds = new Map() // round_id -> round state

// ------------------------------------------------------------------ scoring

const BANDS = [
  [0.05, 'exact'],
  [0.15, 'close'],
  [0.35, 'fair'],
]

function score(guessMinor, actualMinor) {
  const error_ratio = (guessMinor - actualMinor) / actualMinor
  const err = Math.abs(error_ratio)
  // Smooth exponential decay: exact answers score 1000, ~50% off scores ~170.
  const points = Math.max(0, Math.round(1000 * Math.exp(-3.5 * err)))
  const error_band = BANDS.find(([t]) => err <= t)?.[1] ?? 'way_off'
  return { points, max_points: 1000, error_ratio: Number(error_ratio.toFixed(4)), error_band }
}

// ------------------------------------------------------------- projections

// The pre-guess projection. Everything price-bearing is stripped here, once,
// so no endpoint can leak it by forgetting to.
function publicItem(item) {
  return {
    item_id: item.item_id,
    dish_name: item.dish_name,
    description: item.description,
    menu_category: item.menu_category ?? null,
    image: item.image,
    // Restaurant name is withheld until reveal — see Open Question 2.
    restaurant: { city: item.restaurant.city, region: item.restaurant.region, country: item.restaurant.country, cuisine_tags: item.restaurant.cuisine_tags },
    currency: item.currency,
    guess_bounds: BOUNDS,
    captured_at: item.captured_at,
  }
}

function revealedItem(item) {
  return {
    item_id: item.item_id,
    dish_name: item.dish_name,
    actual_price: item.actual_price,
    price_confidence: item.price_confidence,
    price_source: item.price_source,
    restaurant_name: item.restaurant.name,
    captured_at: item.captured_at,
  }
}

// ------------------------------------------------------------------ rounds

function createRound(itemCount) {
  const shuffled = [...PLAYABLE]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  const chosen = shuffled.slice(0, Math.min(itemCount, shuffled.length))
  const round = {
    round_id: 'rnd_' + randomUUID().slice(0, 8),
    mode: 'classic',
    items: chosen,
    guesses: new Map(), // item_id -> { guess, result }
    created_at: Date.now(),
    expires_at: Date.now() + 60 * 60 * 1000,
  }
  rounds.set(round.round_id, round)
  return round
}

function roundView(round) {
  return {
    round_id: round.round_id,
    mode: round.mode,
    item_count: round.items.length,
    current_index: round.guesses.size,
    items: round.items.map((item) => {
      const played = round.guesses.get(item.item_id)
      return played
        ? { ...publicItem(item), revealed: revealedItem(item), guess: played.guess, result: played.result }
        : publicItem(item)
    }),
    score: { total: totalScore(round), max_possible: round.items.length * 1000 },
    expires_at: new Date(round.expires_at).toISOString(),
  }
}

const totalScore = (round) => [...round.guesses.values()].reduce((s, g) => s + g.result.points, 0)

// ----------------------------------------------------------------- routing

const json = (res, status, body) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

const fail = (res, status, code, message, extra = {}) =>
  json(res, status, { error: { code, message, retryable: status >= 500, request_id: 'req_' + randomBytes(4).toString('hex'), ...extra } })

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname

  if (path.startsWith('/v1/')) return api(req, res, path)
  return serveStatic(res, path)
})

async function api(req, res, path) {
  const body = req.method === 'POST' ? await readBody(req) : {}
  if (body === null) return fail(res, 400, 'malformed_request', 'Request body is not valid JSON.')

  if (req.method === 'POST' && path === '/v1/sessions') {
    const access_token = 'tok_' + randomBytes(16).toString('hex')
    const player = { player_id: 'ply_' + randomBytes(4).toString('hex'), display_name: 'Guest', is_anonymous: true }
    sessions.set(access_token, player)
    return json(res, 201, { session_id: 'ses_' + randomBytes(4).toString('hex'), access_token, expires_in: 3600, player })
  }

  const token = (req.headers.authorization || '').replace(/^Bearer /, '')
  if (!sessions.has(token)) return fail(res, 401, 'token_invalid', 'Session token missing or unknown.')

  if (req.method === 'POST' && path === '/v1/rounds') {
    const want = Number.isInteger(body.item_count) ? body.item_count : 5
    if (!PLAYABLE.length) return fail(res, 422, 'insufficient_pool', 'No playable items are available.')
    const round = createRound(want)
    const view = roundView(round)
    return json(res, 201, {
      ...view,
      pool_size: PLAYABLE.length,
      // The client must be told when it asked for more than the pool can serve.
      items_truncated: want > PLAYABLE.length ? { requested: want, served: round.items.length } : null,
    })
  }

  const m = path.match(/^\/v1\/rounds\/([^/]+)(\/guesses|\/complete)?$/)
  if (!m) return fail(res, 404, 'not_found', 'Unknown endpoint.')

  const round = rounds.get(m[1])
  if (!round) return fail(res, 404, 'round_not_found', 'No such round.')
  if (Date.now() > round.expires_at) return fail(res, 410, 'round_expired', 'This round has expired.')

  if (req.method === 'GET' && !m[2]) return json(res, 200, roundView(round))

  if (req.method === 'POST' && m[2] === '/guesses') {
    const item = round.items.find((i) => i.item_id === body.item_id)
    if (!item) return fail(res, 404, 'item_not_found', 'That item is not part of this round.')

    const existing = round.guesses.get(item.item_id)
    // Idempotent replay: a repeated guess returns the original result, not an error.
    if (existing) return json(res, 200, guessResponse(round, item, existing))

    const amount = body.guess?.amount_minor
    if (!Number.isInteger(amount)) return fail(res, 400, 'malformed_request', 'guess.amount_minor must be an integer.', { field: 'guess.amount_minor' })
    if (amount < BOUNDS.min_minor || amount > BOUNDS.max_minor) {
      return fail(res, 422, 'guess_out_of_bounds', `Guess must be between $${(BOUNDS.min_minor / 100).toFixed(2)} and $${(BOUNDS.max_minor / 100).toFixed(2)}.`, {
        field: 'guess.amount_minor',
      })
    }

    const played = { guess: { amount_minor: amount, currency: 'USD' }, result: score(amount, item.actual_price.amount_minor) }
    round.guesses.set(item.item_id, played)
    return json(res, 200, guessResponse(round, item, played))
  }

  if (req.method === 'POST' && m[2] === '/complete') {
    const total = totalScore(round)
    const max = round.items.length * 1000
    return json(res, 200, {
      round_id: round.round_id,
      score: { total, max_possible: max, accuracy_pct: max ? Number(((total / max) * 100).toFixed(1)) : 0 },
      items: round.items.map((i) => ({ ...revealedItem(i), ...(round.guesses.get(i.item_id) || {}) })),
      share_payload: { text: sharePayload(round, total, max) },
    })
  }

  return fail(res, 404, 'not_found', 'Unknown endpoint.')
}

function guessResponse(round, item, played) {
  const remaining = round.items.filter((i) => !round.guesses.has(i.item_id))
  return {
    item_id: item.item_id,
    guess: played.guess,
    revealed: revealedItem(item),
    result: played.result,
    round_progress: { current_index: round.guesses.size, item_count: round.items.length, score_total: totalScore(round) },
    next_item_id: remaining[0]?.item_id ?? null,
  }
}

const BAND_EMOJI = { exact: '🟩', close: '🟩', fair: '🟨', way_off: '🟥' }

function sharePayload(round, total, max) {
  const squares = round.items.map((i) => BAND_EMOJI[round.guesses.get(i.item_id)?.result.error_band] ?? '⬜').join('')
  return `Price Guess — ${total}/${max} ${squares}`
}

// ------------------------------------------------------------------ static

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
}
const IMAGE_EXT = new Set(['.jpg', '.png', '.webp', '.avif'])

function serveStatic(res, path) {
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^([/\\])+/, '')
  for (const dir of ['web', 'public']) {
    const file = join(ROOT, dir, rel)
    if (!file.startsWith(join(ROOT, dir))) break // path traversal
    if (existsSync(file)) {
      const ext = extname(file)
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': IMAGE_EXT.has(ext) ? 'public, max-age=31536000, immutable' : 'no-cache',
      })
      return res.end(readFileSync(file))
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
}

server.listen(PORT, () => {
  console.log(`Price Guess prototype → http://localhost:${PORT}`)
  for (const p of pools) {
    const n = PLAYABLE.filter((i) => i.restaurant.name === p.restaurant.name).length
    console.log(`  ${String(n).padStart(3)} items — ${p.restaurant.name} (${p.restaurant.city}, ${p.restaurant.region})`)
  }
  console.log(`pool: ${PLAYABLE.length} playable · excluded ${rejected.cheap} under $${(MIN_PLAYABLE_MINOR / 100).toFixed(2)}, ${rejected.not_a_dish} non-dish, ${rejected.duplicate} duplicate, ${rejected.low_confidence} low-confidence`)
  console.log(`bounds: $${(BOUNDS.min_minor / 100).toFixed(2)} – $${(BOUNDS.max_minor / 100).toFixed(2)}`)
})
