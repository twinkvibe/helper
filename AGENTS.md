# Agent guide

This file is the canonical instruction set for coding agents working in this repository. Read it before editing. Keep it accurate when architecture, commands, or security boundaries change.

## Product

Helper is a private personal workspace delivered as a public static GitHub Pages application at `/` on custom domain `helper.slutvibe.site`. It provides authenticated tasks, browser-local Markdown notes, and an administrator UI. The interface language is Russian.

The product should feel like a compact tool. Prefer direct labels such as «Задачи», «Заметки», and «Аккаунт». Avoid filling routine screens with slogans, oversized decorative headings, or repeated labels such as «личное» and «чистый лист».

## Stack and commands

- Frontend: Vite, vanilla JavaScript, and CSS.
- Authentication and remote task storage: Supabase Auth and PostgreSQL.
- Privileged account operations: Supabase Edge Function `account`.
- Markdown: Marked, DOMPurify, and lazy-loaded Mermaid.
- Tests: Node test runner and JSDOM.

Use Node.js 22.12 or newer. Normal validation is:

```sh
npm ci
npm test
npm run build
```

Use `npm install` only when dependencies change. Do not commit `.env.local`, `dist/`, credentials, database passwords, Supabase secret keys, service-role keys, access tokens, or user passwords.

## Repository map

- `src/main.js`: application boot, authentication lifecycle, session expiry handling, top-level navigation, account and admin views.
- `src/workbench.js`: task and note workflows, filters, links, local persistence, import/export, and task details.
- `src/articles.js`: publication management, public article and author profile rendering, cover upload and image insertion.
- `src/editor.js`: Markdown toolbar (format and view groups), shortcuts, editor and split modes, and image insertion.
- `src/image-editor.js`: canvas-based image cropper with zoom and pan for avatars (1:1) and article covers (16:9).
- `src/router.js`: route resolution (public profiles, articles, admin), navigation links, and brand HTML helper.
- `src/security.js`: Markdown sanitization and auth storage adapter.
- `src/diagram.js`: lazy Mermaid rendering and SVG sanitization.
- `src/notes.js`: note persistence, legacy migration, tag parsing, and task filtering.
- `src/style.css`: shell, login, account, and shared styles.
- `src/workbench.css`: task, note, editor, dialog, and responsive styles.
- `supabase/schema.sql`: full schema for a brand-new project only.
- `supabase/migrations/`: ordered, append-only SQL changes for an existing project.
- `supabase/functions/account/index.ts`: authenticated privileged operations (user management, roles, deletions, article moderation, and audit logs).
- `.github/workflows/pages.yml`: tests, production build, and GitHub Pages deployment.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing data ownership, authentication, Markdown storage, or task-note linking. Read [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) before changing the database or deployment.

## Security invariants

Treat these as requirements, not implementation suggestions:

1. GitHub Pages and all shipped frontend code are public. Access control must be enforced by Supabase, RLS, and the Edge Function.
2. Never place `SUPABASE_SERVICE_ROLE_KEY`, a secret key, or a real password in frontend code, GitHub Pages variables, tests, documentation examples, or commits. The Vite URL and publishable key are public by design.
3. Keep RLS enabled. A task owner may access only their own tasks and only while their profile is active and no forced password change is pending.
4. Admin authorization comes from `public.profiles.role`, read by trusted server code. Do not trust client state, `user_metadata`, request payload roles, or hidden UI controls.
5. Verify the user token and current profile inside every privileged Edge Function request. Blocking must take effect for already-issued access tokens.
6. Check or refresh the session before remote operations, when the tab regains focus, and before token expiry. If refresh fails, clear local auth and return to login immediately.
7. Render user strings with DOM APIs such as `textContent`. Markdown HTML must pass through `renderMarkdown`; Mermaid output must be sanitized separately. Do not add raw `innerHTML` using user-controlled content.
8. Permit Markdown images only from HTTPS, a same-site relative path, or a validated supported image data URL. Keep file size limits explicit.
9. Do not silently discard notes, failed imports, unsaved task edits, or legacy localStorage data. Prefer a recoverable migration and retain the old copy.

When changing authentication, RLS, sanitization, imports, storage, image handling, Mermaid, or admin operations, add or update a meaningful regression test.

## Data ownership and behavior

Tasks are remote and synchronize across devices. Notes intentionally live only in the current browser, namespaced by the authenticated user UUID. Clearing site data removes them. Logging out must not remove them. Export is their backup mechanism.

Tasks and notes connect in two ways:

- a task can store a note UUID in `todos.note_id`;
- shared normalized `#tags` provide loose relationships and filtering.

The note UUID is browser-local. Another device may see a task's note link but not possess that note. Preserve the explanatory unavailable state.

The editor operates directly on the Markdown source with two modes: «Редактор» (compact single-pane editing with formatting toolbar) and «Редактор + просмотр» (split view with a live rendered preview and resizable pane slider). Whole Markdown structures (lists, tables, quotes, code fences) are preserved on edit.

## Database changes

Do not edit an already-applied migration. Add a new dated migration under `supabase/migrations/`. Make safe migrations idempotent where practical and preserve existing data. Update `supabase/schema.sql` to describe the final state for new installations, then document which migration existing installations must run.

Never execute destructive SQL or deploy an Edge Function against the user's Supabase project without explicit authorization. The local repository does not contain the authority needed to do so.

## Change discipline

- Inspect `git status` before editing and preserve unrelated user changes.
- Keep the Vite base path `/` unless the deployment target changes.
- Maintain usable desktop and mobile layouts.
- Prefer native browser APIs and small focused modules over adding dependencies.
- Do not weaken validation merely to make an error disappear. Surface actionable Russian error messages.
- Do not push, deploy, publish, or alter remote configuration unless the user asks. A request to push authorizes the normal Pages workflow triggered by that push, but not a Supabase schema or function deployment.
- Before handing off code, run relevant tests and `npm run build`. Report any required SQL migration or Edge Function redeploy explicitly.

## Definition of done

A change is complete when its user-visible path works, failure states are understandable, security boundaries still hold, tests cover material logic, the production build succeeds, and setup documentation reflects any operator action that remains.
