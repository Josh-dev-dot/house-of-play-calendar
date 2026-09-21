export type CalendarEvent = {
  uid: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  url?: string;
  source: "dom" | "vision" | "event-page";
  confidence: number;
};

export type CalendarObservation = {
  pageUrl: string;
  screenshot: string;
  visibleText: string;
  detectedRange?: string;
  events: CalendarEvent[];
  nextAction: "next" | "stop" | "retry";
  confidence: number;
};