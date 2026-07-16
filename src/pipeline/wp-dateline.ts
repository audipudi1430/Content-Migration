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
 * `2024-09-19T09:00:00` are treated as PST/PDT wall time (avoids day-off from CT→PT).
 */
function loadDatelineSourceTimeZone(): string {
  return process.env.BLOG_DATELINE_SOURCE_TIMEZONE?.trim() || "America/Los_Angeles";
}

/** Target wall-clock zone stored on Contentstack `dateline` (default Pacific). */
function loadDatelineTargetTimeZone(): string {
  return process.env.BLOG_DATELINE_TIMEZONE?.trim() || "America/Los_Angeles";
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

/** Map a wall-clock time in `timeZone` to a UTC instant. */
function wallTimeToInstant(parts: DateTimeParts, timeZone: string): Date {
  let ms = Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.se);
  for (let i = 0; i < 4; i++) {
    const got = readWallTimeInZone(new Date(ms), timeZone);
    ms -= wallTimeDiffSeconds(got, parts) * 1000;
  }
  return new Date(ms);
}

function formatWallTime(parts: DateTimeParts): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${parts.y}-${pad(parts.mo)}-${pad(parts.d)}T${pad(parts.h)}:${pad(parts.mi)}:${pad(parts.se)}`;
}

function instantToWallTime(instant: Date, timeZone: string): string {
  return formatWallTime(readWallTimeInZone(instant, timeZone));
}

function pickStringField(story: Record<string, unknown>, key: string): string {
  const v = story[key];
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

/**
 * WordPress publish date → Contentstack dateline in Pacific Time.
 *
 * Prefers `date` (e.g. `2024-09-19T09:00:00`) treated as Pacific wall time by default,
 * so the calendar day/time are preserved. Falls back to `date_gmt` (UTC → Pacific).
 */
export function pickWpStoryDateline(story: Record<string, unknown>): string | undefined {
  const targetTz = loadDatelineTargetTimeZone();
  const sourceTz = loadDatelineSourceTimeZone();

  // Prefer local `date` — treat bare timestamps as Pacific (or BLOG_DATELINE_SOURCE_TIMEZONE).
  const date = pickStringField(story, "date");
  if (date) {
    const parts = parseWpDateTimeParts(date);
    if (parts) {
      // Same zone → keep wall clock as-is (no day shift).
      if (sourceTz === targetTz) {
        return formatWallTime(parts);
      }
      const instant = wallTimeToInstant(parts, sourceTz);
      return instantToWallTime(instant, targetTz);
    }
  }

  const dateGmt = pickStringField(story, "date_gmt");
  if (dateGmt) {
    const parts = parseWpDateTimeParts(dateGmt);
    if (parts) {
      const instant = new Date(Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.se));
      return instantToWallTime(instant, targetTz);
    }
  }

  return undefined;
}
