#!/usr/bin/env node
// Extract a restaurant menu from a Grubhub HAR capture: name, description, price,
// and the photo, as plain files you can open and check.
//
//   node scripts/extract-menu.mjs pages/taco-rock.har
//   node scripts/extract-menu.mjs pages/*.har --out menus
//   node scripts/extract-menu.mjs pages/taco-rock.har --no-images --all
//
// Output, per restaurant, under <out>/<restaurant-slug>/:
//   menu.json    every field, structured
//   menu.csv     name, description, price, image — opens in Excel/Sheets
//   images/      one file per dish, named after the dish
//
// This has nothing to do with the game. It's the plain extraction step; the game's
// pool builder (ingest-har.mjs) reads the same parser.

import { writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs'
import { basename, join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseHar, slugify } from './lib/grubhub-har.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ------------------------------------------------------------------- args

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const valueOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const inputs = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out')

if (!inputs.length || flags.has('--help')) {
  console.log(`
Extract Grubhub menus from HAR captures.

  node scripts/extract-menu.mjs <capture.har> [more.har ...] [options]

Options
  --out <dir>    output directory (default: out)
  --no-images    don't write image files, just the data
  --all          keep dishes with no photo and/or no price (default: skip them)
  --quiet        only print the summary line

How to make a capture
  1. Open the restaurant page in Chrome/Edge, F12 -> Network
  2. Tick "Preserve log", filter Fetch/XHR
  3. Reload the page
  4. Scroll the whole menu (a photo you never scrolled past isn't captured)
  5. Download icon -> Export HAR   (the "sanitized" option is fine and safer)
`)
  process.exit(inputs.length ? 0 : 1)
}

const outRoot = resolve(ROOT, valueOf('--out', 'out'))
const writeImages = !flags.has('--no-images')
const keepIncomplete = flags.has('--all')
const quiet = flags.has('--quiet')

// ------------------------------------------------------------------- run

let totalDishes = 0
let totalRestaurants = 0
const problems = []

for (const input of inputs) {
  const harPath = resolve(input)
  if (!existsSync(harPath)) {
    problems.push(`${input}: no such file`)
    continue
  }

  let parsed
  try {
    parsed = parseHar(harPath)
  } catch (err) {
    problems.push(`${basename(input)}: ${err.message}`)
    continue
  }

  if (!parsed.restaurants.length) {
    problems.push(
      `${basename(input)}: no menu data found. The capture probably started after the page ` +
        `had already loaded — reload the page with DevTools open and "Preserve log" ticked.`,
    )
    continue
  }

  const capturedAt = new Date(statSync(harPath).mtime).toISOString().replace(/\.\d{3}Z$/, 'Z')

  for (const restaurant of parsed.restaurants) {
    const kept = restaurant.items.filter((i) => keepIncomplete || (i.price_minor != null && i.image))
    const skippedNoPhoto = restaurant.items.filter((i) => !i.image).length
    const skippedNoPrice = restaurant.items.filter((i) => i.price_minor == null).length
    if (!kept.length) {
      problems.push(`${restaurant.name}: every dish was missing a price or a photo`)
      continue
    }

    const dir = join(outRoot, slugify(restaurant.name, restaurant.source_id))
    mkdirSync(dir, { recursive: true })
    const imageDir = join(dir, 'images')
    if (writeImages) {
      rmSync(imageDir, { recursive: true, force: true })
      mkdirSync(imageDir, { recursive: true })
    }

    // Dish name makes the friendliest filename; disambiguate the rare collision.
    const used = new Map()
    const rows = kept.map((item) => {
      let file = null
      if (item.image) {
        const base = slugify(item.name) || item.image.public_id
        const n = (used.get(base) ?? 0) + 1
        used.set(base, n)
        file = `${base}${n > 1 ? `-${n}` : ''}${item.image.ext}`
        if (writeImages) writeFileSync(join(imageDir, file), item.image.bytes)
      }
      return {
        name: item.name,
        description: item.description,
        price: item.price_minor == null ? null : `$${(item.price_minor / 100).toFixed(2)}`,
        price_minor: item.price_minor,
        currency: item.currency,
        category: item.category,
        image_file: file && `images/${file}`,
        source_item_id: item.source_item_id,
      }
    })

    writeFileSync(
      join(dir, 'menu.json'),
      JSON.stringify(
        {
          restaurant: {
            name: restaurant.name,
            city: restaurant.city,
            region: restaurant.region,
            country: restaurant.country,
            cuisine_tags: restaurant.cuisine_tags,
            source_url: restaurant.source_url,
          },
          captured_at: capturedAt,
          captured_from: basename(harPath),
          item_count: rows.length,
          items: rows,
        },
        null,
        2,
      ) + '\n',
    )

    writeFileSync(join(dir, 'menu.csv'), toCsv(rows))

    totalRestaurants++
    totalDishes += rows.length

    if (!quiet) {
      const where = [restaurant.city, restaurant.region].filter(Boolean).join(', ')
      console.log(`\n${restaurant.name}${where ? ` — ${where}` : ''}`)
      console.log(`  ${restaurant.items.length} dishes in capture · ${rows.length} written`)
      if (!keepIncomplete && (skippedNoPhoto || skippedNoPrice)) {
        console.log(`  skipped: ${skippedNoPhoto} without a photo, ${skippedNoPrice} without a simple price  (--all keeps them)`)
      }
      const priced = rows.filter((r) => r.price_minor != null).map((r) => r.price_minor)
      if (priced.length) console.log(`  price range: $${(Math.min(...priced) / 100).toFixed(2)} – $${(Math.max(...priced) / 100).toFixed(2)}`)
      console.log(`  → ${join(dir, 'menu.json').replace(ROOT + '\\', '').replace(ROOT + '/', '')}`)
      for (const r of rows.slice(0, 3)) console.log(`      ${String(r.price).padStart(7)}  ${r.name}`)
      if (rows.length > 3) console.log(`      … and ${rows.length - 3} more`)
    }
  }
}

function toCsv(rows) {
  const cols = ['name', 'description', 'price', 'price_minor', 'currency', 'category', 'image_file']
  const cell = (v) => {
    if (v == null) return ''
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  // BOM so Excel reads it as UTF-8 and doesn't mangle accented dish names.
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n'
}

console.log(`\n${totalDishes} dishes from ${totalRestaurants} restaurant${totalRestaurants === 1 ? '' : 's'} → ${outRoot}`)
for (const p of problems) console.error(`  ! ${p}`)
process.exit(problems.length && !totalDishes ? 1 : 0)
