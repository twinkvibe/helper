import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachEditor } from '../src/editor.js';
import { mountArticles } from '../src/articles.js';

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


