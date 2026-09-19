import { renderMarkdown } from './security.js';
import { enhanceDiagrams } from './diagram.js';
import { icon } from './icons.js';

function getPref(key, fallback) {
  try {
    const val = localStorage.getItem(key);
    return val !== null ? val : fallback;
  } catch {
    return fallback;
  }
}

function setPref(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {}
}

export function attachEditor(host, {
  value = '',
  onChange = () => {},
  onLink = () => {},
  onError = () => {},
  onImageRequest = null,
  id = 'source',
  imageStore = null,
  variant = 'basic',
} = {}) {
  let savedMode = getPref('helper:editor:view', 'editor');
  let mode = ['split', 'preview'].includes(savedMode) ? savedMode : 'editor';

  let savedSplit = parseInt(getPref('helper:editor:split', '50'), 10);
  let splitRatio = (!isNaN(savedSplit) && savedSplit >= 30 && savedSplit <= 70) ? savedSplit : 50;

  if (variant === 'article') {
    host.classList.add('article-editor');
  }

  host.innerHTML = `
    <div class="format-bar" role="toolbar" aria-label="Форматирование Markdown">
      <div class="format-bar__format"></div>
      <div class="format-bar__view"></div>
    </div>
    <div class="editor ${mode === 'split' ? 'split' : ''}">
      <textarea id="${id}" aria-label="Markdown текст" spellcheck="false" placeholder="Начни писать…" ${mode === 'preview' ? 'hidden' : ''}></textarea>
      <article class="preview" aria-label="Предпросмотр" ${mode === 'editor' ? 'hidden' : ''}></article>
    </div>
    <div class="editor-footer">
      <span class="word-count"></span>
      <span>Ctrl/⌘ B, I, K · Markdown</span>
    </div>
  `;

  const text = host.querySelector('textarea');
  const preview = host.querySelector('.preview');
  const formatGroup = host.querySelector('.format-bar__format');
  const viewGroup = host.querySelector('.format-bar__view');
  const editorBox = host.querySelector('.editor');
  const wordCount = host.querySelector('.word-count');

  text.value = value;
  let lastValue = value;
  let initializing = true;
  let undoStack = [];
  let redoStack = [];
  let renderVersion = 0;

  const pushState = () => {
    undoStack.push(lastValue);
    if (undoStack.length > 150) undoStack.shift();
    redoStack = [];
  };

  const restore = val => {
    text.value = val;
    lastValue = val;
    text.focus();
    emit();
  };

  const doUndo = () => {
    if (undoStack.length) {
      redoStack.push(lastValue);
      restore(undoStack.pop());
    }
  };

  const doRedo = () => {
    if (redoStack.length) {
      undoStack.push(lastValue);
      restore(redoStack.pop());
    }
  };

  const renderInto = (target, val) => {
    const version = ++renderVersion;
    const source = imageStore
      ? val.replace(/\((attachment:\/\/[a-zA-Z0-9_-]+)\)/g, (match, url) => {
          const data = imageStore.get(url.slice(13));
          return data ? `(${data})` : match;
        })
      : val;
    target.innerHTML = renderMarkdown(source);
    enhanceDiagrams(target).catch(() => {}).then(() => {
      if (version !== renderVersion) return;
    });
  };

  const emit = () => {
    renderInto(preview, text.value);
    const trimmed = text.value.trim();
    wordCount.textContent = `${trimmed ? trimmed.split(/\s+/).length : 0} слов · ${text.value.length} символов`;
    if (!initializing) onChange(text.value);
  };

  function insert(before, after = '', placeholder = 'текст') {
    pushState();
    const start = text.selectionStart;
    const end = text.selectionEnd;
    const selection = text.value.slice(start, end) || placeholder;
    text.setRangeText(before + selection + after, start, end, 'select');
    lastValue = text.value;
    text.focus();
    emit();
  }

  function formatInline(before, after, placeholder = 'текст') {
    pushState();
    const start = text.selectionStart;
    const end = text.selectionEnd;
    const val = text.value;
    if (start === end) {
      text.setRangeText(before + placeholder + after, start, end, 'end');
      text.setSelectionRange(start + before.length, start + before.length + placeholder.length);
    } else {
      const sel = val.slice(start, end);
      text.setRangeText(before + sel + after, start, end, 'end');
      text.setSelectionRange(start + before.length, start + before.length + sel.length);
    }
    lastValue = text.value;
    text.focus();
    emit();
  }

  function applyHeading(level) {
    pushState();
    const start = text.selectionStart;
    const end = text.selectionEnd;
    const val = text.value;
    const lineStart = val.lastIndexOf('\n', start - 1) + 1;
    const lineEndIdx = val.indexOf('\n', end);
    const lineEnd = lineEndIdx === -1 ? val.length : lineEndIdx;
    const block = val.slice(lineStart, lineEnd);
    const lines = block.split('\n');
    const prefix = level > 0 ? `${'#'.repeat(level)} ` : '';
    const newLines = lines.map(line => {
      const cleaned = line.replace(/^#{1,6}\s+/, '');
      return prefix + cleaned;
    });
    const replacement = newLines.join('\n');
    text.setRangeText(replacement, lineStart, lineEnd, 'select');
    lastValue = text.value;
    text.focus();
    emit();
  }

  function applyList(type) {
    pushState();
    const start = text.selectionStart;
    const end = text.selectionEnd;
    const val = text.value;

    if (start === end) {
      const prefix = type === 'numbered' ? '1. ' : type === 'check' ? '- [ ] ' : '- ';
      const placeholder = 'Пункт';
      const preceding = val.slice(0, start);
      const needNewline = preceding.length && !preceding.endsWith('\n') ? '\n' : '';
      text.setRangeText(needNewline + prefix + placeholder, start, end, 'end');
      const selStart = start + needNewline.length + prefix.length;
      text.setSelectionRange(selStart, selStart + placeholder.length);
    } else {
      const lineStart = val.lastIndexOf('\n', start - 1) + 1;
      const lineEndIdx = val.indexOf('\n', end);
      const lineEnd = lineEndIdx === -1 ? val.length : lineEndIdx;
      const block = val.slice(lineStart, lineEnd);
      const lines = block.split('\n');
      const newLines = lines.map((line, idx) => {
        const cleaned = line.replace(/^(\s*)(?:[-*+]|\d+\.)(?:\s+\[[ xX]\])?\s*/, '$1');
        if (type === 'numbered') {
          return `${idx + 1}. ${cleaned}`;
        } else if (type === 'check') {
          return `- [ ] ${cleaned}`;
        } else {
          return `- ${cleaned}`;
        }
      });
      const replacement = newLines.join('\n');
      text.setRangeText(replacement, lineStart, lineEnd, 'select');
    }
    lastValue = text.value;
    text.focus();
    emit();
  }

  function insertHorizontalRule() {
    pushState();
    const start = text.selectionStart;
    const end = text.selectionEnd;
    const val = text.value;
    const before = val.slice(0, start);
    const after = val.slice(end);
    const prefix = !before.length || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const suffix = !after.length || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
    text.setRangeText(prefix + '---' + suffix, start, end, 'end');
    lastValue = text.value;
    text.focus();
    emit();
  }

  function createModal(titleText, contentEl, onConfirm) {
    const backdrop = document.createElement('div');
    backdrop.className = 'editor-dialog-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-label', titleText);

    const dialog = document.createElement('div');
    dialog.className = 'editor-dialog';

    const title = document.createElement('h3');
    title.textContent = titleText;
    dialog.append(title, contentEl);

    const actions = document.createElement('div');
    actions.className = 'dialog-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'quiet';
    cancelBtn.textContent = 'Отмена';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'primary';
    confirmBtn.textContent = 'Вставить';

    actions.append(cancelBtn, confirmBtn);
    dialog.append(actions);
    backdrop.append(dialog);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', handleKey);
      backdrop.remove();
      text.focus();
    };

    const handleKey = e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.target.tagName !== 'TEXTAREA')) {
        if (!e.target.closest('.dialog-hints')) {
          e.preventDefault();
          onConfirm(close);
        }
      }
    };

    cancelBtn.onclick = () => close();
    confirmBtn.onclick = () => onConfirm(close);
    backdrop.onclick = e => {
      if (e.target === backdrop) close();
    };
    document.addEventListener('keydown', handleKey);

    host.append(backdrop);
    return { backdrop, dialog, close, confirmBtn };
  }

  function openQuoteDialog() {
    const start = text.selectionStart;
    const end = text.selectionEnd;
    const selected = text.value.slice(start, end).trim();

    const form = document.createElement('div');
    form.innerHTML = `
      <div class="field-group">
        <label for="quote-modal-text">Цитата</label>
        <textarea id="quote-modal-text" placeholder="Текст цитаты…"></textarea>
      </div>
      <div class="field-group">
        <label for="quote-modal-author">Автор (необязательно)</label>
        <input type="text" id="quote-modal-author" placeholder="Имя автора или источник">
      </div>
    `;

    const quoteInput = form.querySelector('#quote-modal-text');
    const authorInput = form.querySelector('#quote-modal-author');

    if (selected) {
      quoteInput.value = selected;
    }

    createModal('Вставить цитату', form, done => {
      const q = quoteInput.value.trim();
      const a = authorInput.value.trim();
      if (!q) {
        done();
        return;
      }
      const quoteLines = q.split('\n').map(l => `> ${l}`).join('\n');
      const val = text.value;
      const before = val.slice(0, start);
      const after = val.slice(end);
      const prefix = !before.length || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
      const suffix = !after.length || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
      const md = a ? `${quoteLines}\n>\n> — ${a}` : quoteLines;
      pushState();
      text.setRangeText(prefix + md + suffix, start, end, 'end');
      lastValue = text.value;
      emit();
      done();
    });

    setTimeout(() => {
      if (selected) authorInput.focus();
      else quoteInput.focus();
    }, 0);
  }

  function openCodeBlockDialog() {
    const start = text.selectionStart;
    const end = text.selectionEnd;
    const selected = text.value.slice(start, end);

    const form = document.createElement('div');
    form.innerHTML = `
      <div class="field-group">
        <label for="code-modal-lang">Язык (необязательно)</label>
        <input type="text" id="code-modal-lang" placeholder="например, js, ts, python">
        <div class="dialog-hints">
          <span class="hint-chip" data-lang="js">js</span>
          <span class="hint-chip" data-lang="ts">ts</span>
          <span class="hint-chip" data-lang="html">html</span>
          <span class="hint-chip" data-lang="css">css</span>
          <span class="hint-chip" data-lang="json">json</span>
          <span class="hint-chip" data-lang="bash">bash</span>
          <span class="hint-chip" data-lang="sql">sql</span>
          <span class="hint-chip" data-lang="python">python</span>
        </div>
      </div>
      <div class="field-group">
        <label for="code-modal-code">Код</label>
        <textarea id="code-modal-code" placeholder="Вставь или напиши код…"></textarea>
      </div>
    `;

    const langInput = form.querySelector('#code-modal-lang');
    const codeTextarea = form.querySelector('#code-modal-code');

    form.querySelectorAll('.hint-chip').forEach(chip => {
      chip.onclick = () => {
        langInput.value = chip.getAttribute('data-lang');
        codeTextarea.focus();
      };
    });

    if (selected) {
      codeTextarea.value = selected;
    }

    createModal('Вставить блок кода', form, done => {
      const lang = langInput.value.trim().toLowerCase();
      const code = codeTextarea.value;
      const fence = '```';
      const block = lang ? `${fence}${lang}\n${code}\n${fence}` : `${fence}\n${code}\n${fence}`;
      const val = text.value;
      const before = val.slice(0, start);
      const after = val.slice(end);
      const prefix = !before.length || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
      const suffix = !after.length || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
      pushState();
      text.setRangeText(prefix + block + suffix, start, end, 'end');
      lastValue = text.value;
      emit();
      done();
    });

    setTimeout(() => {
      if (selected) langInput.focus();
      else codeTextarea.focus();
    }, 0);
  }

  function openLinkDialog() {
    const start = text.selectionStart;
    const end = text.selectionEnd;
    const selected = text.value.slice(start, end).trim();

    const form = document.createElement('div');
    form.innerHTML = `
      <div class="field-group">
        <label for="link-modal-text">Текст ссылки</label>
        <input type="text" id="link-modal-text" placeholder="Текст ссылки">
      </div>
      <div class="field-group">
        <label for="link-modal-url">Адрес (URL)</label>
        <input type="text" id="link-modal-url" placeholder="https://…">
        <span class="dialog-error" hidden></span>
      </div>
    `;

    const textInput = form.querySelector('#link-modal-text');
    const urlInput = form.querySelector('#link-modal-url');
    const errSpan = form.querySelector('.dialog-error');

    if (selected) {
      textInput.value = selected;
    }

    createModal('Вставить ссылку', form, done => {
      const linkText = textInput.value.trim() || 'ссылка';
      const url = urlInput.value.trim();
      const isSafe = /^https?:\/\//i.test(url) || /^(\.\.?\/|\/(?!\/)|#)/.test(url);
      if (!isSafe || /^javascript:/i.test(url)) {
        errSpan.textContent = 'Укажи безопасный адрес (https://, http:// или относительный путь)';
        errSpan.hidden = false;
        urlInput.focus();
        return;
      }
      errSpan.hidden = true;
      const safeTitle = linkText.replace(/[\[\]]/g, '');
      const md = `[${safeTitle}](${url})`;
      pushState();
      text.setRangeText(md, start, end, 'end');
      lastValue = text.value;
      emit();
      done();
    });

    setTimeout(() => {
      if (selected) urlInput.focus();
      else textInput.focus();
    }, 0);
  }

  function openTableDialog() {
    const start = text.selectionStart;
    const end = text.selectionEnd;

    const form = document.createElement('div');
    form.innerHTML = `
      <div class="field-group">
        <label for="table-modal-cols">Колонок (2–6)</label>
        <input type="number" id="table-modal-cols" min="2" max="6" value="3">
      </div>
      <div class="field-group">
        <label for="table-modal-rows">Строк данных (1–10)</label>
        <input type="number" id="table-modal-rows" min="1" max="10" value="2">
      </div>
      <div class="field-group">
        <label class="dialog-check">
          <input type="checkbox" id="table-modal-header" checked>
          <span>Заголовок таблицы</span>
        </label>
      </div>
    `;

    const colsInput = form.querySelector('#table-modal-cols');
    const rowsInput = form.querySelector('#table-modal-rows');
    const headerCheck = form.querySelector('#table-modal-header');

    createModal('Вставить таблицу', form, done => {
      const cols = Math.max(2, Math.min(6, parseInt(colsInput.value, 10) || 3));
      const rows = Math.max(1, Math.min(10, parseInt(rowsInput.value, 10) || 2));
      const hasHeader = headerCheck.checked;

      const lines = [];
      if (hasHeader) {
        lines.push(`| ${Array.from({ length: cols }, (_, i) => `Колонка ${i + 1}`).join(' | ')} |`);
        lines.push(`| ${Array.from({ length: cols }, () => '---').join(' | ')} |`);
      } else {
        lines.push(`| ${Array.from({ length: cols }, () => ' ').join(' | ')} |`);
        lines.push(`| ${Array.from({ length: cols }, () => '---').join(' | ')} |`);
      }
      for (let r = 0; r < rows; r++) {
        lines.push(`| ${Array.from({ length: cols }, () => ' ').join(' | ')} |`);
      }
      const tableMd = lines.join('\n');
      const val = text.value;
      const before = val.slice(0, start);
      const after = val.slice(end);
      const prefix = !before.length || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
      const suffix = !after.length || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
      pushState();
      text.setRangeText(prefix + tableMd + suffix, start, end, 'end');
      lastValue = text.value;
      emit();
      done();
    });

    setTimeout(() => colsInput.focus(), 0);
  }

  function keydown(e) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        doRedo();
      } else {
        doUndo();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      doRedo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === 'b') {
        e.preventDefault();
        formatInline('**', '**', 'жирный текст');
        return;
      }
      if (key === 'i') {
        e.preventDefault();
        formatInline('*', '*', 'курсив');
        return;
      }
      if (key === 'k') {
        e.preventDefault();
        if (variant === 'article') {
          openLinkDialog();
        } else {
          insert('[', '](https://example.com)', 'текст ссылки');
        }
        return;
      }
    }
    const start = text.selectionStart;
    const end = text.selectionEnd;
    const preceding = text.value.slice(0, start);
    const line = preceding.slice(preceding.lastIndexOf('\n') + 1);
    if (e.key === 'Tab' && (preceding.match(/^```/gm) || []).length % 2) {
      e.preventDefault();
      pushState();
      text.setRangeText('  ', start, end, 'end');
      lastValue = text.value;
      emit();
      return;
    }
    if (e.key === 'Enter' && start === end) {
      const m = line.match(/^(\s*)([-*+]|\d+\.)(\s+)(\[[ xX]\]\s+)?(.*)$/);
      if (m) {
        e.preventDefault();
        pushState();
        if (!m[5].trim()) {
          text.setRangeText('', start - line.length, end, 'end');
        } else {
          const nextPrefix = /\d/.test(m[2]) ? `${parseInt(m[2], 10) + 1}.` : m[2];
          const checkPart = m[4] ? '[ ] ' : '';
          text.setRangeText(`\n${m[1]}${nextPrefix} ${checkPart}`, start, end, 'end');
        }
        lastValue = text.value;
        emit();
      }
    }
  }

  function makeBtn(iconName, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-button';
    b.append(icon(iconName));
    b.title = title;
    b.setAttribute('aria-label', title);
    b.onmousedown = e => e.preventDefault();
    b.onclick = onClick;
    return b;
  }

  function makeGroup(buttons) {
    const g = document.createElement('div');
    g.className = 'toolbar-group';
    buttons.forEach(b => g.append(b));
    return g;
  }

  if (variant === 'article') {
    // TEXT STYLE
    const styleGroup = makeGroup([
      makeBtn('paragraph', 'Обычный текст (параграф)', () => applyHeading(0)),
      makeBtn('h1', 'Заголовок 1 (H1)', () => applyHeading(1)),
      makeBtn('h2', 'Заголовок 2 (H2)', () => applyHeading(2)),
      makeBtn('h3', 'Заголовок 3 (H3)', () => applyHeading(3)),
    ]);

    // INLINE
    const inlineGroup = makeGroup([
      makeBtn('bold', 'Жирный · Ctrl/⌘ B', () => formatInline('**', '**', 'жирный текст')),
      makeBtn('italic', 'Курсив · Ctrl/⌘ I', () => formatInline('*', '*', 'курсив')),
      makeBtn('strike', 'Зачёркивание', () => formatInline('~~', '~~', 'зачёркнутый текст')),
      makeBtn('code', 'Встроенный код', () => formatInline('`', '`', 'код')),
    ]);

    // LISTS
    const listGroup = makeGroup([
      makeBtn('list', 'Маркированный список', () => applyList('bullet')),
      makeBtn('numberedList', 'Нумерованный список', () => applyList('numbered')),
      makeBtn('checklist', 'Подзадачи / чеклист', () => applyList('check')),
    ]);

    // BLOCKS
    const blockGroup = makeGroup([
      makeBtn('quote', 'Цитата', () => openQuoteDialog()),
      makeBtn('codeBlock', 'Блок кода', () => openCodeBlockDialog()),
      makeBtn('separator', 'Разделитель (---)', () => insertHorizontalRule()),
      makeBtn('table', 'Таблица', () => openTableDialog()),
    ]);

    // INSERT
    const insertGroup = makeGroup([
      makeBtn('link', 'Ссылка · Ctrl/⌘ K', () => openLinkDialog()),
      makeBtn('image', 'Изображение', () => {
        if (onImageRequest) {
          onImageRequest({ insert });
        } else {
          insert('![описание|640](', ')', 'https://example.com/image.jpg');
        }
      }),
    ]);

    // HISTORY
    const historyGroup = makeGroup([
      makeBtn('undo', 'Отменить · Ctrl/⌘ Z', doUndo),
      makeBtn('redo', 'Повторить · Ctrl/⌘ Shift+Z', doRedo),
    ]);

    formatGroup.append(styleGroup, inlineGroup, listGroup, blockGroup, insertGroup, historyGroup);
  } else {
    // Basic variant (compact toolbar for tasks & notes)
    const styleSelect = document.createElement('select');
    styleSelect.className = 'style-select';
    styleSelect.setAttribute('aria-label', 'Стиль строки');
    styleSelect.innerHTML = '<option value="">Стиль</option><option value="p">Обычный текст</option><option value="1">H1</option><option value="2">H2</option><option value="3">H3</option>';
    styleSelect.onchange = () => {
      const val = styleSelect.value;
      if (val === 'p') applyHeading(0);
      else if (val === '1' || val === '2' || val === '3') applyHeading(parseInt(val, 10));
      styleSelect.value = '';
    };
    formatGroup.append(styleSelect);

    const formats = [
      ['bold', 'Жирный · Ctrl/⌘ B', '**', '**'],
      ['italic', 'Курсив · Ctrl/⌘ I', '*', '*'],
      ['strike', 'Зачёркивание', '~~', '~~'],
      ['list', 'Список', '- ', ''],
      ['checklist', 'Подзадачи / чеклист', '- [ ] ', ''],
      ['link', 'Ссылка · Ctrl/⌘ K', '[', '](https://example.com)'],
      ['code', 'Код', '`', '`'],
      ['codeBlock', 'Блок кода', '```\n', '\n```'],
      ['quote', 'Цитата', '> ', ''],
      ['image', 'Изображение', '![описание|640](', ')', 'https://example.com/image.jpg'],
    ];

    formats.forEach(([iconName, title, before, after, placeholder]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'icon-button';
      b.append(icon(iconName));
      b.title = title;
      b.setAttribute('aria-label', title);
      b.onmousedown = e => e.preventDefault();
      if (iconName === 'image' && onImageRequest) {
        b.onclick = () => onImageRequest({ insert });
      } else {
        b.onclick = () => insert(before, after, placeholder);
      }
      formatGroup.append(b);
    });
  }

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
  fileInput.hidden = true;

  async function attachImage(image) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(image.type) || image.size > 1024 * 1024) {
      onError('Выбери PNG, JPEG, WebP или GIF до 1 МБ. Для больших фото можно вставить HTTPS-ссылку.');
      return;
    }
    if (!imageStore) {
      onError('Для изображения в задаче вставь HTTPS-ссылку. Локальные фото доступны в заметках.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (!host.isConnected) return;
      try {
        const data = String(reader.result);
        const reference = `attachment://${imageStore.add({ name: image.name, type: image.type, data })}`;
        insert('\n![изображение|640](', ')\n', reference);
      } catch {
        onError('Не удалось сохранить изображение в заметке.');
      }
    };
    reader.onerror = () => onError('Не удалось прочитать изображение.');
    reader.readAsDataURL(image);
  }

  fileInput.onchange = () => {
    if (fileInput.files[0]) attachImage(fileInput.files[0]);
    fileInput.value = '';
  };

  if (imageStore) {
    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'icon-button image-upload';
    uploadBtn.append(icon('imagePlus'), document.createTextNode('Фото'));
    uploadBtn.title = 'Вставить фото с устройства (до 1 МБ)';
    uploadBtn.onmousedown = e => e.preventDefault();
    uploadBtn.onclick = () => fileInput.click();
    formatGroup.append(uploadBtn, fileInput);
  }

  host.addEventListener('paste', e => {
    const image = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
    if (image) {
      e.preventDefault();
      attachImage(image);
    }
  });

  host.addEventListener('dragover', e => {
    if (imageStore && [...(e.dataTransfer?.items || [])].some(item => item.type.startsWith('image/'))) {
      e.preventDefault();
      host.classList.add('drag-image');
    }
  });
  host.addEventListener('dragleave', () => host.classList.remove('drag-image'));
  host.addEventListener('drop', e => {
    host.classList.remove('drag-image');
    const image = [...(e.dataTransfer?.files || [])].find(item => item.type.startsWith('image/'));
    if (image) {
      e.preventDefault();
      attachImage(image);
    }
  });

  // Mode select & Split control
  const modeSelect = document.createElement('select');
  modeSelect.className = 'mode-select';
  modeSelect.setAttribute('aria-label', 'Режим редактора');
  modeSelect.innerHTML = '<option value="editor">Редактор</option><option value="split">Редактор + просмотр</option><option value="preview">Просмотр</option>';
  modeSelect.value = mode;

  const splitControl = document.createElement('label');
  splitControl.className = 'split-control';
  splitControl.title = 'Ширина редактора и предпросмотра';
  splitControl.innerHTML = `<span>Ширина</span><input type="range" min="30" max="70" value="${splitRatio}" aria-label="Ширина редактора">`;
  const splitRange = splitControl.querySelector('input');

  function applyModeLayout() {
    if (mode === 'split') {
      editorBox.className = 'editor split';
      editorBox.style.gridTemplateColumns = `minmax(0, ${splitRatio}fr) minmax(0, ${100 - splitRatio}fr)`;
      text.hidden = false;
      preview.hidden = false;
      splitControl.hidden = false;
      splitControl.style.display = '';
      splitRange.disabled = false;
      splitRange.tabIndex = 0;
      formatGroup.hidden = false;
      renderInto(preview, text.value);
    } else if (mode === 'preview') {
      editorBox.className = 'editor';
      editorBox.style.gridTemplateColumns = '1fr';
      text.hidden = true;
      preview.hidden = false;
      splitControl.hidden = true;
      splitControl.style.display = 'none';
      splitRange.disabled = true;
      splitRange.tabIndex = -1;
      formatGroup.hidden = true;
      renderInto(preview, text.value);
    } else {
      editorBox.className = 'editor';
      editorBox.style.gridTemplateColumns = '1fr';
      text.hidden = false;
      preview.hidden = true;
      splitControl.hidden = true;
      splitControl.style.display = 'none';
      splitRange.disabled = true;
      splitRange.tabIndex = -1;
      formatGroup.hidden = false;
    }
  }

  modeSelect.onchange = () => {
    mode = modeSelect.value;
    setPref('helper:editor:view', mode);
    applyModeLayout();
    if (mode !== 'preview') text.focus();
  };

  splitRange.oninput = e => {
    splitRatio = Number(e.target.value);
    setPref('helper:editor:split', splitRatio);
    if (mode === 'split') {
      editorBox.style.gridTemplateColumns = `minmax(0, ${splitRatio}fr) minmax(0, ${100 - splitRatio}fr)`;
    }
  };

  viewGroup.append(modeSelect, splitControl);
  applyModeLayout();

  // Details syntax guide
  const help = document.createElement('details');
  help.className = 'editor-help';
  help.innerHTML = '<summary>Справка по синтаксису</summary><div class="syntax-guide"><p><code># H1</code> … <code>###### H6</code> · <code>**жирный**</code> · <code>*курсив*</code> · <code>~~зачёркнутый~~</code></p><p><code>- пункт</code> · <code>1. пункт</code> · <code>- [ ] задача</code> · <code>&gt; цитата</code> · <code>[ссылка](https://…)</code></p><p>Фото: <code>![описание|640](адрес)</code>. Число после <code>|</code> — ширина в пикселях, например <code>320</code> или <code>640x480</code>.</p><p>Таблица: строки с <code>| колонками |</code>. Код: тройные обратные кавычки. Диаграмма: блок кода с языком <code>mermaid</code>. <code>#тег</code> связывает заметки и задачи.</p><p>Enter продолжает список; пустой пункт завершает его. Tab в блоке кода — отступ.</p></div>';
  host.append(help);

  host.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (a?.getAttribute('href')?.startsWith('#note=')) {
      e.preventDefault();
      onLink(a.getAttribute('href').slice(6));
    }
  });

  text.oninput = () => {
    if (text.value !== lastValue) {
      pushState();
      lastValue = text.value;
    }
    emit();
  };
  text.onkeydown = keydown;

  // Toggle checklist inside rendered preview
  preview.addEventListener('click', e => {
    if (e.target.matches('input[type="checkbox"]')) {
      e.preventDefault();
      const checks = [...preview.querySelectorAll('input[type="checkbox"]')];
      const index = checks.indexOf(e.target);
      let seen = -1;
      pushState();
      text.value = text.value.replace(/^(\s*(?:[-*+]|\d+\.)\s+)\[([ xX])\]/gm, (all, prefix, state) => {
        seen++;
        return seen === index ? `${prefix}[${state.trim() ? ' ' : 'x'}]` : all;
      });
      lastValue = text.value;
      emit();
    }
  });

  emit();
  initializing = false;

  return {
    text,
    getValue: () => text.value,
    getSelection: () => text.value.slice(text.selectionStart, text.selectionEnd),
    insertLink: (title, noteId) => insert(`[${title.replace(/[\[\]\\]/g, '')}](`, ')', `#note=${noteId}`),
    undo: doUndo,
    redo: doRedo,
    insert,
  };
}
