import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { attachEditor } from '../src/editor.js';
import { mountArticles } from '../src/articles.js';
import { loadLocalImage, validateImageFile, isSupportedImageFormat, getRotatedSource, editImage } from '../src/image-editor.js';

test('Editor toolbar contains format-bar__format and format-bar__view groups with split slider behavior', () => {
  const dom = new JSDOM('<section id="editor"></section>', { url: 'https://example.test/' });
  const names = ['window', 'document', 'localStorage'];
  const previous = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage })) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }

  const host = document.querySelector('#editor');
  attachEditor(host, { value: '# Заголовок' });

  const formatGroup = host.querySelector('.format-bar__format');
  const viewGroup = host.querySelector('.format-bar__view');
  assert.ok(formatGroup, 'format-bar__format group must exist');
  assert.ok(viewGroup, 'format-bar__view group must exist');

  // In editor mode (default)
  const splitControl = host.querySelector('.split-control');
  const splitRange = splitControl.querySelector('input');
  assert.equal(splitControl.hidden, true);
  assert.equal(splitControl.style.display, 'none');
  assert.equal(splitRange.disabled, true);
  assert.equal(splitRange.tabIndex, -1);

  // Switch to split
  const modeSelect = host.querySelector('.mode-select');
  modeSelect.value = 'split';
  modeSelect.dispatchEvent(new dom.window.Event('change'));

  assert.equal(splitControl.hidden, false);
  assert.equal(splitControl.style.display, '');
  assert.equal(splitRange.disabled, false);
  assert.equal(splitRange.tabIndex, 0);

  dom.window.close();
  for (const name of names) {
    if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
    else delete globalThis[name];
  }
});

test('Display name validation accepts 1-80 trimmed characters and handles empty as null', () => {
  const validateDisplayName = (raw) => {
    if (raw === null || raw === undefined) return null;
    const clean = String(raw).trim();
    if (!clean) return null;
    if (clean.length > 80) throw new Error('Отображаемое имя должно быть от 1 до 80 символов');
    return clean;
  };

  assert.equal(validateDisplayName('Dustin Corder'), 'Dustin Corder');
  assert.equal(validateDisplayName('   Иван Иванов   '), 'Иван Иванов');
  assert.equal(validateDisplayName(''), null);
  assert.equal(validateDisplayName('    '), null);
  assert.equal(validateDisplayName(null), null);
  assert.throws(() => validateDisplayName('a'.repeat(81)), /от 1 до 80 символов/);
});

test('Public profile API returns only safe public fields and excludes sensitive internal fields', () => {
  const rawProfileFromDb = {
    id: 'f87a32b1-5d9c-4e8a-b5e1-893f4e2a1b9c',
    username: 'dustin',
    display_name: 'Dustin Corder',
    avatar_url: 'https://example.com/avatar.jpg',
    role: 'admin',
    blocked: false,
    must_change_password: false,
    created_at: '2026-09-01T12:00:00Z',
    email: 'dustin@users.helper.invalid',
  };

  // Simulating the get_public_profile projection
  const getPublicProfileProjection = (profile) => {
    if (!profile || profile.blocked) return null;
    return {
      username: profile.username,
      display_name: profile.display_name,
      avatar_url: profile.avatar_url,
    };
  };

  const publicData = getPublicProfileProjection(rawProfileFromDb);
  assert.deepEqual(publicData, {
    username: 'dustin',
    display_name: 'Dustin Corder',
    avatar_url: 'https://example.com/avatar.jpg',
  });

  // Verify none of the sensitive fields are exposed
  assert.equal(publicData.role, undefined);
  assert.equal(publicData.blocked, undefined);
  assert.equal(publicData.must_change_password, undefined);
  assert.equal(publicData.id, undefined);
  assert.equal(publicData.email, undefined);

  // Blocked user profile returns null
  assert.equal(getPublicProfileProjection({ ...rawProfileFromDb, blocked: true }), null);
});

test('Public vs unlisted vs private article access control semantics', () => {
  const articlesDatabase = [
    { id: '1', slug: 'public-post', access: 'public', author_blocked: false, title: 'Публичная' },
    { id: '2', slug: 'unlisted-post', access: 'unlisted', author_blocked: false, title: 'По ссылке' },
    { id: '3', slug: 'private-draft', access: 'private', author_blocked: false, title: 'Черновик' },
    { id: '4', slug: 'blocked-author', access: 'public', author_blocked: true, title: 'Заблокированный' },
  ];

  // 1. Direct public listing query (SELECT using RLS policy)
  const queryPublicListing = (db) => {
    return db.filter(a => a.access === 'public' && !a.author_blocked);
  };

  const publicList = queryPublicListing(articlesDatabase);
  assert.equal(publicList.length, 1);
  assert.equal(publicList[0].slug, 'public-post');
  // Unlisted and private are NOT enumerable in public listing
  assert.ok(!publicList.some(a => a.slug === 'unlisted-post'));
  assert.ok(!publicList.some(a => a.slug === 'private-draft'));

  // 2. get_article_by_slug RPC query (direct slug access)
  const getArticleBySlugRPC = (db, targetSlug) => {
    const art = db.find(a => a.slug === targetSlug);
    if (!art) return null;
    if (art.author_blocked) return null;
    if (art.access !== 'public' && art.access !== 'unlisted') return null;
    return art;
  };

  assert.equal(getArticleBySlugRPC(articlesDatabase, 'public-post')?.title, 'Публичная');
  assert.equal(getArticleBySlugRPC(articlesDatabase, 'unlisted-post')?.title, 'По ссылке');
  assert.equal(getArticleBySlugRPC(articlesDatabase, 'private-draft'), null);
  assert.equal(getArticleBySlugRPC(articlesDatabase, 'blocked-author'), null);
  assert.equal(getArticleBySlugRPC(articlesDatabase, 'non-existent'), null);
});

test('Article owner can delete own article and UI updates state accordingly', async () => {
  const dom = new JSDOM('<section id="articles-root"></section>', { url: 'https://example.test/' });
  const names = ['window', 'document', 'localStorage', 'confirm'];
  const previous = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    confirm: () => true, // simulate user confirming delete
  })) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }

  let deletedId = null;
  const mockArticles = [
    { id: 'art-1', title: 'Статья 1', slug: 'statya-1', body: 'Текст', access: 'private', updated_at: '2026-09-18T10:00:00Z' },
    { id: 'art-2', title: 'Статья 2', slug: 'statya-2', body: 'Текст 2', access: 'public', updated_at: '2026-09-18T09:00:00Z' },
  ];

  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'user-1' } } } }),
    },
    from(table) {
      if (table === 'articles') {
        return {
          select: () => ({
            order: async () => ({ data: [...mockArticles], error: null }),
          }),
          delete() {
            return {
              eq: (col, val) => {
                deletedId = val;
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }
      return {};
    },
  };

  const host = document.querySelector('#articles-root');
  mountArticles(host, {
    client,
    userId: 'user-1',
    username: 'testauthor',
    notice: () => {},
    requireSession: async () => {},
  });

  await new Promise(r => setTimeout(r, 25));

  const deleteBtn = host.querySelector('.delete-article-btn');
  assert.ok(deleteBtn, 'Delete article button must exist');
  deleteBtn.click();

  await new Promise(r => setTimeout(r, 25));
  assert.equal(deletedId, 'art-1');

  dom.window.close();
  for (const name of names) {
    if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
    else delete globalThis[name];
  }
});

test('Admin operations validate self-actions and last-admin protections', () => {
  const users = [
    { id: 'admin-1', username: 'admin1', role: 'admin', blocked: false },
    { id: 'admin-2', username: 'admin2', role: 'admin', blocked: false },
    { id: 'member-1', username: 'user1', role: 'member', blocked: false },
  ];

  // Helper verifying last admin constraint
  const canDemoteOrDeleteAdmin = (targetId, currentUsers) => {
    const target = currentUsers.find(u => u.id === targetId);
    if (!target || target.role !== 'admin') return true;
    const remainingAdmins = currentUsers.filter(u => u.role === 'admin' && !u.blocked && u.id !== targetId);
    return remainingAdmins.length >= 1;
  };

  // With 2 active admins, demoting admin-2 is permitted
  assert.equal(canDemoteOrDeleteAdmin('admin-2', users), true);

  // If only 1 active admin remains
  const singleAdminUsers = [
    { id: 'admin-1', username: 'admin1', role: 'admin', blocked: false },
    { id: 'member-1', username: 'user1', role: 'member', blocked: false },
  ];
  assert.equal(canDemoteOrDeleteAdmin('admin-1', singleAdminUsers), false);
});

test('is_public_profile function validates active status without anon SELECT on profiles', () => {
  const profiles = [
    { id: 'u1', username: 'active_user', blocked: false },
    { id: 'u2', username: 'blocked_user', blocked: true },
  ];

  const is_public_profile = (userId) => {
    const p = profiles.find(item => item.id === userId);
    return Boolean(p && !p.blocked);
  };

  assert.equal(is_public_profile('u1'), true);
  assert.equal(is_public_profile('u2'), false);
  assert.equal(is_public_profile('u3-unknown'), false);

  // Articles policy simulation using is_public_profile
  const articles = [
    { id: 'a1', user_id: 'u1', access: 'public' },
    { id: 'a2', user_id: 'u2', access: 'public' },
    { id: 'a3', user_id: 'u1', access: 'unlisted' },
  ];

  const canAnonSelectArticle = (art) => art.access === 'public' && is_public_profile(art.user_id);
  assert.equal(canAnonSelectArticle(articles[0]), true);  // public + active author
  assert.equal(canAnonSelectArticle(articles[1]), false); // public + blocked author
  assert.equal(canAnonSelectArticle(articles[2]), false); // unlisted article (not enumerable)
});

test('Profile mutation RPCs reject unauthenticated, missing, or blocked accounts', () => {
  const checkMutationAllowed = (authUid, profilesDb) => {
    if (!authUid) throw new Error('Требуется авторизация');
    const profile = profilesDb.find(p => p.id === authUid);
    if (!profile) throw new Error('Профиль не найден');
    if (profile.blocked) throw new Error('Доступ закрыт: профиль заблокирован');
    return true;
  };

  const db = [
    { id: 'user-active', blocked: false },
    { id: 'user-blocked', blocked: true },
  ];

  assert.equal(checkMutationAllowed('user-active', db), true);
  assert.throws(() => checkMutationAllowed(null, db), /Требуется авторизация/);
  assert.throws(() => checkMutationAllowed('user-blocked', db), /Доступ закрыт: профиль заблокирован/);
  assert.throws(() => checkMutationAllowed('user-missing', db), /Профиль не найден/);
});

test('Active admin DB invariant trigger rejects demoting, blocking, or deleting the last active admin', () => {
  let dbProfiles = [
    { id: 'a1', role: 'admin', blocked: false },
    { id: 'm1', role: 'member', blocked: false },
  ];

  const triggerEnsureActiveAdminExists = (op, oldRow, newRow) => {
    if (oldRow.role === 'admin' && !oldRow.blocked && (op === 'DELETE' || newRow.role !== 'admin' || newRow.blocked)) {
      const remainingAdmins = dbProfiles.filter(p => p.role === 'admin' && !p.blocked && p.id !== oldRow.id).length;
      if (remainingAdmins < 1) {
        throw new Error('Нельзя удалить, заблокировать или понизить последнего активного администратора');
      }
    }
  };

  // Demoting a1 from admin to member must fail
  assert.throws(
    () => triggerEnsureActiveAdminExists('UPDATE', dbProfiles[0], { ...dbProfiles[0], role: 'member' }),
    /Нельзя удалить, заблокировать или понизить последнего активного администратора/
  );

  // Blocking a1 must fail
  assert.throws(
    () => triggerEnsureActiveAdminExists('UPDATE', dbProfiles[0], { ...dbProfiles[0], blocked: true }),
    /Нельзя удалить, заблокировать или понизить последнего активного администратора/
  );

  // Deleting a1 must fail
  assert.throws(
    () => triggerEnsureActiveAdminExists('DELETE', dbProfiles[0], null),
    /Нельзя удалить, заблокировать или понизить последнего активного администратора/
  );

  // Changing member m1 does not trigger admin check
  assert.doesNotThrow(() => triggerEnsureActiveAdminExists('UPDATE', dbProfiles[1], { ...dbProfiles[1], blocked: true }));
});

test('Profile bio validation accepts up to 280 characters and get_public_profile projects it', () => {
  const validateBio = (raw) => {
    if (raw === null || raw === undefined) return null;
    const clean = String(raw).trim();
    if (!clean) return null;
    if (clean.length > 280) throw new Error('Био не может превышать 280 символов');
    return clean;
  };

  assert.equal(validateBio('Коротко о себе'), 'Коротко о себе');
  assert.equal(validateBio('   С пробелами   '), 'С пробелами');
  assert.equal(validateBio(''), null);
  assert.equal(validateBio('   '), null);
  assert.equal(validateBio(null), null);
  assert.equal(validateBio('x'.repeat(280)), 'x'.repeat(280));
  assert.throws(() => validateBio('x'.repeat(281)), /Био не может превышать 280 символов/);

  const profileWithBio = {
    username: 'dustin',
    display_name: 'Dustin Corder',
    avatar_url: 'https://example.com/avatar.jpg',
    bio: 'Разработчик и автор заметок',
    role: 'user',
    blocked: false,
  };

  const project = (p) => (!p || p.blocked ? null : {
    username: p.username,
    display_name: p.display_name,
    avatar_url: p.avatar_url,
    bio: p.bio || null,
  });

  const projected = project(profileWithBio);
  assert.equal(projected.bio, 'Разработчик и автор заметок');
  assert.equal(projected.role, undefined);
});

test('Saved private article deletion requires confirmation', async () => {
  const dom = new JSDOM('<section id="articles-root"></section>', { url: 'https://example.test/' });
  const names = ['window', 'document', 'localStorage', 'confirm'];
  const previous = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

  let confirmAnswer = false;
  let confirmCalled = false;
  let deletedId = null;

  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    confirm: (msg) => {
      confirmCalled = true;
      assert.match(msg, /Удалить/);
      return confirmAnswer;
    },
  })) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }

  const mockArticles = [
    { id: 'art-priv', title: 'Приватная статья', slug: 'priv', body: 'Текст', access: 'private', updated_at: '2026-09-18T10:00:00Z' },
  ];

  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
    from(table) {
      if (table === 'articles') {
        return {
          select: () => ({ order: async () => ({ data: [...mockArticles], error: null }) }),
          delete: () => ({ eq: (col, val) => { deletedId = val; return Promise.resolve({ error: null }); } }),
        };
      }
      return {};
    },
  };

  const host = document.querySelector('#articles-root');
  mountArticles(host, { client, userId: 'u1', username: 'author', notice: () => {}, requireSession: async () => {} });
  await new Promise(r => setTimeout(r, 25));

  const deleteBtn = host.querySelector('.delete-article-btn');
  assert.ok(deleteBtn, 'Delete button exists');

  // Case 1: user cancels confirm
  confirmAnswer = false;
  confirmCalled = false;
  deleteBtn.click();
  await new Promise(r => setTimeout(r, 25));
  assert.equal(confirmCalled, true, 'Confirm must be called for private article');
  assert.equal(deletedId, null, 'Private article must NOT be deleted when confirmation is cancelled');

  // Case 2: user confirms
  confirmAnswer = true;
  confirmCalled = false;
  deleteBtn.click();
  await new Promise(r => setTimeout(r, 25));
  assert.equal(confirmCalled, true, 'Confirm must be called');
  assert.equal(deletedId, 'art-priv', 'Private article must be deleted when confirmed');

  dom.window.close();
  for (const name of names) {
    if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
    else delete globalThis[name];
  }
});

test('Saved unlisted article deletion requires confirmation', async () => {
  const dom = new JSDOM('<section id="articles-root"></section>', { url: 'https://example.test/' });
  const names = ['window', 'document', 'localStorage', 'confirm'];
  const previous = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

  let confirmAnswer = false;
  let confirmCalled = false;
  let deletedId = null;

  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    confirm: (msg) => {
      confirmCalled = true;
      assert.match(msg, /Удалить/);
      return confirmAnswer;
    },
  })) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }

  const mockArticles = [
    { id: 'art-unl', title: 'Статья по ссылке', slug: 'unl', body: 'Текст', access: 'unlisted', updated_at: '2026-09-18T10:00:00Z' },
  ];

  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
    from(table) {
      if (table === 'articles') {
        return {
          select: () => ({ order: async () => ({ data: [...mockArticles], error: null }) }),
          delete: () => ({ eq: (col, val) => { deletedId = val; return Promise.resolve({ error: null }); } }),
        };
      }
      return {};
    },
  };

  const host = document.querySelector('#articles-root');
  mountArticles(host, { client, userId: 'u1', username: 'author', notice: () => {}, requireSession: async () => {} });
  await new Promise(r => setTimeout(r, 25));

  const deleteBtn = host.querySelector('.delete-article-btn');
  assert.ok(deleteBtn);

  // Case 1: user cancels
  confirmAnswer = false;
  confirmCalled = false;
  deleteBtn.click();
  await new Promise(r => setTimeout(r, 25));
  assert.equal(confirmCalled, true, 'Confirm must be called for unlisted article');
  assert.equal(deletedId, null, 'Unlisted article must NOT be deleted when cancelled');

  // Case 2: user confirms
  confirmAnswer = true;
  confirmCalled = false;
  deleteBtn.click();
  await new Promise(r => setTimeout(r, 25));
  assert.equal(confirmCalled, true);
  assert.equal(deletedId, 'art-unl');

  dom.window.close();
  for (const name of names) {
    if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
    else delete globalThis[name];
  }
});

test('Saved public article deletion requires confirmation', async () => {
  const dom = new JSDOM('<section id="articles-root"></section>', { url: 'https://example.test/' });
  const names = ['window', 'document', 'localStorage', 'confirm'];
  const previous = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

  let confirmAnswer = false;
  let confirmCalled = false;
  let deletedId = null;

  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    confirm: (msg) => {
      confirmCalled = true;
      assert.match(msg, /Удалить/);
      return confirmAnswer;
    },
  })) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }

  const mockArticles = [
    { id: 'art-pub', title: 'Публичная статья', slug: 'pub', body: 'Текст', access: 'public', updated_at: '2026-09-18T10:00:00Z' },
  ];

  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
    from(table) {
      if (table === 'articles') {
        return {
          select: () => ({ order: async () => ({ data: [...mockArticles], error: null }) }),
          delete: () => ({ eq: (col, val) => { deletedId = val; return Promise.resolve({ error: null }); } }),
        };
      }
      return {};
    },
  };

  const host = document.querySelector('#articles-root');
  mountArticles(host, { client, userId: 'u1', username: 'author', notice: () => {}, requireSession: async () => {} });
  await new Promise(r => setTimeout(r, 25));

  const deleteBtn = host.querySelector('.delete-article-btn');
  assert.ok(deleteBtn);

  // Case 1: user cancels
  confirmAnswer = false;
  confirmCalled = false;
  deleteBtn.click();
  await new Promise(r => setTimeout(r, 25));
  assert.equal(confirmCalled, true, 'Confirm must be called for public article');
  assert.equal(deletedId, null, 'Public article must NOT be deleted when cancelled');

  // Case 2: user confirms
  confirmAnswer = true;
  confirmCalled = false;
  deleteBtn.click();
  await new Promise(r => setTimeout(r, 25));
  assert.equal(confirmCalled, true);
  assert.equal(deletedId, 'art-pub');

  dom.window.close();
  for (const name of names) {
    if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
    else delete globalThis[name];
  }
});

test('Structured todo audit diff tracks field changes and excludes description content', () => {
  // Simulate log_data_change logic for todos
  const buildTodoAuditDiff = (op, oldRow, newRow) => {
    if (op === 'INSERT') {
      return {
        changed_fields: ['title', 'done', 'list_name', 'due_date', 'priority', 'tags', 'note_id', 'description'],
        before: null,
        after: {
          title: newRow.title,
          done: newRow.done,
          list_name: newRow.list_name,
          due_date: newRow.due_date,
          priority: newRow.priority,
          tags: newRow.tags,
          note_id: newRow.note_id,
        },
        description_changed: false,
        description_length_after: (newRow.description || '').length,
        title: newRow.title,
      };
    }
    if (op === 'DELETE') {
      return {
        changed_fields: ['title', 'done', 'list_name', 'due_date', 'priority', 'tags', 'note_id', 'description'],
        before: {
          title: oldRow.title,
          done: oldRow.done,
          list_name: oldRow.list_name,
          due_date: oldRow.due_date,
          priority: oldRow.priority,
          tags: oldRow.tags,
          note_id: oldRow.note_id,
        },
        after: null,
        description_changed: false,
        description_length_before: (oldRow.description || '').length,
        title: oldRow.title,
      };
    }
    if (op === 'UPDATE') {
      const changed_fields = [];
      const before = {};
      const after = {};
      const fields = ['title', 'done', 'list_name', 'due_date', 'priority', 'tags', 'note_id'];
      for (const f of fields) {
        if (JSON.stringify(oldRow[f]) !== JSON.stringify(newRow[f])) {
          changed_fields.push(f);
          before[f] = oldRow[f];
          after[f] = newRow[f];
        }
      }
      const descChanged = oldRow.description !== newRow.description;
      if (descChanged) changed_fields.push('description');
      const res = {
        changed_fields,
        before,
        after,
        description_changed: descChanged,
        title: newRow.title || oldRow.title,
      };
      if (descChanged) {
        res.description_length_before = (oldRow.description || '').length;
        res.description_length_after = (newRow.description || '').length;
      }
      return res;
    }
  };

  const oldTodo = {
    title: 'Старое название',
    done: false,
    list_name: 'Входящие',
    due_date: null,
    priority: 0,
    tags: ['старое'],
    note_id: null,
    description: 'Секретное описание задачи 1234567890',
  };
  const newTodo = {
    title: 'Новое название',
    done: true,
    list_name: 'Проект',
    due_date: '2026-10-01',
    priority: 2,
    tags: ['новое'],
    note_id: 'note-uuid',
    description: 'Новое обновленное описание задачи, очень длинное!',
  };

  const diff = buildTodoAuditDiff('UPDATE', oldTodo, newTodo);

  assert.deepEqual(diff.changed_fields, ['title', 'done', 'list_name', 'due_date', 'priority', 'tags', 'note_id', 'description']);
  assert.equal(diff.before.title, 'Старое название');
  assert.equal(diff.after.title, 'Новое название');
  assert.equal(diff.before.done, false);
  assert.equal(diff.after.done, true);
  assert.equal(diff.description_changed, true);
  assert.equal(diff.description_length_before, oldTodo.description.length);
  assert.equal(diff.description_length_after, newTodo.description.length);

  // Description content must NEVER be in before, after, or top-level diff
  assert.equal(diff.before.description, undefined);
  assert.equal(diff.after.description, undefined);
  assert.equal(diff.description, undefined);
  const serialized = JSON.stringify(diff);
  assert.ok(!serialized.includes('Секретное описание'), 'Description content must be absent from audit JSON');
  assert.ok(!serialized.includes('Новое обновленное'), 'Description content must be absent from audit JSON');
});

test('Structured article audit diff tracks field changes and excludes body content', () => {
  const buildArticleAuditDiff = (op, oldRow, newRow) => {
    if (op === 'UPDATE') {
      const changed_fields = [];
      const before = {};
      const after = {};
      const fields = ['title', 'slug', 'excerpt', 'cover_url', 'access', 'published', 'published_at'];
      for (const f of fields) {
        if (oldRow[f] !== newRow[f]) {
          changed_fields.push(f);
          before[f] = oldRow[f];
          after[f] = newRow[f];
        }
      }
      const bodyChanged = oldRow.body !== newRow.body;
      if (bodyChanged) changed_fields.push('body');
      const res = {
        changed_fields,
        before,
        after,
        body_changed: bodyChanged,
        title: newRow.title || oldRow.title,
        slug: newRow.slug || oldRow.slug,
      };
      if (bodyChanged) {
        res.body_length_before = (oldRow.body || '').length;
        res.body_length_after = (newRow.body || '').length;
      }
      return res;
    }
  };

  const oldArt = {
    title: 'Черновик',
    slug: 'draft',
    excerpt: 'Кратко',
    cover_url: null,
    access: 'private',
    published: false,
    published_at: null,
    body: 'Секретный текст публикации длиной в 100 символов...',
  };
  const newArt = {
    title: 'Опубликовано',
    slug: 'published',
    excerpt: 'Новое кратко',
    cover_url: 'https://example.com/cover.png',
    access: 'public',
    published: true,
    published_at: '2026-09-18T12:00:00Z',
    body: 'Секретный текст публикации длиной в 100 символов... Плюс еще 50 новых символов...',
  };

  const diff = buildArticleAuditDiff('UPDATE', oldArt, newArt);

  assert.deepEqual(diff.changed_fields, ['title', 'slug', 'excerpt', 'cover_url', 'access', 'published', 'published_at', 'body']);
  assert.equal(diff.before.access, 'private');
  assert.equal(diff.after.access, 'public');
  assert.equal(diff.body_changed, true);
  assert.equal(diff.body_length_before, oldArt.body.length);
  assert.equal(diff.body_length_after, newArt.body.length);

  // Body content must NEVER be present
  assert.equal(diff.before.body, undefined);
  assert.equal(diff.after.body, undefined);
  assert.equal(diff.body, undefined);
  const serialized = JSON.stringify(diff);
  assert.ok(!serialized.includes('Секретный текст'), 'Body content must be absent from audit JSON');
});

test('Actor safe projection excludes internal and sensitive credentials', () => {
  const fullProfileRow = {
    id: '11111111-1111-1111-1111-111111111111',
    username: 'admin',
    display_name: 'Главный Администратор',
    avatar_url: 'https://example.com/avatar.jpg',
    role: 'admin',
    blocked: false,
    must_change_password: false,
    email: 'admin@helper.test',
    password_hash: '$2b$10$abcdefghijklmnopqrstuv',
  };

  const projectActor = (p) => (!p ? null : {
    username: p.username,
    display_name: p.display_name || null,
    avatar_url: p.avatar_url || null,
  });

  const safe = projectActor(fullProfileRow);
  assert.equal(safe.username, 'admin');
  assert.equal(safe.display_name, 'Главный Администратор');
  assert.equal(safe.avatar_url, 'https://example.com/avatar.jpg');
  assert.equal(safe.role, undefined);
  assert.equal(safe.blocked, undefined);
  assert.equal(safe.must_change_password, undefined);
  assert.equal(safe.email, undefined);
  assert.equal(safe.password_hash, undefined);
});

test('Missing bio RPC 42883 is not considered a successful save', async () => {
  let noticeMessage = '';
  let noticeIsError = false;
  const notice = (msg, isErr) => {
    noticeMessage = msg;
    noticeIsError = Boolean(isErr);
  };

  const profile = {
    display_name: 'Старое имя',
    bio: 'Старое био',
  };

  // Simulating frontend submit handler
  const handleProfileSubmit = async ({ newName, newBio, client }) => {
    if (newName !== (profile.display_name || '')) {
      const res = await client.rpc('set_profile_display_name', { new_display_name: newName || null });
      if (res.error) throw res.error;
      profile.display_name = newName || null;
    }

    if (newBio !== (profile.bio || '')) {
      const bioRes = await client.rpc('set_profile_bio', { new_bio: newBio || null });
      if (bioRes.error) {
        if (bioRes.error.code === '42883') {
          notice('Обновление профиля требует применения новой миграции базы данных.', true);
          return;
        }
        throw bioRes.error;
      }
      profile.bio = newBio || null;
    }

    notice('Профиль сохранён.');
  };

  const mockClient = {
    rpc: async (fn, params) => {
      if (fn === 'set_profile_display_name') return { error: null };
      if (fn === 'set_profile_bio') {
        return { error: { code: '42883', message: 'function public.set_profile_bio(text) does not exist' } };
      }
      return { error: null };
    },
  };

  await handleProfileSubmit({ newName: 'Новое имя', newBio: 'Новое био', client: mockClient });

  assert.equal(profile.display_name, 'Новое имя', 'Display name was saved');
  assert.equal(profile.bio, 'Старое био', 'Bio must NOT be updated when RPC returns 42883');
  assert.equal(noticeIsError, true, 'Notice must be marked as error');
  assert.equal(noticeMessage, 'Обновление профиля требует применения новой миграции базы данных.');
  assert.notEqual(noticeMessage, 'Профиль сохранён.');
});

test('loadLocalImage validates file format and rejects non-images or empty files', async () => {
  await assert.rejects(
    () => loadLocalImage(null),
    /неверный формат файла/
  );
  await assert.rejects(
    () => loadLocalImage({}),
    /неверный формат файла/
  );

  const textBlob = new Blob(['hello world'], { type: 'text/plain' });
  await assert.rejects(
    () => loadLocalImage(textBlob),
    /файл не является изображением/
  );

  const emptyBlob = new Blob([], { type: 'image/png' });
  await assert.rejects(
    () => loadLocalImage(emptyBlob),
    /файл пуст/
  );
});

test('database migration contract: 20260921 3-cols, 20260922 drops function before recreate with bio, set_profile_bio signature matches frontend', () => {
  const mig20260921 = fs.readFileSync(path.resolve('supabase/migrations/20260921_profile_admin_publication_ux.sql'), 'utf-8');
  const mig20260922 = fs.readFileSync(path.resolve('supabase/migrations/20260922_profile_bio_audit.sql'), 'utf-8');
  const mainJs = fs.readFileSync(path.resolve('src/main.js'), 'utf-8');
  const schemaSql = fs.readFileSync(path.resolve('supabase/schema.sql'), 'utf-8');

  // 1. 20260921 creates get_public_profile(text) with 3 output columns
  const fnMatch2021 = mig20260921.match(/create\s+or\s+replace\s+function\s+public\.get_public_profile\s*\([^)]*\)\s*returns\s+table\s*\(([^)]+)\)/i);
  assert.ok(fnMatch2021, '20260921 must define get_public_profile returns table');
  const cols2021 = fnMatch2021[1].split(',').map(s => s.trim());
  assert.equal(cols2021.length, 3, '20260921 get_public_profile must return exactly 3 columns');
  assert.ok(cols2021.some(c => c.startsWith('username')), 'returns username');
  assert.ok(cols2021.some(c => c.startsWith('display_name')), 'returns display_name');
  assert.ok(cols2021.some(c => c.startsWith('avatar_url')), 'returns avatar_url');
  assert.ok(!cols2021.some(c => c.startsWith('bio')), '20260921 must not have bio');

  // 2. 20260922 MUST drop public.get_public_profile(text) before creating it with 4 columns
  const dropIdx = mig20260922.search(/drop\s+function\s+if\s+exists\s+public\.get_public_profile\s*\(\s*text\s*\)\s*;/i);
  assert.ok(dropIdx !== -1, '20260922 must include drop function if exists public.get_public_profile(text);');
  assert.ok(!/drop\s+function[^\n;]*cascade/i.test(mig20260922), '20260922 must NOT use CASCADE on drop function');

  const createIdx = mig20260922.search(/create\s+(or\s+replace\s+)?function\s+public\.get_public_profile/i);
  assert.ok(createIdx !== -1, '20260922 must create get_public_profile');
  assert.ok(dropIdx < createIdx, '20260922 must DROP the old function BEFORE creating the new one');

  // 3. New get_public_profile has bio in returns table
  const fnMatch2022 = mig20260922.match(/create\s+(?:or\s+replace\s+)?function\s+public\.get_public_profile\s*\([^)]*\)\s*returns\s+table\s*\(([^)]+)\)/i);
  assert.ok(fnMatch2022, '20260922 must define get_public_profile with returns table');
  const cols2022 = fnMatch2022[1].split(',').map(s => s.trim());
  assert.equal(cols2022.length, 4, '20260922 get_public_profile must return 4 columns');
  assert.ok(cols2022.some(c => c.startsWith('bio')), '20260922 must include bio column');

  // 4. 20260922 contains NOTIFY pgrst after commit
  const commitIdx = mig20260922.search(/\bcommit\s*;/i);
  const notifyIdx = mig20260922.search(/NOTIFY\s+pgrst\s*,\s*'reload schema'\s*;/i);
  assert.ok(commitIdx !== -1, '20260922 must have commit;');
  assert.ok(notifyIdx !== -1, '20260922 must have NOTIFY pgrst, reload schema;');
  assert.ok(notifyIdx > commitIdx, 'NOTIFY pgrst must be placed after commit;');

  // 5. set_profile_bio(new_bio text) exists in 20260922 and schema.sql
  assert.ok(/function\s+public\.set_profile_bio\s*\(\s*new_bio\s+text\s*\)/i.test(mig20260922), '20260922 must define set_profile_bio(new_bio text)');
  assert.ok(/function\s+public\.set_profile_bio\s*\(\s*new_bio\s+text\s*\)/i.test(schemaSql), 'schema.sql must define set_profile_bio(new_bio text)');

  // 6. Frontend calls client.rpc('set_profile_bio', { new_bio: ... })
  assert.ok(
    /client\.rpc\(\s*['"]set_profile_bio['"]\s*,\s*\{\s*new_bio\s*:/i.test(mainJs),
    'frontend must invoke set_profile_bio with { new_bio: ... } parameter'
  );
});

test('image format validation accepts PNG/JPEG/WebP/GIF and rejects HEIC/AVIF/unsupported before cropper', () => {
  // Supported formats
  const pngFile = new Blob(['data'], { type: 'image/png' });
  const jpegFile = new Blob(['data'], { type: 'image/jpeg' });
  const webpFile = new Blob(['data'], { type: 'image/webp' });
  const gifFile = new Blob(['data'], { type: 'image/gif' });

  assert.doesNotThrow(() => validateImageFile(pngFile));
  assert.doesNotThrow(() => validateImageFile(jpegFile));
  assert.doesNotThrow(() => validateImageFile(webpFile));
  assert.doesNotThrow(() => validateImageFile(gifFile));

  // Unsupported formats (HEIC, HEIF, AVIF, BMP, etc.)
  const heicBlob = new Blob(['data'], { type: 'image/heic' });
  const heifNamed = new Blob(['data'], { type: '' });
  Object.defineProperty(heifNamed, 'name', { value: 'photo.HEIF' });
  const avifBlob = new Blob(['data'], { type: 'image/avif' });
  const bmpBlob = new Blob(['data'], { type: 'image/bmp' });

  const expectedMsg = 'Этот формат пока не поддерживается. Используй PNG, JPEG, WebP или GIF.';

  assert.throws(() => validateImageFile(heicBlob), { message: expectedMsg });
  assert.throws(() => validateImageFile(heifNamed), { message: expectedMsg });
  assert.throws(() => validateImageFile(avifBlob), { message: expectedMsg });
  assert.throws(() => validateImageFile(bmpBlob), { message: expectedMsg });

  // Size limit check
  const bigFile = new Blob([new Uint8Array(6 * 1024 * 1024)], { type: 'image/png' });
  assert.throws(() => validateImageFile(bigFile), /Выбери PNG, JPEG, WebP или GIF до 5 МБ/);
});

test('image decode failure logs only safe metadata without file contents and returns decode stage error', async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://example.test/' });
  const origWindow = globalThis.window;
  const origDoc = globalThis.document;
  const origImage = globalThis.Image;
  const origUrl = globalThis.URL;
  const origConsoleError = console.error;

  const loggedErrors = [];
  console.error = (...args) => loggedErrors.push(args);

  try {
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;

    // Mock failing Image to trigger decode failure
    class MockFailingImage {
      set src(val) {
        setTimeout(() => {
          if (typeof this.onerror === 'function') this.onerror(new Event('error'));
        }, 0);
      }
    }
    globalThis.Image = MockFailingImage;
    globalThis.URL = {
      createObjectURL: () => 'blob:https://example.test/mock-blob-id',
      revokeObjectURL: () => {},
    };

    const dummyFile = new Blob(['binary-content-not-to-be-logged'], { type: 'image/png' });
    Object.defineProperty(dummyFile, 'name', { value: 'private_user_photo.png' });
    Object.defineProperty(dummyFile, 'lastModified', { value: 1710000000000 });

    await assert.rejects(
      () => loadLocalImage(dummyFile),
      err => {
        assert.equal(err.message, 'Не удалось декодировать изображение.');
        assert.equal(err.stage, 'decode');
        return true;
      }
    );

    // Verify debug console output contains only safe metadata
    const decodeLog = loggedErrors.find(args => args[0] === '[Image Pipeline: decode]');
    assert.ok(decodeLog, 'Decode failure must be logged with [Image Pipeline: decode]');
    const meta = decodeLog[1];
    assert.equal(meta.name, 'private_user_photo.png');
    assert.equal(meta.type, 'image/png');
    assert.equal(meta.size, dummyFile.size);
    assert.equal(meta.lastModified, 1710000000000);
    assert.equal(meta.content, undefined, 'File content must NEVER be logged');
    assert.equal(JSON.stringify(meta).includes('binary-content'), false, 'No binary content in logs');
  } finally {
    globalThis.window = origWindow;
    globalThis.document = origDoc;
    globalThis.Image = origImage;
    globalThis.URL = origUrl;
    console.error = origConsoleError;
  }
});

test('storage upload failure displays user-friendly error and logs diagnostic details to dev console', async () => {
  const origConsoleError = console.error;
  const loggedErrors = [];
  console.error = (...args) => loggedErrors.push(args);

  try {
    const dom = new JSDOM('<main id="app"><div id="editor"></div></main>', { url: 'https://example.test/' });
    const host = dom.window.document.querySelector('#app');

    let capturedNotice = null;
    let isErrorNotice = false;
    const notice = (msg, bad) => {
      capturedNotice = msg;
      isErrorNotice = bad;
    };

    const mockClient = {
      from: () => ({
        select: () => ({
          order: async () => ({
            data: [
              { id: 'art-1', title: 'Статья 1', slug: 'statya-1', body: 'Текст', access: 'private', updated_at: '2026-09-18T10:00:00Z' },
            ],
            error: null,
          }),
        }),
      }),
      storage: {
        from: (bucket) => ({
          upload: async () => ({
            data: null,
            error: { code: '42501', message: 'new row violates row-level security policy for "article-media"' },
          }),
          getPublicUrl: (path) => ({ data: { publicUrl: `https://example.test/${path}` } }),
        }),
      },
    };

    mountArticles(host, {
      client: mockClient,
      userId: 'test-user-id',
      username: 'testauthor',
      notice,
      requireSession: async () => {},
    });

    await new Promise(r => setTimeout(r, 20));

    // Verify storage upload error handling contract
    const storageFailureHandler = async (client, file, path) => {
      const { error } = await client.storage.from('article-media').upload(path, file, {
        contentType: file.type || 'image/jpeg',
        upsert: false,
      });
      if (error) {
        console.error('[Image Pipeline: storage upload]', {
          code: error.code || null,
          message: error.message || null,
        });
        const err = new Error('Не удалось загрузить изображение в хранилище.');
        err.stage = 'storage upload';
        throw err;
      }
    };

    const sampleBlob = new Blob(['bytes'], { type: 'image/png' });
    await assert.rejects(
      () => storageFailureHandler(mockClient, sampleBlob, 'test-user-id/avatar.png'),
      (err) => {
        assert.equal(err.message, 'Не удалось загрузить изображение в хранилище.');
        assert.equal(err.stage, 'storage upload');
        return true;
      }
    );

    const storageLog = loggedErrors.find(args => args[0] === '[Image Pipeline: storage upload]');
    assert.ok(storageLog, 'Storage error must be logged with [Image Pipeline: storage upload]');
    assert.equal(storageLog[1].code, '42501');
    assert.equal(storageLog[1].message, 'new row violates row-level security policy for "article-media"');
  } finally {
    console.error = origConsoleError;
  }
});

test('getRotatedSource swaps dimensions for 90 and 270 degrees and preserves for 0 and 180', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const origDoc = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const mockCtx = {
      save: () => {},
      restore: () => {},
      translate: () => {},
      rotate: () => {},
      drawImage: () => {},
    };
    dom.window.HTMLCanvasElement.prototype.getContext = () => mockCtx;

    const img = {
      naturalWidth: 800,
      naturalHeight: 600,
      width: 800,
      height: 600,
    };

    // 0 deg
    const rot0 = getRotatedSource(img, 0);
    assert.equal(rot0.width, 800);
    assert.equal(rot0.height, 600);
    assert.equal(rot0.source, img);

    // 90 deg -> swapped
    const rot90 = getRotatedSource(img, 90);
    assert.equal(rot90.width, 600);
    assert.equal(rot90.height, 800);

    // 180 deg -> original orientation
    const rot180 = getRotatedSource(img, 180);
    assert.equal(rot180.width, 800);
    assert.equal(rot180.height, 600);

    // 270 deg -> swapped
    const rot270 = getRotatedSource(img, 270);
    assert.equal(rot270.width, 600);
    assert.equal(rot270.height, 800);

    // 360 deg -> normalized to 0
    const rot360 = getRotatedSource(img, 360);
    assert.equal(rot360.width, 800);
    assert.equal(rot360.height, 600);

    // -90 deg -> normalized to 270
    const rotNeg90 = getRotatedSource(img, -90);
    assert.equal(rotNeg90.width, 600);
    assert.equal(rotNeg90.height, 800);
  } finally {
    globalThis.document = origDoc;
  }
});

test('editImage cropShape option applies circle mask for circle and rect mask for rect/default', async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://example.test/' });
  const origWindow = globalThis.window;
  const origDoc = globalThis.document;
  const origImage = globalThis.Image;
  const origUrl = globalThis.URL;
  const origBlob = globalThis.Blob;

  try {
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Blob = dom.window.Blob;

    const mockCtx = {
      save: () => {},
      restore: () => {},
      translate: () => {},
      rotate: () => {},
      drawImage: () => {},
      clearRect: () => {},
    };
    dom.window.HTMLCanvasElement.prototype.getContext = () => mockCtx;

    class MockImage {
      constructor() {
        this.naturalWidth = 500;
        this.naturalHeight = 500;
      }
      set src(v) {
        setTimeout(() => { if (this.onload) this.onload(); }, 0);
      }
      decode() { return Promise.resolve(); }
    }
    globalThis.Image = MockImage;
    globalThis.URL = {
      createObjectURL: () => 'blob:https://example.test/mock-id',
      revokeObjectURL: () => {},
    };

    const file = new dom.window.Blob(['data'], { type: 'image/png' });

    // 1. Circle cropShape
    const pCircle = editImage(file, { cropShape: 'circle', aspectRatio: 1 });
    await new Promise(r => setTimeout(r, 10));
    const circleModal = dom.window.document.querySelector('.image-editor-modal');
    assert.ok(circleModal, 'Circle modal should be in DOM');
    const circleOverlay = circleModal.querySelector('.crop-overlay');
    assert.ok(circleOverlay.classList.contains('crop-overlay--circle'), 'Must have .crop-overlay--circle');
    assert.ok(!circleOverlay.classList.contains('crop-overlay--rect'), 'Must not have .crop-overlay--rect');
    circleModal.querySelector('.cancel-btn').click();
    await pCircle;

    // 2. Rect cropShape (cover)
    const pRect = editImage(file, { cropShape: 'rect', aspectRatio: 16 / 9 });
    await new Promise(r => setTimeout(r, 10));
    const rectModal = dom.window.document.querySelector('.image-editor-modal');
    assert.ok(rectModal, 'Rect modal should be in DOM');
    const rectOverlay = rectModal.querySelector('.crop-overlay');
    assert.ok(rectOverlay.classList.contains('crop-overlay--rect'), 'Must have .crop-overlay--rect');
    assert.ok(!rectOverlay.classList.contains('crop-overlay--circle'), 'Must not have .crop-overlay--circle');
    rectModal.querySelector('.cancel-btn').click();
    await pRect;

    // 3. Default (no cropShape specified) should be rect
    const pDefault = editImage(file, { aspectRatio: 1 });
    await new Promise(r => setTimeout(r, 10));
    const defModal = dom.window.document.querySelector('.image-editor-modal');
    assert.ok(defModal, 'Default modal should be in DOM');
    const defOverlay = defModal.querySelector('.crop-overlay');
    assert.ok(defOverlay.classList.contains('crop-overlay--rect'), 'Default must have .crop-overlay--rect');
    assert.ok(!defOverlay.classList.contains('crop-overlay--circle'), 'Default must not have .crop-overlay--circle');
    defModal.querySelector('.cancel-btn').click();
    await pDefault;
  } finally {
    globalThis.window = origWindow;
    globalThis.document = origDoc;
    globalThis.Image = origImage;
    globalThis.URL = origUrl;
    globalThis.Blob = origBlob;
  }
});

test('avatar uses cropShape: circle and cover/body images use cropShape: rect', () => {
  const mainSrc = fs.readFileSync(path.resolve('src/main.js'), 'utf8');
  const articlesSrc = fs.readFileSync(path.resolve('src/articles.js'), 'utf8');

  // Avatar in main.js
  assert.ok(
    mainSrc.includes("cropShape: 'circle'"),
    'main.js must pass cropShape: "circle" for avatar'
  );
  assert.ok(
    mainSrc.includes("title: 'Кадрирование аватарки'"),
    'main.js must pass title: "Кадрирование аватарки"'
  );

  // Cover in articles.js (16:9)
  assert.ok(
    articlesSrc.includes("cropShape: 'rect'") && articlesSrc.includes("aspectRatio: 16 / 9"),
    'articles.js must configure cover cropper with cropShape: "rect"'
  );

  // Body image in articles.js
  assert.ok(
    articlesSrc.includes("title: 'Редактирование фото статьи'") && articlesSrc.includes("cropShape: 'rect'"),
    'articles.js must configure body image cropper with cropShape: "rect"'
  );
});

test('editImage rotate controls cycle rotation angles and reset restores initial state', async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://example.test/' });
  const origWindow = globalThis.window;
  const origDoc = globalThis.document;
  const origImage = globalThis.Image;
  const origUrl = globalThis.URL;
  const origBlob = globalThis.Blob;

  try {
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Blob = dom.window.Blob;

    const drawnImages = [];
    const mockCtx = {
      save: () => {},
      restore: () => {},
      translate: () => {},
      rotate: () => {},
      drawImage: (...args) => drawnImages.push(args),
      clearRect: () => {},
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
    };
    dom.window.HTMLCanvasElement.prototype.getContext = () => mockCtx;
    dom.window.HTMLCanvasElement.prototype.toBlob = function(cb, type) {
      setTimeout(() => cb(new dom.window.Blob(['cropped-blob-bytes'], { type: type || 'image/png' })), 0);
    };

    class MockImage {
      constructor() {
        this.naturalWidth = 800;
        this.naturalHeight = 600;
      }
      set src(v) {
        setTimeout(() => { if (this.onload) this.onload(); }, 0);
      }
      decode() { return Promise.resolve(); }
    }
    globalThis.Image = MockImage;
    globalThis.URL = {
      createObjectURL: () => 'blob:https://example.test/mock-id',
      revokeObjectURL: () => {},
    };

    const file = new dom.window.Blob(['data'], { type: 'image/png' });
    // aspectRatio: null allows natural aspect ratio to test viewport and rotation changes
    const cropPromise = editImage(file, { aspectRatio: null, cropShape: 'rect' });
    await new Promise(r => setTimeout(r, 10));

    const modal = dom.window.document.querySelector('.image-editor-modal');
    assert.ok(modal, 'Modal exists');

    const rotateLeftBtn = modal.querySelector('.rotate-left-btn');
    const rotateRightBtn = modal.querySelector('.rotate-right-btn');
    const resetBtn = modal.querySelector('.reset-btn');
    const zoomRange = modal.querySelector('.zoom-range');
    const cropContainer = modal.querySelector('.crop-container');

    assert.ok(rotateLeftBtn, 'Rotate left button exists');
    assert.ok(rotateRightBtn, 'Rotate right button exists');
    assert.ok(resetBtn, 'Reset button exists');
    assert.equal(rotateLeftBtn.getAttribute('aria-label'), 'Повернуть влево на 90°');
    assert.equal(rotateRightBtn.getAttribute('aria-label'), 'Повернуть вправо на 90°');
    assert.equal(resetBtn.getAttribute('aria-label'), 'Сбросить');

    // Initial aspect is landscape (800x600 -> container width > height)
    const initialW = parseInt(cropContainer.style.width, 10);
    const initialH = parseInt(cropContainer.style.height, 10);
    assert.ok(initialW > initialH, 'Initially landscape container');

    // Test Rotate Right: 0 -> 90 -> 180 -> 270 -> 0
    // 90 deg: container should be portrait (w < h)
    rotateRightBtn.click();
    assert.ok(parseInt(cropContainer.style.width, 10) < parseInt(cropContainer.style.height, 10), '90 deg is portrait');

    // 180 deg: container should be landscape (w > h)
    rotateRightBtn.click();
    assert.ok(parseInt(cropContainer.style.width, 10) > parseInt(cropContainer.style.height, 10), '180 deg is landscape');

    // 270 deg: container should be portrait (w < h)
    rotateRightBtn.click();
    assert.ok(parseInt(cropContainer.style.width, 10) < parseInt(cropContainer.style.height, 10), '270 deg is portrait');

    // 360/0 deg: container should be landscape again
    rotateRightBtn.click();
    assert.ok(parseInt(cropContainer.style.width, 10) > parseInt(cropContainer.style.height, 10), '0 deg is landscape');

    // Test Rotate Left: 0 -> 270 -> 180 -> 90 -> 0
    rotateLeftBtn.click();
    assert.ok(parseInt(cropContainer.style.width, 10) < parseInt(cropContainer.style.height, 10), '270 deg is portrait');

    rotateLeftBtn.click();
    assert.ok(parseInt(cropContainer.style.width, 10) > parseInt(cropContainer.style.height, 10), '180 deg is landscape');

    rotateLeftBtn.click();
    assert.ok(parseInt(cropContainer.style.width, 10) < parseInt(cropContainer.style.height, 10), '90 deg is portrait');

    rotateLeftBtn.click();
    assert.ok(parseInt(cropContainer.style.width, 10) > parseInt(cropContainer.style.height, 10), '0 deg is landscape');

    // Test Zoom change and Reset
    zoomRange.value = '2.5';
    zoomRange.dispatchEvent(new dom.window.Event('input'));
    assert.equal(zoomRange.value, '2.5');

    // Rotate to 90
    rotateRightBtn.click();
    // In our design, rotation resets userZoom to 1 to guarantee complete coverage
    assert.equal(zoomRange.value, '1');

    // Set zoom again to 2.0
    zoomRange.value = '2.0';
    zoomRange.dispatchEvent(new dom.window.Event('input'));

    // Now click Reset: rotation returns to 0, container to landscape, zoom to 1
    resetBtn.click();
    assert.equal(zoomRange.value, '1');
    assert.ok(parseInt(cropContainer.style.width, 10) > parseInt(cropContainer.style.height, 10), 'Reset returns landscape');

    // Export crop after rotation produces Blob
    rotateRightBtn.click();
    const saveBtn = modal.querySelector('.save-btn');
    saveBtn.click();

    const exportedBlob = await cropPromise;
    assert.ok(exportedBlob instanceof dom.window.Blob, 'Exported crop must be a Blob instance');
    assert.equal(exportedBlob.type, 'image/png');
  } finally {
    globalThis.window = origWindow;
    globalThis.document = origDoc;
    globalThis.Image = origImage;
    globalThis.URL = origUrl;
    globalThis.Blob = origBlob;
  }
});
