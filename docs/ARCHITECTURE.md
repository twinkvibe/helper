# Architecture

## Runtime boundaries

```text
GitHub Pages (public static files)
  ├─ Supabase Auth ── session / refresh token
  ├─ PostgreSQL REST ── todos protected by RLS
  ├─ Edge Function account ── privileged user management
  └─ browser storage ── local Markdown notes and remember-me choice
```

GitHub Pages executes no server code. The browser is untrusted. Hiding a control is presentation only; PostgreSQL policies and the Edge Function make authorization decisions.

## Authentication lifecycle

The UI converts a normalized username into `<username>@users.helper.invalid` and signs in with Supabase email/password Auth. The synthetic email is an internal identifier, not a recovery address.

`src/main.js` owns session lifecycle:

1. validate the stored session at boot with `auth.getUser()`;
2. schedule refresh shortly before `expires_at`;
3. recheck when the page becomes visible or focused;
4. call `requireSession()` before database or Edge Function operations;
5. on refresh or JWT failure, clear local authentication and render login.

“Remember me” selects localStorage for the Supabase session. Without it, sessionStorage is used. Markdown notes always use localStorage and survive logout.

## Server data and publications

`profiles` stores the application username, optional `display_name` (1–80 chars, falls back to username), `avatar_url`, `admin` or `member` role, blocked state, and forced-password-change state. Public profile data is queried via the `get_public_profile(username)` RPC, which projects only safe public fields (`username`, `display_name`, `avatar_url`) for active profiles.

`todos` stores task title, completion, Markdown description, list, due date, priority, tags, and an optional browser-note UUID. RLS checks task ownership and the current profile on every operation.

`articles` stores authored publication drafts and published articles. Access control follows three tiers:
- `public`: accessible via direct SELECT to anyone when author is unblocked; displayed in public author profile at `/u/:username`;
- `unlisted`: not enumerable via direct SELECT (protected by RLS); accessible only via the SECURITY DEFINER RPC `get_article_by_slug(slug)`;
- `private`: accessible only by the author.

The `account` Edge Function executes privileged administrative tasks with service-role authority while recording explicit audit entries in `audit_logs`:
- user role promotions/demotions with last-admin protection;
- user blocking/unblocking and password resets;
- complete account deletion (including cascading rows and cleaning orphaned `article-media/<userId>/...` storage objects);
- publication moderation (`articles:list`, `articles:access`, `articles:delete`).

## Local notes

The versioned note collection is stored under `helper:notes:<user UUID>`. Each note has a stable UUID, title, Markdown body, and deletion flag. The former single-note key is copied into the collection on first load and retained as a recovery copy.

Internal Markdown links use `#note=<UUID>`. Renaming a note therefore does not break links. Because notes do not synchronize, such links resolve only in a browser that possesses the target UUID.

Images selected from the device are stored as local note attachments with short `attachment://` references in the Markdown source, currently limited to 1 MB each. Remote images must use HTTPS. Task descriptions store any existing embedded images in PostgreSQL; note attachments count against browser storage quota.

## Dossier

`dossier_people`, `dossier_entries`, `dossier_entry_people`, and `dossier_person_links` store owner-only records: one profile card per person (private avatar, relationship status, key-value facts, links to other people) plus a day-grouped event timeline with Markdown, photos, and video. Row level security mirrors `todos`: an owner may read and write only their own rows, and only while their profile is active and no forced password change is pending. Unlike local notes, the dossier synchronizes across devices.

Event bodies are Markdown rendered through `renderMarkdown`. Photos are uploaded to the private storage bucket `dossier-media` under `<userId>/<entryId>/…`; the bucket is not public, so the frontend requests short-lived signed URLs and never exposes a stable public path. `account` deletion cleans the whole `<userId>/` prefix.

## AI providers and Telegram

AI actions (`dossier:analyze`, `dossier:review`, bot chat) share the provider chain in `supabase/functions/_shared/ai.ts`, configured by the `AI_CHAIN` secret (ordered providers and models, OpenAI-compatible `/chat/completions`). Attempts run provider-by-provider; 401/403 skips the whole provider; total failure raises `AI_UNAVAILABLE`, and web-initiated calls then ping the owner's linked Telegram chat. No provider key ever reaches the browser.

The `telegram` Edge Function serves the bot webhook (verified by `WEBHOOK_SECRET`, platform JWT off). One user links one chat via a one-time code (`telegram_links`, sha256 only). The bot uses service-role authority but scopes every query to the linked owner and re-verifies row ownership on callbacks. Conversation memory lives in `telegram_history` (last 30 per chat). Login and client-error pings are sent by the frontend through `notify:login` / `notify:error` (errors throttled to one per 5 minutes).

## Markdown rendering and editor

All Markdown first passes through Marked and DOMPurify with a small tag and attribute allowlist. Checkboxes are disabled. Image sources are validated and receive lazy loading and a no-referrer policy.

Mermaid is imported only when a `mermaid` fenced block exists. It runs with strict security settings, and its generated SVG is sanitized again before insertion.

The editor operates on the plain Markdown source with two modes:
- editor mode: compact single-pane textarea with formatting toolbar;
- split mode: two panes (editor + live preview) with a resizable split slider.

Toolbar actions include quick formatting, heading styles, link insertion, code fences, and custom image insertion with cropper support or HTTPS URLs.

## Deployment

A push to `main` runs tests, builds with repository-level public Supabase variables, and deploys `dist/` to GitHub Pages. SQL migrations and Edge Functions are separate Supabase deployments and are never applied by the Pages workflow.
