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

export function attachEditor(host, { value = '', onChange = () => {}, onLink = () => {}, onError = () => {}, onImageRequest = null, id = 'source', imageStore = null } = {}) {
  let savedMode = getPref('helper:editor:view', 'editor');
  let mode = savedMode === 'split' ? 'split' : 'editor';

  let savedSplit = parseInt(getPref('helper:editor:split', '50'), 10);
  let splitRatio = (!isNaN(savedSplit) && savedSplit >= 30 && savedSplit <= 70) ? savedSplit : 50;

  host.innerHTML = `
    <div class="format-bar" role="toolbar" aria-label="Форматирование Markdown">
      <div class="format-bar__format"></div>
      <div class="format-bar__view"></div>
    </div>
    <div class="editor ${mode === 'split' ? 'split' : ''}">
      <textarea id="${id}" aria-label="Markdown текст" spellcheck="false" placeholder="Начни писать…"></textarea>
      <article class="preview" aria-label="Предпросмотр" ${mode === 'editor' ? 'hidden' : ''}></article>
    </div>
    <div class="editor-footer">
      <span class="word-count"></span>
      <span>Ctrl/⌘ B, I, K · Markdown</span>
    </div>
  `;

  const text = host.querySelector('textarea');
  const preview = host.querySelector('.preview');
  const bar = host.querySelector('.format-bar');
  const formatGroup = host.querySelector('.format-bar__format');
  const viewGroup = host.querySelector('.format-bar__view');
  const editorBox = host.querySelector('.editor');
  const wordCount = host.querySelector('.word-count');

  text.value = value;
  let lastValue = value;
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

  const renderInto = (target, val) => {
    const version = ++renderVersion;
    const source = imageStore
      ? val.replace(/\((attachment:\/\/[a-zA-Z0-9_-]+)\)/g, (match, url) => {
          const data = imageStore.get(url.slice(13));
          return data ? `(${data})` : match;
        })
      : val;
    target.innerHTML = renderMarkdown(source);
    target.querySelectorAll('pre > code[class*="language-"]').forEach(code => {
      const language = code.className.match(/(?:^|\s)language-([\w+-]+)/)?.[1];
      if (!language || code.parentElement.querySelector('.code-language')) return;
      const label = document.createElement('span');
      label.className = 'code-language';
      label.textContent = language;
      code.parentElement.prepend(label);
    });
    enhanceDiagrams(target).catch(() => {}).then(() => {
      if (version !== renderVersion) return;
    });
  };

  const emit = () => {
    renderInto(preview, text.value);
    const trimmed = text.value.trim();
    wordCount.textContent = `${trimmed ? trimmed.split(/\s+/).length : 0} слов · ${text.value.length} символов`;
    onChange(text.value);
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

  function applyHeading(level) {
    pushState();
    const start = text.selectionStart;
    const end = text.selectionEnd;
    const lineStart = text.value.lastIndexOf('\n', start - 1) + 1;
    const lineEndIdx = text.value.indexOf('\n', end);
    const lineEnd = lineEndIdx === -1 ? text.value.length : lineEndIdx;
    const line = text.value.slice(lineStart, lineEnd);
    const cleaned = line.replace(/^#{1,6}\s+/, '');
    const prefix = level ? `${'#'.repeat(level)} ` : '';
    text.setRangeText(prefix + cleaned, lineStart, lineEnd, 'select');
    lastValue = text.value;
    text.focus();
    emit();
  }

  function keydown(e) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        if (redoStack.length) {
          undoStack.push(lastValue);
          restore(redoStack.pop());
        }
      } else if (undoStack.length) {
        redoStack.push(lastValue);
        restore(undoStack.pop());
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      if (redoStack.length) {
        undoStack.push(lastValue);
        restore(redoStack.pop());
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const f = { b: ['**', '**'], i: ['*', '*'], k: ['[', '](https://example.com)'] }[e.key.toLowerCase()];
      if (f) {
        e.preventDefault();
        insert(...f);
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

  // Heading / Style selector
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

  // Formatting buttons
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
  modeSelect.innerHTML = '<option value="editor">Редактор</option><option value="split">Редактор + просмотр</option>';
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
      preview.hidden = false;
      splitControl.hidden = false;
      splitControl.style.display = '';
      splitRange.disabled = false;
      splitRange.tabIndex = 0;
      renderInto(preview, text.value);
    } else {
      editorBox.className = 'editor';
      editorBox.style.gridTemplateColumns = '1fr';
      preview.hidden = true;
      splitControl.hidden = true;
      splitControl.style.display = 'none';
      splitRange.disabled = true;
      splitRange.tabIndex = -1;
    }
  }

  modeSelect.onchange = () => {
    mode = modeSelect.value;
    setPref('helper:editor:view', mode);
    applyModeLayout();
    text.focus();
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

  return {
    text,
    getValue: () => text.value,
    getSelection: () => text.value.slice(text.selectionStart, text.selectionEnd),
    insertLink: (title, noteId) => insert(`[${title.replace(/[\[\]\\]/g, '')}](`, ')', `#note=${noteId}`),
  };
}
