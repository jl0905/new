// Ingests a browser-saved delivery-platform menu page into the normalized Item pool.
//
//   node scripts/ingest-saved-page.mjs "pages/<Saved Page>.html"
//
// Produces data/items.json (the price-bearing source of truth, server-side only)
// and public/img/<item_id>.jpg (the photos the client is allowed to see).
//
// The saved page is a snapshot of a virtualized React list, so this is deliberately
// tolerant: it recovers what is actually present and reports what it dropped, rather
// than pretending a partial capture is a complete menu.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const POOL_DIR = join(ROOT, 'data', 'pools')
const OUT_IMG = join(ROOT, 'public', 'img')

const htmlPath = process.argv[2]
if (!htmlPath) {
  console.error('usage: node scripts/ingest-saved-page.mjs <saved-page.html>')
  process.exit(1)
}

const html = readFileSync(htmlPath, 'utf8')
const assetDir = htmlPath.replace(/\.html$/, '_files')

// ---------------------------------------------------------------- restaurant

function parseRestaurant() {
  const m = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/)
  if (!m) throw new Error('no JSON-LD block found; is this a Grubhub restaurant page?')
  const ld = JSON.parse(m[1])
  return {
    source_id: ld['@id'],
    source_url: ld.url,
    name: ld.name,
    city: ld.address?.addressLocality,
    region: ld.address?.addressRegion,
    country: ld.address?.addressCountry === 'USA' ? 'US' : ld.address?.addressCountry,
    price_range: ld.priceRange,
    cuisine_tags: (ld.servesCuisine || []).map((c) => c.toLowerCase()),
  }
}

// ---------------------------------------------------------------- menu rows

// Flatten tags to text nodes, then walk the stream. A menu row is
// <name> [description] [badge] <price>, with section headings interleaved.
function parseMenu() {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, '\n')
  const lines = text
    .split('\n')
    .map((l) => decodeEntities(l).trim())
    .filter(Boolean)

  const PRICE = /^\$(\d+)\.(\d{2})$/
  const BADGES = new Set(['Best Seller', 'Add to bag', 'Popular'])
  const rows = new Map() // dish_name -> row

  for (let i = 0; i < lines.length; i++) {
    const p = lines[i].match(PRICE)
    if (!p) continue
    const amount_minor = Number(p[1]) * 100 + Number(p[2])

    // Walk backwards past description/badge text to the dish name.
    let description = null
    let name = null
    for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
      const cand = lines[j]
      if (PRICE.test(cand) || BADGES.has(cand)) continue
      if (/^[A-Z]/.test(cand) && !/[.]$/.test(cand) && cand.length <= 60) {
        name = cand
        break
      }
      if (cand.length > 20) description ??= cand // sentence-shaped => description
    }
    if (!name) continue

    const prev = rows.get(name)
    if (prev) {
      // Same dish seen twice (carousel + list). Keep the richer record; flag conflicts.
      if (prev.price.amount_minor !== amount_minor) prev.price_conflict = true
      prev.description ??= description
      continue
    }
    rows.set(name, {
      dish_name: name,
      description,
      price: { amount_minor, currency: 'USD' },
    })
  }
  return [...rows.values()]
}

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
}

// ---------------------------------------------------------------- photos

// Two linkage paths: inline background-image URLs (authoritative — the page itself
// tied the asset to the dish) and scripts/curation.json (hand-assigned).
function linkImages(rows) {
  const links = new Map() // asset id -> { dish_name, confidence }

  const inline = /f_auto,h_\d+\/([a-z0-9]{16,})(?:&quot;|")\);?"[^>]*>\s*(?:<[^>]+>\s*)*([^<]{2,60}?)\s*</g
  for (const m of html.matchAll(inline)) {
    links.set(m[1], { dish_name: decodeEntities(m[2]).trim(), confidence: 'high', via: 'inline' })
  }

  const curation = JSON.parse(readFileSync(join(ROOT, 'scripts', 'curation.json'), 'utf8'))
  for (const l of curation.links) {
    if (!l.dish_name) continue
    if (links.has(l.asset)) continue // never override the page's own linkage
    links.set(l.asset, { dish_name: l.dish_name, confidence: l.confidence, via: 'curation' })
  }

  const byName = new Map(rows.map((r) => [r.dish_name, r]))
  const linked = []
  for (const [asset, link] of links) {
    const row = byName.get(link.dish_name)
    if (!row) continue
    const file = findAsset(asset)
    if (!file) continue
    linked.push({ ...row, asset, file, link })
  }
  return linked
}

function findAsset(id) {
  let names
  try {
    names = readdirSync(assetDir)
  } catch {
    throw new Error(`asset directory not found: ${assetDir}`)
  }
  // Browsers suffix duplicate downloads as "name(1)"; prefer the unsuffixed copy.
  const exact = names.find((n) => n === id)
  const any = exact ?? names.find((n) => n.startsWith(id))
  if (!any) return null
  const path = join(assetDir, any)
  const sig = readFileSync(path).subarray(0, 3)
  return sig[0] === 0xff && sig[1] === 0xd8 ? path : null // JPEG only
}

// ---------------------------------------------------------------- emit

const restaurant = parseRestaurant()
const rows = parseMenu()
const linked = linkImages(rows)

// price_confidence folds two risks: is the price right, and is this photo really
// that dish. A hand-assigned photo caps confidence at the linkage's own confidence.
const confidenceOf = (l) => (l.link.via === 'inline' && !l.price_conflict ? 'high' : l.link.confidence)

const itemId = (name) =>
  'itm_' + createHash('sha256').update(restaurant.source_id + '|' + name).digest('hex').slice(0, 10)

const slug =
  restaurant.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') +
  '-' +
  restaurant.source_id.split('/').pop()
const OUT_DATA = join(POOL_DIR, `${slug}.json`)

mkdirSync(OUT_IMG, { recursive: true })
mkdirSync(POOL_DIR, { recursive: true })

// Rewriting this pool: drop its old images so renamed dishes leave no orphans.
if (existsSync(OUT_DATA)) {
  for (const old of JSON.parse(readFileSync(OUT_DATA, 'utf8')).items) {
    rmSync(join(OUT_IMG, old.image.url.split('/').pop()), { force: true })
  }
}

const items = linked
  .map((l) => {
    const id = itemId(l.dish_name)
    copyFileSync(l.file, join(OUT_IMG, `${id}.jpg`))
    return {
      item_id: id,
      dish_name: l.dish_name,
      description: l.description,
      image: {
        url: `/img/${id}.jpg`,
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
      actual_price: l.price,
      price_confidence: confidenceOf(l),
      price_source: 'delivery_platform_menu',
      image_link_method: l.link.via,
      captured_at: capturedAt(),
    }
  })
  .sort((a, b) => a.dish_name.localeCompare(b.dish_name))

function capturedAt() {
  // The page carries no observation timestamp; the snapshot's mtime is when the
  // price was actually seen.
  return new Date(statSync(htmlPath).mtime).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

writeFileSync(OUT_DATA, JSON.stringify({ generated_from: basename(htmlPath), restaurant, items }, null, 2) + '\n')

// ---------------------------------------------------------------- report
const dropped = rows.length - items.length
console.log(`restaurant : ${restaurant.name} (${restaurant.city}, ${restaurant.region})`)
console.log(`menu rows  : ${rows.length} priced dishes recovered`)
console.log(`playable   : ${items.length} with a linked photo`)
console.log(`dropped    : ${dropped} priced dishes had no usable photo in the snapshot`)
for (const i of items) {
  console.log(`  ${i.price_confidence.padEnd(6)} ${i.image_link_method.padEnd(9)} $${(i.actual_price.amount_minor / 100).toFixed(2).padStart(6)}  ${i.dish_name}`)
}
console.log(`\nwrote ${OUT_DATA}`)
