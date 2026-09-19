import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { mountArticles } from '../src/articles.js';
import { attachEditor } from '../src/editor.js';

function setupDom() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="articles-root"></div></body></html>', {
    url: 'https://helper.slutvibe.site/',
  });

  const mockCtx = {
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    drawImage: () => {},
    clearRect: () => {},
  };
  dom.window.HTMLCanvasElement.prototype.getContext = () => mockCtx;
  dom.window.HTMLCanvasElement.prototype.toBlob = function(cb) {
    cb(new dom.window.Blob(['cropped-data'], { type: 'image/jpeg' }));
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
  dom.window.Image = MockImage;

  const mockUrl = Object.assign(Object.create(dom.window.URL), {
    createObjectURL: () => 'blob:https://example.test/mock-crop-id',
    revokeObjectURL: () => {},
  });
  dom.window.URL = mockUrl;

  const names = ['window', 'document', 'navigator', 'localStorage', 'confirm', 'crypto', 'FileReader', 'Blob', 'File', 'URL', 'Image'];
  const previous = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    confirm: () => true,
    crypto: dom.window.crypto || { randomUUID: () => '11111111-2222-3333-4444-555555555555' },
    FileReader: dom.window.FileReader,
    Blob: dom.window.Blob,
    File: dom.window.File,
    URL: mockUrl,
    Image: MockImage,
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

test('ARTICLE WRITER: dedicated title and body containers without author identity in editor', async () => {
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

    // Author Identity MUST NOT be in the authenticated editor
    assert.equal(host.querySelector('.article-author-header'), null, 'Author header must NOT exist in editor');
    assert.equal(host.querySelector('.article-author-avatar'), null, 'Author avatar must NOT exist in editor');
    assert.equal(host.querySelector('.article-author-name'), null, 'Author name must NOT exist in editor');
    assert.equal(host.querySelector('.article-author-handle'), null, 'Author handle must NOT exist in editor');

    // Dedicated Title Container
    const titleContainer = host.querySelector('.article-title-editor');
    assert.ok(titleContainer, 'Dedicated title container must exist');
    const titleInput = titleContainer.querySelector('.article-title-input');
    assert.ok(titleInput, 'Title input must exist inside title container');
    assert.equal(titleInput.tagName.toLowerCase(), 'input');
    assert.equal(titleInput.getAttribute('placeholder'), 'Заголовок');
    assert.equal(titleInput.getAttribute('maxlength'), '180');
    assert.equal(titleInput.value, 'Телетайп-вдохновлённый редактор');
    const titlePreview = titleContainer.querySelector('.article-title-preview');
    assert.ok(titlePreview, 'Title preview heading must exist in title container');
    assert.equal(titlePreview.hidden, true, 'Title preview must be hidden in editor mode');

    // Dedicated Body Container
    const bodyContainer = host.querySelector('.article-body-editor');
    assert.ok(bodyContainer, 'Dedicated body container must exist below title');
    const bodyTextarea = bodyContainer.querySelector('textarea');
    assert.ok(bodyTextarea, 'Body textarea must exist inside body container');
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

test('ARTICLE WRITER: CSS architecture ensures separated title and body containers and split mode panels', () => {
  const workbenchCss = fs.readFileSync(path.resolve(process.cwd(), 'src/workbench.css'), 'utf8');

  // Title container max-width approximately 700-760px
  assert.match(workbenchCss, /\.article-title-editor\s*\{[^}]*max-width:\s*740px/);

  // Body container max-width approximately 700-760px
  assert.match(workbenchCss, /\.article-body-editor\s*\{[^}]*max-width:\s*740px/);

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
  assert.match(workbenchCss, /\.article-body-editor \.editor textarea[^{]*\{[^}]*background:\s*transparent/);
  assert.match(workbenchCss, /\.article-body-editor \.editor textarea[^{]*\{[^}]*border:\s*none/);
  assert.match(workbenchCss, /\.article-body-editor \.editor textarea[^{]*\{[^}]*resize:\s*none/);

  // Split mode divider and labels
  assert.match(workbenchCss, /\.article-body-editor \.editor-pane--source\s*\{[^}]*border-right:/);
  assert.match(workbenchCss, /\.article-body-editor \.editor-pane-label\s*\{/);

  // Mobile responsiveness
  assert.match(workbenchCss, /@media\s*\(max-width:\s*768px\)[\s\S]*?\.article-settings-drawer\s*\{[^}]*max-width:\s*100%/);
});

test('ARTICLE WRITER: editor, split, and preview mode switching with title and body behavior', async () => {
  const { dom, cleanup } = setupDom();
  try {
    const mockArticles = [
      {
        id: 'art-400',
        title: 'Заголовок режима',
        slug: 'mode-test',
        body: 'Текст для проверки режимов',
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

    const titleInput = host.querySelector('.article-title-input');
    const titlePreview = host.querySelector('.article-title-preview');
    const bodyContainer = host.querySelector('.article-body-editor');
    const textarea = bodyContainer.querySelector('textarea');
    const preview = bodyContainer.querySelector('.preview');
    const modeSelect = host.querySelector('.mode-select');

    // 1. Initial EDITOR mode
    assert.equal(titleInput.hidden, false, 'Title input must be visible in editor mode');
    assert.equal(titlePreview.hidden, true, 'Title preview must be hidden in editor mode');
    assert.equal(textarea.hidden, false, 'Textarea must be visible in editor mode');
    assert.equal(preview.hidden, true, 'Preview must be hidden in editor mode');

    // 2. Switch to SPLIT mode
    modeSelect.value = 'split';
    modeSelect.dispatchEvent(new dom.window.Event('change'));
    assert.equal(titleInput.hidden, false, 'Title input must remain visible above in split mode');
    assert.equal(titlePreview.hidden, true, 'Title preview must remain hidden in split mode');
    assert.equal(textarea.hidden, false, 'Textarea must be visible in split mode');
    assert.equal(preview.hidden, false, 'Preview must be visible in split mode');

    // Split panels check
    const sourcePane = bodyContainer.querySelector('.editor-pane--source');
    const previewPane = bodyContainer.querySelector('.editor-pane--preview');
    assert.ok(sourcePane, 'Source pane must exist in split mode');
    assert.ok(previewPane, 'Preview pane must exist in split mode');
    assert.equal(sourcePane.querySelector('.editor-pane-label').textContent, 'Markdown');
    assert.equal(previewPane.querySelector('.editor-pane-label').textContent, 'Preview');
    // Title is NOT in split panels
    assert.equal(sourcePane.querySelector('.article-title-input'), null);
    assert.equal(previewPane.querySelector('.article-title-input'), null);

    // 3. Switch to PREVIEW mode
    modeSelect.value = 'preview';
    modeSelect.dispatchEvent(new dom.window.Event('change'));
    assert.equal(titleInput.hidden, true, 'Title input must be hidden in preview mode');
    assert.equal(titlePreview.hidden, false, 'Title preview must be visible in preview mode');
    assert.equal(titlePreview.textContent, 'Заголовок режима');
    assert.equal(textarea.hidden, true, 'Textarea must be hidden in preview mode');
    assert.equal(preview.hidden, false, 'Preview must be visible in preview mode');

    // 4. Switch back to EDITOR mode
    modeSelect.value = 'editor';
    modeSelect.dispatchEvent(new dom.window.Event('change'));
    assert.equal(titleInput.hidden, false);
    assert.equal(titlePreview.hidden, true);
    assert.equal(textarea.hidden, false);
    assert.equal(preview.hidden, true);
  } finally {
    cleanup();
  }
});

test('ARTICLE IMAGE PIPELINE: generic editor.js onImageFile, drag/drop, and removal of old task string', async () => {
  const editorCode = fs.readFileSync(path.resolve(process.cwd(), 'src/editor.js'), 'utf8');
  assert.equal(editorCode.includes('Для изображения в задаче'), false, 'Old task-specific error string must be removed from generic editor.js');

  const { dom, cleanup } = setupDom();
  try {
    const host = dom.window.document.createElement('div');
    dom.window.document.body.append(host);

    // 1. Generic editor with onImageFile
    let receivedFile = null;
    let receivedInsertOpts = null;
    const editor = attachEditor(host, {
      variant: 'article',
      onImageFile: async (file, opts) => {
        receivedFile = file;
        receivedInsertOpts = opts;
        opts.insert('\n![test-image|640](https://example.com/test.png)\n');
      },
    });

    const file = new dom.window.File(['content'], 'sample.png', { type: 'image/png' });

    // Simulate paste with clipboardData containing image
    const pasteEvent = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    pasteEvent.clipboardData = { files: [file] };
    host.dispatchEvent(pasteEvent);

    assert.equal(pasteEvent.defaultPrevented, true, 'Paste event must be prevented');
    assert.equal(receivedFile, file, 'onImageFile must receive the pasted image file');
    assert.ok(receivedInsertOpts && typeof receivedInsertOpts.insert === 'function', 'onImageFile must receive insert helper');
    assert.match(editor.getValue(), /!\[test-image\|640\]\(https:\/\/example\.com\/test\.png\)/, 'Markdown must be inserted');
    assert.equal(editor.getValue().includes('текст'), false, 'Rogue placeholder "текст" must not be appended');

    // Dragover with image item
    const dragoverEvent = new dom.window.Event('dragover', { bubbles: true, cancelable: true });
    dragoverEvent.dataTransfer = { items: [{ type: 'image/png' }] };
    host.dispatchEvent(dragoverEvent);
    assert.equal(dragoverEvent.defaultPrevented, true, 'Dragover must be accepted when onImageFile exists');
    assert.ok(host.classList.contains('drag-image'), 'Must add drag-image class on dragover');

    // Drop with image file
    receivedFile = null;
    const dropFile = new dom.window.File(['drop-content'], 'dropped.png', { type: 'image/png' });
    const dropEvent = new dom.window.Event('drop', { bubbles: true, cancelable: true });
    dropEvent.dataTransfer = { files: [dropFile] };
    host.dispatchEvent(dropEvent);
    assert.equal(dropEvent.defaultPrevented, true, 'Drop event must be prevented');
    assert.equal(receivedFile, dropFile, 'onImageFile must receive the dropped image file');

    // 2. Generic editor without imageStore and without onImageFile (e.g. task editor)
    const hostTask = dom.window.document.createElement('div');
    dom.window.document.body.append(hostTask);
    let taskError = null;
    attachEditor(hostTask, {
      variant: 'basic',
      onError: msg => { taskError = msg; },
    });

    const taskPaste = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    taskPaste.clipboardData = { files: [file] };
    hostTask.dispatchEvent(taskPaste);
    assert.equal(taskError, 'Вставка изображения из файла здесь не поддерживается.', 'Task editor must show neutral error');

    // 3. Notes editor with imageStore retains local attachments
    const hostNote = dom.window.document.createElement('div');
    dom.window.document.body.append(hostNote);
    const mockImageStore = {
      add: ({ name, type, data }) => `note-att-${name}`,
      get: () => null,
    };
    const noteEditor = attachEditor(hostNote, {
      variant: 'basic',
      imageStore: mockImageStore,
    });

    const notePaste = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    notePaste.clipboardData = { files: [file] };
    hostNote.dispatchEvent(notePaste);

    await new Promise(r => setTimeout(r, 20));
    assert.match(noteEditor.getValue(), /attachment:\/\/note-att-sample\.png/, 'Note editor must still create attachment:// links');
  } finally {
    cleanup();
  }
});

test('ARTICLE IMAGE PIPELINE: article editor wires onImageFile to unified pipeline (paste, drag/drop, dialog)', async () => {
  const { dom, cleanup } = setupDom();

  try {
    let uploadedPath = null;
    const uploadedUrls = [];
    const client = {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
      from(table) {
        if (table === 'articles') {
          return {
            select: () => ({
              order: async () => ({
                data: [{
                  id: 'art-img-1',
                  title: 'Статья с фото',
                  slug: 'photo-article',
                  body: 'Начальный текст.',
                  access: 'private',
                  published: false,
                  updated_at: '2026-09-19T12:00:00Z',
                }],
                error: null,
              }),
            }),
          };
        }
        return {};
      },
      storage: {
        from(bucket) {
          assert.equal(bucket, 'article-media', 'Must upload to article-media storage bucket');
          return {
            upload: async (path, file) => {
              uploadedPath = path;
              return { error: null };
            },
            getPublicUrl: path => {
              const url = `https://storage.example.test/article-media/${path}`;
              uploadedUrls.push(url);
              return { data: { publicUrl: url } };
            },
          };
        },
      },
    };

    let lastNotice = null;
    const host = dom.window.document.querySelector('#articles-root');
    mountArticles(host, {
      client,
      userId: 'u1',
      username: 'writer',
      notice: msg => { lastNotice = msg; },
      requireSession: async () => {},
    });

    await new Promise(r => setTimeout(r, 40));

    const bodyEditor = host.querySelector('.article-body-editor');
    assert.ok(bodyEditor, 'Body editor container must exist');
    const textarea = bodyEditor.querySelector('textarea');
    assert.ok(textarea, 'Textarea must exist');

    // 1. Test paste of an image file into article body
    const pastedFile = new dom.window.File(['pasted-img-bytes'], 'screenshot.png', { type: 'image/png' });
    const pasteEv = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    pasteEv.clipboardData = { files: [pastedFile] };
    bodyEditor.dispatchEvent(pasteEv);

    await new Promise(r => setTimeout(r, 40));

    // Cropper modal should have appeared
    const cropModal = dom.window.document.querySelector('.image-editor-modal');
    assert.ok(cropModal, 'Crop modal must appear when image is pasted');
    const saveCropBtn = cropModal.querySelector('.save-btn');
    assert.ok(saveCropBtn, 'Cropper save button must exist');
    saveCropBtn.click();

    await new Promise(r => setTimeout(r, 40));

    assert.match(uploadedPath, /^u1\/[a-f0-9-]+-screenshot\.png$/);
    assert.match(textarea.value, /!\[screenshot\|640\]\(https:\/\/storage\.example\.test\/article-media\/u1\/[a-f0-9-]+-screenshot\.png\)/);
    assert.equal(lastNotice, 'Изображение вставлено в текст.');

    // 2. Test drop of an image file into article body
    const droppedFile = new dom.window.File(['dropped-img-bytes'], 'chart.webp', { type: 'image/webp' });
    const dropEv = new dom.window.Event('drop', { bubbles: true, cancelable: true });
    dropEv.dataTransfer = { files: [droppedFile] };
    bodyEditor.dispatchEvent(dropEv);

    await new Promise(r => setTimeout(r, 40));

    const cropModal2 = dom.window.document.querySelector('.image-editor-modal');
    assert.ok(cropModal2, 'Crop modal must appear when image is dropped');
    const saveCropBtn2 = cropModal2.querySelector('.save-btn');
    saveCropBtn2.click();

    await new Promise(r => setTimeout(r, 40));

    assert.match(textarea.value, /!\[chart\|640\]\(https:\/\/storage\.example\.test\/article-media\/u1\/[a-f0-9-]+-chart\.webp\)/);

    // 3. Test image button dialog -> "Выбрать файл" reuses the same pipeline
    const imgBtn = host.querySelector('button[aria-label="Изображение"]');
    assert.ok(imgBtn, 'Toolbar image button must exist');
    imgBtn.click();

    const dialogScrim = dom.window.document.querySelector('.dialog-scrim');
    assert.ok(dialogScrim, 'Image insertion dialog scrim must open');
    const dialogFileInput = dialogScrim.querySelector('input[type="file"]');
    assert.ok(dialogFileInput, 'File input must exist in image dialog');

    const dialogFile = new dom.window.File(['dialog-img'], 'diagram.jpeg', { type: 'image/jpeg' });
    Object.defineProperty(dialogFileInput, 'files', { value: [dialogFile], configurable: true });
    dialogFileInput.onchange();

    await new Promise(r => setTimeout(r, 40));

    const cropModal3 = dom.window.document.querySelector('.image-editor-modal');
    assert.ok(cropModal3, 'Crop modal must appear when file is picked in dialog');
    const saveCropBtn3 = cropModal3.querySelector('.save-btn');
    saveCropBtn3.click();

    await new Promise(r => setTimeout(r, 40));

    assert.match(textarea.value, /!\[diagram\|640\]\(https:\/\/storage\.example\.test\/article-media\/u1\/[a-f0-9-]+-diagram\.jpeg\)/);
  } finally {
    cleanup();
  }
});
