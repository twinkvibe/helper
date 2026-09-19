import { Diff, diffLines } from 'diff';

const unicodeWordDiff = new Diff();
unicodeWordDiff.tokenize = (value) => value.split(/(\s+|[^\p{L}\p{N}]+)/u).filter(Boolean);

export const FIELD_LABELS = {
  access: 'Доступ',
  title: 'Заголовок',
  done: 'Статус',
  role: 'Роль',
  blocked: 'Блокировка',
  list_name: 'Список',
  due_date: 'Срок',
  priority: 'Приоритет',
  tags: 'Теги',
  note_id: 'Заметка',
  slug: 'Адрес (slug)',
  excerpt: 'Краткое описание',
  cover_url: 'Обложка',
  published: 'Опубликовано',
  published_at: 'Дата публикации',
  username: 'Логин',
  must_change_password: 'Смена пароля',
  display_name: 'Отображаемое имя',
  bio: 'О себе',
  avatar_url: 'Аватар',
  body: 'Содержимое статьи',
  description: 'Описание задачи',
};

export const ACTION_LABELS = {
  insert: 'Создание',
  update: 'Обновление',
  delete: 'Удаление',
  profile_display_name: 'Изменение имени',
  profile_avatar: 'Изменение аватара',
  profile_bio: 'Изменение описания профиля',
  password_change: 'Изменение пароля',
  password_reset: 'Сброс пароля',
  admin_article_access: 'Изменение доступа',
  admin_article_delete: 'Удаление статьи',
  role_change: 'Смена роли',
  block: 'Блокировка',
  unblock: 'Разблокировка',
  user_create: 'Создание пользователя',
  account_delete: 'Удаление аккаунта',
  error: 'Ошибка клиента',
};

export const ENTITY_LABELS = {
  todos: 'Задача',
  articles: 'Статья',
  profiles: 'Профиль',
  users: 'Аккаунт',
  client: 'Клиент',
};

export function formatVal(field, val) {
  if (val === null || val === undefined) return '—';
  if (field === 'access') {
    if (val === 'private') return 'Приватно';
    if (val === 'unlisted') return 'По ссылке';
    if (val === 'public') return 'Общедоступно';
  }
  if (field === 'role') {
    if (val === 'admin') return 'Администратор';
    if (val === 'member') return 'Участник';
  }
  if (field === 'done') return val ? 'Выполнено' : 'Не выполнено';
  if (field === 'blocked') return val ? 'Заблокирован' : 'Активен';
  if (field === 'priority') {
    if (val === 2) return 'Высокий';
    if (val === 1) return 'Средний';
    return 'Обычный';
  }
  if (field === 'tags' && Array.isArray(val)) return val.length ? val.join(', ') : '—';
  if (typeof val === 'boolean') return val ? 'Да' : 'Нет';
  return String(val);
}

export function safeImageUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch {
    return null;
  }
  return null;
}

export function extractMarkdownImages(markdown) {
  if (!markdown || typeof markdown !== 'string') return [];
  const regex = /!\[.*?\]\((https:\/\/[^\s\)]+)\)/g;
  const urls = [];
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    const safe = safeImageUrl(match[1]);
    if (safe && !urls.includes(safe)) {
      urls.push(safe);
    }
  }
  return urls;
}

export function renderImageDiff(beforeUrl, afterUrl, options = {}) {
  const shape = options.shape || 'rect';
  const emptyLabel = options.emptyLabel || (shape === 'circle' ? 'Без аватара' : 'Без обложки');
  const container = document.createElement('div');
  container.className = 'audit-image-diff';

  const renderSide = (url, tagLabel) => {
    const safe = safeImageUrl(url);
    if (!safe) {
      const empty = document.createElement('div');
      empty.className = 'audit-image-empty';
      const label = document.createElement('span');
      label.className = 'muted';
      label.textContent = emptyLabel;
      empty.append(label);
      return empty;
    }

    const box = document.createElement('div');
    box.className = 'audit-image-box';

    const tag = document.createElement('span');
    tag.className = 'audit-image-tag';
    tag.textContent = tagLabel;
    box.append(tag);

    const link = document.createElement('a');
    link.href = safe;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.referrerPolicy = 'no-referrer';

    const img = document.createElement('img');
    img.src = safe;
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.alt = tagLabel;
    img.className = `audit-image-preview ${shape === 'circle' ? 'audit-image-avatar' : 'audit-image-cover'}`;
    img.onerror = () => {
      const broken = document.createElement('div');
      broken.className = 'audit-image-broken';
      broken.textContent = 'Изображение недоступно';
      link.replaceChildren(broken);
    };
    link.append(img);
    box.append(link);

    const urlLink = document.createElement('a');
    urlLink.href = safe;
    urlLink.target = '_blank';
    urlLink.rel = 'noopener noreferrer';
    urlLink.referrerPolicy = 'no-referrer';
    urlLink.className = 'audit-image-url-link';
    urlLink.textContent = safe;
    box.append(urlLink);

    return box;
  };

  container.append(renderSide(beforeUrl, 'До'));

  const arrow = document.createElement('span');
  arrow.className = 'audit-image-arrow';
  arrow.textContent = '→';
  container.append(arrow);

  container.append(renderSide(afterUrl, 'После'));

  return container;
}

export function renderTextDiff(beforeText, afterText, metadata = {}) {
  const container = document.createElement('div');
  container.className = 'audit-text-diff-wrapper';

  const isTruncated = Boolean(metadata.before_truncated || metadata.after_truncated);
  if (isTruncated) {
    const warning = document.createElement('div');
    warning.className = 'audit-truncated-warning';
    const total = Math.max(metadata.before_length || 0, metadata.after_length || 0);
    warning.textContent = `Показаны первые 100 000 символов. Полный текст: ${total} символов.`;
    container.append(warning);
  }

  const diffBox = document.createElement('div');
  diffBox.className = 'audit-text-diff';

  const bText = beforeText ?? '';
  const aText = afterText ?? '';
  const changes = diffLines(bText, aText);

  changes.forEach(part => {
    const rawLines = part.value.split('\n');
    if (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') {
      rawLines.pop();
    }
    rawLines.forEach(lineStr => {
      const lineDiv = document.createElement('div');
      lineDiv.className = 'audit-text-diff-line';
      const sign = document.createElement('span');
      sign.className = 'audit-diff-sign';
      const content = document.createElement('span');
      content.className = 'audit-diff-content';
      content.textContent = lineStr || ' ';

      if (part.added) {
        lineDiv.classList.add('audit-diff-add');
        sign.textContent = '+';
      } else if (part.removed) {
        lineDiv.classList.add('audit-diff-remove');
        sign.textContent = '-';
      } else {
        lineDiv.classList.add('audit-diff-context');
        sign.textContent = ' ';
      }

      lineDiv.append(sign, content);
      diffBox.append(lineDiv);
    });
  });

  container.append(diffBox);
  return container;
}

export function renderWordDiff(beforeStr, afterStr) {
  const container = document.createElement('div');
  container.className = 'audit-word-diff';

  const changes = unicodeWordDiff.diff(beforeStr ?? '', afterStr ?? '');
  changes.forEach(part => {
    const span = document.createElement('span');
    span.textContent = part.value;
    if (part.added) {
      span.className = 'audit-word-add';
    } else if (part.removed) {
      span.className = 'audit-word-remove';
    }
    container.append(span);
  });

  return container;
}

export function renderMarkdownImageChanges(beforeText, afterText) {
  const beforeImages = extractMarkdownImages(beforeText);
  const afterImages = extractMarkdownImages(afterText);

  const added = afterImages.filter(url => !beforeImages.includes(url)).slice(0, 12);
  const removed = beforeImages.filter(url => !afterImages.includes(url)).slice(0, 12);

  if (!added.length && !removed.length) return null;

  const container = document.createElement('div');
  container.className = 'audit-markdown-images';

  const renderSection = (title, urls) => {
    if (!urls.length) return;
    const header = document.createElement('h5');
    header.textContent = `${title} (${urls.length})`;
    container.append(header);

    const grid = document.createElement('div');
    grid.className = 'audit-image-grid';
    urls.forEach(url => {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.referrerPolicy = 'no-referrer';
      link.className = 'audit-image-thumb-link';

      const img = document.createElement('img');
      img.src = url;
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.className = 'audit-image-thumb';
      img.alt = 'Изображение';
      img.onerror = () => {
        img.style.display = 'none';
      };
      link.append(img);
      grid.append(link);
    });
    container.append(grid);
  };

  renderSection('Добавленные изображения', added);
  renderSection('Удалённые изображения', removed);

  return container;
}

export function renderAuditField(k, beforeVal, afterVal, textChanges = null) {
  if (k === 'cover_url') {
    return renderImageDiff(beforeVal, afterVal, { shape: 'rect', emptyLabel: 'Без обложки' });
  }

  if (k === 'avatar_url') {
    return renderImageDiff(beforeVal, afterVal, { shape: 'circle', emptyLabel: 'Без аватара' });
  }

  if (k === 'body' || k === 'description') {
    const changeMeta = textChanges?.[k] || {};
    const b = changeMeta.before !== undefined ? changeMeta.before : (typeof beforeVal === 'string' ? beforeVal : null);
    const a = changeMeta.after !== undefined ? changeMeta.after : (typeof afterVal === 'string' ? afterVal : null);

    const wrapper = document.createElement('div');
    wrapper.className = 'audit-text-change-container';
    wrapper.append(renderTextDiff(b, a, changeMeta));

    const imgDiff = renderMarkdownImageChanges(b, a);
    if (imgDiff) {
      wrapper.append(imgDiff);
    }
    return wrapper;
  }

  if (['title', 'excerpt', 'display_name', 'bio'].includes(k)) {
    if (typeof beforeVal === 'string' && typeof afterVal === 'string') {
      return renderWordDiff(beforeVal, afterVal);
    }
  }

  const container = document.createElement('div');
  container.className = 'audit-diff-values';

  const spanBefore = document.createElement('span');
  spanBefore.className = 'diff-before';
  spanBefore.textContent = formatVal(k, beforeVal);

  const arrow = document.createElement('span');
  arrow.className = 'diff-arrow';
  arrow.textContent = '→';

  const spanAfter = document.createElement('span');
  spanAfter.className = 'diff-after';
  spanAfter.textContent = formatVal(k, afterVal);

  container.append(spanBefore, arrow, spanAfter);
  return container;
}

export function populateAuditDiffs(diffContainer, details) {
  diffContainer.replaceChildren();
  const before = details?.before;
  const after = details?.after;
  const textChanges = details?.text_changes || null;
  const renderedKeys = new Set();

  const addDiffRow = (fieldKey, fieldLabel, valueElement) => {
    renderedKeys.add(fieldKey);
    const row = document.createElement('div');
    row.className = 'audit-diff-row';
    const labelEl = document.createElement('div');
    labelEl.className = 'audit-diff-field';
    labelEl.textContent = fieldLabel;
    row.append(labelEl, valueElement);
    diffContainer.append(row);
  };

  if (before && after) {
    const keys = details.changed_fields && Array.isArray(details.changed_fields)
      ? details.changed_fields
      : Object.keys({ ...before, ...after });

    keys.forEach(k => {
      const vBefore = before[k];
      const vAfter = after[k];
      const valEl = renderAuditField(k, vBefore, vAfter, textChanges);
      addDiffRow(k, FIELD_LABELS[k] || k, valEl);
    });
  } else if (before === null && after) {
    const keys = Object.keys(after);
    keys.forEach(k => {
      if (k === 'body' || k === 'description') return;
      const valEl = renderAuditField(k, null, after[k], textChanges);
      addDiffRow(k, FIELD_LABELS[k] || k, valEl);
    });
  } else if (after === null && before) {
    const keys = Object.keys(before);
    keys.forEach(k => {
      if (k === 'body' || k === 'description') return;
      const valEl = renderAuditField(k, before[k], null, textChanges);
      addDiffRow(k, FIELD_LABELS[k] || k, valEl);
    });
  }

  // Handle text_changes for body and description if not already added
  if (textChanges) {
    ['body', 'description'].forEach(fieldKey => {
      if (textChanges[fieldKey] && !renderedKeys.has(fieldKey)) {
        const valEl = renderAuditField(fieldKey, null, null, textChanges);
        addDiffRow(fieldKey, FIELD_LABELS[fieldKey] || fieldKey, valEl);
      }
    });
  }

  // Handle legacy body_changed / description_changed
  if (details?.body_changed && !renderedKeys.has('body')) {
    const legacyEl = document.createElement('div');
    legacyEl.className = 'audit-diff-values';
    legacyEl.textContent = `изменено: ${details.body_length_before ?? 0} → ${details.body_length_after ?? 0} символов`;
    addDiffRow('body', FIELD_LABELS.body || 'Содержимое статьи', legacyEl);
  }

  if (details?.description_changed && !renderedKeys.has('description')) {
    const legacyEl = document.createElement('div');
    legacyEl.className = 'audit-diff-values';
    legacyEl.textContent = `изменено: ${details.description_length_before ?? 0} → ${details.description_length_after ?? 0} символов`;
    addDiffRow('description', FIELD_LABELS.description || 'Описание задачи', legacyEl);
  }

  // Any remaining unhandled details fields
  if (details && typeof details === 'object') {
    Object.entries(details).forEach(([k, v]) => {
      if (renderedKeys.has(k)) return;
      if (['title', 'username', 'changed_fields', 'before', 'after', 'body_changed', 'description_changed', 'text_changes'].includes(k)) return;
      const valEl = renderAuditField(k, null, v, textChanges);
      addDiffRow(k, FIELD_LABELS[k] || k, valEl);
    });
  }
}

