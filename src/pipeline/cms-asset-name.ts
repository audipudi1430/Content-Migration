/** True when Contentstack locale is English (`en`, `en-us`, `en-gb`, …). */
export function isEnglishContentstackLocale(locale?: string): boolean {
  const loc = (locale ?? process.env.CONTENTSTACK_LOCALE ?? "en-us").trim().toLowerCase();
  if (!loc) return true;
  return loc === "en" || loc.startsWith("en-");
}

/**
 * CMS Asset Name (`title` / `cms_asset_name`) for non-English microsite migrations.
 * When `MIGRATION_MICROSITE` is set and locale is not English: `{title}-{microsite}`.
 */
export function resolveCmsAssetName(
  title: string,
  opts?: { locale?: string; microsite?: string }
): string {
  const base = title.trim() || "Untitled";
  const microsite = (opts?.microsite ?? process.env.MIGRATION_MICROSITE ?? "").trim();
  if (!microsite || isEnglishContentstackLocale(opts?.locale)) {
    return base;
  }

  const suffix = `-${microsite}`;
  if (base.toLowerCase().endsWith(suffix.toLowerCase())) {
    return base;
  }
  return `${base}${suffix}`;
}
