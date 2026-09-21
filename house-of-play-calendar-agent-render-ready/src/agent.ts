import "dotenv/config";
import { chromium, Page, Frame } from "playwright";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CalendarEvent } from "./types.js";

const CALENDAR_URL = process.env.HOUSE_OF_PLAY_CALENDAR || "https://www.houseofplay.dk/calendar";
const WEEKS = Number(process.env.CRAWL_WEEKS || 12);
const DATA = path.resolve("data");
const SHOTS = path.join(DATA, "screenshots");

function uidFor(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24) + "@houseofplay.dk";
}
function clean(s: string) { return s.replace(/\s+/g, " ").trim(); }
async function ensureData() { await fs.mkdir(SHOTS, { recursive: true }); }
async function screenshot(page: Page, name: string) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

function parseDateTime(text: string): { start: string; end: string } | null {
  const re = /([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)(?:\s*(?:to|[-–])\s*(?:[A-Z][a-z]+\s+)?(\d{1,2}),?\s*(?:,?\s*(\d{4}))?\s*(\d{1,2}):(\d{2})\s*(AM|PM))?/i;
  const m = text.match(re);
  if (!m) return null;
  const month = new Date(`${m[1]} 1, 2000`).getMonth() + 1;
  const year = Number(m[3]);
  const startHour = Number(m[4]) % 12 + (m[6].toUpperCase() === "PM" ? 12 : 0);
  const date = `${year}-${String(month).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const start = `${date}T${String(startHour).padStart(2, "0")}:${m[5]}:00+02:00`;
  if (!m[7]) {
    const endHour = startHour + 2;
    return { start, end: `${date}T${String(endHour % 24).padStart(2, "0")}:${m[5]}:00+02:00` };
  }
  const endDay = Number(m[7]);
  const endYear = Number(m[8] || year);
  const endHour = Number(m[9]) % 12 + (m[11].toUpperCase() === "PM" ? 12 : 0);
  return {
    start,
    end: `${endYear}-${String(month).padStart(2, "0")}-${String(endDay).padStart(2, "0")}T${String(endHour).padStart(2, "0")}:${m[10]}:00+02:00`
  };
}

async function scrapeEventPage(browserPage: Page, url: string): Promise<CalendarEvent | null> {
  await browserPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await browserPage.waitForTimeout(500);
  const text = clean(await browserPage.locator("body").innerText().catch(() => ""));
  const title = clean(await browserPage.locator("h1").first().innerText().catch(() => ""));
  const dt = parseDateTime(text);
  if (!title || !dt) return null;
  return {
    uid: uidFor(url), title, start: dt.start, end: dt.end,
    location: "Shetlandsgade 3, 1st floor, 2300 Copenhagen, Denmark",
    description: text.slice(0, 10000), url, source: "event-page", confidence: 0.99
  };
}

function isHopEventUrl(href: string) {
  try {
    const u = new URL(href);
    return u.hostname.endsWith("houseofplay.dk") &&
      (/\/(special-events|courses|events)\//i.test(u.pathname) || /\/.*event/i.test(u.pathname));
  } catch { return false; }
}

async function frameText(frame: Frame) {
  return clean(await frame.locator("body").innerText({ timeout: 5000 }).catch(() => ""));
}

async function collectRenderedCalendarLinks(page: Page): Promise<string[]> {
  const urls = new Set<string>();
  for (const frame of page.frames()) {
    const links = await frame.locator("a[href]").evaluateAll((els: Element[]) =>
      els.map((a) => (a as HTMLAnchorElement).href).filter(Boolean)
    ).catch(() => [] as string[]);
    for (const href of links) if (isHopEventUrl(href)) urls.add(href);
  }
  return [...urls];
}

async function extractCalendarCards(page: Page): Promise<CalendarEvent[]> {
  const found: CalendarEvent[] = [];
  // YOGO's website widget renders into .yogo-calendar. It may use an iframe
  // or a dynamically-created subtree, so inspect every frame rather than only
  // the top-level document.
  for (const frame of page.frames()) {
    const selectors = [
      ".yogo-calendar a", ".yogo-calendar [role=button]", ".yogo-calendar button",
      ".yogo-calendar article", ".yogo-calendar [class*=event i]", ".yogo-calendar [class*=class i]"
    ];
    for (const selector of selectors) {
      const n = await frame.locator(selector).count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 300); i++) {
        const el = frame.locator(selector).nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        const text = clean(await el.innerText().catch(() => ""));
        if (!text || text.length < 8 || text.length > 1500) continue;
        const dt = parseDateTime(text);
        if (!dt) continue;
        const title = clean(text.split(/\n|\d{1,2}:\d{2}/)[0]);
        if (!title) continue;
        found.push({ uid: uidFor(`${title}|${dt.start}`), title, start: dt.start, end: dt.end,
          location: "Shetlandsgade 3, 1st floor, 2300 Copenhagen, Denmark", description: text,
          source: "dom", confidence: 0.82 });
      }
    }
  }
  return found;
}

async function clickCalendarEventCards(page: Page): Promise<CalendarEvent[]> {
  const found: CalendarEvent[] = [];
  // Some YOGO versions render event details in a modal after clicking a class.
  for (const frame of page.frames()) {
    const candidates = frame.locator(".yogo-calendar a, .yogo-calendar button, .yogo-calendar [role=button]");
    const n = Math.min(await candidates.count().catch(() => 0), 250);
    for (let i = 0; i < n; i++) {
      const el = candidates.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const label = clean(await el.innerText().catch(() => ""));
      if (!label || !/\d{1,2}:\d{2}/.test(label)) continue;
      try {
        await el.click({ timeout: 3000 });
        await page.waitForTimeout(250);
        const modalText = await frameText(frame);
        const dt = parseDateTime(modalText);
        const title = clean((await frame.locator("h1,h2,h3,[role=dialog]").allInnerTexts().catch(() => [])).join(" "));
        if (dt && title) {
          const cleanTitle = title.split(/\d{1,2}:\d{2}/)[0].trim();
          found.push({ uid: uidFor(`${cleanTitle}|${dt.start}`), title: cleanTitle, start: dt.start, end: dt.end,
            location: "Shetlandsgade 3, 1st floor, 2300 Copenhagen, Denmark", description: modalText.slice(0, 10000),
            source: "dom", confidence: 0.9 });
        }
        await frame.keyboard.press("Escape").catch(() => {});
      } catch {}
    }
  }
  return found;
}

async function clickNext(page: Page) {
  const candidates = [
    'button[aria-label*="next" i]', 'button[title*="next" i]', '[role="button"][aria-label*="next" i]',
    'a[aria-label*="next" i]', 'button:has-text("Next")', 'button:has-text("›")', 'button:has-text("→")'
  ];
  for (const frame of page.frames()) {
    for (const selector of candidates) {
      const loc = frame.locator(selector).first();
      if (await loc.count() && await loc.isVisible().catch(() => false)) {
        await loc.click().catch(() => {}); await page.waitForTimeout(700); return true;
      }
    }
  }
  return false;
}

async function diagnosticFrames(page: Page) {
  const rows = [] as Array<{url:string;text:string;html:string}>;
  for (const frame of page.frames()) {
    const text = await frameText(frame);
    const html = await frame.locator("body").innerHTML().catch(() => "");
    rows.push({ url: frame.url(), text: text.slice(0, 12000), html: html.slice(0, 30000) });
  }
  await fs.writeFile(path.join(DATA, "calendar-diagnostic.json"), JSON.stringify(rows, null, 2));
}

export async function crawl() {
  await ensureData();
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "false", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const eventPage = await browser.newPage();
  const all = new Map<string, CalendarEvent>();
  const visitedStates = new Set<string>();
  try {
    await page.goto(CALENDAR_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3500);

    await diagnosticFrames(page);

    // First, harvest event URLs from the actual rendered calendar (including YOGO frames).
    for (const url of await collectRenderedCalendarLinks(page)) {
      try { const event = await scrapeEventPage(eventPage, url); if (event) all.set(event.uid, event); }
      catch (e) { console.warn("Event page failed", url, e); }
    }

    const maxSteps = Math.min(WEEKS * 5 + 10, 70);
    for (let step = 0; step < maxSteps; step++) {
      const textParts = await Promise.all(page.frames().map(frameText));
      const text = clean(textParts.join(" "));
      const stateHash = crypto.createHash("sha1").update(text).digest("hex");
      if (visitedStates.has(stateHash)) break;
      visitedStates.add(stateHash);

      await screenshot(page, `step-${String(step).padStart(2, "0")}`);

      for (const event of await extractCalendarCards(page)) all.set(event.uid, event);
      for (const event of await clickCalendarEventCards(page)) all.set(event.uid, event);

      // Re-scan links after each calendar state because YOGO can change them as the month changes.
      for (const url of await collectRenderedCalendarLinks(page)) {
        try { const event = await scrapeEventPage(eventPage, url); if (event) all.set(event.uid, event); }
        catch {}
      }

      const clicked = await clickNext(page);
      if (!clicked) break;
    }
  } finally { await browser.close(); }

  const events = [...all.values()].sort((a, b) => a.start.localeCompare(b.start));
  await fs.writeFile(path.join(DATA, "events.json"), JSON.stringify({ generatedAt: new Date().toISOString(), source: CALENDAR_URL, events }, null, 2));
  console.log(`Crawl complete: ${events.length} events`);
  return events;
}

if (import.meta.url === `file://${process.argv[1]}`) crawl().catch(err => { console.error(err); process.exit(1); });
