export const KNOWN_PRIVATE_PAGES = {
  '': 'todos',
  tasks: 'todos',
  notes: 'markdown',
  editor: 'articles',
  account: 'settings',
  admin: 'admin',
  'admin/articles': 'adminArticles',
  logs: 'logs',
};

export const PAGE_TO_ROUTE = {
  todos: 'tasks',
  markdown: 'notes',
  articles: 'editor',
  settings: 'account',
  admin: 'admin',
  adminArticles: 'admin/articles',
  logs: 'logs',
};

export function normalizeSubpath(pathname) {
  return String(pathname || '')
    .replace(/^\/helper\/?/, '')
    .replace(/\/+$/, '');
}

export function parseRoute(pathname) {
  const sub = normalizeSubpath(pathname);
  if (sub === 'login') {
    return { type: 'login' };
  }
  const uMatch = sub.match(/^u\/([a-z0-9_]{3,32})$/);
  if (uMatch) {
    return { type: 'publicProfile', username: uMatch[1], subpath: sub };
  }
  if (Object.prototype.hasOwnProperty.call(KNOWN_PRIVATE_PAGES, sub)) {
    return { type: 'private', page: KNOWN_PRIVATE_PAGES[sub], subpath: sub };
  }
  return { type: '404', subpath: sub };
}

export function sanitizeNext(rawNext) {
  if (!rawNext || typeof rawNext !== 'string') return null;
  // Reject protocol, protocol-relative, and backslash tricks
  if (/^[a-zA-Z][a-zA-Z0-9+-.]*:|^\/\/|\\/.test(rawNext)) return null;
  const cleanPath = rawNext.split('?')[0].split('#')[0];
  const sub = normalizeSubpath(cleanPath);
  if (sub !== 'login' && Object.prototype.hasOwnProperty.call(KNOWN_PRIVATE_PAGES, sub)) {
    return `/helper/${sub ? sub : ''}`;
  }
  return null;
}

export function pageHref(page) {
  return page === 'todos' ? './' : `./${PAGE_TO_ROUTE[page] || page}`;
}

/** Canonical absolute URL rooted at BASE_URL — use for location.replace() / redirects. */
export function appPath(path) {
  const base = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL
    ? import.meta.env.BASE_URL
    : '/helper/').replace(/\/+$/, '') + '/';
  return path ? `${base}${path}` : base;
}

export function brandHtml(href) {
  const base = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL ? import.meta.env.BASE_URL : '/helper/').replace(/\/+$/, '') + '/';
  const target = href !== undefined && href !== null ? href : base;
  return `<a class="brand" href="${target}">h<span>elper</span><img class="brand-mark" src="${base}favicon.svg" alt="" width="24" height="24"></a>`;
}
