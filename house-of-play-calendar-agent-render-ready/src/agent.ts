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

function monthNumber(mon: string) {
  const months: Record<string, number> = {
    JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12
  };
  return months[mon.toUpperCase()] ?? null;
}

function copenhagenOffset(date: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Copenhagen",
    timeZoneName: "longOffset"
  }).formatToParts(new Date(`${date}T12:00:00Z`));
  const value = parts.find(p => p.type === "timeZoneName")?.value || "GMT+01:00";
  const m = value.match(/GMT([+-]\d{2}):?(\d{2})?/);
  if (!m) return "+01:00";
  return `${m[1]}:${m[2] || "00"}`;
}

function localIso(date: string, hour: number, minute: number) {
  return `${date}T${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}:00${copenhagenOffset(date)}`;
}

function timeToMinutes(h: number, m: number) { return h * 60 + m; }

function parseWeekEvents(text: string): CalendarEvent[] {
  const found: CalendarEvent[] = [];
  const normalized = clean(text).replace(/\u00a0/g, " ");
  const dayRe = /(?:^|\s)(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)\s+(\d{1,2})\.\s*([A-ZÆØÅ]{3,})\b/gi;
  const days = [...normalized.matchAll(dayRe)];
  console.log(`CALENDAR PARSER: found ${days.length} day headers`);
  if (!days.length) return found;

  const now = new Date();
  const candidatesYears = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];

  for (let d = 0; d < days.length; d++) {
    const match = days[d];
    const dayNum = Number(match[2]);
    const monNum = monthNumber(match[3]);
    if (!monNum) continue;

    let year = now.getFullYear();
    const possible = candidatesYears
      .map(y => new Date(y, monNum - 1, dayNum))
      .filter(dt => dt.getDate() === dayNum && dt.getMonth() === monNum - 1);
    const exact = possible.find(dt =>
      dt.toLocaleDateString("en-US", { weekday: "long" }).toUpperCase() === match[1].toUpperCase()
    );
    if (exact) year = exact.getFullYear();

    const date = `${year}-${String(monNum).padStart(2,"0")}-${String(dayNum).padStart(2,"0")}`;
    const blockStart = (match.index ?? 0) + match[0].length;
    const blockEnd = d + 1 < days.length ? (days[d + 1].index ?? normalized.length) : normalized.length;
    const block = normalized.slice(blockStart, blockEnd);

    const times = [...block.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)];
    console.log(`CALENDAR PARSER: ${match[1]} ${dayNum} ${match[3]} -> ${date}: ${times.length} time ranges`);

    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      const afterTime = (t.index ?? 0) + t[0].length;
      const nextTime = i + 1 < times.length ? (times[i + 1].index ?? block.length) : block.length;
      let segment = clean(block.slice(afterTime, nextTime));
      if (!segment) continue;

      const status = /\bFully booked\b/i.test(segment) ? "Fully booked" :
        /\bJoin waitlist\b/i.test(segment) ? "Join waitlist" : "";
      segment = segment.replace(/\bSign up\b/gi, "").replace(/\bFully booked\b/gi, "").replace(/\bJoin waitlist\b/gi, "").trim();

      const priceMatch = segment.match(/\(([^)]*(?:kr|free|per couple)[^)]*)\)/i);
      if (!priceMatch) {
        console.log(`CALENDAR PARSER: skipped time ${t[0]} because no price block: ${segment.slice(0,160)}`);
        continue;
      }
      const price = clean(priceMatch[1]);
      const title = clean(segment.slice(0, priceMatch.index));
      const facilitator = clean(segment.slice((priceMatch.index ?? 0) + priceMatch[0].length));
      if (!title) continue;

      const startH = Number(t[1]), startM = Number(t[2]);
      const endH = Number(t[3]), endM = Number(t[4]);
      const start = localIso(date, startH, startM);
      let endDate = date;
      if (timeToMinutes(endH, endM) <= timeToMinutes(startH, startM)) {
        const next = new Date(`${date}T12:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        endDate = next.toISOString().slice(0,10);
      }
      const end = localIso(endDate, endH, endM);
      const descriptionParts = [`Price: ${price}`, facilitator ? `Facilitator: ${facilitator}` : "", status ? `Status: ${status}` : ""].filter(Boolean);

      found.push({
        uid: uidFor(`${title}|${start}`), title, start, end,
        location: "Shetlandsgade 3, 1st floor, 2300 Copenhagen, Denmark",
        description: descriptionParts.join("\\n"), url: CALENDAR_URL,
        source: "dom", confidence: 0.98
      });
      console.log(`CALENDAR PARSER: event ${date} ${t[0]} — ${title}`);
    }
  }
  return found;
}

async function frameText(frame: Frame) {
  return clean(await frame.locator("body").innerText({ timeout: 8000 }).catch(() => ""));
}

async function findNextControl(page: Page): Promise<{frame: Frame, locator: ReturnType<Frame["locator"]>} | null> {
  const selectors = [
    'button[aria-label*="next" i]', 'button[title*="next" i]',
    '[role="button"][aria-label*="next" i]', '[role="button"][title*="next" i]',
    'a[aria-label*="next" i]', 'a[title*="next" i]',
    'button[aria-label*="forward" i]', 'button[title*="forward" i]',
    '[class*="next" i]', '[class*="arrow-right" i]',
    'button:has-text("›")', 'button:has-text("→")',
    '[role="button"]:has-text("›")', '[role="button"]:has-text("→")'
  ];
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const loc = frame.locator(selector).first();
      if (await loc.count().catch(() => 0) && await loc.isVisible().catch(() => false)) return { frame, locator: loc };
    }
  }
  return null;
}

async function logControls(page: Page) {
  for (const [i, frame] of page.frames().entries()) {
    const controls = await frame.locator('button, [role="button"], a').evaluateAll((els: Element[]) =>
      els.slice(0, 200).map(el => ({
        tag: el.tagName,
        text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0,120),
        aria: el.getAttribute("aria-label") || "",
        title: el.getAttribute("title") || "",
        cls: el.className?.toString().slice(0,120) || ""
      }))
    ).catch(() => []);
    console.log(`CALENDAR CONTROLS frame ${i}: ${JSON.stringify(controls.slice(0,80))}`);
  }
}

async function clickNext(page: Page): Promise<boolean> {
  const control = await findNextControl(page);
  if (!control) {
    console.log("CALENDAR: no accessible Next control found");
    await logControls(page);
    return false;
  }
  const before = clean(await page.locator("body").innerText().catch(() => ""));
  await control.locator.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const after = clean(await page.locator("body").innerText().catch(() => ""));
  if (after === before) {
    console.log("CALENDAR: Next control clicked but visible calendar text did not change");
    return false;
  }
  console.log("CALENDAR: advanced to next week");
  return true;
}

export async function crawl() {
  await ensureData();
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== "false",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const all = new Map<string, CalendarEvent>();

  try {
    console.log(`CALENDAR: opening ${CALENDAR_URL}`);
    await page.goto(CALENDAR_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);

    for (let week = 0; week < WEEKS; week++) {
      const text = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
      const events = parseWeekEvents(text);
      for (const event of events) all.set(event.uid, event);

      console.log(`CALENDAR: week ${week + 1}/${WEEKS}: parsed ${events.length} events; total ${all.size}`);

      if (week === WEEKS - 1) break;
      const moved = await clickNext(page);
      if (!moved) break;
    }
  } finally {
    await browser.close();
  }

  const events = [...all.values()].sort((a, b) => a.start.localeCompare(b.start));
  await fs.writeFile(
    path.join(DATA, "events.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), source: CALENDAR_URL, events }, null, 2)
  );
  console.log(`Crawl complete: ${events.length} events`);
  return events;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  crawl().catch(err => { console.error(err); process.exit(1); });
}
