# WordPress → Contentstack migration

Node/TypeScript tooling to copy content from a WordPress site (REST API) into Contentstack (Content Management API), with a **JSON mapping file** that records WordPress IDs next to new Contentstack entry or asset UIDs so you can resume work and resolve references later.

It also includes a media-first workflow that extracts WordPress media into an Excel sheet (source of truth by `mime_type`) and then migrates by selected IDs with pass/fail tracking.

## What it does today

1. **Categories** — Reads `/wp/v2/categories`, creates entries in your category content type, stores mappings.
2. **Assets (media)** — Reads `/wp/v2/media`, downloads files, uploads them to Contentstack in a dedicated folder (or a folder you specify), maps attachment IDs to asset UIDs. Supports **batched runs** so you can migrate gradually.
3. **Posts & pages** — Reads `/wp/v2/posts` and `/wp/v2/pages`, creates entries, maps IDs.

Taxonomy **tags** are not migrated yet (the full run still expects a tag content type UID in the environment for future use).

## Requirements

- Node.js 18+ (global `fetch`, `FormData`, `Blob`)
- WordPress with REST API access (Application Passwords recommended for authenticated media and non-public content)
- Contentstack stack with a **management token**, stack **API key**, and content types whose **field UIDs** match what the scripts send (see below)

## Setup

```bash
npm install
```

## Environment variables

### Required for every run

| Variable | Description |
|----------|-------------|
| `WP_BASE_URL` | WordPress origin, e.g. `https://example.com` |
| `CONTENTSTACK_MANAGEMENT_TOKEN` | CMA management token |
| `CONTENTSTACK_STACK_API_KEY` | Stack API key |

### Strongly recommended (WordPress)

| Variable | Description |
|----------|-------------|
| `WP_USER` | WordPress username |
| `WP_APPLICATION_PASSWORD` | Application password (not your normal login password) |

### Full migration (`npm run migrate`)

| Variable | Description |
|----------|-------------|
| `CS_CONTENT_TYPE_CATEGORY` | Content type UID for categories |
| `CS_CONTENT_TYPE_TAG` | Content type UID for tags (required by config even though tags are not migrated yet) |
| `CS_CONTENT_TYPE_POST` | Content type UID for posts |
| `CS_CONTENT_TYPE_PAGE` | Content type UID for pages |

### Optional (all runs)

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTENTSTACK_API_HOST` | `api.contentstack.io` | Use your region host if different (e.g. EU) |
| `MIGRATION_MAP_PATH` | `migration-map.json` | Path to the ID mapping / state file |
| `CONTENTSTACK_LOCALE` | _(unset)_ | Passed to entry creation when using locales |

### Assets / media batching

| Variable | Default | Description |
|----------|---------|-------------|
| `MEDIA_BATCH_SIZE` | `25` | Maximum **new** uploads per run (already mapped items are skipped) |
| `MEDIA_OFFSET_OVERRIDE` | _(unset)_ | One-off override of the saved media list offset |
| `CS_ASSET_FOLDER_NAME` | `WordPress Media` | Name of folder created in Contentstack when none is stored yet |
| `CS_ASSET_PARENT_FOLDER_UID` | _(unset)_ | Parent folder UID when **creating** the migration folder |
| `CS_ASSET_FOLDER_UID` | _(unset)_ | Use this existing asset folder; skip auto-create |

You can load these from env files directly. This repo now supports:

- `--env-file=env/.env.dev` (explicit file path)
- `--env=dev` (auto-resolves to `env/.env.dev`)
- fallback to `.env` in project root

## Scripts

```bash
# Full pipeline: categories → assets → posts/pages
npm run migrate -- --env=dev

# Only WordPress media → Contentstack assets (no content-type UIDs for entries required)
npm run migrate:media -- --env=stack-a

# Step 1: extract WordPress media to Excel
npm run media:extract -- --env-file=env/.env.prod --sheet=wp-media-mapping.prod.xlsx

# Step 2: migrate selected rows from Excel
npm run media:migrate -- --env=prod --sheet=wp-media-mapping.prod.xlsx --mode=failed --limit=25 --offset=0
```

The media-only command runs `tsx src/migrate.ts --media-only`.

`media:extract` and `media:migrate` run `tsx src/media/cli.ts`.

## Multi-environment / multi-stack files

Sample files are included in `env/`:

- `env/.env.dev`
- `env/.env.prod`
- `env/.env.stack-a`
- `env/.env.stack-b`

Copy and update values for your real stacks/tokens before running.

### Which env file to use

| File | Use case | Output isolation |
|------|----------|------------------|
| `env/.env.dev` | Development / testing migrations | `migration-map.dev.json`, `wp-media-mapping.dev.xlsx` |
| `env/.env.prod` | Production migration runs | `migration-map.prod.json`, `wp-media-mapping.prod.xlsx` |
| `env/.env.stack-a` | One Contentstack stack target | `migration-map.stack-a.json`, `wp-media-mapping.stack-a.xlsx` |
| `env/.env.stack-b` | Another Contentstack stack target | `migration-map.stack-b.json`, `wp-media-mapping.stack-b.xlsx` |

This keeps each environment/stack fully separate and avoids accidental cross-mapping.

### Env selection options (all commands)

- `--env=<name>` loads `env/.env.<name>` (for example `--env=dev`)
- `--env-file=<path>` loads an explicit file path
- If both are present, `--env-file` wins
- If neither is provided, `.env` in project root is used

Examples:

```bash
# full migration
npm run migrate -- --env=dev

# media-only legacy phase
npm run migrate:media -- --env=stack-a

# extract sheet
npm run media:extract -- --env=prod

# migrate selected IDs from sheet
npm run media:migrate -- --env-file=env/.env.stack-b --mode=ids --ids=101,102 --limit=2
```

> Replace placeholder values in `env/.env.*` files before running.

## Media Excel flow (source of truth)

The generated Excel workbook (`wp_media_mapping.xlsx` by default) now contains:

- `main_mapping` (primary control/lookup tab)
- `images` (rows where `mime_type` is `image/*`)
- `videos` (rows where `mime_type` is `video/*`)
- `documents` (rows where `mime_type` is `application/pdf`)
- `others` (all other mime types)

The `main_mapping` tab includes:

- `wp_id`
- `mime_type`
- `media_kind` (`image`, `video`, `document`, `other`)
- `migration_status` (`Pending`, `Pass`, `Fail`, `Skipped`)
- `contentstack_uid`
- `contentstack_type`
- `migration_message`
- source metadata (`wp_slug`, `wp_source_url`, `wp_title`)
- `target_tab` (which mime tab contains the row)
- `open_tab` (Excel hyperlink to jump to that mime tab row)
- `resolved_contentstack_uid` (formula lookup from the target tab)
- `reference_value` (auto JSON snippet: `{"uid":"<resolved_uid>"}`)

Migration rules implemented from `mime_type`:

- `image/*` → Contentstack **asset**
- `video/*` → upload asset + create **video entry**
- `application/pdf` → upload asset + create **document entry**

If your WordPress endpoint is custom, set `WP_MEDIA_ENDPOINT` (path or full URL), e.g. `https://my.domain.com/wp-json/wp/v2/media`.

## Media migration selectors

`media:migrate` supports:

- `--mode=all`
- `--mode=single --single-id=123`
- `--mode=ids --ids=12,18,29`
- `--mode=failed`
- `--mode=xml --xml-path=media-ids.xml`

Use `--offset` and `--limit` for controlled batches.

## Additional env vars for media sheet workflow

| Variable | Default | Description |
|----------|---------|-------------|
| `MEDIA_SHEET_PATH` | `wp-media-mapping.xlsx` | Excel sheet path |
| `WP_MEDIA_ENDPOINT` | `/wp-json/wp/v2/media` | WordPress media endpoint path or full URL |
| `MEDIA_MIGRATION_MODE` | `all` | Mode for `media:migrate` |
| `MEDIA_IDS` | _(unset)_ | Comma-separated IDs for `ids` mode |
| `MEDIA_IDS_XML_PATH` | _(unset)_ | XML file path for `xml` mode |
| `MEDIA_OFFSET` | `0` | Start index on selected IDs |
| `MEDIA_LIMIT` | `25` | Max rows processed in one run |
| `CS_CONTENT_TYPE_VIDEO` | _(required for video)_ | Content type UID for video entries |
| `CS_VIDEO_ASSET_FIELD_UID` | `video_file` | Asset field UID in video content type |
| `CS_CONTENT_TYPE_DOCUMENT` | _(required for pdf)_ | Content type UID for document entries |
| `CS_DOCUMENT_ASSET_FIELD_UID` | `document_file` | Asset field UID in document content type |

## Mapping file

By default, `migration-map.json` holds:

- **`records`** — Keys like `category:123` or `asset:456` → `{ wpId, kind, contentstackUid | assetUid, migratedAt, … }`.
- **`state`** — Resume data, including:
  - `wpMediaListOffset` — Position in the WordPress media list (`orderby=id`, `order=asc`) for the next asset run.
  - `wpMediaAssetFolderUid` — Contentstack folder UID created for this migration (unless you always use `CS_ASSET_FOLDER_UID`).

Commit or back up this file if you rely on it across machines.

## Contentstack field UIDs

The code sends fixed field IDs when creating entries. Your content types must define matching UIDs (or change the code):

- **Category entries:** `title`, `url_slug`, `description`
- **Post / page entries:** `title`, `url_slug`, `body`

## Migration order

Dependencies are handled by phase order:

1. Categories (and later tags when implemented)
2. Assets
3. Posts and pages

Run `migrate:media` repeatedly with a small `MEDIA_BATCH_SIZE` until everything is mapped, then run the full `migrate` when entry content types are ready.

## Typecheck

```bash
npm run typecheck
```

## Limitations

- HTML bodies are passed as strings; rich text / modular blocks need a custom transform.
- Hierarchical categories and tag migration are only partially sketched (parent category and tag phase are TODOs).
- Asset folder creation tries the documented CMA body shape; if your stack returns a different error, adjust `createAssetFolder` in `src/contentstack/client.ts`.

## License

Private project (`package.json`); add a license if you open-source it.
