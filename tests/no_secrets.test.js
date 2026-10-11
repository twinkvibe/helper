import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Guardrail: secrets must never reach the public frontend or the repository.
// The frontend is served publicly by GitHub Pages, so only the Supabase URL and
// the publishable (anon) key may appear there.

function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some(ext => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

test('No service-role or secret keys are shipped to the frontend', () => {
  const publicFiles = [...walk('src', ['.js', '.css']), 'index.html'];
  const forbidden = [
    /sb_secret_[A-Za-z0-9]/,
    /SUPABASE_SERVICE_ROLE_KEY/,
    /SERVICE_ROLE/,
    /service_role/,
    /AI_CHAIN/,
    /BOT_TOKEN/,
    /WEBHOOK_SECRET/,
    /gsk_[A-Za-z0-9]/,
    /sk-E4ng/,
  ];
  for (const file of publicFiles) {
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(content), `${file} must not contain ${pattern}`);
    }
  }
});

test('Only public Supabase variables are referenced from the frontend', () => {
  const src = fs.readFileSync('src/main.js', 'utf8');
  const referenced = [...src.matchAll(/import\.meta\.env\.([A-Z0-9_]+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(referenced)].sort(), ['VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_URL']);
  assert.ok(!referenced.some(name => /SERVICE|SECRET|PASSWORD/.test(name)));
});

test('.env.example exposes only public placeholder variables', () => {
  const example = fs.readFileSync('.env.example', 'utf8');
  const names = example.split(/\r?\n/).filter(Boolean).map(line => line.split('=')[0]);
  assert.deepEqual(names.sort(), ['VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_URL']);
  assert.ok(!/service|secret/i.test(example));
});

test('No AI provider secrets are referenced from the frontend', () => {
  const files = walk('src', ['.js']);
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(!/AI_API_KEY|AI_BASE_URL|AI_MODEL/.test(content), `${file} must not reference server-side AI secrets`);
  }
});
test('.gitignore excludes environment files but keeps the example', () => {
  const ignore = fs.readFileSync('.gitignore', 'utf8');
  assert.match(ignore, /^\.env$/m);
  assert.match(ignore, /^\.env\.\*$/m);
  assert.match(ignore, /^!\.env\.example$/m);
});
