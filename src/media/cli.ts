import { initEnvFromArgs } from "../config.js";
import { extractMediaToSheet, migrateFromSheet } from "./workflow.js";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  initEnvFromArgs(args);
  if (!command || command === "help" || command === "--help") {
    console.error("Usage:");
    console.error("  npm run media:extract -- --env-file=env/.env.dev --sheet=wp-media-mapping.xlsx");
    console.error(
      "  npm run media:migrate -- --env=dev --sheet=wp-media-mapping.xlsx --mode=all|single|ids|failed|xml [--single-id=123] [--ids=1,2,3] [--offset=0] [--limit=25] [--xml-path=ids.xml]"
    );
    process.exit(0);
  }

  if (command === "extract") {
    await extractMediaToSheet(args);
    return;
  }
  if (command === "migrate") {
    await migrateFromSheet(args);
    return;
  }

  throw new Error(`Unknown media command: ${command}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
