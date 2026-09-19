import { attachEditor } from './editor.js';
import { renderMarkdown } from './security.js';
import { icon } from './icons.js';
import { brandHtml } from './router.js';
import { editImage, validateImageFile } from './image-editor.js';

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
  const base = (import.meta.env?.BASE_URL || '/').replace(/\/+$/, '') + '/';
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
  const base = (import.meta.env?.BASE_URL || '/').replace(/\/+$/, '') + '/';
  host.innerHTML = `<main class="public-profile-page loading">${brandHtml(base)}<p>Загрузка профиля…</p></main>`;

  let profile = null;
  const rpcProf = await client.rpc('get_public_profile', { profile_username: username }).maybeSingle();
  if (!rpcProf.error && rpcProf.data) {
    profile = rpcProf.data;
  } else {
    const { data: directProf } = await client
      .from('profiles')
      .select('username,display_name,avatar_url,bio')
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
            ${profile.bio ? `<p class="author-bio">${escapeHtml(profile.bio)}</p>` : ''}
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
      validateImageFile(file);
      uploadStatus.textContent = 'Подготовка…';
      const croppedBlob = await editImage(file, {
        aspectRatio: null,
        outputWidth: 1600,
        outputHeight: 1200,
        cropShape: 'rect',
        title: 'Редактирование фото статьи',
      });
      if (!croppedBlob) {
        uploadStatus.textContent = '';
        return;
      }
      uploadStatus.textContent = 'Загрузка…';
      const url = await uploadMedia(croppedBlob, file.name);
      insert(`\n![${escapeHtml(file.name.replace(/\.[^.]+$/, ''))}|640](${url})\n`);
      notice('Изображение вставлено в текст.');
      close();
    } catch (err) {
      uploadStatus.textContent = err.message || 'Ошибка загрузки';
      notice(err.message || 'Ошибка загрузки', true);
    } finally {
      fileInput.value = '';
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

export function mountArticles(host, { client, userId, username, profile, notice, requireSession }) {
  let articles = [], selected = null, editor = null, alive = true;

  const uploadMedia = async (file, originalName) => {
    validateImageFile(file);
    const fileName = originalName || file.name || 'image';
    const safe = fileName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    const path = `${userId}/${crypto.randomUUID()}-${safe}`;
    const { error } = await client.storage.from('article-media').upload(path, file, {
      contentType: file.type || 'image/jpeg',
      upsert: false,
    });
    if (error) {
      console.error('[Image Pipeline: storage upload]', {
        code: error.code || null,
        message: error.message || null,
      });
      const err = new Error('Не удалось загрузить изображение в хранилище.');
      err.stage = 'storage upload';
      throw err;
    }
    const publicUrlData = client.storage.from('article-media').getPublicUrl(path)?.data;
    const url = publicUrlData?.publicUrl;
    if (!url) {
      console.error('[Image Pipeline: public URL]', { path });
      const err = new Error('Не удалось получить публичную ссылку на изображение.');
      err.stage = 'public URL';
      throw err;
    }
    return url;
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
    const titleText = article.title ? `«${article.title}»` : 'статью';
    if (!confirm(`Удалить ${titleText}?\nЭто действие нельзя отменить.`)) return;
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
    if (selected === null && articles.length > 0) {
      selected = articles[0].id;
    }
    render();
  };

  const showOverview = () => {
    selected = null;
    render();
  };

  const render = () => {
    if (!alive) return;
    host.replaceChildren();

    if (selected) {
      const art = articles.find(x => x.id === selected);
      if (art) {
        edit(art);
        return;
      }
    }

    const overview = document.createElement('div');
    overview.className = 'articles-overview';

    const heading = document.createElement('div');
    heading.className = 'work-heading';
    heading.append(Object.assign(document.createElement('h1'), { textContent: 'Публикации' }));

    const create = document.createElement('button');
    create.className = 'primary new-article-btn';
    create.textContent = 'Новая статья';
    create.prepend(icon('plus'));
    create.onclick = () => {
      const item = {
        id: null,
        title: '',
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
    overview.append(heading);

    if (articles.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Создай статью: она будет черновиком, пока ты не опубликуешь её.';
      overview.append(empty);
    } else {
      const grid = document.createElement('div');
      grid.className = 'articles-cards-grid';
      articles.filter(x => x.id).forEach(art => {
        const card = document.createElement('div');
        card.className = 'article-overview-card';
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.innerHTML = `
          <div class="article-overview-card__header">
            <h3 class="article-overview-card__title"></h3>
            <span class="article-access-badge badge-${escapeHtml(art.access || 'private')}">${
              art.access === 'public' ? 'Общедоступно' : art.access === 'unlisted' ? 'По ссылке' : 'Приватно'
            }</span>
          </div>
          ${art.excerpt ? `<p class="article-overview-card__excerpt">${escapeHtml(art.excerpt)}</p>` : ''}
          <div class="article-overview-card__footer">
            <time class="muted">${art.updated_at ? date(art.updated_at) : 'Черновик'}</time>
          </div>
        `;
        card.querySelector('.article-overview-card__title').textContent = art.title || 'Без названия';
        card.onclick = () => {
          selected = art.id;
          edit(art);
        };
        card.onkeydown = e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selected = art.id;
            edit(art);
          }
        };
        grid.append(card);
      });
      overview.append(grid);
    }

    host.append(overview);
  };

  function edit(article) {
    host.replaceChildren();

    const form = document.createElement('form');
    form.className = 'article-writer';

    form.innerHTML = `
      <header class="article-top-bar">
        <div class="article-top-bar__left">
          <button type="button" class="quiet icon-button article-back-btn" title="Ко всем статьям" aria-label="Ко всем статьям">
            <span class="article-back-text">Статьи</span>
          </button>
        </div>
        <div class="article-top-bar__center">
          <div class="article-save-status notice" role="status" aria-live="polite">Сохранено</div>
        </div>
        <div class="article-top-bar__right">
          <button type="button" class="quiet icon-button article-settings-btn" title="Настройки статьи" aria-label="Настройки статьи" aria-haspopup="dialog" aria-expanded="false">
            <span class="article-settings-btn-text">Настройки</span>
          </button>
          <button type="submit" class="primary article-save-btn">Сохранить</button>
        </div>
      </header>

      <div class="article-toolbar-host"></div>

      <div class="article-canvas-scroll">
        <div class="article-title-editor">
          <input type="text" name="title" class="article-title-input" maxlength="180" placeholder="Заголовок" required spellcheck="false" autocomplete="off">
          <h1 class="article-title-preview" hidden></h1>
        </div>

        <div class="article-body-editor"></div>
      </div>

      <div class="article-settings-backdrop" hidden>
        <aside class="article-settings-drawer" role="dialog" aria-label="Настройки статьи" aria-modal="true">
          <div class="article-settings-header">
            <h3>Настройки статьи</h3>
            <button type="button" class="quiet icon-button close-settings-btn" aria-label="Закрыть настройки">✕</button>
          </div>
          <div class="article-settings-body">
            <label class="drawer-field">
              <span class="drawer-field-title">Адрес статьи (slug)</span>
              <input name="slug" maxlength="80" pattern="[a-z0-9а-яё-]+" required class="drawer-input">
              <small class="drawer-slug-preview muted"></small>
            </label>

            <label class="drawer-field">
              <span class="drawer-field-title">Доступ</span>
              <select name="access" class="drawer-select">
                <option value="private">Приватно (черновик)</option>
                <option value="unlisted">Только по ссылке</option>
                <option value="public">Общедоступно</option>
              </select>
            </label>

            <div class="drawer-field">
              <span class="drawer-field-title">Обложка</span>
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

            <div class="drawer-field">
              <span class="drawer-field-title">Публичная ссылка</span>
              <button type="button" class="secondary w-full copy-link-btn" data-copy>Скопировать ссылку</button>
            </div>

            <div class="drawer-field drawer-danger-zone">
              <span class="drawer-field-title">Опасная зона</span>
              <button class="danger quiet delete-article-btn" type="button">Удалить статью</button>
            </div>
          </div>
          <div class="article-settings-footer">
            <button type="button" class="primary close-settings-done-btn">Готово</button>
          </div>
        </aside>
      </div>
    `;

    // Prepend SVG icons via DOM (not innerHTML) to avoid [object SVGSVGElement]
    form.querySelector('.article-back-btn').prepend(icon('back'));
    form.querySelector('.article-settings-btn').prepend(icon('settings'));

    // Title input and preview
    const titleInput = form.elements.title;
    const titlePreview = form.querySelector('.article-title-preview');
    titleInput.value = article.title || '';
    titlePreview.textContent = (article.title || '').trim() || 'Без заголовка';

    const saveStatus = form.querySelector('.article-save-status');
    saveStatus.textContent = 'Сохранено';
    const markDirty = () => {
      saveStatus.textContent = 'Есть изменения';
      saveStatus.classList.add('is-dirty');
      saveStatus.classList.remove('error');
    };

    titleInput.addEventListener('input', () => {
      titlePreview.textContent = titleInput.value.trim() || 'Без заголовка';
      markDirty();
    });
    titleInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        editor?.focus();
      }
    });

    // Slug & live preview
    const slugInput = form.elements.slug;
    slugInput.value = article.slug || '';
    const slugPreview = form.querySelector('.drawer-slug-preview');
    const base = (import.meta.env?.BASE_URL || '/').replace(/\/+$/, '') + '/';
    const updateSlugPreview = () => {
      const s = slugify(slugInput.value.trim());
      slugPreview.textContent = `${base}${articleHash(s)}`;
    };
    updateSlugPreview();
    slugInput.addEventListener('input', () => {
      updateSlugPreview();
      markDirty();
    });

    // Access selector & Save button text
    const accessSelect = form.elements.access;
    accessSelect.value = article.access || (article.published ? 'public' : 'private');
    const saveBtn = form.querySelector('.article-save-btn');
    const updateSaveBtnText = () => {
      const val = accessSelect.value;
      saveBtn.textContent = (val === 'unlisted' || val === 'public') ? 'Сохранить изменения' : 'Сохранить';
    };
    updateSaveBtnText();
    accessSelect.addEventListener('change', () => {
      updateSaveBtnText();
      markDirty();
    });

    // Settings Drawer controls
    const settingsBackdrop = form.querySelector('.article-settings-backdrop');
    const settingsBtn = form.querySelector('.article-settings-btn');
    const closeSettingsBtn = form.querySelector('.close-settings-btn');
    const doneSettingsBtn = form.querySelector('.close-settings-done-btn');

    const openSettings = () => {
      settingsBackdrop.hidden = false;
      settingsBtn.setAttribute('aria-expanded', 'true');
      slugInput.focus();
    };
    const closeSettings = () => {
      settingsBackdrop.hidden = true;
      settingsBtn.setAttribute('aria-expanded', 'false');
      editor?.focus();
    };

    settingsBtn.onclick = openSettings;
    closeSettingsBtn.onclick = closeSettings;
    doneSettingsBtn.onclick = closeSettings;
    settingsBackdrop.onclick = e => {
      if (e.target === settingsBackdrop) closeSettings();
    };

    const onKeydownBackdrop = e => {
      if (!form.isConnected) {
        document.removeEventListener('keydown', onKeydownBackdrop);
        return;
      }
      if (e.key === 'Escape' && !settingsBackdrop.hidden) {
        closeSettings();
      }
    };
    document.addEventListener('keydown', onKeydownBackdrop);

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
        validateImageFile(file);
        coverUploadStatus.textContent = 'Кадрирование…';
        const croppedBlob = await editImage(file, {
          aspectRatio: 16 / 9,
          outputWidth: 1600,
          outputHeight: 900,
          cropShape: 'rect',
          title: 'Обложка статьи (16:9)',
        });
        if (!croppedBlob) {
          coverUploadStatus.textContent = '';
          return;
        }
        coverUploadStatus.textContent = 'Загрузка…';
        const url = await uploadMedia(croppedBlob, file.name);
        coverInput.value = url;
        coverPreviewImg.src = url;
        coverPreviewBox.hidden = false;
        coverUploadStatus.textContent = 'Обложка установлена.';
        markDirty();
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
      markDirty();
    };

    removeCoverBtn.onclick = () => {
      coverInput.value = '';
      coverPreviewImg.src = '';
      coverPreviewBox.hidden = true;
      coverUrlField.value = '';
      coverUploadStatus.textContent = '';
      markDirty();
    };

    changeCoverBtn.onclick = () => {
      setCoverTab('upload');
      selectCoverBtn.click();
    };

    // Editor attachment
    editor = attachEditor(form.querySelector('.article-body-editor'), {
      toolbarHost: form.querySelector('.article-toolbar-host'),
      value: article.body,
      variant: 'article',
      onChange: () => {
        markDirty();
      },
      onModeChange: mode => {
        form.setAttribute('data-mode', mode);
        form.classList.toggle('is-split', mode === 'split');
        if (mode === 'preview') {
          titleInput.hidden = true;
          titlePreview.hidden = false;
          titlePreview.textContent = titleInput.value.trim() || 'Без заголовка';
        } else {
          titleInput.hidden = false;
          titlePreview.hidden = true;
        }
      },
      onError: m => notice(m, true),
      onImageRequest: ({ insert }) => {
        openArticleImageDialog({ uploadMedia, insert, notice });
      },
    });

    // Back to overview
    form.querySelector('.article-back-btn').onclick = () => {
      showOverview();
    };

    // Copy public link
    form.querySelector('[data-copy]').onclick = () => {
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
      saveBtn.disabled = true;
      saveStatus.className = 'article-save-status notice';
      saveStatus.textContent = 'Сохраняем…';
      try {
        article.title = form.elements.title.value;
        article.slug = slugify(form.elements.slug.value);
        article.cover_url = coverInput.value;
        article.access = form.elements.access.value;
        article.body = editor.getValue();
        await save(article);
        notice(article.access === 'private' ? 'Приватная статья сохранена.' : 'Статья сохранена.');
        saveStatus.textContent = 'Сохранено';
        saveStatus.classList.remove('is-dirty', 'error');
        updateSaveBtnText();
      } catch (error) {
        saveStatus.textContent = error?.message || 'Не удалось сохранить статью.';
        saveStatus.classList.add('error');
        notice(error?.message || 'Не удалось сохранить статью.', true);
      } finally {
        saveBtn.disabled = false;
      }
    };

    // Shortcut Ctrl+S / Cmd+S
    form.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    host.append(form);
  }

  refresh().catch(error => {
    host.textContent = error.message;
    notice(error.message, true);
  });

  return () => {
    alive = false;
    return true;
  };
}
