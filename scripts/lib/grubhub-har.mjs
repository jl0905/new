// Shared Grubhub HAR parser.
//
// A DevTools HAR of a Grubhub restaurant page contains the menu API responses, which
// state dish name, description, price and photo asset together, plus the image bytes
// themselves as base64. This module turns that into plain data. It writes nothing and
// knows nothing about the game — callers decide what to do with the result.
//
//   import { parseHar } from './lib/grubhub-har.mjs'
//   const { restaurants } = parseHar('pages/taco-rock.har')

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const EXT_BY_MIME = { 'image/avif': '.avif', 'image/webp': '.webp', 'image/jpeg': '.jpg', 'image/png': '.png' }

/**
 * @param {string} harPath
 * @param {{ cuisineLookup?: boolean }} [opts]
 * @returns {{ restaurants: Array<{
 *   source_id: string, source_url: string, name: string,
 *   city: string, region: string, country: string, cuisine_tags: string[],
 *   items: Array<{
 *     source_item_id: string, name: string, description: string|null,
 *     price_minor: number|null, currency: string, category: string|null,
 *     image: { public_id: string, mime: string, ext: string, bytes: Buffer }|null
 *   }>
 * }>, stats: object }}
 */
export function parseHar(harPath, { cuisineLookup = true } = {}) {
  let har
  try {
    har = JSON.parse(readFileSync(harPath, 'utf8'))
  } catch (err) {
    throw new Error(`could not read ${harPath} as JSON: ${err.message}`)
  }
  const entries = har?.log?.entries?.filter((e) => e.response?.content?.text)
  if (!entries) throw new Error(`${harPath} is not a HAR file (no log.entries)`)

  const images = collectImages(entries)
  const restaurants = new Map()
  const items = new Map() // "<restaurantId>|<itemId>" -> item

  // ---- restaurant identity, from the page's own info call
  for (const e of entries) {
    if (!e.request.url.includes('/info/nonvolatile/')) continue
    const r = asJson(e)?.object?.data?.content?.[0]?.entity
    if (!r?.id) continue
    restaurants.set(String(r.id), {
      source_id: String(r.id),
      source_url: `https://www.grubhub.com/restaurant/${r.merchant_url_path}/${r.id}`,
      name: r.name,
      city: r.address?.locality ?? null,
      region: r.address?.region ?? null,
      country: r.address?.country === 'USA' ? 'US' : (r.address?.country ?? null),
      cuisine_tags: [],
      items: [],
    })
  }

  // ---- menu items, from two response shapes that both appear in a normal capture
  for (const e of entries) {
    const restaurantId = e.request.url.match(/\/(?:feed|restaurants)\/(\d+)/)?.[1]
    if (!restaurantId) continue

    if (e.request.url.includes('/feed/')) {
      for (const c of asJson(e)?.object?.data?.content ?? []) {
        const it = c.entity
        if (!it?.item_id || !it.item_name) continue
        upsert(items, restaurantId, {
          source_item_id: String(it.item_id),
          name: it.item_name.trim(),
          description: cleanDescription(it.item_description),
          price_minor: it.item_price?.delivery?.value ?? it.item_price?.pickup?.value ?? null,
          currency: it.item_price?.delivery?.currency ?? 'USD',
          category: it.menu_category_name ?? null,
          image: resolveImage(it.media_image, images),
        })
      }
    }

    if (e.request.url.includes('/menu_items/')) {
      for (const it of asJson(e)?.menu_items ?? []) {
        if (!it?.id || !it.name) continue
        upsert(items, restaurantId, {
          source_item_id: String(it.id),
          name: it.name.trim(),
          description: cleanDescription(it.description),
          price_minor: it.delivery_price?.amount ?? it.price?.amount ?? null,
          currency: it.delivery_price?.currency ?? it.price?.currency ?? 'USD',
          category: it.menu_category_name ?? null,
          image: resolveImage(it.media_image, images),
        })
      }
    }
  }

  // A capture can contain restaurants we saw items for but never an info call
  // (e.g. a search page rendered alongside). Keep them with a placeholder identity
  // rather than silently dropping their dishes.
  for (const key of items.keys()) {
    const id = key.split('|')[0]
    if (!restaurants.has(id)) {
      restaurants.set(id, { source_id: id, source_url: null, name: `Restaurant ${id}`, city: null, region: null, country: null, cuisine_tags: [], items: [] })
    }
  }

  for (const [key, item] of items) restaurants.get(key.split('|')[0]).items.push(item)

  for (const r of restaurants.values()) {
    r.items.sort((a, b) => a.name.localeCompare(b.name))
    if (cuisineLookup) r.cuisine_tags = cuisinesFromSiblingHtml(harPath, r.name)
  }

  // Restaurants with no items are noise from other pages in the capture.
  const list = [...restaurants.values()].filter((r) => r.items.length).sort((a, b) => b.items.length - a.items.length)

  return {
    restaurants: list,
    stats: {
      har_entries: har.log.entries.length,
      responses_with_body: entries.length,
      images_in_capture: images.size,
      restaurants_found: list.length,
      items_found: list.reduce((n, r) => n + r.items.length, 0),
    },
  }
}

// The same dish appears in several responses; merge fields rather than overwrite so
// a later, thinner record can't null out a description we already have.
function upsert(map, restaurantId, next) {
  const key = `${restaurantId}|${next.source_item_id}`
  const prev = map.get(key)
  if (!prev) return map.set(key, next)
  for (const [k, v] of Object.entries(next)) if (v != null && prev[k] == null) prev[k] = v
}

function asJson(entry) {
  try {
    return JSON.parse(entry.response.content.text)
  } catch {
    return null
  }
}

// Grubhub requests each photo at several widths. Keep the largest — it's the sharpest.
function collectImages(entries) {
  const best = new Map()
  for (const e of entries) {
    const mime = e.response.content.mimeType || ''
    if (!mime.startsWith('image/') || e.response.content.encoding !== 'base64') continue
    const id = e.request.url.match(/media-cdn\.grubhub\.com\/image\/upload\/.*?\/([a-z0-9]{16,})(?:[.?]|$)/)?.[1]
    if (!id) continue
    const bytes = Buffer.from(e.response.content.text, 'base64')
    if (!best.has(id) || bytes.length > best.get(id).bytes.length) {
      best.set(id, { public_id: id, mime, ext: EXT_BY_MIME[mime] ?? '.jpg', bytes })
    }
  }
  return best
}

// An item can name a photo the browser never actually fetched (off-screen, never
// scrolled to). That's a photo we don't have, so it isn't an image.
function resolveImage(media, images) {
  const id = media?.public_id
  return id && images.has(id) ? images.get(id) : null
}

// Merchant menu copy is written for a menu: hard line breaks mid-sentence, `**`
// around allergen and preparation notes.
export function cleanDescription(d) {
  if (!d) return null
  return d.replace(/\*\*/g, '').replace(/\s*[\r\n]+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim() || null
}

// The menu API carries no cuisine field, but a Ctrl+S snapshot of the same page has
// one in its JSON-LD. Use it when a sibling .html is sitting next to the HAR.
function cuisinesFromSiblingHtml(harPath, restaurantName) {
  const dir = dirname(resolve(harPath))
  let files
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.html'))
  } catch {
    return []
  }
  for (const file of files) {
    const m = readFileSync(join(dir, file), 'utf8').match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/)
    if (!m) continue
    try {
      const ld = JSON.parse(m[1])
      if (ld.name === restaurantName && ld.servesCuisine?.length) return ld.servesCuisine.map((c) => c.toLowerCase())
    } catch {
      /* not the snapshot we're after */
    }
  }
  return []
}

export function slugify(name, id) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + (id ? `-${id}` : '')
}
