import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PORT = process.env.CDP_PORT ?? "9222";
const PROFILE_DIR = fileURLToPath(
  new URL("../browser-profiles/grubhub/", import.meta.url),
);

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter((p): p is string => !!p && existsSync(p));

const browserPath = BROWSER_CANDIDATES[0];
if (!browserPath) {
  console.error(
    "Could not find Microsoft Edge or Google Chrome. Set CHROME_PATH to the browser executable.",
  );
  process.exit(1);
}

const child = spawn(
  browserPath,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "https://www.grubhub.com/",
  ],
  { detached: true, stdio: "ignore" },
);
child.unref();

console.log(
  `Opened ${browserPath} with a dedicated profile (debug port ${PORT}).\n` +
    "Log in to GrubHub in that window. The session lives in the dedicated\n" +
    "profile and is reused by `npm run scrape`. Keep the window open while scraping.",
);
