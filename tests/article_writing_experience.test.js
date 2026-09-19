import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { mountArticles } from '../src/articles.js';

function setupDom() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="articles-root"></div></body></html>', {
    url: 'https://helper.slutvibe.site/',
  });
  const names = ['window', 'document', 'navigator', 'localStorage', 'confirm', 'crypto', 'FileReader'];
  const previous = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    confirm: () => true,
    crypto: dom.window.crypto || { randomUUID: () => '11111111-2222-3333-4444-555555555555' },
    FileReader: dom.window.FileReader,
  })) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }

  const cleanup = () => {
    dom.window.close();
    for (const name of names) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
      else delete globalThis[name];
    }
  };

  return { dom, cleanup };
}

test('ARTICLE WRITER: focused document canvas layout with top bar, author header, and borderless title', async () => {
  const { dom, cleanup } = setupDom();
  try {
    const mockArticles = [
      {
        id: 'art-100',
        title: 'Телетайп-вдохновлённый редактор',
        slug: 'teletype-style-writer',
        body: 'Основной текст статьи.',
        access: 'private',
        published: false,
        cover_url: '',
        updated_at: '2026-09-19T12:00:00Z',
      },
    ];

    const client = {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
      from(table) {
        if (table === 'articles') {
          return {
            select: () => ({ order: async () => ({ data: [...mockArticles], error: null }) }),
            update: () => ({ eq: () => ({ select: () => ({ data: [{ ...mockArticles[0] }], error: null }) }) }),
          };
        }
        return {};
      },
    };

    const host = dom.window.document.querySelector('#articles-root');
    mountArticles(host, {
      client,
      userId: 'u1',
      username: 'writer',
      profile: {
        username: 'writer',
        display_name: 'Писатель',
        avatar_url: 'https://example.com/avatar.jpg',
      },
      notice: () => {},
      requireSession: async () => {},
    });

    await new Promise(r => setTimeout(r, 30));

    // Top article bar
    const topBar = host.querySelector('.article-top-bar');
    assert.ok(topBar, 'Top article bar must exist');
    assert.ok(topBar.querySelector('.article-back-btn'), 'Back button must exist in top bar');
    const saveStatus = topBar.querySelector('.article-save-status');
    assert.ok(saveStatus, 'Save status indicator must exist');
    assert.equal(saveStatus.textContent.trim(), 'Сохранено');
    const settingsBtn = topBar.querySelector('.article-settings-btn');
    assert.ok(settingsBtn, 'Settings button must exist');
    const saveBtn = topBar.querySelector('.article-save-btn');
    assert.ok(saveBtn, 'Save action button must exist');
    assert.equal(saveBtn.textContent.trim(), 'Сохранить', 'Private article must have "Сохранить" as action');

    // Document canvas
    const documentCol = host.querySelector('.article-document');
    assert.ok(documentCol, 'Document column must exist');

    // Author Identity Header
    const authorHeader = documentCol.querySelector('.article-author-header');
    assert.ok(authorHeader, 'Author header must exist above the title');
    assert.match(authorHeader.querySelector('.article-author-name').textContent, /Писатель/);
    assert.match(authorHeader.querySelector('.article-author-handle').textContent, /@writer/);
    const avatarImg = authorHeader.querySelector('.article-author-avatar-img');
    assert.ok(avatarImg, 'Author avatar img must exist');
    assert.equal(avatarImg.getAttribute('src'), 'https://example.com/avatar.jpg');

    // Title input
    const titleInput = documentCol.querySelector('.article-title-input');
    assert.ok(titleInput, 'Title input must exist');
    assert.equal(titleInput.tagName.toLowerCase(), 'textarea');
    assert.equal(titleInput.getAttribute('placeholder'), 'Заголовок');
    assert.equal(titleInput.getAttribute('maxlength'), '180');
    assert.equal(titleInput.value, 'Телетайп-вдохновлённый редактор');

    // Markdown textarea is source of truth (no contenteditable)
    const bodyTextarea = documentCol.querySelector('.article-editor textarea');
    assert.ok(bodyTextarea, 'Body textarea must exist');
    assert.equal(bodyTextarea.value, 'Основной текст статьи.');
    assert.ok(!host.querySelector('[contenteditable="true"]'), 'Must not introduce contenteditable');
  } finally {
    cleanup();
  }
});

test('ARTICLE WRITER: Settings drawer contains metadata and toggles visibility via button, backdrop and Escape', async () => {
  const { dom, cleanup } = setupDom();
  try {
    const mockArticles = [
      {
        id: 'art-200',
        title: 'Статья с настройками',
        slug: 'settings-test',
        body: 'Тестовый текст',
        access: 'private',
        published: false,
        cover_url: 'https://example.com/cover.jpg',
        updated_at: '2026-09-19T12:00:00Z',
      },
    ];

    const client = {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
      from(table) {
        if (table === 'articles') {
          return {
            select: () => ({ order: async () => ({ data: [...mockArticles], error: null }) }),
          };
        }
        return {};
      },
    };

    const host = dom.window.document.querySelector('#articles-root');
    mountArticles(host, {
      client,
      userId: 'u1',
      username: 'writer',
      notice: () => {},
      requireSession: async () => {},
    });

    await new Promise(r => setTimeout(r, 30));

    const backdrop = host.querySelector('.article-settings-backdrop');
    assert.ok(backdrop, 'Settings backdrop must exist');
    assert.equal(backdrop.hidden, true, 'Settings drawer must be hidden by default while writing');

    // Open drawer
    const settingsBtn = host.querySelector('.article-settings-btn');
    settingsBtn.click();
    assert.equal(backdrop.hidden, false, 'Clicking settings button must open drawer');

    // Check non-writing fields inside drawer
    const drawer = host.querySelector('.article-settings-drawer');
    assert.ok(drawer.querySelector('input[name="slug"]'), 'Slug field must be inside drawer');
    assert.ok(drawer.querySelector('.drawer-slug-preview'), 'Live slug preview must be inside drawer');
    assert.ok(drawer.querySelector('select[name="access"]'), 'Access selector must be inside drawer');
    assert.ok(drawer.querySelector('.cover-picker'), 'Cover picker must be inside drawer');
    assert.ok(drawer.querySelector('[data-copy]'), 'Copy public link button must be inside drawer');
    assert.ok(drawer.querySelector('.delete-article-btn'), 'Delete article button must be inside drawer');

    // Close via close button
    const closeBtn = drawer.querySelector('.close-settings-btn');
    closeBtn.click();
    assert.equal(backdrop.hidden, true, 'Clicking close button must close drawer');

    // Reopen and close via Escape
    settingsBtn.click();
    assert.equal(backdrop.hidden, false);
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(backdrop.hidden, true, 'Pressing Escape must close settings drawer');

    // Reopen and close via "Готово" button
    settingsBtn.click();
    assert.equal(backdrop.hidden, false);
    const doneBtn = drawer.querySelector('.close-settings-done-btn');
    doneBtn.click();
    assert.equal(backdrop.hidden, true, 'Clicking Готово must close settings drawer');
  } finally {
    cleanup();
  }
});

test('ARTICLE WRITER: save/publish action changes dynamically with access level and dirty state', async () => {
  const { dom, cleanup } = setupDom();
  try {
    const mockArticles = [
      {
        id: 'art-300',
        title: 'Статья доступа',
        slug: 'access-test',
        body: 'Контент',
        access: 'private',
        published: false,
        updated_at: '2026-09-19T12:00:00Z',
      },
    ];

    const client = {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
      from(table) {
        if (table === 'articles') {
          return {
            select: () => ({ order: async () => ({ data: [...mockArticles], error: null }) }),
            update: (payload) => ({
              eq: () => ({
                select: () => {
                  Object.assign(mockArticles[0], payload);
                  return { data: [mockArticles[0]], error: null };
                },
              }),
            }),
          };
        }
        return {};
      },
    };

    let lastNotice = null;
    const host = dom.window.document.querySelector('#articles-root');
    mountArticles(host, {
      client,
      userId: 'u1',
      username: 'writer',
      notice: (msg) => { lastNotice = msg; },
      requireSession: async () => {},
    });

    await new Promise(r => setTimeout(r, 30));

    const saveBtn = host.querySelector('.article-save-btn');
    const saveStatus = host.querySelector('.article-save-status');
    const accessSelect = host.querySelector('select[name="access"]');

    assert.equal(saveBtn.textContent.trim(), 'Сохранить');
    assert.equal(saveStatus.textContent.trim(), 'Сохранено');

    // Change title -> marks dirty
    const titleInput = host.querySelector('.article-title-input');
    titleInput.value = 'Обновлённый заголовок';
    titleInput.dispatchEvent(new dom.window.Event('input'));
    assert.equal(saveStatus.textContent.trim(), 'Есть изменения');

    // Change access to public -> button becomes "Сохранить изменения"
    accessSelect.value = 'public';
    accessSelect.dispatchEvent(new dom.window.Event('change'));
    assert.equal(saveBtn.textContent.trim(), 'Сохранить изменения');

    // Change access to unlisted -> button is still "Сохранить изменения"
    accessSelect.value = 'unlisted';
    accessSelect.dispatchEvent(new dom.window.Event('change'));
    assert.equal(saveBtn.textContent.trim(), 'Сохранить изменения');

    // Change access back to private -> button is "Сохранить"
    accessSelect.value = 'private';
    accessSelect.dispatchEvent(new dom.window.Event('change'));
    assert.equal(saveBtn.textContent.trim(), 'Сохранить');
  } finally {
    cleanup();
  }
});

test('ARTICLE WRITER: CSS architecture ensures max-width document column and borderless styling', () => {
  const workbenchCss = fs.readFileSync(path.resolve(process.cwd(), 'src/workbench.css'), 'utf8');

  // Document column max-width approximately 700-760px
  assert.match(workbenchCss, /\.article-document\s*\{[^}]*max-width:\s*740px/);

  // Top article bar sticky
  assert.match(workbenchCss, /\.article-top-bar\s*\{[^}]*position:\s*sticky/);

  // Sticky toolbar host
  assert.match(workbenchCss, /\.article-toolbar-host\s*\{[^}]*position:\s*sticky/);
  assert.match(workbenchCss, /\.article-toolbar-host \.format-bar\s*\{[^}]*max-width:\s*740px/);

  // Aa dropdown popover
  assert.match(workbenchCss, /\.aa-menu\s*\{[^}]*position:\s*absolute/);

  // Borderless and transparent title
  assert.match(workbenchCss, /\.article-title-input\s*\{[^}]*background:\s*transparent/);
  assert.match(workbenchCss, /\.article-title-input\s*\{[^}]*border:\s*none/);

  // Borderless and transparent body textarea
  assert.match(workbenchCss, /\.article-editor \.editor textarea\s*\{[^}]*background:\s*transparent/);
  assert.match(workbenchCss, /\.article-editor \.editor textarea\s*\{[^}]*border:\s*none/);
  assert.match(workbenchCss, /\.article-editor \.editor textarea\s*\{[^}]*resize:\s*none/);

  // Mobile responsiveness
  assert.match(workbenchCss, /@media\s*\(max-width:\s*768px\)[\s\S]*?\.article-settings-drawer\s*\{[^}]*max-width:\s*100%/);
});
