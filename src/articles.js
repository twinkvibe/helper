import { attachEditor } from './editor.js';
import { renderMarkdown } from './security.js';
import { icon } from './icons.js';
import { brandHtml } from './router.js';
import { editImage } from './image-editor.js';

const MAX_BODY = 5000000;
const slugify = value =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'article';

const date = value =>
  value ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(value)) : '';

const excerpt = body =>
  body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#>*_~`\[\]()|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);

const escapeHtml = str =>
  String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function articleHash(slug) {
  return `#article=${encodeURIComponent(slug)}`;
}

export function publicArticleSlug(hash = location.hash) {
  const value = hash.match(/^#article=([^&]+)$/)?.[1];
  try {
    return value ? decodeURIComponent(value) : null;
  } catch {
    return null;
  }
}

export async function renderPublicArticle(host, client, slug) {
  const base = (import.meta.env?.BASE_URL || '/helper/').replace(/\/+$/, '') + '/';
  host.innerHTML = `<main class="public-article loading">${brandHtml(base)}<p>Открываем публикацию…</p></main>`;

  let data = null;
  // Try secure RPC first (allows public and unlisted by exact slug)
  const rpcRes = await client.rpc('get_article_by_slug', { article_slug: slug }).maybeSingle();
  if (!rpcRes.error && rpcRes.data) {
    data = rpcRes.data;
  } else {
    // Fallback query for existing setups
    const { data: directData } = await client
      .from('articles')
      .select('title,slug,body,excerpt,cover_url,author_name,author_avatar_url,access,published_at,updated_at')
      .eq('slug', slug)
      .in('access', ['public', 'unlisted'])
      .maybeSingle();
    data = directData;
  }

  if (!data) {
    host.innerHTML = `<main class="public-article missing">${brandHtml(base)}<h1>Публикация не найдена</h1><p class="muted">Возможно, ссылка устарела или статья стала черновиком.</p><a class="primary public-login" href="${base}">Войти в Helper</a></main>`;
    return;
  }

  host.innerHTML = `
    <main class="public-article">
      <header class="public-header">
        ${brandHtml(base)}
        <a class="quiet account-link" href="${base}">Войти</a>
      </header>
      <div class="article-cover article-cover-empty"></div>
      <article class="article-paper">
        <header class="article-title">
          <h1></h1>
          <div class="article-byline"></div>
        </header>
        <div class="article-body"></div>
      </article>
    </main>
  `;

  const { data: { session } } = await client.auth.getSession();
  if (session) {
    const { data: me } = await client
      .from('profiles')
      .select('username,display_name,avatar_url')
      .eq('id', session.user.id)
      .maybeSingle();
    if (me) {
      const link = host.querySelector('.account-link');
      link.textContent = me.display_name || `@${me.username}`;
      if (me.avatar_url) {
        const avatar = document.createElement('img');
        avatar.className = 'account-avatar';
        avatar.src = me.avatar_url;
        avatar.alt = '';
        avatar.referrerPolicy = 'no-referrer';
        link.prepend(avatar);
      }
    }
  }

  if (data.cover_url && /^https:\/\//i.test(data.cover_url)) {
    const image = document.createElement('img');
    image.className = 'article-cover';
    image.src = data.cover_url;
    image.alt = '';
    image.referrerPolicy = 'no-referrer';
    host.querySelector('.article-cover').replaceWith(image);
  }

  host.querySelector('h1').textContent = data.title;
  const byline = host.querySelector('.article-byline');

  const authorHandle = data.author_name || 'автор';
  const authorDisplay = data.author_display_name || null;
  const authorAvatar = data.author_avatar_url || null;
  const authorUrl = `${base}u/${encodeURIComponent(authorHandle)}`;

  byline.innerHTML = `
    <a href="${authorUrl}" class="article-author-link">
      ${authorAvatar && /^https:\/\//i.test(authorAvatar) ? `<img class="article-author-avatar" src="${escapeHtml(authorAvatar)}" alt="" referrerpolicy="no-referrer">` : ''}
      <span>${escapeHtml(authorDisplay || `@${authorHandle}`)}</span>
    </a>
    ${authorDisplay ? `<span class="muted">@${escapeHtml(authorHandle)}</span>` : ''}
    <span class="muted">· ${date(data.published_at)}</span>
  `;

  host.querySelector('.article-body').innerHTML = renderMarkdown(data.body);
  host.querySelectorAll('.article-body pre > code[class*="language-"]').forEach(code => {
    const language = code.className.match(/(?:^|\s)language-([\w+-]+)/)?.[1];
    if (!language) return;
    const label = document.createElement('span');
    label.className = 'code-language';
    label.textContent = language;
    code.parentElement.prepend(label);
  });
  host.querySelectorAll('.article-body input[type="checkbox"]').forEach(input => {
    input.disabled = true;
    input.setAttribute('aria-disabled', 'true');
  });

  document.title = `${data.title} — helper`;
  [
    ['og:title', data.title],
    ['og:description', data.excerpt || excerpt(data.body)],
    ['og:url', location.href],
    ['twitter:title', data.title],
    ['twitter:description', data.excerpt || excerpt(data.body)],
  ].forEach(([property, content]) => {
    let meta = document.querySelector(`meta[property="${property}"],meta[name="${property}"]`);
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute(property.startsWith('twitter:') ? 'name' : 'property', property);
      document.head.append(meta);
    }
    meta.content = content;
  });

  if (data.cover_url && /^https:\/\//i.test(data.cover_url)) {
    let meta = document.querySelector('meta[property="og:image"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('property', 'og:image');
      document.head.append(meta);
    }
    meta.content = data.cover_url;
  }
}

export async function renderPublicProfile(host, client, username) {
  const base = (import.meta.env?.BASE_URL || '/helper/').replace(/\/+$/, '') + '/';
  host.innerHTML = `<main class="public-profile-page loading">${brandHtml(base)}<p>Загрузка профиля…</p></main>`;

  let profile = null;
  const rpcProf = await client.rpc('get_public_profile', { profile_username: username }).maybeSingle();
  if (!rpcProf.error && rpcProf.data) {
    profile = rpcProf.data;
  } else {
    const { data: directProf } = await client
      .from('profiles')
      .select('username,display_name,avatar_url')
      .eq('username', username)
      .eq('blocked', false)
      .maybeSingle();
    profile = directProf;
  }

  if (!profile) {
    host.innerHTML = `
      <main class="public-profile-page">
        <div class="public-profile-container">
          <header class="public-header">${brandHtml(base)}</header>
          <div class="not-found-card panel">
            <h2>Автор не найден</h2>
            <p class="muted">Пользователь @${escapeHtml(username)} не существует или заблокирован.</p>
            <a class="primary" href="${base}">Вернуться в Helper</a>
          </div>
        </div>
      </main>
    `;
    return;
  }

  // Load public articles
  let articles = [];
  const rpcArts = await client.rpc('get_public_articles_by_author', { author_username: username });
  if (!rpcArts.error && Array.isArray(rpcArts.data)) {
    articles = rpcArts.data;
  } else {
    const { data: directArts } = await client
      .from('articles')
      .select('id,title,slug,excerpt,cover_url,published_at')
      .eq('author_name', username)
      .eq('access', 'public')
      .order('published_at', { ascending: false });
    articles = directArts || [];
  }

  const displayName = profile.display_name || profile.username;
  document.title = `${displayName} (@${profile.username}) — helper`;

  host.innerHTML = `
    <main class="public-profile-page">
      <div class="public-profile-container">
        <header class="public-header">
          ${brandHtml(base)}
          <a class="quiet account-link" href="${base}">Войти</a>
        </header>
        <section class="public-author-header">
          <div class="author-avatar-xl">
            ${profile.avatar_url && /^https:\/\//i.test(profile.avatar_url)
              ? `<img src="${escapeHtml(profile.avatar_url)}" alt="" referrerpolicy="no-referrer">`
              : `<span>${escapeHtml(profile.username.slice(0, 1).toUpperCase())}</span>`
            }
          </div>
          <div class="author-meta">
            <h1>${escapeHtml(displayName)}</h1>
            <span class="handle">@${escapeHtml(profile.username)}</span>
          </div>
        </section>
        <section class="author-articles-section">
          <h2>Публикации</h2>
          ${articles.length === 0
            ? '<p class="empty">Публичных статей пока нет.</p>'
            : `<div class="author-articles-grid">
                ${articles.map(art => `
                  <a class="author-article-card" href="${base}${articleHash(art.slug)}">
                    ${art.cover_url && /^https:\/\//i.test(art.cover_url)
                      ? `<img class="author-article-thumb" src="${escapeHtml(art.cover_url)}" alt="" referrerpolicy="no-referrer">`
                      : ''
                    }
                    <div class="author-article-info">
                      <h3>${escapeHtml(art.title)}</h3>
                      ${art.excerpt ? `<p>${escapeHtml(art.excerpt)}</p>` : ''}
                      <time>${date(art.published_at)}</time>
                    </div>
                  </a>
                `).join('')}
              </div>`
          }
        </section>
      </div>
    </main>
  `;
}

function openArticleImageDialog({ uploadMedia, insert, notice }) {
  const modal = document.createElement('div');
  modal.className = 'dialog-scrim';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-label', 'Вставить изображение в статью');

  modal.innerHTML = `
    <div class="dialog-box">
      <div class="image-editor-header">
        <h3>Вставить изображение</h3>
        <button type="button" class="quiet icon-button close-dialog" aria-label="Закрыть">✕</button>
      </div>
      <div class="image-editor-body" style="align-items: stretch;">
        <div class="cover-picker__tabs">
          <button type="button" class="tab-btn active" data-tab="upload">Загрузить</button>
          <button type="button" class="tab-btn" data-tab="url">По ссылке</button>
        </div>
        <div class="dialog-panel-upload" style="display: flex; flex-direction: column; gap: 10px;">
          <p class="muted" style="font-size: 13px; margin: 0;">Выбери файл PNG, JPEG, WebP или GIF до 5 МБ.</p>
          <button type="button" class="secondary select-file-btn">Выбрать файл</button>
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
          <p class="upload-status muted" style="font-size: 12px; margin: 0;"></p>
        </div>
        <div class="dialog-panel-url" style="display: none; flex-direction: column; gap: 10px;">
          <label style="display: grid; gap: 4px; font-size: 13px;">
            HTTPS-адрес изображения
            <input type="url" class="img-url-input" placeholder="https://example.com/photo.jpg" required>
          </label>
          <label style="display: grid; gap: 4px; font-size: 13px;">
            Описание (alt)
            <input type="text" class="img-alt-input" placeholder="Краткое описание" value="изображение">
          </label>
          <label style="display: grid; gap: 4px; font-size: 13px;">
            Ширина (пиксели, опционально)
            <input type="text" class="img-width-input" placeholder="640">
          </label>
        </div>
      </div>
      <div class="image-editor-footer">
        <button type="button" class="secondary close-btn">Отмена</button>
        <button type="button" class="primary confirm-btn" style="display: none;">Вставить</button>
      </div>
    </div>
  `;

  document.body.append(modal);

  const tabUpload = modal.querySelector('[data-tab="upload"]');
  const tabUrl = modal.querySelector('[data-tab="url"]');
  const panelUpload = modal.querySelector('.dialog-panel-upload');
  const panelUrl = modal.querySelector('.dialog-panel-url');
  const fileInput = modal.querySelector('input[type="file"]');
  const selectFileBtn = modal.querySelector('.select-file-btn');
  const uploadStatus = modal.querySelector('.upload-status');
  const confirmBtn = modal.querySelector('.confirm-btn');
  const urlInput = modal.querySelector('.img-url-input');
  const altInput = modal.querySelector('.img-alt-input');
  const widthInput = modal.querySelector('.img-width-input');

  let activeTab = 'upload';
  const setTab = tab => {
    activeTab = tab;
    if (tab === 'upload') {
      tabUpload.classList.add('active');
      tabUrl.classList.remove('active');
      panelUpload.style.display = 'flex';
      panelUrl.style.display = 'none';
      confirmBtn.style.display = 'none';
    } else {
      tabUrl.classList.add('active');
      tabUpload.classList.remove('active');
      panelUrl.style.display = 'flex';
      panelUpload.style.display = 'none';
      confirmBtn.style.display = '';
    }
  };

  tabUpload.onclick = () => setTab('upload');
  tabUrl.onclick = () => setTab('url');

  const close = () => modal.remove();
  modal.querySelector('.close-dialog').onclick = close;
  modal.querySelector('.close-btn').onclick = close;

  selectFileBtn.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      uploadStatus.textContent = 'Подготовка…';
      const croppedBlob = await editImage(file, {
        aspectRatio: null,
        outputWidth: 1600,
        outputHeight: 1200,
        title: 'Редактирование фото статьи',
      });
      if (!croppedBlob) {
        uploadStatus.textContent = '';
        return;
      }
      uploadStatus.textContent = 'Загрузка…';
      const url = await uploadMedia(croppedBlob);
      insert(`\n![${escapeHtml(file.name.replace(/\.[^.]+$/, ''))}|640](${url})\n`);
      notice('Изображение вставлено в текст.');
      close();
    } catch (err) {
      uploadStatus.textContent = err.message || 'Ошибка загрузки';
      notice(err.message || 'Ошибка загрузки', true);
    }
  };

  confirmBtn.onclick = () => {
    const url = urlInput.value.trim();
    if (!/^https:\/\//i.test(url)) {
      notice('Укажите корректную HTTPS-ссылку.', true);
      return;
    }
    const alt = altInput.value.trim() || 'изображение';
    const width = widthInput.value.trim();
    const tag = width ? `![${alt}|${width}](${url})` : `![${alt}](${url})`;
    insert(`\n${tag}\n`);
    notice('Изображение вставлено.');
    close();
  };
}

export function mountArticles(host, { client, userId, username, notice, requireSession }) {
  let articles = [], selected = null, editor = null, alive = true;

  const uploadMedia = async file => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
      throw new Error('Выбери PNG, JPEG, WebP или GIF до 5 МБ.');
    }
    const safe = (file.name || 'image').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    const path = `${userId}/${crypto.randomUUID()}-${safe}`;
    const { error } = await client.storage.from('article-media').upload(path, file, {
      contentType: file.type,
      upsert: false,
    });
    if (error) throw new Error('Не удалось загрузить изображение. Проверь права доступа к хранилищу.');
    return client.storage.from('article-media').getPublicUrl(path).data.publicUrl;
  };

  const save = async article => {
    await requireSession();
    const title = article.title.trim();
    if (!title) throw new Error('Добавь заголовок статьи.');
    if (article.body.length > MAX_BODY) throw new Error('Статья слишком большая (максимум 5 млн символов).');
    const payload = {
      title,
      slug: article.slug,
      body: article.body,
      excerpt: excerpt(article.body),
      cover_url: article.cover_url?.trim() || null,
      access: article.access,
      published: article.access !== 'private',
      published_at: article.access !== 'private' ? article.published_at || new Date().toISOString() : null,
      author_name: username,
      updated_at: new Date().toISOString(),
    };
    const query = article.id
      ? client.from('articles').update(payload).eq('id', article.id)
      : client.from('articles').insert({ ...payload, user_id: userId });
    const { data, error } = await query.select('*');
    if (error || !data?.[0]) {
      throw new Error(error?.code === '23505' ? 'Такая ссылка уже занята — измени адрес.' : 'Не удалось сохранить статью. Проверь подключение.');
    }
    const saved = data[0];
    if (article.id) {
      articles = articles.map(x => (x.id === saved.id ? saved : x));
    } else {
      Object.assign(article, saved);
      articles = [article, ...articles.filter(x => x !== article)];
    }
    selected = saved.id;
    return saved;
  };

  const deleteArticle = async article => {
    if (!article.id) {
      articles = articles.filter(x => x !== article);
      selected = articles[0]?.id || null;
      render();
      return;
    }
    if (!confirm(`Удалить «${article.title}»?\nЭто действие нельзя отменить.`)) return;
    await requireSession();
    const { error } = await client.from('articles').delete().eq('id', article.id);
    if (error) {
      notice('Не удалось удалить статью.', true);
      return;
    }
    notice('Статья удалена.');
    articles = articles.filter(x => x.id !== article.id);
    selected = articles[0]?.id || null;
    render();
  };

  const copy = text =>
    navigator.clipboard
      ?.writeText(text)
      .then(() => notice('Публичная ссылка скопирована.'))
      .catch(() => notice(text));

  const refresh = async () => {
    await requireSession();
    const { data, error } = await client
      .from('articles')
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) throw new Error('Не удалось загрузить статьи. Проверь подключение.');
    articles = data || [];
    render();
  };

  const render = () => {
    if (!alive) return;
    host.replaceChildren();

    const heading = document.createElement('div');
    heading.className = 'work-heading';
    heading.append(Object.assign(document.createElement('h1'), { textContent: 'Публикации' }));

    const create = document.createElement('button');
    create.className = 'primary';
    create.textContent = 'Новая статья';
    create.prepend(icon('plus'));
    create.onclick = () => {
      const item = {
        id: null,
        title: 'Без названия',
        slug: `${slugify('bez-nazvaniya')}-${Math.random().toString(36).slice(2, 7)}`,
        body: '',
        excerpt: '',
        cover_url: '',
        access: 'private',
        published: false,
      };
      articles.unshift(item);
      selected = null;
      edit(item);
    };
    heading.append(create);
    host.append(heading);

    const layout = document.createElement('div');
    layout.className = 'articles-layout';
    const list = document.createElement('aside');
    list.className = 'article-list';
    const pane = document.createElement('section');
    pane.className = 'article-pane';
    layout.append(list, pane);
    host.append(layout);

    const add = article => {
      const b = document.createElement('button');
      b.className = `article-list-item ${article.id === selected ? 'selected' : ''}`;
      b.innerHTML = `<strong></strong><small>${
        article.access === 'public' ? 'Общедоступно' : article.access === 'unlisted' ? 'По ссылке' : 'Приватно'
      }</small>`;
      b.querySelector('strong').textContent = article.title;
      b.onclick = () => {
        selected = article.id;
        edit(article);
      };
      list.append(b);
    };

    articles.filter(x => x.id).forEach(add);
    if (!articles.some(x => x.id === selected)) {
      if (articles[0]?.id) {
        selected = articles[0].id;
        edit(articles[0]);
      } else {
        pane.innerHTML = '<p class="empty">Создай статью: она будет черновиком, пока ты не опубликуешь её.</p>';
      }
    }

    function edit(article) {
      pane.replaceChildren();
      const form = document.createElement('form');
      form.className = 'article-form';
      form.innerHTML = `
        <label>Заголовок<input name="title" maxlength="180" required></label>
        <div class="article-fields">
          <div class="article-meta-col">
            <label>Адрес статьи<input name="slug" maxlength="80" pattern="[a-z0-9а-яё-]+" required></label>
            <label>Доступ
              <select name="access">
                <option value="private">Приватно</option>
                <option value="unlisted">Только по ссылке</option>
                <option value="public">Общедоступно</option>
              </select>
            </label>
          </div>
          <div class="cover-picker-container">
            <span class="field-label" style="font-size: 13px; font-weight: 550; display: block; margin-bottom: 6px;">Обложка</span>
            <div class="cover-picker">
              <div class="cover-picker__tabs">
                <button type="button" class="tab-btn active" data-cover-tab="upload">Загрузить</button>
                <button type="button" class="tab-btn" data-cover-tab="url">По ссылке</button>
              </div>
              <div class="cover-picker__panel cover-upload-panel">
                <button type="button" class="secondary select-cover-btn">Выбрать изображение</button>
                <input type="file" class="cover-file-hidden" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
                <small class="cover-upload-status muted"></small>
              </div>
              <div class="cover-picker__panel cover-url-panel" style="display: none;">
                <div class="cover-url-row">
                  <input type="url" class="cover-url-field" placeholder="https://example.com/cover.jpg">
                  <button type="button" class="secondary apply-cover-url-btn">Применить</button>
                </div>
              </div>
              <div class="cover-preview-box" ${article.cover_url ? '' : 'hidden'}>
                <img class="cover-preview-img" src="${escapeHtml(article.cover_url || '')}" alt="Обложка">
                <div class="cover-preview-actions">
                  <button type="button" class="quiet change-cover-btn">Изменить</button>
                  <button type="button" class="danger quiet remove-cover-btn">Удалить</button>
                </div>
              </div>
            </div>
            <input type="hidden" name="cover" value="${escapeHtml(article.cover_url || '')}">
          </div>
        </div>
        <div class="article-editor"></div>
        <div class="article-actions" style="display: flex; justify-content: space-between; align-items: center;">
          <div class="article-actions__left">
            <button class="danger quiet delete-article-btn" type="button">Удалить статью</button>
          </div>
          <div class="article-actions__right" style="display: flex; gap: 8px;">
            <button class="quiet" type="button" data-copy>Скопировать ссылку</button>
            <button class="primary" type="submit">Сохранить</button>
          </div>
        </div>
        <p class="notice" role="status"></p>
      `;

      form.elements.title.value = article.title;
      form.elements.slug.value = article.slug;
      form.elements.access.value = article.access || (article.published ? 'public' : 'private');

      // Cover Picker wiring
      const coverInput = form.elements.cover;
      const coverPreviewBox = form.querySelector('.cover-preview-box');
      const coverPreviewImg = form.querySelector('.cover-preview-img');
      const coverTabUpload = form.querySelector('[data-cover-tab="upload"]');
      const coverTabUrl = form.querySelector('[data-cover-tab="url"]');
      const coverUploadPanel = form.querySelector('.cover-upload-panel');
      const coverUrlPanel = form.querySelector('.cover-url-panel');
      const selectCoverBtn = form.querySelector('.select-cover-btn');
      const coverFileHidden = form.querySelector('.cover-file-hidden');
      const coverUploadStatus = form.querySelector('.cover-upload-status');
      const coverUrlField = form.querySelector('.cover-url-field');
      const applyCoverUrlBtn = form.querySelector('.apply-cover-url-btn');
      const removeCoverBtn = form.querySelector('.remove-cover-btn');
      const changeCoverBtn = form.querySelector('.change-cover-btn');

      const setCoverTab = mode => {
        if (mode === 'upload') {
          coverTabUpload.classList.add('active');
          coverTabUrl.classList.remove('active');
          coverUploadPanel.style.display = 'flex';
          coverUrlPanel.style.display = 'none';
        } else {
          coverTabUrl.classList.add('active');
          coverTabUpload.classList.remove('active');
          coverUrlPanel.style.display = 'flex';
          coverUploadPanel.style.display = 'none';
        }
      };
      coverTabUpload.onclick = () => setCoverTab('upload');
      coverTabUrl.onclick = () => setCoverTab('url');

      selectCoverBtn.onclick = () => coverFileHidden.click();
      coverFileHidden.onchange = async () => {
        const file = coverFileHidden.files[0];
        if (!file) return;
        try {
          coverUploadStatus.textContent = 'Кадрирование…';
          const croppedBlob = await editImage(file, {
            aspectRatio: 16 / 9,
            outputWidth: 1600,
            outputHeight: 900,
            title: 'Обложка статьи (16:9)',
          });
          if (!croppedBlob) {
            coverUploadStatus.textContent = '';
            return;
          }
          coverUploadStatus.textContent = 'Загрузка…';
          const url = await uploadMedia(croppedBlob);
          coverInput.value = url;
          coverPreviewImg.src = url;
          coverPreviewBox.hidden = false;
          coverUploadStatus.textContent = 'Обложка установлена.';
        } catch (err) {
          coverUploadStatus.textContent = err.message || 'Ошибка загрузки';
          notice(err.message || 'Ошибка загрузки', true);
        } finally {
          coverFileHidden.value = '';
        }
      };

      applyCoverUrlBtn.onclick = () => {
        const url = coverUrlField.value.trim();
        if (!/^https:\/\//i.test(url)) {
          notice('Укажите корректный HTTPS URL для обложки', true);
          return;
        }
        coverInput.value = url;
        coverPreviewImg.src = url;
        coverPreviewBox.hidden = false;
        notice('Обложка по ссылке установлена.');
      };

      removeCoverBtn.onclick = () => {
        coverInput.value = '';
        coverPreviewImg.src = '';
        coverPreviewBox.hidden = true;
        coverUrlField.value = '';
        coverUploadStatus.textContent = '';
      };

      changeCoverBtn.onclick = () => {
        setCoverTab('upload');
        selectCoverBtn.click();
      };

      // Editor with onImageRequest
      editor = attachEditor(form.querySelector('.article-editor'), {
        value: article.body,
        onError: m => notice(m, true),
        onImageRequest: ({ insert }) => {
          openArticleImageDialog({ uploadMedia, insert, notice });
        },
      });

      // Copy link
      form.querySelector('[data-copy]').onclick = () => {
        const base = (import.meta.env?.BASE_URL || '/helper/').replace(/\/+$/, '') + '/';
        const fullUrl = new URL(`${base}${articleHash(form.elements.slug.value.trim())}`, location.href).href;
        copy(fullUrl);
      };

      // Delete article
      form.querySelector('.delete-article-btn').onclick = () => {
        deleteArticle(article);
      };

      // Save article
      form.onsubmit = async event => {
        event.preventDefault();
        const button = form.querySelector('[type=submit]');
        button.disabled = true;
        const status = form.querySelector('.notice');
        status.className = 'notice';
        status.textContent = 'Сохраняем…';
        try {
          article.title = form.elements.title.value;
          article.slug = slugify(form.elements.slug.value);
          article.cover_url = coverInput.value;
          article.access = form.elements.access.value;
          article.body = editor.getValue();
          await save(article);
          notice(article.access === 'private' ? 'Приватная статья сохранена.' : 'Статья сохранена.');
          status.textContent = 'Сохранено.';
        } catch (error) {
          status.textContent = error?.message || 'Не удалось сохранить статью.';
          status.classList.add('error');
        } finally {
          button.disabled = false;
        }
      };

      pane.append(form);
    }
  };

  refresh().catch(error => {
    host.textContent = error.message;
    notice(error.message, true);
  });

  return () => {
    alive = false;
    return true;
  };
}
