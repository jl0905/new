import { chromium, type Page } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PORT = process.env.CDP_PORT ?? "9222";
const ADDRESSES_FILE = fileURLToPath(new URL("../addresses.json", import.meta.url));
const SEARCH_BASE = "https://www.grubhub.com/search?queryText=";

interface AddressEntry {
  name?: string;
  address: string;
}

interface LdNode {
  "@type"?: string | string[];
  name?: unknown;
  aggregateRating?: { ratingValue?: unknown };
  servesCuisine?: unknown;
  priceRange?: unknown;
  address?: {
    streetAddress?: unknown;
    addressLocality?: unknown;
    addressRegion?: unknown;
    postalCode?: unknown;
  };
}

interface RestaurantBasics {
  name: string;
  rating: string | null;
  cuisine: string | null;
  priceRange: string | null;
  address: string | null;
}

function loadAddresses(): AddressEntry[] {
  if (!existsSync(ADDRESSES_FILE)) {
    console.error(`Missing ${ADDRESSES_FILE}. Add a list of addresses there.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(ADDRESSES_FILE, "utf8"));
}

function pickAddress(addresses: AddressEntry[]): AddressEntry {
  const indexArg = process.argv[2];
  const idx =
    indexArg !== undefined
      ? Number(indexArg)
      : Math.floor(Math.random() * addresses.length);
  if (Number.isNaN(idx) || idx < 0 || idx >= addresses.length) {
    console.error(
      `Invalid index ${indexArg}. The list has ${addresses.length} entries.`,
    );
    process.exit(1);
  }
  return addresses[idx];
}

async function extractJsonLd(page: Page): Promise<LdNode | null> {
  const nodes = (await page.$$eval(
    'script[type="application/ld+json"]',
    (els) =>
      els
        .map((el) => {
          try {
            return JSON.parse(el.textContent ?? "");
          } catch {
            return null;
          }
        })
        .filter((v): v is object => !!v && typeof v === "object"),
  )) as LdNode[];

  return (
    nodes.find((n) => {
      const type = n["@type"];
      return Array.isArray(type) ? type.includes("Restaurant") : type === "Restaurant";
    }) ?? null
  );
}

function basicsFromJsonLd(ld: LdNode): RestaurantBasics {
  const addr = ld.address;
  return {
    name: String(ld.name ?? "?"),
    rating:
      ld.aggregateRating?.ratingValue != null
        ? String(ld.aggregateRating.ratingValue)
        : null,
    cuisine: Array.isArray(ld.servesCuisine)
      ? ld.servesCuisine.join(", ")
      : (ld.servesCuisine as string) ?? null,
    priceRange: (ld.priceRange as string) ?? null,
    address:
      [
        addr?.streetAddress,
        addr?.addressLocality,
        addr?.addressRegion,
        addr?.postalCode,
      ]
        .filter((v): v is string => !!v && v !== "")
        .join(", ") || null,
  };
}

async function basicsFromDom(page: Page): Promise<RestaurantBasics> {
  const get = async (selector: string) => {
    const text = await page
      .locator(selector)
      .first()
      .innerText()
      .catch(() => "");
    return text.trim() || null;
  };

  return {
    name: (await get("h1")) || "?",
    rating: await get("[data-testid*='rating'], [aria-label*='rating']"),
    cuisine: null,
    priceRange: null,
    address: null,
  };
}

async function main() {
  const addresses = loadAddresses();
  const entry = pickAddress(addresses);
  const query = entry.name ? `${entry.name} ${entry.address}` : entry.address;
  console.log(`Target: ${query}`);

  const browser = await chromium
    .connectOverCDP(`http://127.0.0.1:${PORT}`)
    .catch(() => null);
  if (!browser) {
    console.error(
      `No browser detected on port ${PORT}. Run \`npm run auth\` to start one.`,
    );
    process.exit(1);
  }

  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  await page.goto(`${SEARCH_BASE}${encodeURIComponent(query)}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(3000);

  const restaurantLinks = page.locator('a[href*="/restaurant/"]');
  if ((await restaurantLinks.count()) === 0) {
    console.warn("No restaurant results found for this search. Dumping page text:");
    console.log((await page.locator("body").innerText()).slice(0, 1500));
    process.exit(1);
  }

  await restaurantLinks.first().click();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2000);

  const ld = await extractJsonLd(page);
  const basics = ld ? basicsFromJsonLd(ld) : await basicsFromDom(page);

  console.log("\nRestaurant basics:");
  console.log(JSON.stringify(basics, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
