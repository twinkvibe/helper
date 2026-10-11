import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import {
  parseTagInput, formatTagsInput, collectTags, filterPeople, sortEntries,
  entryMatches, entryTags, mediaPath, formatBytes, initials,
  normalizeFacts, groupEntriesByDay, dayKey, dayLabel, classifyUpload,
} from '../src/dossier-model.js';
import { mountDossier } from '../src/dossier.js';

function makeStubClient({ people = [], entries = [], links = [], personLinks = [] } = {}) {
  const tableData = {
    dossier_people: people,
    dossier_entries: entries,
    dossier_entry_people: links,
    dossier_person_links: personLinks,
  };
  const from = (table) => {
    const result = { data: tableData[table] || [], error: null };
    const chain = {
      select: () => chain,
      order: () => chain,
      eq: () => chain,
      neq: () => chain,
      insert: () => chain,
      update: () => chain,
      delete: () => chain,
      single: () => chain,
      then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
      catch: (reject) => Promise.resolve(result).catch(reject),
    };
    return chain;
  };
  const storage = {
    from: () => ({
      createSignedUrls: async (paths) => ({
        data: paths.map((p) => ({ path: p, signedUrl: `https://storage.example.test/${p}` })),
        error: null,
      }),
      upload: async () => ({ error: null }),
      remove: async () => ({ error: null }),
    }),
  };
  return { from, storage };
}

test('Dossier tag input normalizes, lowercases, dedupes and limits', () => {
  assert.deepEqual(parseTagInput('#Учёба, ссора; #Учёба  #долг'), ['учёба', 'ссора', 'долг']);
  assert.deepEqual(parseTagInput(''), []);
  assert.equal(parseTagInput(Array.from({ length: 30 }, (_, i) => `t${i}`).join(' ')).length, 20);
  assert.equal(formatTagsInput(['проект', 'идея']), '#проект #идея');
});

test('Dossier collects unique tags from people and entries', () => {
  const tags = collectTags(
    [{ tags: ['Учёба', 'друзья'] }],
    [{ tags: ['учёба', 'долг'] }],
  );
  assert.deepEqual(tags, ['долг', 'друзья', 'учёба']);
});

test('Dossier people filter matches name, alias, relation and bio', () => {
  const people = [
    { id: 'a', name: 'Костя', aliases: ['Константин'], relation: 'одногруппник', bio: 'любит спорить', tags: ['учёба'] },
    { id: 'b', name: 'Аня', aliases: [], relation: 'соседка', bio: '', tags: ['дом'] },
  ];
  assert.deepEqual(filterPeople(people, { query: 'констант' }).map(p => p.id), ['a']);
  assert.deepEqual(filterPeople(people, { query: 'спорить' }).map(p => p.id), ['a']);
  assert.deepEqual(filterPeople(people, { tag: 'дом' }).map(p => p.id), ['b']);
  assert.deepEqual(filterPeople(people, { query: '' }).map(p => p.id), ['a', 'b']);
});

test('Dossier entries sort by event date, falling back to creation date', () => {
  const entries = [
    { id: 'old', occurred_at: '2026-01-01T10:00:00.000Z', created_at: '2026-02-01T10:00:00.000Z' },
    { id: 'new', occurred_at: '2026-03-01T10:00:00.000Z', created_at: '2026-03-02T10:00:00.000Z' },
    { id: 'undated', occurred_at: null, created_at: '2026-04-01T10:00:00.000Z' },
  ];
  assert.deepEqual(sortEntries(entries).map(e => e.id), ['undated', 'new', 'old']);
});

test('Dossier entry search and tags combine explicit and Markdown tags', () => {
  const entry = { title: 'Ссора', body: 'Обсуждали #проект', tags: ['учёба'] };
  assert.equal(entryMatches(entry, 'ссора'), true);
  assert.equal(entryMatches(entry, 'проект'), true);
  assert.equal(entryMatches(entry, 'отпуск'), false);
  assert.equal(entryMatches(entry, ''), true);
  assert.deepEqual(entryTags(entry).sort(), ['проект', 'учёба']);
});

test('Dossier media path keeps the owner as first folder and sanitizes the filename', () => {
  const path = mediaPath('user-1', 'entry-2', 'Photo Shot!!.PNG', 'ab');
  const [owner, entry, file] = path.split('/');
  assert.equal(owner, 'user-1');
  assert.equal(entry, 'entry-2');
  assert.match(file, /^[a-z0-9]+-photo-shot-\.png$/);
  assert.ok(!path.includes(' '));

  // Cyrillic filenames never leak raw characters into the storage path.
  const cyrillic = mediaPath('user-1', 'entry-2', 'Фото Ссоры.png', 'cd').split('/')[2];
  assert.ok(!/[\u0400-\u04ff]/.test(cyrillic));
  assert.ok(cyrillic.endsWith('.png'));
});

test('Dossier upload classifier accepts images, video and docs within limits', () => {
  const file = (type, size) => ({ type, size, name: 'f' });
  assert.equal(classifyUpload(file('image/png', 100)), 'image');
  assert.equal(classifyUpload(file('image/jpeg', 5 * 1024 * 1024)), 'image');
  assert.equal(classifyUpload(file('video/mp4', 100)), 'video');
  assert.equal(classifyUpload(file('video/webm', 25 * 1024 * 1024)), 'video');
  assert.equal(classifyUpload(file('application/pdf', 100)), 'doc');
  assert.equal(classifyUpload(file('text/plain', 10 * 1024 * 1024)), 'doc');
  assert.throws(() => classifyUpload(file('image/png', 5 * 1024 * 1024 + 1)), /Фото до/);
  assert.throws(() => classifyUpload(file('video/mp4', 26 * 1024 * 1024)), /Видео/);
  assert.throws(() => classifyUpload(file('application/pdf', 11 * 1024 * 1024)), /Файлы/);
  assert.throws(() => classifyUpload(file('application/x-msdownload', 100)), /Принимаются/);
  assert.throws(() => classifyUpload(file('text/html', 100)), /Принимаются/);
  assert.throws(() => classifyUpload({ type: 'image/png', size: 0 }), /Пустой/);
});

test('Dossier byte and initials helpers', () => {
  assert.equal(formatBytes(0), '');
  assert.equal(formatBytes(900), '900 Б');
  assert.equal(formatBytes(2048), '2 КБ');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 МБ');
  assert.equal(initials('Костя'), 'КО');
  assert.equal(initials('Иван Петров'), 'ИП');
  assert.equal(initials(''), '?');
});

test('Dossier facts normalize: trims, drops empties, caps length and count', () => {
  assert.deepEqual(normalizeFacts([
    { key: '  Адрес ', value: ' ул. Ленина, 5 ' },
    { key: '', value: '' },
    { key: '', value: 'без названия, но со значением' },
    { key: 'x'.repeat(100), value: 'y'.repeat(900) },
  ]), [
    { key: 'Адрес', value: 'ул. Ленина, 5' },
    { key: '', value: 'без названия, но со значением' },
    { key: 'x'.repeat(60), value: 'y'.repeat(500) },
  ]);
  assert.deepEqual(normalizeFacts(null), []);
  assert.equal(normalizeFacts(Array.from({ length: 50 }, (_, i) => ({ key: `k${i}`, value: 'v' }))).length, 30);
});

test('Dossier groups entries by calendar day, newest day first', () => {
  const entries = [
    { id: 'a', occurred_at: '2026-10-02T23:30:00.000Z', created_at: '2026-10-03T00:00:00.000Z' },
    { id: 'b', occurred_at: null, created_at: '2026-10-05T10:00:00.000Z' },
    { id: 'c', occurred_at: '2026-10-05T08:00:00.000Z', created_at: '2026-10-05T09:00:00.000Z' },
    { id: 'd', occurred_at: null, created_at: null },
  ];
  const groups = groupEntriesByDay(entries);
  assert.ok(groups.length >= 2);
  // Undated group always last.
  assert.equal(groups[groups.length - 1].key, '');
  assert.equal(groups[groups.length - 1].label, 'Без даты');
  // Groups are ordered newest first.
  const dated = groups.filter(g => g.key);
  const keys = dated.map(g => g.key);
  assert.deepEqual(keys, [...keys].sort().reverse());
  assert.ok(dayKey('2026-10-05T10:00:00.000Z').startsWith('2026-10-'));
  assert.equal(dayKey(null), '');
  assert.match(dayLabel(''), /Без даты/);
});

test('Dossier migrations keep every table owner-only: RLS, no anon, private bucket', () => {
  const sql = ['supabase/migrations/20260924_dossier.sql', 'supabase/migrations/20260925_dossier_profile.sql']
    .map(f => fs.readFileSync(path.resolve(f), 'utf8')).join('\n');
  for (const table of ['dossier_people', 'dossier_entries', 'dossier_entry_people', 'dossier_person_links']) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`), `${table} must have RLS`);
    assert.match(sql, new RegExp(`revoke all on public\\.${table} from anon, authenticated`), `${table} must revoke anon`);
  }
  assert.doesNotMatch(sql, /grant\s+\S+\s+on\s+\S+\s+to\s+anon/, 'Dossier must never grant to anon');
  assert.match(sql, /not blocked and not must_change_password/, 'Dossier RLS must check the active profile');
  assert.match(sql, /'dossier-media', 'dossier-media', false/, 'Dossier bucket must stay private');
  assert.match(sql, /jsonb_typeof\(facts\) = 'array'/, 'Facts column must be constrained to an array');
});

test('DB schema: supabase/schema.sql is in sync with dossier profile migration', () => {
  const schema = fs.readFileSync(path.resolve('supabase/schema.sql'), 'utf8');
  assert.match(schema, /avatar_path/);
  assert.match(schema, /relationship text not null default ''/);
  assert.match(schema, /jsonb_typeof\(facts\) = 'array'/);
  assert.match(schema, /create table public\.dossier_person_links/);
  assert.match(schema, /person_id <> linked_person_id/);
  assert.match(schema, /Active users manage own dossier person links/);
});

test('Dossier UI renders people, entries and links from the backend', async () => {
  const dom = new JSDOM('<section id="app"></section>', { url: 'https://example.test/dossier' });
  const names = ['window', 'document', 'localStorage', 'navigator'];
  const previous = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, navigator: dom.window.navigator })) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  try {
    const host = document.querySelector('#app');
    const client = makeStubClient({
      people: [
        { id: 'p1', name: 'Костя', aliases: ['Константин'], relation: 'одногруппник', relationship: 'натянутые', tags: ['учёба'], bio: '', facts: [{ key: 'Адрес', value: 'ул. Ленина, 5' }], avatar_path: 'u1/avatars/k.jpg' },
        { id: 'p2', name: 'Аня', aliases: [], relation: 'соседка', relationship: '', tags: [], bio: '', facts: [], avatar_path: null },
      ],
      entries: [
        { id: 'e1', title: 'Ссора на паре', body: 'Обсуждали **проект**', occurred_at: '2026-05-02T10:00:00.000Z', tags: ['ссора'], attachments: [{ path: 'u1/e1/v.mp4', name: 'Запись', type: 'video/mp4', size: 1000 }], created_at: '2026-05-02T10:00:00.000Z' },
        { id: 'e2', title: 'Чай после пар', body: 'Помирились', occurred_at: '2026-05-04T10:00:00.000Z', tags: [], attachments: [], created_at: '2026-05-04T10:00:00.000Z' },
      ],
      links: [{ entry_id: 'e1', person_id: 'p1' }, { entry_id: 'e2', person_id: 'p1' }],
      personLinks: [{ person_id: 'p1', linked_person_id: 'p2', label: 'одногруппница' }],
    });
    mountDossier(host, { client, userId: 'u1', requireSession: async () => true });
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    const text = host.textContent;
    assert.match(text, /Досье/);
    assert.match(text, /Костя/);
    assert.match(text, /одногруппник/);
    assert.match(text, /Ссора на паре/);
    // Entry body is rendered as sanitized Markdown.
    assert.ok(host.querySelector('.dossier-entry-body strong'));
    // Avatar image renders from the signed URL right in the sidebar.
    assert.ok(host.querySelector('img.dossier-person-avatar'), 'Avatar image must render from signed URL');
    // Video attachment renders a player, entries group by day.
    assert.ok(host.querySelector('video.dossier-video'), 'Video attachment must render a player');
    assert.equal(host.querySelectorAll('.dossier-day-label').length, 2, 'Entries must group by day');
    // Open the person card: relationship status, facts and linked people render.
    const kostyaBtn = [...host.querySelectorAll('.dossier-person')].find(b => b.textContent.includes('Костя'));
    assert.ok(kostyaBtn, 'Person button must exist');
    kostyaBtn.click();
    assert.match(host.querySelector('.dossier-relationship').textContent, /натянутые/);
    assert.equal(host.querySelector('.dossier-facts dt').textContent, 'Адрес');
    assert.match(host.querySelector('.dossier-facts dd').textContent, /Ленина/);
    assert.match(host.querySelector('.dossier-links').textContent, /Аня/);
  } finally {
    for (const name of names) {
      const descriptor = previous[name];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    }
  }
});

test('Dossier UI explains a missing migration instead of crashing', async () => {
  const dom = new JSDOM('<section id="app"></section>', { url: 'https://example.test/dossier' });
  const names = ['window', 'document', 'localStorage', 'navigator'];
  const previous = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, navigator: dom.window.navigator })) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  try {
    const host = document.querySelector('#app');
    const missingTable = () => {
      const chain = {};
      chain.select = () => chain; chain.order = () => chain;
      chain.then = (resolve) => Promise.resolve({ data: null, error: { code: '42P01', message: 'relation does not exist' } }).then(resolve);
      return chain;
    };
    mountDossier(host, { client: { from: missingTable }, userId: 'u1', requireSession: async () => true });
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(host.textContent, /20260924_dossier\.sql/);
  } finally {
    for (const name of names) {
      const descriptor = previous[name];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    }
  }
});
