# Copilot instructions

Read and follow the repository-root `AGENTS.md`; it is the canonical agent guide. Consult `docs/ARCHITECTURE.md` for trust boundaries and `docs/DEVELOPMENT.md` for validation and Supabase workflow.

Never expose Supabase secret/service-role keys or passwords, weaken RLS, trust client-provided roles, render unsanitized Markdown/SVG, delete browser notes during migration, or treat a GitHub Pages deploy as a Supabase deploy. Run `npm test` and `npm run build` for code changes.
