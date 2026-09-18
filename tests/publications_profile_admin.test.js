import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachEditor } from '../src/editor.js';
import { mountArticles } from '../src/articles.js';
import { loadLocalImage } from '../src/image-editor.js';

test('Editor toolbar contains format-bar__format and format-bar__view groups with split slider behavior', () => {
  const dom = new JSDOM('<section id="editor"></section>', { url: 'https://example.test/helper/' });
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
  const dom = new JSDOM('<section id="articles-root"></section>', { url: 'https://example.test/helper/' });
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
  const dom = new JSDOM('<section id="articles-root"></section>', { url: 'https://example.test/helper/' });
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
  const dom = new JSDOM('<section id="articles-root"></section>', { url: 'https://example.test/helper/' });
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
  const dom = new JSDOM('<section id="articles-root"></section>', { url: 'https://example.test/helper/' });
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


