import { createClient } from '@supabase/supabase-js';
import { sessionStorageAdapter } from './security.js';
import { mountWorkbench } from './workbench.js';
import { mountArticles, publicArticleSlug, renderPublicArticle, renderPublicProfile } from './articles.js';
import { icon } from './icons.js';
import { parseRoute, sanitizeNext, pageHref, brandHtml, appPath } from './router.js';
import { editImage } from './image-editor.js';
import './style.css';
import './workbench.css';

const root = document.querySelector('#app');
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

let client, storage, user, profile, page = 'todos', generation = 0, cleanupView = null, authTimer = null, expiring = false, signingOut = false, authMessage = '';
const $ = (id) => document.getElementById(id);
const escape = (s) => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function notice(message, bad = false) {
  const el = $('notice');
  if (el) {
    el.textContent = message;
    el.className = bad ? 'notice error' : 'notice';
  }
}

function scheduleSessionCheck(session) {
  clearTimeout(authTimer);
  if (!session?.expires_at) return;
  const delay = Math.max(1000, session.expires_at * 1000 - Date.now() - 30000);
  authTimer = setTimeout(async () => {
    const { data, error } = await client.auth.refreshSession();
    if (error || !data.session) {
      expireSession();
      return;
    }
    scheduleSessionCheck(data.session);
  }, delay);
}

async function expireSession(message = 'Сессия истекла. Войди снова.') {
  if (expiring || !user) return;
  expiring = true;
  authMessage = message;
  clearTimeout(authTimer);
  signingOut = true;
  try {
    await client.auth.signOut({ scope: 'local' });
  } finally {
    signingOut = false;
    if (user) {
      user = null;
      profile = null;
      if (cleanupView) cleanupView(true);
      cleanupView = null;
      generation++;
      if (parseRoute(location.pathname).type !== 'login') {
        location.replace(appPath('login'));
      } else {
        login();
      }
    }
    expiring = false;
  }
}

async function requireSession() {
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) {
    await expireSession();
    throw new Error('Сессия истекла. Войди снова.');
  }
  const { data: currentProfile, error: profileError } = await client.from('profiles').select('*').eq('id', user.id).single();
  if (profileError || !currentProfile || currentProfile.blocked) {
    await expireSession('Этот аккаунт заблокирован администратором.');
    throw new Error('Доступ закрыт.');
  }
  profile = currentProfile;
  return data.session;
}

async function action(payload) {
  await requireSession();
  const session = (await client.auth.getSession()).data.session;
  const res = await fetch(`${url}/functions/v1/account`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Действие не выполнено.');
  return data;
}

function busy(form, callback) {
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const buttons = [...form.querySelectorAll('button')];
    buttons.forEach(b => b.disabled = true);
    try {
      await callback(new FormData(form));
    } catch (error) {
      notice(error.message, true);
    } finally {
      buttons.forEach(b => b.disabled = false);
    }
  });
}

function login() {
  if (cleanupView) cleanupView(true);
  cleanupView = null;
  generation++;
  user = null;
  profile = null;

  root.innerHTML = `
    <main class="login">
      <div class="intro">
        ${brandHtml()}
        <div>
          <p class="eyebrow">ТВОЁ ЛИЧНОЕ ПРОСТРАНСТВО</p>
          <h1>Меньше шума.<br>Больше <em>ясности.</em></h1>
          <p class="muted">Задачи, заметки и мысли.<br>Всё нужное — в одном месте.</p>
        </div>
        <small>01 / Место для главного</small>
      </div>
      <section class="login-card">
        <span class="badge">ТОЛЬКО ДЛЯ СВОИХ</span>
        <h2>С возвращением</h2>
        <p class="muted">Войди, чтобы продолжить с того же места.</p>
        <form id="login">
          <label>Логин
            <input name="username" autocomplete="username" pattern="[A-Za-z0-9_]{3,32}" required placeholder="Твой логин">
          </label>
          <label>Пароль
            <input name="password" type="password" autocomplete="current-password" required placeholder="Введи пароль">
          </label>
          <label class="check">
            <input name="remember" type="checkbox">Запомнить меня
          </label>
          <button class="primary">Войти <span>↗</span></button>
        </form>
        <p id="notice" class="notice" role="status" aria-live="polite"></p>
        <small>Нет аккаунта? Обратись к администратору.</small>
      </section>
    </main>
  `;

  if (authMessage) {
    notice(authMessage, true);
    authMessage = '';
  }

  busy($('login'), async f => {
    storage.setRemember(f.has('remember'));
    const { data, error } = await client.auth.signInWithPassword({
      email: `${String(f.get('username')).toLowerCase()}@users.helper.invalid`,
      password: String(f.get('password')),
    });
    if (error) throw new Error('Не удалось войти. Проверь логин, пароль и подключение.');
    await enter(data.user);
  });
}

function notFound(isAuth) {
  if (cleanupView) cleanupView(true);
  cleanupView = null;
  generation++;
  const returnHref = isAuth ? './' : './login';
  root.innerHTML = `
    <main class="not-found">
      <div class="not-found-card panel">
        <div style="margin-bottom: 20px;">${brandHtml()}</div>
        <h1>404</h1>
        <h2>Страница не найдена</h2>
        <p class="muted">Запрошенная страница не существует или была перемещена.</p>
        <a href="${returnHref}" class="primary">Вернуться в Helper</a>
      </div>
    </main>
  `;
}

async function enter(nextUser) {
  const token = ++generation;
  const { data, error } = await client.from('profiles').select('*').eq('id', nextUser.id).single();
  if (token !== generation) return;

  if (error || !data) {
    authMessage = 'Аккаунт ещё не настроен.';
    signingOut = true;
    try {
      await client.auth.signOut({ scope: 'local' });
    } finally {
      signingOut = false;
    }
    login();
    return;
  }
  if (data.blocked) {
    authMessage = 'Этот аккаунт заблокирован администратором.';
    signingOut = true;
    try {
      await client.auth.signOut({ scope: 'local' });
    } finally {
      signingOut = false;
    }
    login();
    return;
  }
  user = nextUser;
  profile = data;
  if (profile.must_change_password) page = 'settings';
  shell();
}

function shell() {
  if (cleanupView) cleanupView(true);
  cleanupView = null;

  const navGroups = [
    {
      title: 'Работа',
      items: [
        ['todos', 'tasks', 'Задачи'],
        ['markdown', 'note', 'Заметки'],
      ],
    },
    {
      title: 'Публикация',
      items: [
        ['articles', 'articles', 'Публикации'],
      ],
    },
    {
      title: 'Система',
      items: [
        ['settings', 'settings', 'Аккаунт'],
        ...(profile.role === 'admin' ? [
          ['admin', 'users', 'Участники'],
          ['adminArticles', 'adminArticles', 'Статьи'],
          ['logs', 'logs', 'Логи'],
        ] : []),
      ],
    },
  ];

  const displayName = profile.display_name || profile.username;
  const avatarHtml = profile.avatar_url && /^https:\/\//i.test(profile.avatar_url)
    ? `<img class="account-avatar" src="${escape(profile.avatar_url)}" alt="${escape(displayName)}">`
    : `<span class="account-avatar account-avatar-fallback" aria-hidden="true">${escape((displayName || 'U')[0].toUpperCase())}</span>`;

  root.innerHTML = `
    <div class="workspace" id="workspace">
      <header class="mobile-bar">
        ${brandHtml()}
        <button id="mobile-menu-btn" class="icon-button mobile-menu-btn" type="button" aria-label="Открыть меню навигации" aria-expanded="false" aria-controls="sidebar">
          <span data-nav-icon="menu"></span>
        </button>
      </header>
      <div class="sidebar-backdrop" id="sidebar-backdrop" tabindex="-1" aria-hidden="true"></div>
      <aside id="sidebar" class="sidebar">
        <div class="sidebar-header">${brandHtml()}</div>
        <nav class="nav-groups" aria-label="Основная навигация">
          ${navGroups.map(group => `
            <div class="nav-group">
              <div class="nav-group-title">${group.title}</div>
              <div class="nav-group-items">
                ${group.items.map(([id, iconName, title]) => `
                  <a data-page="${id}" href="${pageHref(id)}" class="nav ${page === id ? 'active' : ''}" ${profile.must_change_password && id !== 'settings' ? 'aria-disabled="true" tabindex="-1"' : ''}>
                    <span data-nav-icon="${iconName}"></span>
                    <span class="nav-title">${title}</span>
                  </a>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </nav>
        <div class="account">
          <div class="account-user">
            ${avatarHtml}
            <div class="account-info">
              <strong class="account-name">${escape(displayName)}</strong>
              <small class="account-role">${escape('@' + profile.username)} · ${profile.role === 'admin' ? 'Администратор' : 'Участник'}</small>
            </div>
            <button id="logout" class="quiet account-logout" title="Выйти" aria-label="Выйти">
              <span data-nav-icon="logout"></span>
            </button>
          </div>
        </div>
      </aside>
      <main class="content">
        <p id="notice" class="notice" role="status" aria-live="polite"></p>
        <section id="view"></section>
      </main>
    </div>
  `;

  document.querySelectorAll('[data-nav-icon]').forEach(slot => slot.replaceChildren(icon(slot.dataset.navIcon)));

  const ws = $('workspace');
  const menuBtn = $('mobile-menu-btn');
  const backdrop = $('sidebar-backdrop');

  const closeMobileMenu = () => {
    if (ws && ws.classList.contains('sidebar-open')) {
      ws.classList.remove('sidebar-open');
      if (menuBtn) {
        menuBtn.setAttribute('aria-expanded', 'false');
        menuBtn.querySelector('[data-nav-icon]')?.replaceChildren(icon('menu'));
      }
    }
  };

  const toggleMobileMenu = () => {
    if (!ws) return;
    const isOpen = ws.classList.toggle('sidebar-open');
    if (menuBtn) {
      menuBtn.setAttribute('aria-expanded', String(isOpen));
      menuBtn.querySelector('[data-nav-icon]')?.replaceChildren(icon(isOpen ? 'close' : 'menu'));
    }
  };

  if (menuBtn) menuBtn.onclick = toggleMobileMenu;
  if (backdrop) backdrop.onclick = closeMobileMenu;
  window.onkeydown = e => { if (e.key === 'Escape') closeMobileMenu(); };

  document.querySelectorAll('[data-page]').forEach(b => b.onclick = e => {
    if (b.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    closeMobileMenu();
    const next = b.dataset.page;
    if (next === page) { e.preventDefault(); return; }
    if (cleanupView && cleanupView() === false) { e.preventDefault(); return; }
    cleanupView = null;
    page = next;
  });

  $('logout').onclick = async () => {
    if (cleanupView && cleanupView() === false) return;
    cleanupView = null;
    signingOut = true;
    try {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) {
        shell();
        notice('Не удалось выйти. Повтори попытку.', true);
        return;
      }
    } finally {
      signingOut = false;
    }
    if (parseRoute(location.pathname).type !== 'login') {
      location.replace(appPath('login'));
    } else {
      login();
    }
  };

  const pages = { todos, markdown, articles, settings, admin: adminPage, adminArticles, logs };
  (pages[page] || todos)();
}

async function todos() {
  cleanupView = mountWorkbench($('view'), { client, userId: user.id, initial: 'todos', notice, requireSession });
}

function markdown() {
  cleanupView = mountWorkbench($('view'), { client, userId: user.id, initial: 'markdown', notice, requireSession });
}

function articles() {
  cleanupView = mountArticles($('view'), { client, userId: user.id, username: profile.username, notice, requireSession });
}

async function logs() {
  $('view').innerHTML = `
    <div class="title">
      <div>
        <h1>Логи</h1>
        <p class="muted">Изменения задач и публикаций, записанные на сервере.</p>
      </div>
    </div>
    <div class="audit-note">ИП входов и полный журнал авторизации находятся в Supabase → Authentication → Logs.</div>
    <div id="audit" class="audit-list">Загружаем…</div>
  `;
  try {
    await requireSession();
    const res = await action({ action: 'logs:list' });
    const data = res.logs || [];
    const list = $('audit');
    list.replaceChildren();
    if (!data.length) {
      list.textContent = 'Записей пока нет.';
      return;
    }

    const FIELD_LABELS = {
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
    };

    const ACTION_LABELS = {
      insert: 'Создание',
      update: 'Обновление',
      delete: 'Удаление',
      admin_article_access: 'Изменение доступа',
      admin_article_delete: 'Удаление статьи',
      role_change: 'Смена роли',
      block: 'Блокировка',
      unblock: 'Разблокировка',
      password_reset: 'Сброс пароля',
      user_create: 'Создание пользователя',
      account_delete: 'Удаление аккаунта',
      error: 'Ошибка клиента',
    };

    const ENTITY_LABELS = {
      todos: 'Задача',
      articles: 'Статья',
      profiles: 'Профиль',
      users: 'Аккаунт',
      client: 'Клиент',
    };

    const formatVal = (field, val) => {
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
    };

    data.forEach(item => {
      const details = item.details || {};
      const actionName = ACTION_LABELS[item.action] || item.action;
      const entityName = ENTITY_LABELS[item.entity] || item.entity;
      const actorName = item.actor
        ? (item.actor.display_name ? `${item.actor.display_name} (@${item.actor.username})` : `@${item.actor.username}`)
        : (item.actor_id ? item.actor_id.slice(0, 8) : 'Система');
      const timeStr = new Date(item.created_at).toLocaleString('ru-RU');

      let objectLabel = entityName;
      if (details.title) objectLabel += ` «${details.title}»`;
      else if (details.username) objectLabel += ` @${details.username}`;
      else if (item.entity_id) objectLabel += ` #${item.entity_id.slice(0, 8)}`;

      const diffRows = [];
      const before = details.before;
      const after = details.after;

      if (before && after) {
        const keys = details.changed_fields && Array.isArray(details.changed_fields)
          ? details.changed_fields
          : Object.keys({ ...before, ...after });

        keys.forEach(k => {
          if (k === 'description' || k === 'body') return;
          const vBefore = before[k];
          const vAfter = after[k];
          diffRows.push(`
            <div class="audit-diff-row">
              <div class="audit-diff-field">${escape(FIELD_LABELS[k] || k)}</div>
              <div class="audit-diff-values">
                <span class="diff-before">${escape(formatVal(k, vBefore))}</span>
                <span class="diff-arrow">→</span>
                <span class="diff-after">${escape(formatVal(k, vAfter))}</span>
              </div>
            </div>
          `);
        });
      }

      if (details.body_changed) {
        diffRows.push(`
          <div class="audit-diff-row">
            <div class="audit-diff-field">Содержимое статьи</div>
            <div class="audit-diff-values">
              <span>изменено: ${details.body_length_before ?? 0} → ${details.body_length_after ?? 0} символов</span>
            </div>
          </div>
        `);
      }

      if (details.description_changed) {
        diffRows.push(`
          <div class="audit-diff-row">
            <div class="audit-diff-field">Описание задачи</div>
            <div class="audit-diff-values">
              <span>изменено: ${details.description_length_before ?? 0} → ${details.description_length_after ?? 0} символов</span>
            </div>
          </div>
        `);
      }

      if (before === null && after) {
        diffRows.push(`
          <div class="audit-diff-row">
            <div class="audit-diff-field">Создан объект</div>
            <div class="audit-diff-values">
              ${Object.entries(after)
                .filter(([k]) => k !== 'body' && k !== 'description')
                .map(([k, v]) => `<span><strong>${escape(FIELD_LABELS[k] || k)}:</strong> ${escape(formatVal(k, v))}</span>`)
                .join(', ')}
            </div>
          </div>
        `);
      }

      if (after === null && before) {
        diffRows.push(`
          <div class="audit-diff-row">
            <div class="audit-diff-field">Удалён объект</div>
            <div class="audit-diff-values">
              ${Object.entries(before)
                .filter(([k]) => k !== 'body' && k !== 'description')
                .map(([k, v]) => `<span><strong>${escape(FIELD_LABELS[k] || k)}:</strong> ${escape(formatVal(k, v))}</span>`)
                .join(', ')}
            </div>
          </div>
        `);
      }

      if (diffRows.length === 0 && Object.keys(details).length > 0) {
        Object.entries(details).forEach(([k, v]) => {
          if (['title', 'username', 'changed_fields', 'before', 'after', 'body_changed', 'description_changed'].includes(k)) return;
          diffRows.push(`
            <div class="audit-diff-row">
              <div class="audit-diff-field">${escape(FIELD_LABELS[k] || k)}</div>
              <div class="audit-diff-values"><span>${escape(formatVal(k, v))}</span></div>
            </div>
          `);
        });
      }

      const row = document.createElement('details');
      row.className = 'audit-row-item';
      row.innerHTML = `
        <summary class="audit-row-summary">
          <div class="audit-summary-main">
            <strong>${escape(actionName)} · ${escape(entityName)}</strong>
            <span class="audit-summary-object">${escape(objectLabel)}</span>
          </div>
          <div class="audit-summary-meta">
            <span class="audit-actor">${escape(actorName)}</span>
            <time class="muted">${escape(timeStr)}</time>
          </div>
        </summary>
        <div class="audit-row-detail">
          <div class="audit-meta-grid">
            <div class="audit-meta-cell">
              <span class="audit-meta-label">Кто</span>
              <span class="audit-meta-val">${escape(actorName)}</span>
            </div>
            <div class="audit-meta-cell">
              <span class="audit-meta-label">Когда</span>
              <span class="audit-meta-val">${escape(timeStr)}</span>
            </div>
            <div class="audit-meta-cell">
              <span class="audit-meta-label">Действие</span>
              <span class="audit-meta-val">${escape(actionName)}</span>
            </div>
            <div class="audit-meta-cell">
              <span class="audit-meta-label">Объект</span>
              <span class="audit-meta-val">${escape(objectLabel)}</span>
            </div>
          </div>
          ${diffRows.length > 0 ? `
            <div class="audit-changes-section">
              <h4 class="audit-changes-title">Изменения</h4>
              <div class="audit-diff-table">
                ${diffRows.join('')}
              </div>
            </div>
          ` : ''}
          <details class="audit-raw-details">
            <summary>Сырые данные (JSON)</summary>
            <pre>${escape(JSON.stringify(details, null, 2))}</pre>
          </details>
        </div>
      `;
      list.append(row);
    });
  } catch (error) {
    $('audit').textContent = 'Не удалось загрузить логи.';
    notice('Не удалось загрузить логи. Проверь миграцию и права администратора.', true);
  }
}

function settings() {
  const displayName = profile.display_name || '';
  const bio = profile.bio || '';
  const avatarImg = profile.avatar_url && /^https:\/\//i.test(profile.avatar_url)
    ? `<img class="avatar-preview-lg" src="${escape(profile.avatar_url)}" alt="Аватар">`
    : `<div class="avatar-preview-lg admin-avatar-box" style="width: 52px; height: 52px; font-size: 20px;">${escape((displayName || profile.username || 'U')[0].toUpperCase())}</div>`;

  const previewName = escape(displayName || profile.username);
  const previewHandle = escape('@' + profile.username);
  const previewBio = escape(bio);
  const previewAvatar = profile.avatar_url && /^https:\/\//i.test(profile.avatar_url)
    ? `<img class="author-avatar-xl" src="${escape(profile.avatar_url)}" alt="" referrerpolicy="no-referrer" style="width:64px;height:64px;border-radius:50%;object-fit:cover;">`
    : `<div class="admin-avatar-box" style="width:64px;height:64px;font-size:26px;border-radius:50%;">${escape((displayName || profile.username || 'U')[0].toUpperCase())}</div>`;
  const base = (import.meta.env?.BASE_URL || '/helper/').replace(/\/+$/, '') + '/';

  $('view').innerHTML = `
    <div class="title">
      <div>
        <h1>Аккаунт</h1>
        <p class="muted">${profile.must_change_password ? 'Для продолжения замени временный пароль.' : 'Управление профилем и безопасность.'}</p>
      </div>
    </div>
    <div class="settings-layout">
      <div class="settings-left">
        <section class="panel">
          <h3>Профиль</h3>
          <div class="profile-avatar-row" style="margin-bottom: 20px;">
            ${avatarImg}
            <div class="profile-avatar-actions">
              <button type="button" class="secondary" id="change-avatar-btn">Изменить фото</button>
              <input type="file" id="avatar-file-input" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
              ${profile.avatar_url ? '<button type="button" class="danger quiet" id="delete-avatar-btn">Удалить фото</button>' : ''}
            </div>
          </div>
          <form id="profile-name-form">
            <label>Отображаемое имя
              <input name="displayName" maxlength="80" placeholder="Например, Иван Иванов" value="${escape(displayName)}">
              <small class="muted" style="display: block; margin-top: 4px;">Логин: @${escape(profile.username)} (используется для входа и ссылок, не меняется)</small>
            </label>
            <label style="margin-top:12px;">О себе
              <textarea name="bio" maxlength="280" rows="3" placeholder="Коротко о себе (до 280 символов)…" style="resize:vertical;">${escape(bio)}</textarea>
              <small class="muted" id="bio-counter" style="display:block;margin-top:4px;text-align:right;">${bio.length}/280</small>
            </label>
            <button class="primary" style="margin-top: 12px;">Сохранить</button>
          </form>
        </section>

        <form id="password" class="panel">
          <h3>Безопасность</h3>
          <label>Текущий пароль<input name="currentPassword" type="password" autocomplete="current-password" required></label>
          <label>Новый пароль<input name="password" type="password" minlength="9" maxlength="128" autocomplete="new-password" required></label>
          <label>Повтори новый пароль<input name="repeat" type="password" minlength="9" maxlength="128" autocomplete="new-password" required></label>
          <small>От 9 до 128 символов.</small>
          <button class="primary" style="margin-top: 12px;">Изменить пароль</button>
        </form>
      </div>

      <div class="settings-right">
        <section class="panel" id="profile-preview-panel">
          <h3>Превью публичного профиля</h3>
          <div class="profile-preview">
            <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px;">
              ${previewAvatar}
              <div>
                <div id="preview-name" style="font-weight:700;font-size:17px;">${previewName}</div>
                <div id="preview-handle" class="muted" style="font-size:13px;">${previewHandle}</div>
              </div>
            </div>
            <div id="preview-bio" class="muted" style="font-size:14px;white-space:pre-wrap;">${previewBio}</div>
            <a href="${base}u/${escape(profile.username)}" target="_blank" rel="noopener" class="quiet" style="display:inline-flex;margin-top:14px;font-size:13px;">Открыть публичный профиль ↗</a>
          </div>
        </section>
      </div>
    </div>
  `;

  // Live preview update
  const nameInput = $('profile-name-form').elements.displayName;
  const bioTextarea = $('profile-name-form').elements.bio;
  const bioCounter = $('bio-counter');
  const previewNameEl = $('preview-name');
  const previewBioEl = $('preview-bio');

  nameInput.oninput = () => {
    const val = nameInput.value.trim() || profile.username;
    if (previewNameEl) previewNameEl.textContent = val;
  };
  bioTextarea.oninput = () => {
    const len = bioTextarea.value.length;
    if (bioCounter) bioCounter.textContent = `${len}/280`;
    if (previewBioEl) previewBioEl.textContent = bioTextarea.value;
  };

  // Avatar change via Cropper
  const changeAvatarBtn = $('change-avatar-btn');
  const avatarFileInput = $('avatar-file-input');
  const deleteAvatarBtn = $('delete-avatar-btn');

  changeAvatarBtn.onclick = () => avatarFileInput.click();
  avatarFileInput.onchange = async () => {
    const file = avatarFileInput.files[0];
    if (!file) return;
    try {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
        throw new Error('Выбери PNG, JPEG, WebP или GIF до 5 МБ.');
      }
      const croppedBlob = await editImage(file, {
        aspectRatio: 1,
        outputWidth: 512,
        outputHeight: 512,
        title: 'Кадрирование аватарки (1:1)',
      });
      if (!croppedBlob) return;

      notice('Загрузка аватарки…');
      const safe = (file.name || 'avatar').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
      const path = `${user.id}/avatar-${crypto.randomUUID()}-${safe}`;
      const uploaded = await client.storage.from('article-media').upload(path, croppedBlob, {
        contentType: croppedBlob.type || 'image/jpeg',
        upsert: true,
      });
      if (uploaded.error) throw uploaded.error;

      const avatar = client.storage.from('article-media').getPublicUrl(path).data.publicUrl;
      const saved = await client.rpc('set_profile_avatar', { avatar });
      if (saved.error) throw saved.error;

      profile.avatar_url = avatar;
      notice('Аватарка обновлена.');
      shell();
    } catch (error) {
      notice(error.message || 'Не удалось сохранить аватарку.', true);
    } finally {
      avatarFileInput.value = '';
    }
  };

  if (deleteAvatarBtn) {
    deleteAvatarBtn.onclick = async () => {
      if (!confirm('Удалить фото профиля?')) return;
      try {
        const saved = await client.rpc('set_profile_avatar', { avatar: null });
        if (saved.error) throw saved.error;
        profile.avatar_url = null;
        notice('Фото профиля удалено.');
        shell();
      } catch (error) {
        notice(error.message || 'Не удалось удалить фото.', true);
      }
    };
  }

  // Display name + bio submit
  busy($('profile-name-form'), async f => {
    const newName = String(f.get('displayName') || '').trim();
    if (newName.length > 80) throw new Error('Отображаемое имя не может превышать 80 символов.');
    const newBio = String(f.get('bio') || '').trim();
    if (newBio.length > 280) throw new Error('Био не может превышать 280 символов.');

    if (newName !== (profile.display_name || '')) {
      const res = await client.rpc('set_profile_display_name', { new_display_name: newName || null });
      if (res.error) throw res.error;
      profile.display_name = newName || null;
    }

    if (newBio !== (profile.bio || '')) {
      const bioRes = await client.rpc('set_profile_bio', { new_bio: newBio || null });
      if (bioRes.error) {
        if (bioRes.error.code === '42883') {
          shell();
          notice('Обновление профиля требует применения новой миграции базы данных.', true);
          return;
        }
        throw bioRes.error;
      }
      profile.bio = newBio || null;
    }

    notice('Профиль сохранён.');
    shell();
  });

  // Password change
  busy($('password'), async f => {
    if (f.get('password') !== f.get('repeat')) throw new Error('Пароли не совпадают.');
    await action({ action: 'password', currentPassword: f.get('currentPassword'), password: f.get('password') });
    page = 'todos';
    await enter(user);
    notice('Пароль изменён.');
  });
}

async function adminPage() {
  const token = generation;
  $('view').innerHTML = `
    <div class="title">
      <div>
        <h1>Участники</h1>
        <p class="muted">Создавай аккаунты, управляй ролями и доступом.</p>
      </div>
    </div>
    <form id="create" class="panel" style="margin-bottom: 24px;">
      <h3>Новый участник</h3>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px;">
        <label>Логин
          <input name="username" pattern="[a-z0-9_]{3,32}" required autocomplete="off" placeholder="a–z, 0–9, _ (3–32 знака)">
        </label>
        <label>Отображаемое имя
          <input name="displayName" maxlength="80" autocomplete="off" placeholder="Например, Иван Иванов">
        </label>
        <label>Временный пароль
          <input name="password" type="password" minlength="9" maxlength="128" required autocomplete="new-password">
        </label>
      </div>
      <button class="primary" style="margin-top: 14px;">Создать аккаунт</button>
    </form>
    <div class="section-heading">
      <h3>Аккаунты</h3>
    </div>
    <div id="users" class="admin-users-list">Загружаем…</div>
  `;

  const refresh = async () => {
    const data = await action({ action: 'list' });
    if (token !== generation) return;
    const usersContainer = $('users');
    usersContainer.replaceChildren();

    for (const p of data.users) {
      const card = document.createElement('div');
      card.className = 'admin-user-card';

      const isSelf = p.id === user.id;
      const displayName = p.display_name || p.username;
      const avatarSrc = p.avatar_url && /^https:\/\//i.test(p.avatar_url) ? p.avatar_url : null;

      card.innerHTML = `
        <div class="admin-user-main">
          <div class="admin-avatar-box">
            ${avatarSrc ? `<img src="${escape(avatarSrc)}" alt="" referrerpolicy="no-referrer">` : `<span>${escape((displayName || 'U')[0].toUpperCase())}</span>`}
          </div>
          <div class="admin-user-meta">
            <div class="admin-user-names">
              <span class="admin-user-display">${escape(displayName)}</span>
              <span class="admin-user-login">@${escape(p.username)}</span>
              ${isSelf ? '<small class="role-badge member" style="opacity: 0.8;">(Вы)</small>' : ''}
            </div>
            <div class="admin-badges-row">
              <span class="role-badge ${p.role}">${p.role === 'admin' ? 'Администратор' : 'Участник'}</span>
              ${p.blocked ? '<span class="status-badge blocked">Заблокирован</span>' : ''}
              ${p.must_change_password ? '<small class="muted">· ожидает смены пароля</small>' : ''}
            </div>
          </div>
        </div>
        <div class="admin-user-actions"></div>
      `;

      const actions = card.querySelector('.admin-user-actions');

      if (!isSelf) {
        // Role toggle
        const roleBtn = document.createElement('button');
        roleBtn.className = 'secondary';
        roleBtn.textContent = p.role === 'admin' ? 'Сделать участником' : 'Сделать админом';
        roleBtn.onclick = async () => {
          const newRole = p.role === 'admin' ? 'member' : 'admin';
          if (p.role === 'admin' && !confirm(`Понизить администратора @${p.username} до участника?`)) return;
          roleBtn.disabled = true;
          try {
            await action({ action: 'role', id: p.id, role: newRole });
            notice(`Роль пользователя @${p.username} изменена.`);
            await refresh();
          } catch (e) {
            notice(e.message, true);
          } finally {
            roleBtn.disabled = false;
          }
        };

        // Block / Unblock
        const blockBtn = document.createElement('button');
        blockBtn.className = 'quiet';
        blockBtn.textContent = p.blocked ? 'Разблокировать' : 'Заблокировать';
        blockBtn.onclick = async () => {
          blockBtn.disabled = true;
          try {
            await action({ action: 'block', id: p.id, blocked: !p.blocked });
            notice(`Пользователь @${p.username} ${p.blocked ? 'разблокирован' : 'заблокирован'}.`);
            await refresh();
          } catch (e) {
            notice(e.message, true);
          } finally {
            blockBtn.disabled = false;
          }
        };

        // Reset password
        const resetBtn = document.createElement('button');
        resetBtn.className = 'quiet';
        resetBtn.textContent = 'Сбросить пароль';
        resetBtn.onclick = () => {
          const pass = prompt(`Введите новый временный пароль для @${p.username} (от 9 символов):`);
          if (!pass) return;
          if (pass.length < 9) {
            notice('Пароль должен быть от 9 символов.', true);
            return;
          }
          action({ action: 'reset', id: p.id, password: pass })
            .then(() => {
              notice(`Временный пароль для @${p.username} установлен.`);
              refresh();
            })
            .catch(e => notice(e.message, true));
        };

        // Delete account
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'danger quiet';
        deleteBtn.textContent = 'Удалить аккаунт';
        deleteBtn.onclick = async () => {
          if (!confirm(`Удалить @${p.username}?\n\nБудут удалены задачи, статьи и профиль пользователя.\nЭто действие нельзя отменить.`)) {
            return;
          }
          deleteBtn.disabled = true;
          try {
            await action({ action: 'delete', id: p.id });
            notice(`Аккаунт @${p.username} удалён.`);
            await refresh();
          } catch (e) {
            notice(e.message, true);
          } finally {
            deleteBtn.disabled = false;
          }
        };

        actions.append(roleBtn, blockBtn, resetBtn, deleteBtn);
      }

      usersContainer.append(card);
    }
  };

  busy($('create'), async f => {
    await action({
      action: 'create',
      username: f.get('username'),
      display_name: f.get('displayName'),
      password: f.get('password'),
    });
    if (token !== generation) return;
    $('create').reset();
    await refresh();
    notice('Аккаунт создан. При первом входе потребуется сменить пароль.');
  });

  try {
    await refresh();
  } catch (e) {
    if (token === generation) {
      $('users').textContent = 'Список недоступен.';
      notice(e.message, true);
    }
  }
}

async function adminArticles() {
  const token = generation;
  $('view').innerHTML = `
    <div class="title">
      <div>
        <h1>Модерация публикаций</h1>
        <p class="muted">Просмотр и управление доступом ко всем статьям пользователей.</p>
      </div>
    </div>
    <div class="admin-articles-header-bar">
      <input type="search" class="admin-articles-search" id="articles-search" placeholder="Поиск по названию или автору…">
      <div id="articles-count" class="muted" style="font-size: 13px;"></div>
    </div>
    <div id="articles-list">Загружаем…</div>
  `;

  let allArticles = [];

  const renderList = (filterText = '') => {
    const container = $('articles-list');
    container.replaceChildren();
    const query = filterText.toLowerCase().trim();
    const filtered = allArticles.filter(a => {
      const matchTitle = (a.title || '').toLowerCase().includes(query);
      const matchAuthor = (a.author_username || '').toLowerCase().includes(query) || (a.author_display_name || '').toLowerCase().includes(query);
      return matchTitle || matchAuthor;
    });

    $('articles-count').textContent = `Всего статей: ${filtered.length}`;

    if (filtered.length === 0) {
      container.innerHTML = '<p class="empty">Статьи не найдены.</p>';
      return;
    }

    const base = (import.meta.env?.BASE_URL || '/helper/').replace(/\/+$/, '') + '/';

    filtered.forEach(art => {
      const card = document.createElement('div');
      card.className = 'admin-article-card';

      const authorDisplay = art.author_display_name || art.author_username;
      const previewLink = `${base}#article=${encodeURIComponent(art.slug)}`;

      const accessText = art.access === 'public' ? 'Общедоступно' : art.access === 'unlisted' ? 'По ссылке' : 'Приватно';

      card.innerHTML = `
        <div class="admin-article-info">
          <a class="admin-article-title" href="${previewLink}" target="_blank" rel="noopener">
            ${escape(art.title)} ↗
          </a>
          <div class="admin-article-meta">
            <span>Автор: <strong>${escape(authorDisplay)}</strong> (@${escape(art.author_username)})</span>
            <span class="access-badge ${art.access}">${accessText}</span>
            <span>· Обновлено: ${new Date(art.updated_at).toLocaleDateString('ru-RU')}</span>
          </div>
        </div>
        <div class="admin-article-actions">
          <label style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px;">
            Доступ:
            <select class="access-select" style="min-height: 32px; padding: 2px 6px;">
              <option value="public" ${art.access === 'public' ? 'selected' : ''}>Общедоступно</option>
              <option value="unlisted" ${art.access === 'unlisted' ? 'selected' : ''}>По ссылке</option>
              <option value="private" ${art.access === 'private' ? 'selected' : ''}>Приватно (черновик)</option>
            </select>
          </label>
          ${art.access !== 'private' ? '<button type="button" class="quiet unpublish-btn">Снять с публикации</button>' : ''}
          <button type="button" class="danger quiet delete-btn">Удалить</button>
        </div>
      `;

      const accessSelect = card.querySelector('.access-select');
      accessSelect.onchange = async () => {
        const nextAccess = accessSelect.value;
        accessSelect.disabled = true;
        try {
          await action({ action: 'articles:access', id: art.id, access: nextAccess });
          art.access = nextAccess;
          notice(`Доступ к статье «${art.title}» изменён.`);
          renderList(filterText);
        } catch (e) {
          notice(e.message, true);
          accessSelect.value = art.access;
        } finally {
          accessSelect.disabled = false;
        }
      };

      const unpublishBtn = card.querySelector('.unpublish-btn');
      if (unpublishBtn) {
        unpublishBtn.onclick = async () => {
          unpublishBtn.disabled = true;
          try {
            await action({ action: 'articles:access', id: art.id, access: 'private' });
            art.access = 'private';
            notice(`Статья «${art.title}» снята с публикации.`);
            renderList(filterText);
          } catch (e) {
            notice(e.message, true);
          } finally {
            unpublishBtn.disabled = false;
          }
        };
      }

      const deleteBtn = card.querySelector('.delete-btn');
      deleteBtn.onclick = async () => {
        if (!confirm(`Удалить статью «${art.title}»?\nЭто действие нельзя отменить.`)) return;
        deleteBtn.disabled = true;
        try {
          await action({ action: 'articles:delete', id: art.id });
          notice(`Статья «${art.title}» удалена.`);
          allArticles = allArticles.filter(x => x.id !== art.id);
          renderList(filterText);
        } catch (e) {
          notice(e.message, true);
        } finally {
          deleteBtn.disabled = false;
        }
      };

      container.append(card);
    });
  };

  try {
    const res = await action({ action: 'articles:list' });
    if (token !== generation) return;
    allArticles = res.articles || [];
    renderList();

    const searchInput = $('articles-search');
    if (searchInput) {
      searchInput.oninput = () => renderList(searchInput.value);
    }
  } catch (e) {
    if (token === generation) {
      $('articles-list').textContent = 'Не удалось загрузить список статей.';
      notice(e.message, true);
    }
  }
}

async function boot() {
  if (!url || !key) {
    root.innerHTML = '<main class="login-card"><h1>Helper</h1><p>Подключение к сервису ещё не настроено.</p></main>';
    return;
  }
  try {
    localStorage.setItem('helper:storage-test', '1');
    localStorage.removeItem('helper:storage-test');
    storage = sessionStorageAdapter(localStorage, sessionStorage);
    client = createClient(url, key, {
      auth: { storage, storageKey: 'helper:auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });

    const reportClientError = (message, context = 'window') => {
      if (client) client.rpc('record_client_error', { error_message: String(message).slice(0, 500), error_context: context }).catch(() => {});
    };
    window.addEventListener('error', event => reportClientError(event.message || 'Неизвестная ошибка', 'window'));
    window.addEventListener('unhandledrejection', event => reportClientError(event.reason?.message || event.reason || 'Необработанное обещание', 'promise'));

    client.auth.onAuthStateChange((event, session) => {
      setTimeout(() => {
        if (event === 'SIGNED_OUT') {
          clearTimeout(authTimer);
          if (!signingOut && user) login();
        } else if (session) {
          scheduleSessionCheck(session);
        }
      }, 0);
    });

    const checkWhenActive = () => {
      if (document.visibilityState === 'visible' && user) requireSession().catch(() => {});
    };
    document.addEventListener('visibilitychange', checkWhenActive);
    window.addEventListener('focus', checkWhenActive);

    // Public article via hash (backward compatibility)
    const publicSlug = publicArticleSlug();
    if (publicSlug) {
      await renderPublicArticle(root, client, publicSlug);
      return;
    }

    const route = parseRoute(location.pathname);

    // Public author profile (/helper/u/:username)
    if (route.type === 'publicProfile') {
      await renderPublicProfile(root, client, route.username);
      return;
    }

    // 404 handling
    if (route.type === '404') {
      const { data: { session } } = await client.auth.getSession();
      let hasUser = false;
      if (session) {
        const { data: { user: verified } } = await client.auth.getUser();
        hasUser = Boolean(verified);
      }
      notFound(hasUser);
      return;
    }

    root.innerHTML = `<main class="login-card"><h1>${brandHtml()}</h1><p>Открываем пространство…</p></main>`;
    const { data: { session } } = await client.auth.getSession();

    if (session) {
      scheduleSessionCheck(session);
      const { data: { user: verified }, error } = await client.auth.getUser();
      if (error || !verified) {
        authMessage = 'Сессия истекла. Войди снова.';
        signingOut = true;
        try {
          await client.auth.signOut({ scope: 'local' });
        } finally {
          signingOut = false;
        }
        if (route.type !== 'login') location.replace(appPath('login'));
        else login();
      } else {
        if (route.type === 'login') {
          const params = new URLSearchParams(location.search);
          const next = sanitizeNext(params.get('next'));
          location.replace(next || appPath(''));
          return;
        }
        page = route.page || 'todos';
        await enter(verified);
      }
    } else {
      if (route.type === 'private') {
        const nextParam = location.pathname + location.search;
        location.replace(appPath(`login?next=${encodeURIComponent(nextParam)}`));
        return;
      }
      login();
    }
  } catch {
    root.innerHTML = '<main class="login-card"><h1>Не удалось открыть Helper</h1><p>Проверь подключение и разреши хранение данных сайта, затем обнови страницу.</p></main>';
  }
}

boot();
