import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

// Initialize DOM environment for frontend audit tests
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://helper.slutvibe.site' });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.URL = dom.window.URL;

const {
  FIELD_LABELS,
  ACTION_LABELS,
  ENTITY_LABELS,
  formatVal,
  safeImageUrl,
  extractMarkdownImages,
  renderImageDiff,
  renderTextDiff,
  renderWordDiff,
  renderMarkdownImageChanges,
  renderAuditField,
  populateAuditDiffs,
} = await import('../src/audit.js');

test('DB migration: historical migrations 20260921 and 20260922 are untouched', () => {
  const mig20260921 = fs.readFileSync(path.resolve('supabase/migrations/20260921_profile_admin_publication_ux.sql'), 'utf-8');
  const mig20260922 = fs.readFileSync(path.resolve('supabase/migrations/20260922_profile_bio_audit.sql'), 'utf-8');

  assert.ok(mig20260921.includes('set_profile_display_name'), '20260921 must retain original content');
  assert.ok(mig20260922.includes('set_profile_bio'), '20260922 must retain original content');
});

test('DB migration: 20260923_rich_audit_diffs.sql defines bounded text snapshots and duplicate suppression', () => {
  const mig = fs.readFileSync(path.resolve('supabase/migrations/20260923_rich_audit_diffs.sql'), 'utf-8');

  // Transaction wrapped
  assert.match(mig, /\bbegin;/);
  assert.match(mig, /\bcommit;/);

  // Duplicate suppression for service-role writes
  assert.match(mig, /if\s+auth\.uid\(\)\s+is\s+null\s+then\s+return\s+case/i, 'Must suppress duplicate audit rows when auth.uid() is null');

  // Bounded 100,000 char snapshot
  assert.match(mig, /left\(NEW\.description,\s*100000\)/);
  assert.match(mig, /left\(OLD\.description,\s*100000\)/);
  assert.match(mig, /left\(NEW\.body,\s*100000\)/);
  assert.match(mig, /left\(OLD\.body,\s*100000\)/);

  // Metadata: length, hash, truncated
  assert.match(mig, /before_length/);
  assert.match(mig, /after_length/);
  assert.match(mig, /before_hash/);
  assert.match(mig, /after_hash/);
  assert.match(mig, /before_truncated/);
  assert.match(mig, /after_truncated/);
  assert.match(mig, /md5\(/);
  assert.match(mig, /char_length\(/);
  assert.match(mig, />\s*100000/);

  // Self-service profile audit actions
  assert.match(mig, /'profile_display_name'/);
  assert.match(mig, /'profile_avatar'/);
  assert.match(mig, /'profile_bio'/);

  // No passwords or auth tokens in audit
  assert.doesNotMatch(mig, /audit_logs.*password.*token/i);
});

test('DB schema: supabase/schema.sql is in sync with 20260923 migration', () => {
  const schema = fs.readFileSync(path.resolve('supabase/schema.sql'), 'utf-8');
  assert.match(schema, /if\s+auth\.uid\(\)\s+is\s+null\s+then/i);
  assert.match(schema, /left\(NEW\.description,\s*100000\)/);
  assert.match(schema, /left\(NEW\.body,\s*100000\)/);
  assert.match(schema, /'profile_display_name'/);
  assert.match(schema, /'profile_avatar'/);
  assert.match(schema, /'profile_bio'/);
});

test('Edge Function: user_create role is explicitly member without undefined role variable', () => {
  const edgeSrc = fs.readFileSync(path.resolve('supabase/functions/account/index.ts'), 'utf-8');
  assert.match(edgeSrc, /after:\s*\{\s*username:\s*body\.username,\s*role:\s*['"]member['"]\s*\}/);
  assert.doesNotMatch(edgeSrc, /after:\s*\{\s*username:\s*body\.username,\s*role\s*\}/);
});

test('Audit Frontend: safeImageUrl permits only HTTPS URLs and rejects unsafe schemes', () => {
  assert.equal(safeImageUrl('https://images.unsplash.com/photo.jpg'), 'https://images.unsplash.com/photo.jpg');
  assert.equal(safeImageUrl('https://helper.slutvibe.site/cover.png'), 'https://helper.slutvibe.site/cover.png');
  assert.equal(safeImageUrl('http://insecure.test/photo.jpg'), null);
  assert.equal(safeImageUrl('javascript:alert(1)'), null);
  assert.equal(safeImageUrl('data:image/png;base64,abc'), null);
  assert.equal(safeImageUrl(''), null);
  assert.equal(safeImageUrl(null), null);
  assert.equal(safeImageUrl(undefined), null);
});

test('Audit Frontend: extractMarkdownImages extracts only HTTPS images from Markdown', () => {
  const md = `
# Title
![Good](https://images.test/a.png)
![Another](https://images.test/b.png)
![Duplicate](https://images.test/a.png)
![Bad](http://images.test/bad.png)
![Evil](javascript:alert(1))
![Data](data:image/png;base64,xyz)
`;
  const urls = extractMarkdownImages(md);
  assert.deepEqual(urls, ['https://images.test/a.png', 'https://images.test/b.png']);
});

test('Audit Frontend: renderImageDiff renders rectangular preview for cover_url and handles states', () => {
  // null -> image
  const container = renderImageDiff(null, 'https://images.test/new-cover.jpg', { shape: 'rect' });
  const emptySide = container.querySelector('.audit-image-empty');
  assert.ok(emptySide, 'Must render empty state for null beforeUrl');
  assert.match(emptySide.textContent, /Без обложки/);

  const img = container.querySelector('img.audit-image-preview');
  assert.ok(img, 'Must render img element');
  assert.equal(img.src, 'https://images.test/new-cover.jpg');
  assert.ok(img.classList.contains('audit-image-cover'), 'Cover must have audit-image-cover class');
  assert.equal(img.referrerPolicy, 'no-referrer');
  assert.equal(img.loading, 'lazy');

  const link = container.querySelector('a[href="https://images.test/new-cover.jpg"]');
  assert.ok(link, 'Must have full HTTPS link');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(link.referrerPolicy, 'no-referrer');

  // image -> null
  const removedContainer = renderImageDiff('https://images.test/old-cover.jpg', null, { shape: 'rect' });
  assert.ok(removedContainer.querySelector('img.audit-image-cover'));
  assert.ok(removedContainer.querySelector('.audit-image-empty'));

  // Invalid URL must not become img src
  const evilContainer = renderImageDiff('javascript:alert(1)', 'http://insecure.test/pic.png', { shape: 'rect' });
  assert.equal(evilContainer.querySelectorAll('img').length, 0, 'No img element must be rendered for non-HTTPS URLs');
});

test('Audit Frontend: renderImageDiff renders circular preview for avatar_url', () => {
  const container = renderImageDiff('https://images.test/old-avatar.jpg', 'https://images.test/new-avatar.jpg', { shape: 'circle' });
  const images = container.querySelectorAll('img.audit-image-preview');
  assert.equal(images.length, 2);
  assert.ok(images[0].classList.contains('audit-image-avatar'), 'Avatar must have audit-image-avatar class');
  assert.ok(images[1].classList.contains('audit-image-avatar'), 'Avatar must have audit-image-avatar class');
});

test('Audit Frontend: renderTextDiff renders line-based additions and removals and protects against XSS', () => {
  const before = 'Первая строка\nВторая строка <script>alert("xss")</script>\nЧетвёртая строка';
  const after = 'Первая строка\nИзменённая строка\nТретья строка\nЧетвёртая строка';

  const container = renderTextDiff(before, after);
  const diffBox = container.querySelector('.audit-text-diff');
  assert.ok(diffBox);

  const addLines = container.querySelectorAll('.audit-diff-add');
  const removeLines = container.querySelectorAll('.audit-diff-remove');
  const contextLines = container.querySelectorAll('.audit-diff-context');

  assert.ok(addLines.length >= 1, 'Must have added lines');
  assert.ok(removeLines.length >= 1, 'Must have removed lines');
  assert.ok(contextLines.length >= 1, 'Must have context lines');

  // Verify XSS payload is strictly textContent, not executable HTML
  assert.equal(container.querySelectorAll('script').length, 0, 'Must never inject script tags');
  assert.match(container.textContent, /<script>alert\("xss"\)<\/script>/, 'Script tags must be plain text');
});

test('Audit Frontend: renderTextDiff displays truncation warning when content exceeds cap', () => {
  const normalContainer = renderTextDiff('Короткий текст', 'Новый текст', { before_truncated: false, after_truncated: false });
  assert.equal(normalContainer.querySelector('.audit-truncated-warning'), null);

  const truncatedContainer = renderTextDiff('Текст...', 'Новый текст...', {
    before_truncated: true,
    after_truncated: false,
    before_length: 125000,
    after_length: 80000,
  });
  const warning = truncatedContainer.querySelector('.audit-truncated-warning');
  assert.ok(warning, 'Warning must be displayed when truncated');
  assert.match(warning.textContent, /Показаны первые 100 000 символов/);
  assert.match(warning.textContent, /125000 символов/);
});

test('Audit Frontend: renderMarkdownImageChanges displays added and removed images', () => {
  const before = 'Текст с ![A](https://images.test/img-a.jpg) и ![B](https://images.test/img-b.jpg)';
  const after = 'Текст с ![A](https://images.test/img-a.jpg) и ![C](https://images.test/img-c.jpg)';

  const container = renderMarkdownImageChanges(before, after);
  assert.ok(container);

  assert.match(container.textContent, /Добавленные изображения \(1\)/);
  assert.match(container.textContent, /Удалённые изображения \(1\)/);

  const addedLink = container.querySelector('a[href="https://images.test/img-c.jpg"]');
  const removedLink = container.querySelector('a[href="https://images.test/img-b.jpg"]');
  assert.ok(addedLink);
  assert.ok(removedLink);
});

test('Audit Frontend: renderWordDiff highlights added and removed words for short text', () => {
  const container = renderWordDiff('Старый заголовок статьи', 'Новый заголовок статьи');
  const added = container.querySelector('.audit-word-add');
  const removed = container.querySelector('.audit-word-remove');

  assert.ok(added);
  assert.ok(removed);
  assert.equal(added.textContent, 'Новый');
  assert.equal(removed.textContent, 'Старый');
});

test('Audit Frontend: populateAuditDiffs handles profile, article, task, and image diffs', () => {
  const diffTable = document.createElement('div');

  // 1. Profile display_name change
  populateAuditDiffs(diffTable, {
    changed_fields: ['display_name'],
    before: { display_name: 'Старое Имя' },
    after: { display_name: 'Новое Имя' },
  });
  assert.equal(diffTable.querySelectorAll('.audit-diff-row').length, 1);
  assert.match(diffTable.textContent, /Отображаемое имя/);
  assert.ok(diffTable.querySelector('.audit-word-add'));
  assert.ok(diffTable.querySelector('.audit-word-remove'));

  // 2. Profile avatar change
  populateAuditDiffs(diffTable, {
    changed_fields: ['avatar_url'],
    before: { avatar_url: 'https://images.test/old.jpg' },
    after: { avatar_url: 'https://images.test/new.jpg' },
  });
  assert.ok(diffTable.querySelector('.audit-image-avatar'));

  // 3. Article body change with text_changes
  populateAuditDiffs(diffTable, {
    changed_fields: ['title', 'body'],
    before: { title: 'Старый заголовок' },
    after: { title: 'Новый заголовок' },
    text_changes: {
      body: {
        before: 'Старое тело статьи',
        after: 'Новое тело статьи',
        before_length: 18,
        after_length: 17,
        before_truncated: false,
        after_truncated: false,
      },
    },
  });
  assert.ok(diffTable.querySelector('.audit-text-diff'));
  assert.ok(diffTable.querySelector('.audit-word-diff'));
});
