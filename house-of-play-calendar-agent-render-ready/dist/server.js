import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { makeIcs } from "./ics.js";
import { crawl } from "./agent.js";
const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA = path.resolve("data");
const REFRESH_MS = Number(process.env.REFRESH_MS || 6 * 60 * 60 * 1000);
let crawlInProgress = false;
async function readEvents() {
    try {
        const raw = await fs.readFile(path.join(DATA, "events.json"), "utf8");
        return JSON.parse(raw).events || [];
    }
    catch {
        return [];
    }
}
app.use(express.static("public"));
app.get("/health", (_req, res) => res.status(200).send("ok"));
async function refreshIfStale() {
    if (crawlInProgress)
        return;
    let stale = true;
    try {
        const raw = await fs.readFile(path.join(DATA, "events.json"), "utf8");
        const generatedAt = JSON.parse(raw).generatedAt;
        stale = !generatedAt || (Date.now() - new Date(generatedAt).getTime() > REFRESH_MS);
    }
    catch { }
    if (!stale)
        return;
    crawlInProgress = true;
    try {
        console.log("Calendar cache is stale; refreshing...");
        await crawl();
    }
    catch (e) {
        console.error("Refresh failed; keeping existing cache:", e);
    }
    finally {
        crawlInProgress = false;
    }
}
app.get("/house-of-play.ics", async (_req, res) => {
    try {
        await refreshIfStale();
        const events = await readEvents();
        const ics = makeIcs(events);
        res.setHeader("Content-Type", "text/calendar; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.send(ics);
    }
    catch (e) {
        res.status(503).send("Calendar feed unavailable");
    }
});
app.get("/api/status", async (_req, res) => {
    const events = await readEvents();
    let generatedAt = null;
    try {
        const raw = await fs.readFile(path.join(DATA, "events.json"), "utf8");
        generatedAt = JSON.parse(raw).generatedAt || null;
    }
    catch { }
    res.json({ events: events.length, generatedAt, feed: "/house-of-play.ics" });
});
app.post("/api/crawl", async (_req, res) => {
    try {
        const events = await crawl();
        res.json({ ok: true, events: events.length });
    }
    catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: String(e) });
    }
});
app.listen(PORT, async () => {
    console.log(`House of Play agent: http://localhost:${PORT}`);
    // Populate the first feed after the server starts so Render can become
    // healthy immediately instead of waiting for a manual crawl.
    try {
        const events = await readEvents();
        if (events.length === 0) {
            console.log("No cached events yet; starting initial crawl...");
            await crawl();
            console.log("Initial crawl complete.");
        }
    }
    catch (e) {
        // Keep the HTTP service alive even if the source site is temporarily unavailable.
        console.error("Initial crawl failed:", e);
    }
});
