import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { renderMarkdown, postProcessMarkdown } from '../src/security.js';
import { attachEditor } from '../src/editor.js';

function setupDom(html = '<section id="host"></section>') {
  const dom = new JSDOM(html, { url: 'https://example.test/' });
  const names = ['window', 'document', 'localStorage'];
  const previous = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage })) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  return {
    dom,
    cleanup() {
      dom.window.close();
      for (const name of names) {
        if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
        else delete globalThis[name];
      }
    }
  };
}

test('CODE: explicit js and javascript show language badge', () => {
  const { dom, cleanup } = setupDom();
  try {
    const htmlJs = renderMarkdown('```js\nconst x = 1;\n```', dom.window);
    assert.match(htmlJs, /<span class="code-language">js<\/span>/);
    assert.match(htmlJs, /<pre class="has-code-language">/);

    const htmlTs = renderMarkdown('```javascript\nconst x = 1;\n```', dom.window);
    assert.match(htmlTs, /<span class="code-language">javascript<\/span>/);
  } finally {
    cleanup();
  }
});

test('CODE: unlabeled fenced block and inline code have NO language badge', () => {
  const { dom, cleanup } = setupDom();
  try {
    const htmlNoLang = renderMarkdown('```\nhello world\n```', dom.window);
    assert.doesNotMatch(htmlNoLang, /class="code-language"/);
    assert.doesNotMatch(htmlNoLang, /<span[^>]*>(?:TEXT|PLAIN|CODE|UNKNOWN)<\/span>/i);

    const htmlInline = renderMarkdown('Here is `const a = 1;` inline code', dom.window);
    assert.doesNotMatch(htmlInline, /class="code-language"/);
  } finally {
    cleanup();
  }
});

test('CODE: preview and public article consistent rendering', () => {
  const { dom, cleanup } = setupDom();
  try {
    const src = '```python\nprint("hi")\n```\n\n```\nraw\n```';
    const output1 = renderMarkdown(src, dom.window);
    const output2 = renderMarkdown(src, dom.window);
    assert.equal(output1, output2);
    assert.match(output1, /<span class="code-language">python<\/span>/);
    assert.equal((output1.match(/class="code-language"/g) || []).length, 1);
  } finally {
    cleanup();
  }
});

test('QUOTE: no Georgia/serif article quote rule and spacing styles present', () => {
  const styleCss = fs.readFileSync(path.resolve(process.cwd(), 'src/style.css'), 'utf8');
  assert.doesNotMatch(styleCss, /\.article-body blockquote[^}]*Georgia/);
  assert.match(styleCss, /\.article-body blockquote\s*\{[^}]*font-family:\s*inherit/);
  assert.match(styleCss, /\.article-body blockquote\s*>\s*p\s*\{\s*margin:\s*0;?\s*\}/);
  assert.match(styleCss, /\.article-body blockquote\s*>\s*p\s*\+\s*p\s*\{\s*margin-top:\s*\.?75em;?\s*\}/);
});

test('QUOTE: quote without author works as normal quote', () => {
  const { dom, cleanup } = setupDom();
  try {
    const html = renderMarkdown('> Quote text.\n> Second line.', dom.window);
    assert.match(html, /<blockquote>/);
    assert.match(html, /<p>Quote text\.<br>\n?Second line\.<\/p>/);
    assert.doesNotMatch(html, /<cite/);
  } finally {
    cleanup();
  }
});

test('QUOTE: final em-dash author becomes attribution, ordinary dash elsewhere remains quote text', () => {
  const { dom, cleanup } = setupDom();
  try {
    // Single quote with author
    const withAuthor = renderMarkdown('> Quote text.\n>\n> — Viktor Frankl', dom.window);
    assert.match(withAuthor, /<cite class="quote-author">Viktor Frankl<\/cite>/);
    assert.match(withAuthor, /<p>Quote text\.<\/p>/);

    // Initial dash line is NOT final paragraph, so it is NOT attribution
    const dialogue = renderMarkdown('> — First dialogue line\n>\n> Second paragraph', dom.window);
    assert.doesNotMatch(dialogue, /<cite/);
    assert.match(dialogue, /<p>— First dialogue line<\/p>/);
    assert.match(dialogue, /<p>Second paragraph<\/p>/);

    // Initial dash line + final dash author: only the final is attribution
    const both = renderMarkdown('> — Speech line\n>\n> — Author Name', dom.window);
    assert.match(both, /<p>— Speech line<\/p>/);
    assert.match(both, /<cite class="quote-author">Author Name<\/cite>/);

    // Normal hyphen is NOT em-dash
    const hyphen = renderMarkdown('> Quote\n>\n> - Not author', dom.window);
    assert.doesNotMatch(hyphen, /<cite/);

    // Em-dash with empty text after is NOT author
    const emptyAfter = renderMarkdown('> Quote\n>\n> —', dom.window);
    assert.doesNotMatch(emptyAfter, /<cite/);
  } finally {
    cleanup();
  }
});

test('QUOTE: quote author is XSS safe', () => {
  const { dom, cleanup } = setupDom();
  try {
    const evil = renderMarkdown('> Quote\n>\n> — Author <script>alert("xss")</script><img src="x" onerror="evil()">', dom.window);
    assert.doesNotMatch(evil, /<script/);
    assert.doesNotMatch(evil, /onerror/);
    assert.match(evil, /<cite class="quote-author">Author<\/cite>/);

    const escaped = renderMarkdown('> Quote\n>\n> — <Author & Co>', dom.window);
    assert.match(escaped, /<cite class="quote-author">&lt;Author &amp; Co&gt;<\/cite>/);
    assert.doesNotMatch(escaped, /<Author/);
  } finally {
    cleanup();
  }
});

test('ARTICLE EDITOR: article variant enables expanded controls, basic remains compact', () => {
  const { dom, cleanup } = setupDom();
  try {
    const hostArticle = dom.window.document.createElement('div');
    dom.window.document.body.append(hostArticle);
    attachEditor(hostArticle, { variant: 'article' });

    assert.ok(hostArticle.classList.contains('article-editor'));
    const groups = hostArticle.querySelectorAll('.format-bar__format .toolbar-group');
    assert.ok(groups.length >= 5, 'Expanded toolbar must have multiple groups');
    assert.ok(hostArticle.querySelector('[aria-label*="параграф" i]'));
    assert.ok(hostArticle.querySelector('[aria-label*="H1" i]'));
    assert.ok(hostArticle.querySelector('[aria-label*="Нумерованный" i]'));
    assert.ok(hostArticle.querySelector('[aria-label*="Таблица" i]'));
    assert.ok(hostArticle.querySelector('[aria-label*="Отменить" i]'));
    assert.ok(hostArticle.querySelector('[aria-label*="Повторить" i]'));

    const hostBasic = dom.window.document.createElement('div');
    dom.window.document.body.append(hostBasic);
    attachEditor(hostBasic, { variant: 'basic' });
    assert.ok(!hostBasic.classList.contains('article-editor'));
    assert.ok(hostBasic.querySelector('.style-select'), 'Basic editor must keep style-select');
    assert.equal(hostBasic.querySelectorAll('.toolbar-group').length, 0);
  } finally {
    cleanup();
  }
});

test('ARTICLE EDITOR: selection-aware wrapping and placeholder selection', () => {
  const { dom, cleanup } = setupDom();
  try {
    const host = dom.window.document.createElement('div');
    dom.window.document.body.append(host);
    const ed = attachEditor(host, { value: 'Hello world', variant: 'article' });
    const textarea = host.querySelector('textarea');

    // Select "world" (indices 6 to 11)
    textarea.setSelectionRange(6, 11);
    const boldBtn = host.querySelector('[aria-label*="Жирный" i]');
    boldBtn.click();

    assert.equal(ed.getValue(), 'Hello **world**');
    assert.equal(textarea.selectionStart, 8);
    assert.equal(textarea.selectionEnd, 13);

    // Empty selection: insert placeholder and select it
    textarea.setSelectionRange(0, 0);
    const italicBtn = host.querySelector('[aria-label*="Курсив" i]');
    italicBtn.click();
    assert.match(ed.getValue(), /^\*курсив\*Hello/);
    assert.equal(ed.getSelection(), 'курсив');
  } finally {
    cleanup();
  }
});

test('ARTICLE EDITOR: numbered list multiline conversion and empty insertion', () => {
  const { dom, cleanup } = setupDom();
  try {
    const host = dom.window.document.createElement('div');
    dom.window.document.body.append(host);
    const ed = attachEditor(host, { value: 'one\ntwo\nthree', variant: 'article' });
    const textarea = host.querySelector('textarea');

    // Select all lines
    textarea.setSelectionRange(0, textarea.value.length);
    const numBtn = host.querySelector('[aria-label*="Нумерованный" i]');
    numBtn.click();
    assert.equal(ed.getValue(), '1. one\n2. two\n3. three');

    // Empty selection
    const host2 = dom.window.document.createElement('div');
    dom.window.document.body.append(host2);
    const ed2 = attachEditor(host2, { value: '', variant: 'article' });
    const numBtn2 = host2.querySelector('[aria-label*="Нумерованный" i]');
    numBtn2.click();
    assert.equal(ed2.getValue(), '1. Пункт');
    assert.equal(ed2.getSelection(), 'Пункт');
  } finally {
    cleanup();
  }
});

test('ARTICLE EDITOR: quote dialog with and without author', () => {
  const { dom, cleanup } = setupDom();
  try {
    const host = dom.window.document.createElement('div');
    dom.window.document.body.append(host);
    const ed = attachEditor(host, { value: 'Цитата дня', variant: 'article' });
    const textarea = host.querySelector('textarea');
    textarea.setSelectionRange(0, textarea.value.length);

    const quoteBtn = host.querySelector('[aria-label*="Цитата" i]');
    quoteBtn.click();

    const backdrop = host.querySelector('.editor-dialog-backdrop');
    assert.ok(backdrop, 'Quote modal must open');
    const quoteText = backdrop.querySelector('#quote-modal-text');
    const authorInput = backdrop.querySelector('#quote-modal-author');
    assert.equal(quoteText.value, 'Цитата дня');

    authorInput.value = 'Лев Толстой';
    const confirmBtn = backdrop.querySelector('.dialog-actions .primary');
    confirmBtn.click();

    assert.ok(!host.querySelector('.editor-dialog-backdrop'), 'Modal must be closed after submit');
    assert.equal(ed.getValue().trim(), '> Цитата дня\n>\n> — Лев Толстой');

    // Quote without author
    const host2 = dom.window.document.createElement('div');
    dom.window.document.body.append(host2);
    const ed2 = attachEditor(host2, { value: 'Простая цитата', variant: 'article' });
    const textarea2 = host2.querySelector('textarea');
    textarea2.setSelectionRange(0, textarea2.value.length);

    host2.querySelector('[aria-label*="Цитата" i]').click();
    const backdrop2 = host2.querySelector('.editor-dialog-backdrop');
    backdrop2.querySelector('.dialog-actions .primary').click();
    assert.equal(ed2.getValue().trim(), '> Простая цитата');
  } finally {
    cleanup();
  }
});

test('ARTICLE EDITOR: code dialog with explicit language and empty language', () => {
  const { dom, cleanup } = setupDom();
  try {
    const host = dom.window.document.createElement('div');
    dom.window.document.body.append(host);
    const ed = attachEditor(host, { value: 'const answer = 42;', variant: 'article' });
    const textarea = host.querySelector('textarea');
    textarea.setSelectionRange(0, textarea.value.length);

    const codeBtn = host.querySelector('[aria-label*="Блок кода" i]');
    codeBtn.click();

    const backdrop = host.querySelector('.editor-dialog-backdrop');
    assert.ok(backdrop, 'Code modal must open');
    const langInput = backdrop.querySelector('#code-modal-lang');
    const codeArea = backdrop.querySelector('#code-modal-code');
    assert.equal(codeArea.value, 'const answer = 42;');

    langInput.value = 'ts';
    backdrop.querySelector('.dialog-actions .primary').click();

    assert.equal(ed.getValue().trim(), '```ts\nconst answer = 42;\n```');

    // Code dialog with empty language (must NOT generate text/plain)
    const host2 = dom.window.document.createElement('div');
    dom.window.document.body.append(host2);
    const ed2 = attachEditor(host2, { value: 'echo hi', variant: 'article' });
    const textarea2 = host2.querySelector('textarea');
    textarea2.setSelectionRange(0, textarea2.value.length);

    host2.querySelector('[aria-label*="Блок кода" i]').click();
    const backdrop2 = host2.querySelector('.editor-dialog-backdrop');
    backdrop2.querySelector('.dialog-actions .primary').click();

    assert.equal(ed2.getValue().trim(), '```\necho hi\n```');
    assert.doesNotMatch(ed2.getValue(), /```text|```plain/);
  } finally {
    cleanup();
  }
});

test('ARTICLE EDITOR: link dialog with safe URL and javascript rejection', () => {
  const { dom, cleanup } = setupDom();
  try {
    const host = dom.window.document.createElement('div');
    dom.window.document.body.append(host);
    const ed = attachEditor(host, { value: 'Документация', variant: 'article' });
    const textarea = host.querySelector('textarea');
    textarea.setSelectionRange(0, textarea.value.length);

    const linkBtn = host.querySelector('[aria-label*="Ссылка" i]');
    linkBtn.click();

    const backdrop = host.querySelector('.editor-dialog-backdrop');
    assert.ok(backdrop, 'Link modal must open');
    const textInput = backdrop.querySelector('#link-modal-text');
    const urlInput = backdrop.querySelector('#link-modal-url');
    assert.equal(textInput.value, 'Документация');

    // Try unsafe javascript: URL
    urlInput.value = 'javascript:alert(1)';
    backdrop.querySelector('.dialog-actions .primary').click();
    assert.ok(host.querySelector('.editor-dialog-backdrop'), 'Modal must stay open on invalid URL');
    assert.equal(backdrop.querySelector('.dialog-error').hidden, false);

    // Provide safe URL
    urlInput.value = 'https://helper.slutvibe.site/docs';
    backdrop.querySelector('.dialog-actions .primary').click();
    assert.ok(!host.querySelector('.editor-dialog-backdrop'), 'Modal must close on valid URL');
    assert.equal(ed.getValue(), '[Документация](https://helper.slutvibe.site/docs)');
  } finally {
    cleanup();
  }
});

test('ARTICLE EDITOR: table insertion dialog generates clean GFM table', () => {
  const { dom, cleanup } = setupDom();
  try {
    const host = dom.window.document.createElement('div');
    dom.window.document.body.append(host);
    const ed = attachEditor(host, { value: '', variant: 'article' });

    const tableBtn = host.querySelector('[aria-label*="Таблица" i]');
    tableBtn.click();

    const backdrop = host.querySelector('.editor-dialog-backdrop');
    assert.ok(backdrop, 'Table modal must open');
    const colsInput = backdrop.querySelector('#table-modal-cols');
    const rowsInput = backdrop.querySelector('#table-modal-rows');
    colsInput.value = '3';
    rowsInput.value = '2';

    backdrop.querySelector('.dialog-actions .primary').click();
    const val = ed.getValue().trim();
    assert.match(val, /\| Колонка 1 \| Колонка 2 \| Колонка 3 \|/);
    assert.match(val, /\| --- \| --- \| --- \|/);
    const rows = val.split('\n');
    assert.equal(rows.length, 4); // header + delimiter + 2 body rows
  } finally {
    cleanup();
  }
});

test('ARTICLE EDITOR: horizontal rule and undo/redo', () => {
  const { dom, cleanup } = setupDom();
  try {
    const host = dom.window.document.createElement('div');
    dom.window.document.body.append(host);
    const ed = attachEditor(host, { value: 'Параграф 1\n\nПараграф 2', variant: 'article' });
    const textarea = host.querySelector('textarea');
    textarea.setSelectionRange(11, 11);

    const hrBtn = host.querySelector('[aria-label*="Разделитель" i]');
    hrBtn.click();

    assert.match(ed.getValue(), /Параграф 1\n\n---\n\nПараграф 2/);

    // Undo
    const undoBtn = host.querySelector('[aria-label*="Отменить" i]');
    undoBtn.click();
    assert.equal(ed.getValue(), 'Параграф 1\n\nПараграф 2');

    // Redo
    const redoBtn = host.querySelector('[aria-label*="Повторить" i]');
    redoBtn.click();
    assert.match(ed.getValue(), /---\n\nПараграф 2/);
  } finally {
    cleanup();
  }
});

test('ARTICLE EDITOR: mode switching between editor, split, preview', () => {
  const { dom, cleanup } = setupDom();
  try {
    const host = dom.window.document.createElement('div');
    dom.window.document.body.append(host);
    attachEditor(host, { value: '# Заголовок статьи\n\nТекст', variant: 'article' });

    const textarea = host.querySelector('textarea');
    const preview = host.querySelector('.preview');
    const modeSelect = host.querySelector('.mode-select');

    // Initial editor mode
    assert.equal(textarea.hidden, false);
    assert.equal(preview.hidden, true);

    // Switch to split
    modeSelect.value = 'split';
    modeSelect.dispatchEvent(new dom.window.Event('change'));
    assert.equal(textarea.hidden, false);
    assert.equal(preview.hidden, false);

    // Switch to preview
    modeSelect.value = 'preview';
    modeSelect.dispatchEvent(new dom.window.Event('change'));
    assert.equal(textarea.hidden, true);
    assert.equal(preview.hidden, false);

    // Switch back to editor
    modeSelect.value = 'editor';
    modeSelect.dispatchEvent(new dom.window.Event('change'));
    assert.equal(textarea.hidden, false);
    assert.equal(preview.hidden, true);
  } finally {
    cleanup();
  }
});

test('ARTICLE EDITOR: dialog accessibility, aria-labels, and escape dismissal', () => {
  const { dom, cleanup } = setupDom();
  try {
    const host = dom.window.document.createElement('div');
    dom.window.document.body.append(host);
    attachEditor(host, { value: 'Цитата для проверки Esc', variant: 'article' });

    // Verify all buttons have aria-label and title
    const buttons = host.querySelectorAll('.format-bar__format button');
    buttons.forEach(b => {
      assert.ok(b.getAttribute('aria-label'), `Button must have aria-label: ${b.outerHTML}`);
      assert.ok(b.title, `Button must have title: ${b.outerHTML}`);
    });

    // Open quote dialog
    host.querySelector('[aria-label*="Цитата" i]').click();
    const backdrop = host.querySelector('.editor-dialog-backdrop');
    assert.ok(backdrop);
    assert.equal(backdrop.getAttribute('role'), 'dialog');
    assert.equal(backdrop.getAttribute('aria-modal'), 'true');

    // Press Escape
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.ok(!host.querySelector('.editor-dialog-backdrop'), 'Escape key must close dialog');
  } finally {
    cleanup();
  }
});

test('MOBILE: CSS ensures no horizontal overflow on 375px viewport', () => {
  const workbenchCss = fs.readFileSync(path.resolve(process.cwd(), 'src/workbench.css'), 'utf8');
  assert.match(workbenchCss, /\.format-bar\s*\{[^}]*max-width:\s*100%/);
  assert.match(workbenchCss, /\.format-bar\s*\{[^}]*box-sizing:\s*border-box/);
  assert.match(workbenchCss, /\.toolbar-group/);
  assert.match(workbenchCss, /\.editor-dialog\s*\{[^}]*box-sizing:\s*border-box/);
});

