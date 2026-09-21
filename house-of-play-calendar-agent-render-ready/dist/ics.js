import { createEvents } from "ics";
export function makeIcs(events) {
    const attrs = events.map(e => {
        const s = new Date(e.start);
        const end = new Date(e.end);
        return {
            uid: e.uid,
            title: e.title,
            start: [s.getFullYear(), s.getMonth() + 1, s.getDate(), s.getHours(), s.getMinutes()],
            end: [end.getFullYear(), end.getMonth() + 1, end.getDate(), end.getHours(), end.getMinutes()],
            description: `${e.description || ""}${e.url ? `\n\nHouse of Play: ${e.url}` : ""}`,
            location: e.location,
            url: e.url,
            status: "CONFIRMED",
            busyStatus: "BUSY",
            productId: "house-of-play-calendar-agent"
        };
    });
    const { error, value } = createEvents(attrs);
    if (error)
        throw error;
    return value || "";
}
