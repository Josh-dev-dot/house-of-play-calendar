import "dotenv/config";
import { chromium, Page } from "playwright";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CalendarEvent, CalendarObservation } from "./types.js";

const CALENDAR_URL =
  process.env.HOUSE_OF_PLAY_CALENDAR ||
  "https://www.houseofplay.dk/calendar";
const WEEKS = Number(process.env.CRAWL_WEEKS || 12);
const DATA = path.resolve("data");
const SHOTS = path.join(DATA, "screenshots");

function uidFor(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24) + "@houseofplay.dk";
}

function clean(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

async function ensureData() {
  await fs.mkdir(SHOTS, { recursive: true });
}

async function screenshot(page: Page, name: string) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function getVisibleText(page: Page) {
  return clean(await page.locator("body").innerText({ timeout: 10000 }).catch(() => ""));
}

function parseDateTime(text: string): { start: string; end: string } | null {
  // Flexible parser for strings containing:
  // "October 29, 2026 7:00 PM 10:00 PM"
  // "October 3, 2026 10:00 AM to October 4, 2026 5:00 PM"
  const re = /([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)(?:\s*(?:to|[-–])\s*(?:[A-Z][a-z]+\s+)?(\d{1,2}),?\s*(?:,?\s*(\d{4}))?\s*(\d{1,2}):(\d{2})\s*(AM|PM))?/i;
  const m = text.match(re);
  if (!m) return null;

  const month = new Date(`${m[1]} 1, 2000`).getMonth() + 1;
  const year = Number(m[3]);
  const startHour = Number(m[4]) % 12 + (m[6].toUpperCase() === "PM" ? 12 : 0);
  const start = `${year}-${String(month).padStart(2, "0")}-${m[2].padStart(2, "0")}T${String(startHour).padStart(2, "0")}:${m[5]}:00+02:00`;

  if (!m[7]) {
    const endHour = startHour + 2;
    return {
      start,
      end: `${year}-${String(month).padStart(2, "0")}-${m[2].padStart(2, "0")}T${String(endHour % 24).padStart(2, "0")}:${m[5]}:00+02:00`
    };
  }

  const endDay = Number(m[7]);
  const endYear = Number(m[8] || year);
  const endHour = Number(m[9]) % 12 + (m[11].toUpperCase() === "PM" ? 12 : 0);
  const endMonth = month;
  return {
    start,
    end: `${endYear}-${String(endMonth).padStart(2, "0")}-${String(endDay).padStart(2, "0")}T${String(endHour).padStart(2, "0")}:${m[10]}:00+02:00`
  };
}

async function collectEventLinks(page: Page) {
  return await page.locator("a[href]").evaluateAll((els) =>
    [...new Set(
      els.map((a) => (a as HTMLAnchorElement).href)
        .filter((href) =>
          href.includes("/special-events/") ||
          href.includes("/courses/") ||
          href.includes("/events/")
        )
    )]
  );
}

async function scrapeEventPage(browserPage: Page, url: string): Promise<CalendarEvent | null> {
  await browserPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await browserPage.waitForTimeout(500);
  const text = clean(await browserPage.locator("body").innerText().catch(() => ""));
  const title = clean(await browserPage.locator("h1").first().innerText().catch(() => ""));
  const dt = parseDateTime(text);
  if (!title || !dt) return null;

  return {
    uid: uidFor(url),
    title,
    start: dt.start,
    end: dt.end,
    location: "Shetlandsgade 3, 1st floor, 2300 Copenhagen, Denmark",
    description: text.slice(0, 6000),
    url,
    source: "event-page",
    confidence: 0.98
  };
}

async function visionObserve(page: Page, shotPath: string, visibleText: string): Promise<CalendarObservation> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return {
      pageUrl: page.url(),
      screenshot: shotPath,
      visibleText,
      events: [],
      nextAction: "next",
      confidence: 0
    };
  }

  const image = (await fs.readFile(shotPath)).toString("base64");
  const model = process.env.OPENAI_MODEL || "gpt-5.6";
  const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

  const prompt = `You are reading a calendar UI screenshot from House of Play in Copenhagen.
Return ONLY valid JSON matching this schema:
{
  "detectedRange": "string or null",
  "events": [
    {
      "title": "string",
      "date": "YYYY-MM-DD",
      "startTime": "HH:MM",
      "endTime": "HH:MM",
      "description": "short string",
      "confidence": 0.0
    }
  ],
  "nextAction": "next" | "stop" | "retry",
  "confidence": 0.0
}
Read only events actually visible in the screenshot. Do not invent recurring dates.
Use Europe/Copenhagen local time. If an event has no visible end time, use null for endTime.
If the calendar is not showing a useful date range, choose retry.
If the screenshot is at the end of the requested crawl horizon, choose stop.
`;

  const response = await fetch(`${base}/responses`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: prompt + "\nVisible page text:\n" + visibleText.slice(0, 12000) },
          { type: "input_image", image_url: `data:image/png;base64,${image}` }
        ]
      }]
    })
  });

  if (!response.ok) throw new Error(`Vision API ${response.status}: ${await response.text()}`);
  const json: any = await response.json();
  const raw =
    json.output_text ||
    json.output?.flatMap((x: any) => x.content || []).find((x: any) => x.type === "output_text")?.text ||
    "";

  const parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, "").trim());

  const events: CalendarEvent[] = (parsed.events || []).map((e: any) => {
    const start = `${e.date}T${e.startTime}:00+02:00`;
    const end = e.endTime ? `${e.date}T${e.endTime}:00+02:00` : `${e.date}T${e.startTime}:00+02:00`;
    const uid = uidFor(`${e.title}|${start}`);
    return {
      uid,
      title: e.title,
      start,
      end,
      description: e.description,
      url: undefined,
      source: "vision",
      confidence: Number(e.confidence || 0.5)
    };
  });

  return {
    pageUrl: page.url(),
    screenshot: shotPath,
    visibleText,
    detectedRange: parsed.detectedRange || undefined,
    events,
    nextAction: parsed.nextAction || "retry",
    confidence: Number(parsed.confidence || 0.5)
  };
}

async function clickNext(page: Page) {
  // First try semantic/accessibility selectors.
  const candidates = [
    'button[aria-label*="next" i]',
    'button[title*="next" i]',
    '[role="button"][aria-label*="next" i]',
    'a[aria-label*="next" i]',
    'button:has-text("Next")',
    'button:has-text("›")',
    'button:has-text("→")'
  ];

  for (const selector of candidates) {
    const loc = page.locator(selector).first();
    if (await loc.count() && await loc.isVisible().catch(() => false)) {
      await loc.click();
      await page.waitForTimeout(700);
      return true;
    }
  }

  // Last-resort visual-ish fallback: click a button/link whose accessible
  // name suggests forward navigation. This keeps the agent browser-driven
  // without hardcoding a fragile pixel coordinate.
  const buttons = page.locator("button, a, [role=button]");
  const n = await buttons.count();
  for (let i = 0; i < Math.min(n, 100); i++) {
    const b = buttons.nth(i);
    const label = clean(
      `${await b.getAttribute("aria-label").catch(() => "")} ${await b.getAttribute("title").catch(() => "")} ${await b.innerText().catch(() => "")}`
    );
    if (/next|forward|›|→/i.test(label) && await b.isVisible().catch(() => false)) {
      await b.click();
      await page.waitForTimeout(700);
      return true;
    }
  }

  return false;
}

export async function crawl() {
  await ensureData();

  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== "false",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });

  const eventPage = await browser.newPage();
  const all = new Map<string, CalendarEvent>();
  const visitedStates = new Set<string>();

  try {
    await page.goto(CALENDAR_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1200);

    // Event links visible in the calendar page are scraped directly where possible.
    // This is more accurate than OCR for title/date information.
    const links = await collectEventLinks(page);
    for (const url of links) {
      try {
        const event = await scrapeEventPage(eventPage, url);
        if (event) all.set(event.uid, event);
      } catch (e) {
        console.warn("Event page failed", url, e);
      }
    }

    // The visual loop advances through the calendar to catch events not exposed
    // as normal links in the page DOM.
    const maxSteps = Math.min(WEEKS * 2 + 4, 30);
    for (let step = 0; step < maxSteps; step++) {
      const text = await getVisibleText(page);
      const stateHash = crypto.createHash("sha1").update(text).digest("hex");
      if (visitedStates.has(stateHash)) break;
      visitedStates.add(stateHash);

      const shot = await screenshot(page, `step-${String(step).padStart(2, "0")}`);
      const obs = await visionObserve(page, shot, text);

      for (const event of obs.events) {
        if (event.confidence >= 0.65) all.set(event.uid, event);
      }

      if (obs.nextAction === "stop") break;

      const clicked = await clickNext(page);
      if (!clicked) {
        // Save a final diagnostic screenshot and stop safely.
        await screenshot(page, `stuck-${String(step).padStart(2, "0")}`);
        break;
      }
    }
  } finally {
    await browser.close();
  }

  const events = [...all.values()].sort((a, b) => a.start.localeCompare(b.start));
  await fs.writeFile(path.join(DATA, "events.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: CALENDAR_URL,
    events
  }, null, 2));

  return events;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  crawl().then(events => {
    console.log(`Crawl complete: ${events.length} events`);
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}