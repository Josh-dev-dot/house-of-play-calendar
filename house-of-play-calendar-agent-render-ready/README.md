# House of Play Calendar Agent

This version uses a real browser (Playwright) rather than relying solely on HTML scraping.

## What it does

1. Opens the House of Play calendar in Chromium.
2. Reads the calendar DOM/text where possible.
3. Takes screenshots of each calendar state.
4. Uses a vision model when configured to interpret the calendar screen.
5. Clicks the calendar's Next button through Playwright/accessibility selectors.
6. Continues through a configurable horizon (12 weeks by default).
7. Also follows ordinary House of Play event links and reads their event pages, which provide exact event dates/times.
8. Deduplicates events using stable UIDs.
9. Writes `data/events.json`.
10. Serves `data/events.json` as `/house-of-play.ics`.

## Install

Node 20+ is recommended.

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Add an `OPENAI_API_KEY` if you want screenshot interpretation by a vision model.

## Run

Terminal 1:

```bash
npm run dev
```

Terminal 2:

```bash
npm run crawl
```

Then open:

http://localhost:3000

ICS feed:

http://localhost:3000/house-of-play.ics

## Important

The agent deliberately prefers DOM/accessibility information over vision when possible. Vision is the fallback for a calendar widget that is visually understandable but poorly exposed in HTML.

For a production deployment, run the crawler on a schedule (for example every 6 hours) and keep the web server public over HTTPS.

Google Calendar can subscribe to the resulting `/house-of-play.ics` URL. Google controls how often it refreshes subscribed calendars, so the server can be kept current even when Google does not immediately fetch the latest version.

## Current House of Play-specific behavior

The site exposes regular activities and special events. The regular-activity page says that selected activities should be checked against the calendar for their actual dates, so the browser crawl is useful for capturing those scheduled instances rather than simply expanding recurring rules ourselves.

The agent also reads individual event pages because those pages expose authoritative date/time details and an existing "Google Calendar ICS" option.

## Safety / reliability

The agent stops rather than inventing events when:
- the calendar state repeats;
- it cannot find a next control;
- vision confidence is low;
- the page is not showing useful calendar content.

Screenshots are retained in `data/screenshots` for debugging.

For deployment, add robots/rate-limit checks and use a modest crawl interval.

## Render deployment

Use a **Web Service**, Node runtime, and the Free plan.

If Render does not automatically use `render.yaml`, set:

- Build Command: `npm install && npx playwright install --with-deps chromium && npm run build`
- Start Command: `npm start`

The service exposes:

- `/` — control panel
- `/health` — Render health check
- `/house-of-play.ics` — Google Calendar feed

No database is required.
