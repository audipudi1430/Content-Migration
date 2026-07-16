type DateTimeParts = {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  se: number;
};

/**
 * Timezone for WordPress `date` (no offset). Default Pacific — bare values like
 * `2024-11-06T01:00:00` mean 1:00 AM America/Los_Angeles.
 */
function loadDatelineSourceTimeZone(): string {
  return process.env.BLOG_DATELINE_SOURCE_TIMEZONE?.trim() || "America/Los_Angeles";
}

/**
 * Optional extra hours after Pacific→UTC conversion (default 0).
 * Prefer leaving unset — fixed offsets break across PST/PDT.
 */
function loadDatelineOffsetHours(): number {
  const raw = process.env.BLOG_DATELINE_OFFSET_HOURS?.trim();
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function parseWpDateTimeParts(value: string): DateTimeParts | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return undefined;
  return {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: Number(m[4]),
    mi: Number(m[5]),
    se: Number(m[6]),
  };
}

function readWallTimeInZone(instant: Date, timeZone: string): DateTimeParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const hour = Number(map.hour);
  return {
    y: Number(map.year),
    mo: Number(map.month),
    d: Number(map.day),
    h: hour === 24 ? 0 : hour,
    mi: Number(map.minute),
    se: Number(map.second),
  };
}

function wallTimeDiffSeconds(actual: DateTimeParts, target: DateTimeParts): number {
  const toUtcMs = (p: DateTimeParts) => Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.se);
  return Math.round((toUtcMs(actual) - toUtcMs(target)) / 1000);
}

/** Map a wall-clock time in `timeZone` to a real UTC instant. */
function wallTimeToInstant(parts: DateTimeParts, timeZone: string): Date {
  let ms = Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.se);
  for (let i = 0; i < 4; i++) {
    const got = readWallTimeInZone(new Date(ms), timeZone);
    ms -= wallTimeDiffSeconds(got, parts) * 1000;
  }
  return new Date(ms);
}

function formatUtcIso(instant: Date): string {
  return instant.toISOString();
}

function pickStringField(story: Record<string, unknown>, key: string): string {
  const v = story[key];
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

/**
 * WordPress publish date → Contentstack `dateline` as a real UTC ISO string.
 *
 * Frontend treats Contentstack isodate as UTC and converts to PST/PDT for display.
 * So we:
 * 1. Treat WP `date` (e.g. `2024-11-06T01:00:00`) as Pacific wall time
 * 2. Convert that wall time → UTC (handles PST −8 / PDT −7 automatically)
 * 3. Store e.g. `2024-11-06T09:00:00.000Z`
 *
 * Frontend UTC→Pacific then shows `2024-11-06` (not the previous day).
 */
export function pickWpStoryDateline(story: Record<string, unknown>): string | undefined {
  const sourceTz = loadDatelineSourceTimeZone();
  const offsetHours = loadDatelineOffsetHours();
  let instant: Date | undefined;

  // Prefer local `date` — intended calendar day/time in Pacific.
  const date = pickStringField(story, "date");
  if (date) {
    const parts = parseWpDateTimeParts(date);
    if (parts) {
      instant = wallTimeToInstant(parts, sourceTz);
    }
  }

  // Fallback: `date_gmt` is already UTC.
  if (!instant) {
    const dateGmt = pickStringField(story, "date_gmt");
    if (dateGmt) {
      const parts = parseWpDateTimeParts(dateGmt);
      if (parts) {
        instant = new Date(Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.se));
      }
    }
  }

  if (!instant || Number.isNaN(instant.getTime())) return undefined;

  if (offsetHours) {
    instant = new Date(instant.getTime() + offsetHours * 3_600_000);
  }

  return formatUtcIso(instant);
}
