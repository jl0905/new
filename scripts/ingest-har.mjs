// Ingests a DevTools HAR capture of a delivery-platform restaurant page.
//
//   node scripts/ingest-har.mjs pages/www.grubhub.com.har
//
// A HAR is a far better source than a saved page: the menu API responses carry
// dish name, description, exact price and the photo's asset id already associated
// with each other, and the image bytes themselves are embedded base64. Nothing has
// to be fetched, and no photo has to be matched to a dish by hand.
//
// Writes data/pools/<slug>.json and public/img/<item_id>.<ext>. Each restaurant is
// its own pool file; the server unions them.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const POOL_DIR = join(ROOT, 'data', 'pools')
const IMG_DIR = join(ROOT, 'public', 'img')

const harPath = process.argv[2]
if (!harPath) {
  console.error('usage: node scripts/ingest-har.mjs <capture.har>')
  process.exit(1)
}

const har = JSON.parse(readFileSync(harPath, 'utf8'))
const entries = har.log.entries.filter((e) => e.response?.content?.text)
const bodiesFor = (fragment) => entries.filter((e) => e.request.url.includes(fragment))

const asJson = (entry) => {
  try {
    return JSON.parse(entry.response.content.text)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- restaurant

function parseRestaurant() {
  const entry = bodiesFor('/info/nonvolatile/')[0]
  if (!entry) throw new Error('no restaurant info response in this HAR — was the page reloaded with the Network tab recording?')
  const e = asJson(entry)?.object?.data?.content?.[0]?.entity
  if (!e) throw new Error('restaurant info response present but not in the expected shape')

  return {
    source_id: e.id,
    source_url: `https://www.grubhub.com/restaurant/${e.merchant_url_path}/${e.id}`,
    name: e.name,
    city: e.address?.locality,
    region: e.address?.region,
    country: e.address?.country === 'USA' ? 'US' : e.address?.country,
    // The HAR carries no cuisine field; the saved HTML page's JSON-LD does. Use it
    // when a sibling snapshot exists, otherwise fall back to menu category names.
    cuisine_tags: cuisinesFromSiblingHtml(e.name),
  }
}

function cuisinesFromSiblingHtml(restaurantName) {
  const dir = dirname(resolve(harPath))
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.html'))) {
    const html = readFileSync(join(dir, file), 'utf8')
    const m = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/)
    if (!m) continue
    let ld
    try {
      ld = JSON.parse(m[1])
    } catch {
      continue
    }
    if (ld.name === restaurantName && ld.servesCuisine?.length) {
      return ld.servesCuisine.map((c) => c.toLowerCase())
    }
  }
  return []
}

// ---------------------------------------------------------------- menu items

// Two response shapes carry items. The category feed is the bulk of the menu; the
// menu_items lookup fills in whatever the feed paged past. Both are normalized here.
function parseItems() {
  const items = new Map()

  for (const entry of bodiesFor('/feed/')) {
    for (const c of asJson(entry)?.object?.data?.content ?? []) {
      const e = c.entity
      if (!e?.item_id || !e.item_name) continue
      const amount = e.item_price?.delivery?.value ?? e.item_price?.pickup?.value
      upsert(items, {
        id: e.item_id,
        name: e.item_name,
        description: e.item_description,
        amount_minor: amount,
        public_id: e.media_image?.public_id,
        format: e.media_image?.format,
        category: c.entity?.menu_category_name ?? null,
      })
    }
  }

  for (const entry of bodiesFor('/menu_items/')) {
    for (const it of asJson(entry)?.menu_items ?? []) {
      if (!it?.id || !it.name) continue
      upsert(items, {
        id: it.id,
        name: it.name,
        description: it.description,
        amount_minor: it.delivery_price?.amount ?? it.price?.amount,
        public_id: it.media_image?.public_id,
        format: it.media_image?.format,
        category: it.menu_category_name ?? null,
      })
    }
  }

  return [...items.values()]
}

// Later responses may carry a category or description the feed lacked; merge rather
// than overwrite, and never let a null clobber a value we already have.
function upsert(map, next) {
  const prev = map.get(next.id)
  if (!prev) return map.set(next.id, next)
  for (const [k, v] of Object.entries(next)) if (v != null && prev[k] == null) prev[k] = v
}

// ---------------------------------------------------------------- images

// Every image the browser rendered is in the HAR as base64. Grubhub requests the
// same asset at several widths; keep the largest, which is the sharpest.
function collectImages() {
  const best = new Map() // public_id -> { buffer, mime }
  for (const e of entries) {
    const mime = e.response.content.mimeType || ''
    if (!mime.startsWith('image/') || e.response.content.encoding !== 'base64') continue
    const id = e.request.url.match(/media-cdn\.grubhub\.com\/image\/upload\/.*?\/([a-z0-9]{16,})(?:[.?]|$)/)?.[1]
    if (!id) continue
    const buffer = Buffer.from(e.response.content.text, 'base64')
    if (!best.has(id) || buffer.length > best.get(id).buffer.length) best.set(id, { buffer, mime })
  }
  return best
}

const EXT = { 'image/avif': '.avif', 'image/webp': '.webp', 'image/jpeg': '.jpg', 'image/png': '.png' }

// ---------------------------------------------------------------- emit

const restaurant = parseRestaurant()
const rows = parseItems()
const images = collectImages()

const slug = restaurant.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + restaurant.source_id
const itemId = (id) => 'itm_' + createHash('sha256').update(restaurant.source_id + '|' + id).digest('hex').slice(0, 10)
const capturedAt = new Date(statSync(harPath).mtime).toISOString().replace(/\.\d{3}Z$/, 'Z')

mkdirSync(POOL_DIR, { recursive: true })
mkdirSync(IMG_DIR, { recursive: true })

// This pool is being rewritten; drop its old images so renamed or removed dishes
// don't leave orphans behind.
const stale = existsSync(join(POOL_DIR, `${slug}.json`))
  ? JSON.parse(readFileSync(join(POOL_DIR, `${slug}.json`), 'utf8')).items.map((i) => i.image.url.split('/').pop())
  : []
for (const f of stale) rmSync(join(IMG_DIR, f), { force: true })

const skipped = { no_price: 0, no_photo: 0, no_bytes: 0 }
const items = []

for (const row of rows) {
  if (!Number.isInteger(row.amount_minor) || row.amount_minor <= 0) {
    skipped.no_price++
    continue
  }
  if (!row.public_id) {
    skipped.no_photo++
    continue
  }
  const asset = images.get(row.public_id)
  if (!asset) {
    skipped.no_bytes++
    continue
  }

  const id = itemId(row.id)
  const file = id + (EXT[asset.mime] ?? '.jpg')
  writeFileSync(join(IMG_DIR, file), asset.buffer)

  items.push({
    item_id: id,
    dish_name: row.name.trim(),
    description: cleanDescription(row.description),
    menu_category: row.category,
    image: {
      url: `/img/${file}`,
      attribution: {
        text: `Menu photo via Grubhub — ${restaurant.name}`,
        source: 'grubhub',
        source_url: restaurant.source_url,
      },
    },
    restaurant: {
      name: restaurant.name,
      city: restaurant.city,
      region: restaurant.region,
      country: restaurant.country,
      cuisine_tags: restaurant.cuisine_tags,
    },
    currency: 'USD',
    actual_price: { amount_minor: row.amount_minor, currency: 'USD' },
    // The source itself associates this photo with this dish, so there is no
    // linkage guesswork to discount for — unlike the saved-page pipeline.
    price_confidence: 'high',
    price_source: 'delivery_platform_menu',
    image_link_method: 'source_api',
    captured_at: capturedAt,
  })
}

// Merchant menu copy is written for a menu, not a paragraph: hard line breaks
// mid-sentence and `**` emphasis around allergen or preparation notes.
function cleanDescription(d) {
  if (!d) return null
  return d.replace(/\*\*/g, '').replace(/\s*[\r\n]+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim() || null
}

items.sort((a, b) => a.dish_name.localeCompare(b.dish_name))

writeFileSync(
  join(POOL_DIR, `${slug}.json`),
  JSON.stringify({ generated_from: basename(harPath), restaurant, items }, null, 2) + '\n',
)

// ---------------------------------------------------------------- report

console.log(`restaurant : ${restaurant.name} — ${restaurant.city}, ${restaurant.region}`)
console.log(`cuisines   : ${restaurant.cuisine_tags.join(', ') || '(none found — no sibling HTML snapshot)'}`)
console.log(`menu items : ${rows.length} found in the capture`)
console.log(`playable   : ${items.length} with a price and a photo`)
console.log(`skipped    : ${skipped.no_photo} no photo · ${skipped.no_price} no simple price · ${skipped.no_bytes} photo never rendered`)
if (skipped.no_bytes) console.log(`             (${skipped.no_bytes} dishes had a photo you never scrolled past — scroll the whole menu next time)`)
const prices = items.map((i) => i.actual_price.amount_minor)
console.log(`price range: $${(Math.min(...prices) / 100).toFixed(2)} – $${(Math.max(...prices) / 100).toFixed(2)}`)
console.log(`\nwrote data/pools/${slug}.json`)
