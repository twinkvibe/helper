import { attachEditor } from './editor.js';
import { renderMarkdown } from './security.js';
import { validateImageFile } from './image-editor.js';
import { icon, iconButton } from './icons.js';
import {
  parseTagInput, formatTagsInput, collectTags, filterPeople, sortEntries,
  entryMatches, entryTags, mediaPath, formatBytes, formatOccurredAt, initials,
  normalizeFacts, groupEntriesByDay, classifyUpload,
} from './dossier-model.js';

const BUCKET = 'dossier-media';
const MAX_FILES = 12;
const MAX_PHOTO_SIZE = 5 * 1024 * 1024;
const isVideoAttachment = (att) => String(att?.type || '').startsWith('video/');

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (text, onClick, cls = 'quiet') => {
  const node = el('button', cls, text);
  node.type = 'button';
  node.onclick = onClick;
  return node;
};
const toLocalInput = (iso) => {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const fromLocalInput = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export function mountDossier(host, {
  client,
  userId,
  notice = () => {},
  requireSession = async () => true,
  onAssistant = null,
}) {
  let alive = true;
  let people = [];
  let entries = [];
  let links = [];
  let personLinks = [];
  let selectedPersonId = null; // null = все записи
  let query = '';
  let activeTag = '';
  let migrationMissing = false;
  let loading = true;

  const mediaUrls = new Map(); // storage path -> signed url
  const peopleById = new Map();
  const linksByEntry = new Map();
  const linksByPerson = new Map();

  const emptyMsg = 'Раздел «Досье» пока пуст. Добавь человека и запиши, что помнишь.';
  const migrationMsg = 'Для «Досье» нужны миграции базы данных 20260924_dossier.sql и 20260925_dossier_profile.sql. Примени их в Supabase по порядку и обнови страницу.';

  function rebuildIndexes() {
    peopleById.clear();
    people.forEach(person => peopleById.set(person.id, person));
    linksByEntry.clear();
    links.forEach(link => {
      if (!linksByEntry.has(link.entry_id)) linksByEntry.set(link.entry_id, new Set());
      linksByEntry.get(link.entry_id).add(link.person_id);
    });
    linksByPerson.clear();
    personLinks.forEach(link => {
      if (!linksByPerson.has(link.person_id)) linksByPerson.set(link.person_id, []);
      linksByPerson.get(link.person_id).push(link);
    });
  }

  const peopleForEntry = (entryId) =>
    [...(linksByEntry.get(entryId) || [])].map(id => peopleById.get(id)).filter(Boolean);

  const linkedPeople = (personId) =>
    (linksByPerson.get(personId) || [])
      .map(link => ({ person: peopleById.get(link.linked_person_id), label: link.label }))
      .filter(item => item.person);

  const entriesForPerson = (personId) =>
    entries.filter(entry => (linksByEntry.get(entry.id) || new Set()).has(personId));

  async function ensureMediaUrls() {
    const paths = [];
    people.forEach(person => {
      if (person.avatar_path && !mediaUrls.has(person.avatar_path)) paths.push(person.avatar_path);
    });
    entries.forEach(entry => (entry.attachments || []).forEach(att => {
      if (att && att.path && !mediaUrls.has(att.path)) paths.push(att.path);
    }));
    if (!paths.length) return;
    try {
      const { data, error } = await client.storage.from(BUCKET).createSignedUrls(paths, 3600);
      if (error) return;
      (data || []).forEach((item, index) => {
        const path = item.path || paths[index];
        if (item.signedUrl) mediaUrls.set(path, item.signedUrl);
      });
    } catch {
      /* хранилище недоступно — галерея покажет только количество */
    }
  }

  async function load() {
    loading = true;
    render();
    try { await requireSession(); } catch { return; }
    const [peopleRes, entriesRes, linksRes, personLinksRes] = await Promise.all([
      client.from('dossier_people').select('*').order('name', { ascending: true }),
      client.from('dossier_entries').select('*').order('occurred_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }),
      client.from('dossier_entry_people').select('entry_id,person_id'),
      client.from('dossier_person_links').select('person_id,linked_person_id,label'),
    ]);
    if (!alive) return;
    const errors = [peopleRes.error, entriesRes.error, linksRes.error, personLinksRes.error].filter(Boolean);
    migrationMissing = errors.some(err => err.code === '42P01' || /does not exist/i.test(err.message || ''));
    if (errors.length && !migrationMissing) {
      notice('Не удалось загрузить «Досье». Проверь подключение.', true);
    }
    people = peopleRes.data || [];
    entries = entriesRes.data || [];
    links = linksRes.data || [];
    personLinks = personLinksRes.data || [];
    rebuildIndexes();
    if (selectedPersonId && !peopleById.has(selectedPersonId)) selectedPersonId = null;
    loading = false;
    await ensureMediaUrls();
    if (alive) render();
  }

  function run(action, node) {
    if (node) node.disabled = true;
    return Promise.resolve(action())
      .catch(error => { if (alive) notice(error?.message || 'Не удалось выполнить действие.', true); })
      .finally(() => { if (node) node.disabled = false; });
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function avatarNode(person, cls) {
    const url = person.avatar_path && mediaUrls.get(person.avatar_path);
    if (url) {
      const img = el('img', cls);
      img.src = url;
      img.alt = person.name || 'Фото';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      return img;
    }
    return el('span', cls, initials(person.name));
  }

  function render() {
    if (!alive) return;
    host.replaceChildren();

    const heading = el('div', 'work-heading');
    heading.append(el('h1', '', 'Досье'));
    const actions = el('div', 'dossier-heading-actions');
    actions.append(
      button('Новый человек', () => openPersonDialog(null), 'secondary'),
      button('Новая запись', () => openEntryDialog(null, selectedPersonId), 'primary'),
    );
    heading.append(actions);
    host.append(heading);

    if (migrationMissing) {
      host.append(el('p', 'empty', migrationMsg));
      return;
    }

    const area = el('div', 'work-area');
    host.append(area);

    const allTags = collectTags(people, entries);
    const toolbar = el('div', 'task-controls dossier-controls');
    const searchWrap = el('label', 'search-field');
    searchWrap.append(icon('search'));
    const search = el('input');
    search.placeholder = 'Поиск по людям и записям';
    search.setAttribute('aria-label', 'Поиск в досье');
    search.value = query;
    search.oninput = () => { query = search.value; renderBody(); };
    searchWrap.append(search);
    toolbar.append(searchWrap);
    if (allTags.length) {
      const chips = el('div', 'tag-filter compact');
      chips.append(el('span', 'muted', 'Теги'));
      allTags.forEach(tag => chips.append(button(`#${tag}`, () => {
        activeTag = activeTag === tag ? '' : tag;
        render();
      }, activeTag === tag ? 'tag active' : 'tag')));
      toolbar.append(chips);
    }
    area.append(toolbar);

    const body = el('div', 'dossier-layout');
    body.id = 'dossier-body';
    area.append(body);
    renderBody();
  }

  function renderBody() {
    const body = host.querySelector('#dossier-body');
    if (!body) return;
    body.replaceChildren();
    if (loading) {
      body.append(el('p', 'empty', 'Загружаем досье…'));
      return;
    }
    body.append(renderPeopleSidebar(), renderPersonPanel());
  }

  function renderPeopleSidebar() {
    const side = el('aside', 'dossier-people');
    const list = el('div', 'dossier-people-list');

    const allBtn = button('Все записи', () => { selectedPersonId = null; render(); }, 'dossier-person');
    allBtn.classList.toggle('selected', selectedPersonId === null);
    allBtn.append(el('span', 'dossier-person-count', String(entries.length)));
    list.append(allBtn);

    const visible = filterPeople(people, { query, tag: activeTag });
    if (!people.length) {
      side.append(list, el('p', 'muted dossier-people-empty', 'Людей пока нет.'));
      return side;
    }
    if (!visible.length) {
      list.append(el('p', 'muted dossier-people-empty', 'Никого не найдено.'));
      side.append(list);
      return side;
    }
    visible.forEach(person => {
      const item = button('', () => { selectedPersonId = person.id; render(); }, 'dossier-person');
      item.classList.toggle('selected', selectedPersonId === person.id);
      const avatar = avatarNode(person, 'dossier-person-avatar');
      const info = el('span', 'dossier-person-info');
      info.append(el('strong', '', person.name));
      if (person.relation) info.append(el('small', '', person.relation));
      item.append(avatar, info, el('span', 'dossier-person-count', String(entriesForPerson(person.id).length)));
      list.append(item);
    });
    side.append(list);
    return side;
  }

  function renderPersonPanel() {
    const panel = el('section', 'dossier-panel');

    if (selectedPersonId && !peopleById.has(selectedPersonId)) selectedPersonId = null;

    if (selectedPersonId) {
      const person = peopleById.get(selectedPersonId);
      const header = el('div', 'dossier-person-header');
      header.append(avatarNode(person, 'dossier-avatar-lg'));
      const meta = el('div', 'dossier-person-meta');
      meta.append(el('h2', '', person.name));
      const subParts = [];
      if (person.relation) subParts.push(person.relation);
      if (person.aliases?.length) subParts.push('также: ' + person.aliases.join(', '));
      if (subParts.length) meta.append(el('p', 'muted', subParts.join(' · ')));
      if (person.relationship) {
        meta.append(el('span', 'dossier-relationship', `Отношения: ${person.relationship}`));
      }
      if (person.tags?.length) {
        const tagRow = el('div', 'tag-filter compact');
        person.tags.forEach(tag => tagRow.append(button(`#${tag}`, () => { activeTag = tag; render(); }, 'tag')));
        meta.append(tagRow);
      }
      const tools = el('div', 'dossier-person-tools');
      tools.append(
        button('Записать событие', () => openEntryDialog(null, person.id), 'secondary'),
        iconButton('note', 'Изменить человека', () => openPersonDialog(person)),
        iconButton('trash', 'Удалить человека', () => deletePerson(person)),
      );
      header.append(meta, tools);
      panel.append(header);

      const facts = normalizeFacts(person.facts);
      if (facts.length) {
        const factsBox = el('dl', 'dossier-facts');
        facts.forEach(fact => {
          const row = el('div', 'dossier-fact');
          if (fact.key) row.append(el('dt', '', fact.key));
          row.append(el('dd', '', fact.value || '—'));
          factsBox.append(row);
        });
        panel.append(factsBox);
      }

      const linked = linkedPeople(person.id);
      if (linked.length) {
        const linksBox = el('div', 'dossier-links');
        linksBox.append(el('span', 'muted', 'Связан:'));
        linked.forEach(({ person: target, label }) => {
          const text = label ? `${target.name} · ${label}` : target.name;
          linksBox.append(button(text, () => { selectedPersonId = target.id; render(); }, 'tag'));
        });
        panel.append(linksBox);
      }

      if (person.bio) {
        const bio = el('div', 'preview dossier-md');
        bio.innerHTML = renderMarkdown(person.bio);
        panel.append(bio);
      }
    } else {
      panel.append(el('h2', 'dossier-all-title', 'Все записи'));
    }

    const source = selectedPersonId ? entriesForPerson(selectedPersonId) : entries;
    const visible = sortEntries(source).filter(entry => entryMatches(entry, query) &&
      (!activeTag || entryTags(entry).map(t => t.toLowerCase()).includes(activeTag)));

    if (!visible.length) {
      panel.append(el('p', 'empty', entries.length ? 'Ничего не найдено по фильтру.' : emptyMsg));
      return panel;
    }

    const timeline = el('div', 'dossier-timeline');
    groupEntriesByDay(visible).forEach(group => {
      const day = el('section', 'dossier-day');
      day.append(el('h3', 'dossier-day-label', group.label));
      group.entries.forEach(entry => day.append(renderEntryCard(entry)));
      timeline.append(day);
    });
    panel.append(timeline);
    return panel;
  }

  function renderEntryCard(entry) {
    const card = el('article', 'dossier-entry');
    const head = el('div', 'dossier-entry-head');
    const heading = el('div', 'dossier-entry-heading');
    heading.append(el('h3', '', entry.title));
    const dateText = formatOccurredAt(entry.occurred_at) || (entry.occurred_at === null
      ? `создано ${formatOccurredAt(entry.created_at) || ''}`
      : '');
    if (dateText) heading.append(el('time', 'muted', dateText));
    head.append(heading);

    const tools = el('div', 'dossier-entry-tools');
    tools.append(
      iconButton('note', 'Изменить запись', () => openEntryDialog(entry)),
      iconButton('trash', 'Удалить запись', () => deleteEntry(entry)),
    );
    head.append(tools);
    card.append(head);

    const persons = peopleForEntry(entry.id);
    const chips = el('div', 'dossier-entry-chips');
    persons.forEach(person => chips.append(button(person.name, () => { selectedPersonId = person.id; render(); }, 'tag')));
    (entry.tags || []).forEach(tag => chips.append(button(`#${tag}`, () => { activeTag = tag; render(); }, 'tag')));
    if (chips.children.length) card.append(chips);

    if (entry.body) {
      const bodyWrap = el('div', 'dossier-entry-body preview dossier-md');
      bodyWrap.innerHTML = renderMarkdown(entry.body);
      card.append(bodyWrap);
    }

    const attachments = entry.attachments || [];
    if (attachments.length) card.append(renderGallery(attachments));
    return card;
  }

  function mediaThumb(att, url) {
    if (url && isVideoAttachment(att)) {
      const video = el('video', 'dossier-video');
      video.src = url;
      video.controls = true;
      video.preload = 'metadata';
      video.setAttribute('playsinline', '');
      return video;
    }
    if (url && String(att?.type || '').startsWith('image/')) {
      const link = el('a', 'dossier-photo-link');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      const img = el('img', 'dossier-photo');
      img.src = url;
      img.alt = att.name || 'Фото';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      link.append(img);
      return link;
    }
    if (url) {
      const link = el('a', 'dossier-doc-link');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = `${att?.name || 'Файл'}${att?.size ? ` · ${formatBytes(att.size)}` : ''} ⬇`;
      return link;
    }
    return el('span', 'dossier-photo dossier-photo-empty', att?.name || 'файл');
  }

  function renderGallery(attachments) {
    const gallery = el('div', 'dossier-gallery');
    attachments.forEach(att => gallery.append(mediaThumb(att, mediaUrls.get(att.path))));
    return gallery;
  }

  // ── Dialogs ───────────────────────────────────────────────────────────────

  function openDialog(title) {
    const dialog = el('dialog', 'dossier-dialog');
    const form = el('form', 'dossier-form');
    form.method = 'dialog';
    const header = el('div', 'section-heading');
    header.append(el('h2', '', title));
    const close = button('Закрыть', () => dialog.close(), 'quiet');
    header.append(close);
    form.append(header);
    dialog.append(form);
    host.append(dialog);
    const closeDialog = () => { dialog.close(); dialog.remove(); };
    close.onclick = closeDialog;
    dialog.addEventListener('close', () => dialog.remove());
    dialog.addEventListener('cancel', e => { e.preventDefault(); closeDialog(); });
    return { dialog, form };
  }

  function openPersonDialog(person) {
    const editing = Boolean(person);
    const { dialog, form } = openDialog(editing ? 'Изменить человека' : 'Новый человек');

    // Аватар: приватный объект dossier-media, показ по подписанной ссылке.
    let avatarPath = person?.avatar_path || null;
    let pendingAvatar = null;
    let pendingAvatarUrl = null;
    const avatarRow = el('div', 'profile-avatar-row');
    const avatarPreview = el('div', 'dossier-avatar-preview');
    const renderAvatarPreview = () => {
      avatarPreview.replaceChildren();
      if (pendingAvatarUrl) {
        const img = el('img', 'avatar-preview-lg');
        img.src = pendingAvatarUrl;
        img.alt = 'Новый аватар';
        avatarPreview.append(img);
      } else if (avatarPath && mediaUrls.get(avatarPath)) {
        const img = el('img', 'avatar-preview-lg');
        img.src = mediaUrls.get(avatarPath);
        img.alt = nameInput.value.trim() || 'Аватар';
        avatarPreview.append(img);
      } else {
        avatarPreview.append(el('div', 'avatar-preview-lg admin-avatar-box', initials(nameInput.value.trim() || '?')));
      }
    };
    const avatarActions = el('div', 'profile-avatar-actions');
    const changeAvatarBtn = button('Выбрать фото', () => avatarInput.click(), 'secondary');
    const removeAvatarBtn = button('Убрать', () => {
      if (pendingAvatarUrl) URL.revokeObjectURL(pendingAvatarUrl);
      pendingAvatar = null;
      pendingAvatarUrl = null;
      avatarPath = null;
      renderAvatarPreview();
    }, 'danger quiet');
    const avatarInput = el('input');
    avatarInput.type = 'file';
    avatarInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
    avatarInput.hidden = true;
    avatarInput.onchange = () => {
      const file = avatarInput.files[0];
      avatarInput.value = '';
      if (!file) return;
      try { validateImageFile(file, { maxSize: MAX_PHOTO_SIZE }); }
      catch (error) { notice(error.message, true); return; }
      if (pendingAvatarUrl) URL.revokeObjectURL(pendingAvatarUrl);
      pendingAvatar = file;
      pendingAvatarUrl = URL.createObjectURL(file);
      renderAvatarPreview();
    };
    avatarActions.append(changeAvatarBtn, avatarInput, removeAvatarBtn);
    avatarRow.append(avatarPreview, avatarActions);
    form.append(avatarRow);

    // Вставка фото лица из буфера обмена прямо на превью.
    avatarPreview.tabIndex = 0;
    avatarPreview.title = 'Нажми и вставь фото из буфера (Ctrl+V)';
    avatarPreview.addEventListener('paste', e => {
      const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      try { validateImageFile(file, { maxSize: MAX_PHOTO_SIZE }); }
      catch (error) { notice(error.message, true); return; }
      if (pendingAvatarUrl) URL.revokeObjectURL(pendingAvatarUrl);
      pendingAvatar = file;
      pendingAvatarUrl = URL.createObjectURL(file);
      renderAvatarPreview();
    });

    const nameLabel = el('label', '', 'Имя');
    const nameInput = el('input');
    nameInput.required = true;
    nameInput.maxLength = 120;
    nameInput.value = person?.name || '';
    nameInput.oninput = renderAvatarPreview;
    nameLabel.append(nameInput);
    form.append(nameLabel);
    renderAvatarPreview();

    const aliasLabel = el('label', '', 'Также известен как (через запятую)');
    const aliasInput = el('input');
    aliasInput.placeholder = 'Костя, Костян, Константин';
    aliasInput.value = (person?.aliases || []).join(', ');
    aliasLabel.append(aliasInput);
    form.append(aliasLabel);

    const fields = el('div', 'dossier-fields');
    const relationLabel = el('label', '', 'Кто это');
    const relationInput = el('input');
    relationInput.maxLength = 120;
    relationInput.placeholder = 'одногруппник, сосед, коллега…';
    relationInput.value = person?.relation || '';
    relationLabel.append(relationInput);
    const relationshipLabel = el('label', '', 'Статус отношений (как я вижу)');
    const relationshipInput = el('input');
    relationshipInput.maxLength = 120;
    relationshipInput.placeholder = 'друзья, натянутые, конфликт…';
    relationshipInput.value = person?.relationship || '';
    relationshipLabel.append(relationshipInput);
    fields.append(relationLabel, relationshipLabel);
    form.append(fields);

    const tagsLabel = el('label', '', 'Теги');
    const tagsInput = el('input');
    tagsInput.placeholder = '#учёба #долг';
    tagsInput.value = formatTagsInput(person?.tags || []);
    tagsLabel.append(tagsInput);
    form.append(tagsLabel);

    // Известные факты: адрес, телефон, день рождения — что угодно.
    const factsBox = el('div', 'dossier-facts-edit');
    factsBox.append(el('span', 'dossier-facts-title', 'Известные факты'));
    const factsRows = el('div', 'dossier-facts-rows');
    factsBox.append(factsRows);
    const factInputs = [];
    function addFactRow(key = '', value = '') {
      if (factInputs.length >= 30) { notice('Не больше 30 фактов.', true); return; }
      const row = el('div', 'dossier-fact-row');
      const keyInput = el('input');
      keyInput.placeholder = 'Адрес';
      keyInput.maxLength = 60;
      keyInput.value = key;
      keyInput.setAttribute('aria-label', 'Название факта');
      const valueInput = el('input');
      valueInput.placeholder = 'ул. Ленина, 5, кв. 12';
      valueInput.maxLength = 500;
      valueInput.value = value;
      valueInput.setAttribute('aria-label', 'Значение факта');
      const remove = button('×', () => {
        row.remove();
        factInputs.splice(factInputs.indexOf(pair), 1);
      }, 'dossier-photo-remove');
      remove.setAttribute('aria-label', 'Убрать факт');
      const pair = { keyInput, valueInput };
      row.append(keyInput, valueInput, remove);
      factsRows.append(row);
      factInputs.push(pair);
    }
    normalizeFacts(person?.facts).forEach(fact => addFactRow(fact.key, fact.value));
    const addFactBtn = button('+ Добавить факт', () => addFactRow(), 'secondary');
    factsBox.append(addFactBtn);
    form.append(factsBox);

    // Ссылки на других людей.
    const others = people.filter(p => !editing || p.id !== person.id);
    const linksBox = el('fieldset', 'dossier-people-picker');
    linksBox.append(el('legend', '', 'Связан с людьми'));
    const selectedLinks = new Map();
    if (editing) {
      (linksByPerson.get(person.id) || []).forEach(link => selectedLinks.set(link.linked_person_id, link.label || ''));
    }
    if (!others.length) {
      linksBox.append(el('p', 'muted', 'Других людей в досье пока нет.'));
    } else {
      others.forEach(other => {
        const row = el('div', 'dossier-link-row');
        const option = el('label', 'dossier-person-option');
        const checkbox = el('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selectedLinks.has(other.id);
        const labelInput = el('input');
        labelInput.placeholder = 'кем приходится…';
        labelInput.maxLength = 120;
        labelInput.value = selectedLinks.get(other.id) || '';
        labelInput.disabled = !checkbox.checked;
        checkbox.onchange = () => {
          labelInput.disabled = !checkbox.checked;
          if (checkbox.checked) selectedLinks.set(other.id, labelInput.value.trim());
          else selectedLinks.delete(other.id);
        };
        labelInput.oninput = () => { if (checkbox.checked) selectedLinks.set(other.id, labelInput.value.trim()); };
        option.append(checkbox, el('span', '', other.name));
        row.append(option, labelInput);
        linksBox.append(row);
      });
    }
    form.append(linksBox);

    const bioLabel = el('label', '', 'Заметки о человеке (Markdown)');
    const bioInput = el('textarea');
    bioInput.rows = 6;
    bioInput.maxLength = 20000;
    bioInput.placeholder = 'Что важно помнить: характер, договорённости, контекст…';
    bioInput.value = person?.bio || '';
    bioLabel.append(bioInput);
    form.append(bioLabel);

    // ИИ-разбор профиля: проверяет статус отношений и факты по записям.
    let assistantOutput = null;
    if (onAssistant) {
      const assistantRow = el('div', 'dossier-assistant');
      const askBtn = button('Предложить правки с ИИ', async () => {
        const name = nameInput.value.trim();
        if (!name) { notice('Сначала укажи имя.', true); return; }
        askBtn.disabled = true;
        askBtn.textContent = 'Думаю…';
        try {
          const personEntries = editing
            ? entriesForPerson(person.id).slice(0, 20).map(e => ({ title: e.title, body: e.body }))
            : [];
          const result = await onAssistant({
            action: 'dossier:review',
            person: {
              name,
              relation: relationInput.value.trim(),
              relationship: relationshipInput.value.trim(),
              facts: normalizeFacts(factInputs.map(pair => ({ key: pair.keyInput.value, value: pair.valueInput.value }))),
              bio: bioInput.value,
            },
            entries: personEntries,
          });
          const answer = result?.text || '';
          if (!assistantOutput) {
            assistantOutput = el('div', 'assistant-output');
            assistantRow.append(assistantOutput);
          }
          assistantOutput.innerHTML = renderMarkdown(String(answer));
        } catch (error) {
          notice(error?.message || 'ИИ-помощник недоступен.', true);
        } finally {
          askBtn.disabled = false;
          askBtn.textContent = 'Предложить правки с ИИ';
        }
      }, 'secondary');
      assistantRow.prepend(askBtn);
      form.append(assistantRow);
    }

    const status = el('p', 'detail-status');
    const footer = el('div', 'dossier-form-footer');
    const save = el('button', 'primary', editing ? 'Сохранить' : 'Добавить');
    save.type = 'submit';
    footer.append(status, save);
    form.append(footer);

    form.onsubmit = e => {
      e.preventDefault();
      run(async () => {
        const name = nameInput.value.trim();
        if (!name) throw new Error('Укажи имя.');
        await requireSession();

        let nextAvatarPath = avatarPath;
        if (pendingAvatar) {
          const path = mediaPath(userId, 'avatars', pendingAvatar.name, person?.id || 'new');
          const { error } = await client.storage.from(BUCKET).upload(path, pendingAvatar, {
            contentType: pendingAvatar.type || 'image/jpeg',
            upsert: false,
          });
          if (error) throw new Error('Не удалось загрузить фото. Проверь хранилище dossier-media.');
          nextAvatarPath = path;
          mediaUrls.delete(path);
        }

        const payload = {
          name,
          aliases: aliasInput.value.split(',').map(s => s.trim()).filter(Boolean).slice(0, 20),
          relation: relationInput.value.trim(),
          relationship: relationshipInput.value.trim(),
          tags: parseTagInput(tagsInput.value),
          facts: normalizeFacts(factInputs.map(pair => ({ key: pair.keyInput.value, value: pair.valueInput.value }))),
          avatar_path: nextAvatarPath,
          bio: bioInput.value,
        };
        let personId = person?.id || null;
        if (editing) {
          const { error } = await client.from('dossier_people').update(payload).eq('id', person.id);
          if (error) throw new Error('Не удалось сохранить человека.');
        } else {
          const { data, error } = await client.from('dossier_people').insert(payload).select('id');
          if (error || !data?.length) throw new Error('Не удалось добавить человека.');
          personId = data[0].id;
          selectedPersonId = personId;
        }

        const cleared = await client.from('dossier_person_links').delete().eq('person_id', personId);
        if (cleared.error) throw new Error('Не удалось обновить связи.');
        const linkRows = [...selectedLinks.entries()].map(([linkedId, label]) => ({
          person_id: personId, linked_person_id: linkedId, label: label || '', user_id: userId,
        }));
        if (linkRows.length) {
          const savedLinks = await client.from('dossier_person_links').insert(linkRows);
          if (savedLinks.error) throw new Error('Не удалось сохранить связи.');
        }

        const removedAvatar = person?.avatar_path && person.avatar_path !== nextAvatarPath
          ? [person.avatar_path] : [];
        if (removedAvatar.length) {
          try { await client.storage.from(BUCKET).remove(removedAvatar); } catch { /* не критично */ }
          removedAvatar.forEach(path => mediaUrls.delete(path));
        }

        dialog.remove();
        notice(editing ? 'Человек обновлён.' : 'Человек добавлен.');
        await load();
      }, save);
    };

    dialog.showModal();
    nameInput.focus();
  }

  async function deletePerson(person) {
    if (!window.confirm(`Удалить «${person.name}»?\nЗаписи останутся, но потеряют связь с этим человеком.`)) return;
    await run(async () => {
      const { error } = await client.from('dossier_people').delete().eq('id', person.id);
      if (error) throw new Error('Не удалось удалить человека.');
      if (person.avatar_path) {
        try { await client.storage.from(BUCKET).remove([person.avatar_path]); } catch { /* не критично */ }
        mediaUrls.delete(person.avatar_path);
      }
      if (selectedPersonId === person.id) selectedPersonId = null;
      notice('Человек удалён.');
      await load();
    });
  }

  function openEntryDialog(entry, presetPersonId = null) {
    const editing = Boolean(entry);
    const entryId = entry?.id || crypto.randomUUID();
    const { dialog, form } = openDialog(editing ? 'Изменить запись' : 'Новая запись');

    const titleLabel = el('label', '', 'Заголовок');
    const titleInput = el('input');
    titleInput.required = true;
    titleInput.maxLength = 300;
    titleInput.placeholder = 'Ссора на паре, 4 курс';
    titleInput.value = entry?.title || '';
    titleLabel.append(titleInput);
    form.append(titleLabel);

    const fields = el('div', 'dossier-fields');
    const dateLabel = el('label', '', 'Когда это было');
    const dateInput = el('input');
    dateInput.type = 'datetime-local';
    dateInput.value = toLocalInput(entry?.occurred_at);
    dateLabel.append(dateInput);
    const tagsLabel = el('label', '', 'Теги');
    const tagsInput = el('input');
    tagsInput.placeholder = '#ссора #учёба';
    tagsInput.value = formatTagsInput(entry?.tags || []);
    tagsLabel.append(tagsInput);
    fields.append(dateLabel, tagsLabel);
    form.append(fields);

    // Участники
    const peopleBox = el('fieldset', 'dossier-people-picker');
    peopleBox.append(el('legend', '', 'Кто участвовал'));
    const selectedPeople = new Set(
      editing ? [...(linksByEntry.get(entry.id) || [])] : (presetPersonId ? [presetPersonId] : []),
    );
    if (!people.length) {
      peopleBox.append(el('p', 'muted', 'Сначала добавь людей в досье.'));
    } else {
      people.forEach(person => {
        const option = el('label', 'dossier-person-option');
        const checkbox = el('input');
        checkbox.type = 'checkbox';
        checkbox.value = person.id;
        checkbox.checked = selectedPeople.has(person.id);
        checkbox.onchange = () => {
          if (checkbox.checked) selectedPeople.add(person.id);
          else selectedPeople.delete(person.id);
        };
        option.append(checkbox, el('span', '', person.name));
        peopleBox.append(option);
      });
    }
    form.append(peopleBox);

    // Markdown-текст
    const bodyLabel = el('label', 'dossier-body-label', 'Что помнишь');
    const editorHost = el('div', 'dossier-editor');
    bodyLabel.append(editorHost);
    form.append(bodyLabel);
    const editor = attachEditor(editorHost, {
      value: entry?.body || '',
      id: `dossier-body-${entryId}`,
      onError: message => notice(message, true),
      onLink: () => {},
      onImageFile: (file) => pasteMediaToGallery(file),
      onFile: (file) => pasteMediaToGallery(file),
    });

    // Вставка из буфера/перетаскиванием: сразу в приватное хранилище и в галерею.
    async function pasteMediaToGallery(file) {
      classifyUpload(file);
      await requireSession();
      const path = mediaPath(userId, entryId, file.name);
      const { error } = await client.storage.from(BUCKET).upload(path, file, {
        contentType: file.type || 'application/octet-stream',
        upsert: false,
      });
      if (error) throw new Error('Не удалось загрузить файл. Проверь хранилище dossier-media.');
      const signed = await client.storage.from(BUCKET).createSignedUrl(path, 3600);
      if (signed.data?.signedUrl) mediaUrls.set(path, signed.data.signedUrl);
      keptAttachments.push({ path, name: file.name, type: file.type, size: file.size });
      renderPhotos();
      notice('Файл добавлен в галерею записи.');
    }

    // Фото, скриншоты, видео и файлы
    const keptAttachments = [...(entry?.attachments || [])];
    const pendingFiles = [];
    const photosBox = el('div', 'dossier-photos');
    const photosHead = el('div', 'dossier-photos-head');
    photosHead.append(el('span', '', 'Фото, видео и файлы'));
    const addPhoto = el('button', 'secondary', 'Добавить файл');
    addPhoto.type = 'button';
    const fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,application/pdf,text/plain,text/markdown,text/csv,application/zip';
    fileInput.multiple = true;
    fileInput.hidden = true;
    addPhoto.onclick = () => fileInput.click();
    fileInput.onchange = () => {
      for (const file of fileInput.files) {
        if (keptAttachments.length + pendingFiles.length >= MAX_FILES) {
          notice(`Не больше ${MAX_FILES} файлов на запись.`, true);
          break;
        }
        try { classifyUpload(file); }
        catch (error) { notice(error.message, true); continue; }
        pendingFiles.push(file);
      }
      fileInput.value = '';
      renderPhotos();
    };
    photosHead.append(addPhoto, fileInput);
    photosBox.append(photosHead);
    const photosGrid = el('div', 'dossier-gallery dossier-gallery-edit');
    photosBox.append(photosGrid);
    form.append(photosBox);

    function renderPhotos() {
      photosGrid.replaceChildren();
      keptAttachments.forEach(att => {
        const cell = el('div', 'dossier-photo-cell');
        cell.append(mediaThumb(att, mediaUrls.get(att.path)));
        cell.append(button('×', () => {
          keptAttachments.splice(keptAttachments.indexOf(att), 1);
          renderPhotos();
        }, 'dossier-photo-remove'));
        photosGrid.append(cell);
      });
      pendingFiles.forEach(file => {
        const cell = el('div', 'dossier-photo-cell');
        const src = URL.createObjectURL(file);
        cell.append(mediaThumb({ name: file.name, type: file.type, size: file.size }, src));
        cell.append(button('×', () => {
          URL.revokeObjectURL(src);
          pendingFiles.splice(pendingFiles.indexOf(file), 1);
          renderPhotos();
        }, 'dossier-photo-remove'));
        photosGrid.append(cell);
      });
    }
    renderPhotos();

    // ИИ-помощник
    let assistantOutput = null;
    if (onAssistant) {
      const assistantRow = el('div', 'dossier-assistant');
      const askBtn = button('Уточнить с ИИ', async () => {
        const text = editor.getValue().trim();
        if (!text) { notice('Сначала опиши событие, чтобы ИИ было что разобрать.', true); return; }
        askBtn.disabled = true;
        askBtn.textContent = 'Думаю…';
        try {
          const result = await onAssistant({ action: 'dossier:analyze', title: titleInput.value.trim(), body: text });
          const answer = result?.text || result?.analysis || result?.answer || '';
          if (!assistantOutput) {
            assistantOutput = el('div', 'assistant-output');
            assistantRow.append(assistantOutput);
          }
          assistantOutput.innerHTML = renderMarkdown(String(answer));
        } catch (error) {
          notice(error?.message || 'ИИ-помощник недоступен.', true);
        } finally {
          askBtn.disabled = false;
          askBtn.textContent = 'Уточнить с ИИ';
        }
      }, 'secondary');
      assistantRow.prepend(askBtn);
      form.append(assistantRow);
    }

    const status = el('p', 'detail-status');
    const footer = el('div', 'dossier-form-footer');
    const save = el('button', 'primary', editing ? 'Сохранить' : 'Добавить запись');
    save.type = 'submit';
    footer.append(status, save);
    form.append(footer);

    form.onsubmit = e => {
      e.preventDefault();
      run(async () => {
        const title = titleInput.value.trim();
        if (!title) throw new Error('Укажи заголовок записи.');
        await requireSession();

        const uploaded = [];
        for (const file of pendingFiles) {
          const path = mediaPath(userId, entryId, file.name);
          const { error } = await client.storage.from(BUCKET).upload(path, file, {
            contentType: file.type || 'application/octet-stream',
            upsert: false,
          });
          if (error) throw new Error('Не удалось загрузить файл. Проверь хранилище dossier-media.');
          uploaded.push({ path, name: file.name, type: file.type, size: file.size });
          mediaUrls.delete(path);
        }

        const payload = {
          id: entryId,
          user_id: userId,
          title,
          body: editor.getValue(),
          occurred_at: fromLocalInput(dateInput.value),
          tags: parseTagInput(tagsInput.value),
          attachments: [...keptAttachments, ...uploaded],
        };
        const saved = editing
          ? await client.from('dossier_entries').update(payload).eq('id', entryId).select('id')
          : await client.from('dossier_entries').insert(payload).select('id');
        if (saved.error || !saved.data?.length) throw new Error('Не удалось сохранить запись.');

        const linkRows = [...selectedPeople].map(personId => ({ entry_id: entryId, person_id: personId, user_id: userId }));
        const cleared = await client.from('dossier_entry_people').delete().eq('entry_id', entryId);
        if (cleared.error) throw new Error('Не удалось обновить участников.');
        if (linkRows.length) {
          const linked = await client.from('dossier_entry_people').insert(linkRows);
          if (linked.error) throw new Error('Не удалось связать участников.');
        }

        const removedPaths = (entry?.attachments || [])
          .filter(att => !keptAttachments.some(kept => kept.path === att.path))
          .map(att => att.path)
          .filter(Boolean);
        if (removedPaths.length) {
          try { await client.storage.from(BUCKET).remove(removedPaths); } catch { /* не критично */ }
          removedPaths.forEach(path => mediaUrls.delete(path));
        }

        dialog.remove();
        notice(editing ? 'Запись обновлена.' : 'Запись добавлена.');
        await load();
      }, save);
    };

    dialog.showModal();
    titleInput.focus();
  }

  async function deleteEntry(entry) {
    if (!window.confirm(`Удалить запись «${entry.title}»?`)) return;
    await run(async () => {
      const paths = (entry.attachments || []).map(att => att.path).filter(Boolean);
      const { error } = await client.from('dossier_entries').delete().eq('id', entry.id);
      if (error) throw new Error('Не удалось удалить запись.');
      if (paths.length) {
        try { await client.storage.from(BUCKET).remove(paths); } catch { /* не критично */ }
        paths.forEach(path => mediaUrls.delete(path));
      }
      notice('Запись удалена.');
      await load();
    });
  }

  load();

  return (force = false) => {
    if (!force && (query || activeTag)) { /* просто закрываем */ }
    alive = false;
    host.querySelector('dialog.dossier-dialog')?.remove();
    return true;
  };
}
