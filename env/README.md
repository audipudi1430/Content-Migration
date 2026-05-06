Use these files to run migrations against different environments and different Contentstack stacks.

Files:
- `.env.dev`
- `.env.prod`
- `.env.stack-a`
- `.env.stack-b`

How loading works:
- `--env-file=env/.env.dev` loads an explicit file.
- `--env=dev` loads `env/.env.dev`.
- If neither is provided, the loader falls back to `.env` in project root.

Examples:
- `npm run media:extract -- --env=dev --sheet=wp-media-mapping.dev.xlsx`
- `npm run media:migrate -- --env=stack-a --mode=failed --limit=25`
- `npm run migrate -- --env-file=env/.env.prod`
- `npm run migrate:media -- --env=stack-b`
