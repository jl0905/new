// Rendering layer over a server-owned round. This file deliberately contains no
// scoring logic and never sees a price until the server sends one back.

const stage = document.getElementById('stage')
const progress = document.getElementById('progress')
const progressText = document.getElementById('progress-text')
const scoreEl = document.getElementById('score')

let token = null
let round = null
let index = 0

const money = (m) => `$${(m.amount_minor / 100).toFixed(2)}`

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error?.message || `Request failed (${res.status})`)
  return data
}

async function start() {
  stage.innerHTML = '<p class="loading">Loading round…</p>'
  try {
    if (!token) token = (await api('/sessions', { method: 'POST', body: { locale: 'en-US', preferred_currency: 'USD' } })).access_token
    round = await api('/rounds', { method: 'POST', body: { mode: 'classic', item_count: 5 } })
    index = 0
    progress.hidden = false
    renderItem()
  } catch (err) {
    stage.innerHTML = `<p class="error">${err.message}</p>`
  }
}

function renderProgress(total = 0) {
  progressText.textContent = `Dish ${Math.min(index + 1, round.item_count)} of ${round.item_count}`
  scoreEl.textContent = `${total} pts`
}

function renderItem() {
  const item = round.items[index]
  renderProgress(round.score.total)

  const node = document.getElementById('tpl-item').content.cloneNode(true)
  const img = node.querySelector('img')
  img.src = item.image.url
  img.alt = item.dish_name
  // Attribution must render alongside the photo, before and after the guess.
  node.querySelector('.attribution').textContent = item.image.attribution.text

  // Restaurant name is withheld until reveal — with it, the answer is one search away.
  // Cuisine is the better label, but not every source supplies it; the dish's menu
  // category is the next best thing and is always more useful than an empty dash.
  const label = item.restaurant.cuisine_tags?.length ? item.restaurant.cuisine_tags.join(' · ') : item.menu_category
  node.querySelector('.eyebrow').textContent = [label, `${item.restaurant.city}, ${item.restaurant.region}`].filter(Boolean).join(' — ')
  node.querySelector('.dish').textContent = item.dish_name
  node.querySelector('.desc').textContent = item.description || ''

  const { min_minor, max_minor } = item.guess_bounds
  const form = node.querySelector('.guess')
  const input = node.querySelector('.amount input')
  const slider = node.querySelector('.slider')
  const mid = Math.round((min_minor + max_minor) / 2)

  Object.assign(input, { min: min_minor / 100, max: max_minor / 100, value: (mid / 100).toFixed(2) })
  Object.assign(slider, { min: min_minor, max: max_minor, step: 25, value: mid })
  node.querySelector('.lo').textContent = money({ amount_minor: min_minor })
  node.querySelector('.hi').textContent = money({ amount_minor: max_minor })

  slider.addEventListener('input', () => (input.value = (slider.value / 100).toFixed(2)))
  input.addEventListener('input', () => {
    const cents = Math.round(Number(input.value) * 100)
    if (Number.isFinite(cents)) slider.value = Math.min(max_minor, Math.max(min_minor, cents))
  })

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    form.querySelector('button').disabled = true
    try {
      const amount_minor = Math.round(Number(input.value) * 100)
      const res = await api(`/rounds/${round.round_id}/guesses`, {
        method: 'POST',
        body: { item_id: item.item_id, guess: { amount_minor, currency: 'USD' } },
      })
      showReveal(res, item)
    } catch (err) {
      form.querySelector('button').disabled = false
      alert(err.message)
    }
  })

  stage.replaceChildren(node)
}

const BAND_COPY = {
  exact: 'Nailed it.',
  close: 'Close.',
  fair: 'Not bad.',
  way_off: 'Way off.',
}

function showReveal(res, item) {
  const form = stage.querySelector('.guess')
  const reveal = stage.querySelector('.reveal')
  form.hidden = true
  reveal.hidden = false

  const { result, revealed } = res
  const verdict = stage.querySelector('.verdict')
  verdict.textContent = `${BAND_COPY[result.error_band]} +${result.points} pts`
  verdict.classList.add(result.error_band)

  const direction = result.error_ratio < 0 ? 'under' : 'over'
  const pct = Math.abs(result.error_ratio * 100).toFixed(0)
  stage.querySelector('.actual').innerHTML =
    `Actual price <b>${money(revealed.actual_price)}</b> — you guessed <b>${money(res.guess)}</b>` +
    (result.error_band === 'exact' ? '.' : `, ${pct}% ${direction}.`)

  const conf = revealed.price_confidence !== 'high' ? ` · ${revealed.price_confidence}-confidence price` : ''
  const asOf = new Date(revealed.captured_at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
  stage.querySelector('.meta').textContent = `${revealed.restaurant_name} · price as of ${asOf}${conf}`

  round.score.total = res.round_progress.score_total
  renderProgress(round.score.total)

  const next = stage.querySelector('.next')
  const last = index === round.item_count - 1
  next.textContent = last ? 'See results' : 'Next dish'
  next.addEventListener('click', () => {
    if (last) return finish()
    index += 1
    renderItem()
  })
  next.focus()
}

async function finish() {
  const summary = await api(`/rounds/${round.round_id}/complete`, { method: 'POST' })
  const node = document.getElementById('tpl-summary').content.cloneNode(true)
  node.querySelector('.total').textContent = `${summary.score.total} / ${summary.score.max_possible}`
  node.querySelector('.accuracy').textContent = `${summary.score.accuracy_pct}% accuracy`
  node.querySelector('.share').textContent = summary.share_payload.text

  const list = node.querySelector('.breakdown')
  for (const item of summary.items) {
    const li = document.createElement('li')
    li.innerHTML = `<span>${item.dish_name}</span><span class="pts">${money(item.guess)} → ${money(item.actual_price)} · ${item.result.points} pts</span>`
    list.append(li)
  }
  node.querySelector('.again').addEventListener('click', start)
  progress.hidden = true
  stage.replaceChildren(node)
}

start()
