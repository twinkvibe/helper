# Development

## Local setup

Use Node.js 22.12 or newer:

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Fill `.env.local` with a Supabase Project URL and publishable key. Never use a secret or service-role key in a `VITE_` variable.

The app is served under `/` (custom domain `helper.slutvibe.site`). For a production-like check:

```sh
npm test
npm run build
npm run preview
```

## Making changes

Place authentication and shell behavior in `main.js`. Keep the task/note domain in `workbench.js`, publications and public views in `articles.js`, image cropper logic in `image-editor.js`, route helpers in `router.js`, generic Markdown editing in `editor.js`, sanitization in `security.js`, and pure storage/filter logic in `notes.js`. Extract a module when a concern can be tested independently.

Tests should target behavior and boundaries: ownership filters, session gates, migration compatibility, sanitization payloads, local persistence, editor preservation, routing semantics, and error recovery. Avoid tests that merely repeat literal implementation details.

## Supabase workflow

For a fresh project, run `supabase/schema.sql`. For an existing project, apply only migrations that have not previously run, in filename order. Never rerun the full schema over an installed project. For existing instances up through `20260920_article_media_access.sql`, run `20260921_profile_admin_publication_ux.sql`.

When schema changes:

1. add an append-only dated migration;
2. update the final-state fresh schema;
3. update tests and README operator steps;
4. test against an isolated Supabase project when credentials are available;
5. report the exact migration the owner must run.

When `supabase/functions/account/index.ts` changes, GitHub Pages deployment does not publish it. Deploy it separately through the Supabase dashboard or CLI after explicit authorization.

## Release checklist

- `npm test` passes;
- `npm run build` passes;
- no secret is present in tracked files or the generated bundle;
- task access remains protected by RLS;
- privileged actions verify the current server-side role;
- Markdown, image, and Mermaid payloads remain sanitized;
- session expiry returns to login without requiring a reload;
- mobile navigation and dialogs remain usable;
- README names every manual migration or function deployment.
