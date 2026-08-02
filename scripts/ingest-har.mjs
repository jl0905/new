// Builds a game pool from a Grubhub HAR capture.
//
//   node scripts/ingest-har.mjs pages/taco-rock.har
//
// Parsing lives in lib/grubhub-har.mjs, shared with extract-menu.mjs. This file is
// only the mapping from "a menu" to "items the game can serve": stable ids, the
// normalized Item shape from docs/api-contract.md, and re-hosted photos.
//
// Writes data/pools/<slug>.json and public/img/<item_id>.<ext>. One pool per
// restaurant; the server unions every pool file at startup.

import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseHar, slugify } from './lib/grubhub-har.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const POOL_DIR = join(ROOT, 'data', 'pools')
const IMG_DIR = join(ROOT, 'public', 'img')

const harPath = process.argv[2]
if (!harPath) {
  console.error('usage: node scripts/ingest-har.mjs <capture.har>')
  process.exit(1)
}

const { restaurants, stats } = parseHar(harPath)
if (!restaurants.length) {
  console.error(
    `No menu data in ${basename(harPath)}. The capture probably started after the page ` +
      `had loaded — reload with DevTools open and "Preserve log" ticked.`,
  )
  process.exit(1)
}

const capturedAt = new Date(statSync(harPath).mtime).toISOString().replace(/\.\d{3}Z$/, 'Z')
const stripItems = ({ items, ...rest }) => rest
mkdirSync(POOL_DIR, { recursive: true })
mkdirSync(IMG_DIR, { recursive: true })

for (const restaurant of restaurants) {
  const slug = slugify(restaurant.name, restaurant.source_id)
  const poolPath = join(POOL_DIR, `${slug}.json`)

  // Rewriting this pool: drop its old images so renamed or delisted dishes don't
  // leave orphans behind in public/img.
  if (existsSync(poolPath)) {
    for (const old of JSON.parse(readFileSync(poolPath, 'utf8')).items) {
      rmSync(join(IMG_DIR, old.image.url.split('/').pop()), { force: true })
    }
  }

  const itemId = (sourceId) =>
    'itm_' + createHash('sha256').update(`${restaurant.source_id}|${sourceId}`).digest('hex').slice(0, 10)

  const skipped = { no_price: 0, no_photo: 0 }
  const items = []

  for (const row of restaurant.items) {
    if (!Number.isInteger(row.price_minor) || row.price_minor <= 0) {
      skipped.no_price++
      continue
    }
    if (!row.image) {
      skipped.no_photo++
      continue
    }

    const id = itemId(row.source_item_id)
    const file = id + row.image.ext
    writeFileSync(join(IMG_DIR, file), row.image.bytes)

    items.push({
      item_id: id,
      dish_name: row.name,
      description: row.description,
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
      currency: row.currency,
      actual_price: { amount_minor: row.price_minor, currency: row.currency },
      // The source itself states which dish this photo belongs to, so there is no
      // linkage guesswork to discount for — unlike the saved-page pipeline.
      price_confidence: 'high',
      price_source: 'delivery_platform_menu',
      image_link_method: 'source_api',
      captured_at: capturedAt,
    })
  }

  if (!items.length) {
    console.error(`${restaurant.name}: nothing playable — every dish lacked a price or a photo.`)
    continue
  }

  writeFileSync(poolPath, JSON.stringify({ generated_from: basename(harPath), restaurant: stripItems(restaurant), items }, null, 2) + '\n')

  const prices = items.map((i) => i.actual_price.amount_minor)
  console.log(`${restaurant.name} — ${restaurant.city}, ${restaurant.region}`)
  console.log(`  cuisines   : ${restaurant.cuisine_tags.join(', ') || '(none — no sibling HTML snapshot next to the HAR)'}`)
  console.log(`  menu items : ${restaurant.items.length} in capture`)
  console.log(`  playable   : ${items.length} with a price and a photo`)
  console.log(`  skipped    : ${skipped.no_photo} no photo · ${skipped.no_price} no simple price`)
  console.log(`  price range: $${(Math.min(...prices) / 100).toFixed(2)} – $${(Math.max(...prices) / 100).toFixed(2)}`)
  console.log(`  → data/pools/${slug}.json`)
}

console.log(`\n${stats.items_found} items across ${stats.restaurants_found} restaurant(s) in ${basename(harPath)}`)
