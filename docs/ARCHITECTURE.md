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

## Server data

`profiles` stores the application username, `admin` or `member` role, blocked state, and forced-password-change state. Auth credentials stay inside Supabase Auth.

`todos` stores task title, completion, Markdown description, list, due date, priority, tags, and an optional browser-note UUID. RLS checks task ownership and the current profile on every operation. The `account` Edge Function separately verifies the access token and current profile before privileged operations.

## Local notes

The versioned note collection is stored under `helper:notes:<user UUID>`. Each note has a stable UUID, title, Markdown body, and deletion flag. The former single-note key is copied into the collection on first load and retained as a recovery copy.

Internal Markdown links use `#note=<UUID>`. Renaming a note therefore does not break links. Because notes do not synchronize, such links resolve only in a browser that possesses the target UUID.

Images selected from the device are stored as local note attachments with short `attachment://` references in the Markdown source, currently limited to 1 MB each. Remote images must use HTTPS. Task descriptions store any existing embedded images in PostgreSQL; note attachments count against browser storage quota.

## Markdown rendering

All Markdown first passes through Marked and DOMPurify with a small tag and attribute allowlist. Checkboxes are disabled. Image sources are validated and receive lazy loading and a no-referrer policy.

Mermaid is imported only when a `mermaid` fenced block exists. It runs with strict security settings, and its generated SVG is sanitized again before insertion.

The editor has two presentations over the same Markdown source:

- split mode shows the complete source and rendered preview;
- live mode tokenizes the document into semantic Markdown blocks, shows rendered blocks, and replaces only the focused block with a textarea.

## Deployment

A push to `main` runs tests, builds with repository-level public Supabase variables, and deploys `dist/` to GitHub Pages. SQL migrations and Edge Functions are separate Supabase deployments and are never applied by the Pages workflow.
