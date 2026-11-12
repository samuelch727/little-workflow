# Little Stack documentation

The unified documentation app for **https://little-stack.dev**, built with
Next.js and Fumadocs. The directory and package keep their existing
`little-workflow-doc` names so the connected hosting project continues to build
the same app.

## Content and routes

- `content/docs/harness`: Little Harness, published as `@little-stack/harness`.
- `content/docs/workflow`: Little Workflow, published as `@little-stack/workflow`.
- `content/docs/littledb`: LittleDB's documented private-source integrations.
- `content/docs/compute`: Little Compute's unpublished self-hosted workspace engine.
- Shared setup, architecture, glossary, and release pages live at the docs root.

Preserve the historical `v0.1.0-alpha` path segments. They are stable URLs, not
the current package version. Availability is stated separately in the release
page and product status component. Do not copy private engineering plans or
operational reports into the published content.

`next.config.mjs` keeps permanent redirects for the former Workflow and Compute
paths. `public/docs-migration.json` records the full migration map, including
the old Harness paths. The separate Harness host retains its current routing:
its `/docs/v0.1.0-alpha/...` URLs overlap with Workflow paths and must not be
pointed at this app without a host-aware migration.

## Run and verify

Use the repository's pinned pnpm version (`10.27.0`) from the repository root:

```sh
pnpm install --filter little-workflow-doc... --frozen-lockfile
pnpm --filter little-workflow-doc dev
pnpm --filter little-workflow-doc typecheck
pnpm --filter little-workflow-doc build
pnpm --filter little-workflow-doc start
```

With the production server running, verify the actual served pages:

```sh
pnpm --filter little-workflow-doc verify:site http://localhost:3000
```

Check avatar behavior in Chromium against the same served build:

```sh
cd apps/little-workflow-doc
node scripts/verify-avatars.mjs http://localhost:3000
```

This check covers idle timing, finite playback, interruption, cooldown, reduced
motion, hidden-document handling, responsive light/dark layouts, and the static
fallback without JavaScript. Set `CHROMIUM_EXECUTABLE` when using a system
browser instead of Playwright's installed Chromium. The supplied SVG sources
and their motion policy are documented in `assets/icons/README.md`.

The check covers every sitemap page, rendered internal documentation links,
Markdown copies, all declared Workflow/Compute migration redirects (including
query preservation), product search, representative Open Graph images, crawler
metadata, and a real 404. Pass a deployed origin to verify the hosted build.

## Hosting and canonical URLs

The existing Vercel `little-workflow-doc` project in the GIMII team builds this
app. Deploy only a tested commit from the private integration workflow; a site
deployment is distinct from merging a pull request or publishing npm packages.
Keep the build root at `apps/little-workflow-doc` with the repository lockfile
available. This documentation app needs no runtime secrets.

`src/lib/shared.ts` defines `https://little-stack.dev` as the canonical origin.
Page metadata, sitemap and robots use it even on a preview hostname. Preview
hosts are for review; they are not separate canonical documentation sites.

The UI and release corrections prepared on `codex/little-stack-docs` must remain
in the integration source before subsequent production deployments from other
branches. The release corrections reuse PR #130 at
`608c2ddc62f18cca4d960029b0aef6b26ee75e4b`; they do not merge or close that PR.
