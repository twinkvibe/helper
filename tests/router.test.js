import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseRoute, sanitizeNext, pageHref, appPath, normalizeSubpath, brandHtml } from '../src/router.js';

test('Route resolver distinguishes known private routes, login, and unknown 404 routes', () => {
  assert.deepEqual(parseRoute('/'), { type: 'private', page: 'todos', subpath: '' });
  assert.deepEqual(parseRoute(''), { type: 'private', page: 'todos', subpath: '' });
  assert.deepEqual(parseRoute('/tasks'), { type: 'private', page: 'todos', subpath: 'tasks' });
  assert.deepEqual(parseRoute('/tasks/'), { type: 'private', page: 'todos', subpath: 'tasks' });
  assert.deepEqual(parseRoute('/notes'), { type: 'private', page: 'markdown', subpath: 'notes' });
  assert.deepEqual(parseRoute('/editor'), { type: 'private', page: 'articles', subpath: 'editor' });
  assert.deepEqual(parseRoute('/account'), { type: 'private', page: 'settings', subpath: 'account' });
  assert.deepEqual(parseRoute('/admin'), { type: 'private', page: 'admin', subpath: 'admin' });
  assert.deepEqual(parseRoute('/admin/articles'), { type: 'private', page: 'adminArticles', subpath: 'admin/articles' });
  assert.deepEqual(parseRoute('/logs'), { type: 'private', page: 'logs', subpath: 'logs' });

  // Public author profile
  assert.deepEqual(parseRoute('/u/dustin'), { type: 'publicProfile', username: 'dustin', subpath: 'u/dustin' });
  assert.deepEqual(parseRoute('/u/ivan_123'), { type: 'publicProfile', username: 'ivan_123', subpath: 'u/ivan_123' });

  // Login
  assert.deepEqual(parseRoute('/login'), { type: 'login' });
  assert.deepEqual(parseRoute('/login/'), { type: 'login' });

  // Unknown 404 routes
  assert.deepEqual(parseRoute('/potato'), { type: '404', subpath: 'potato' });
  assert.deepEqual(parseRoute('/something/random'), { type: '404', subpath: 'something/random' });
  // Old /helper prefix is not a valid route on root domain
  assert.deepEqual(parseRoute('/helper/notes'), { type: '404', subpath: 'helper/notes' });
});

test('normalizeSubpath converts root-domain paths to normalized subpaths', () => {
  assert.equal(normalizeSubpath('/'), '');
  assert.equal(normalizeSubpath('/notes'), 'notes');
  assert.equal(normalizeSubpath('/editor'), 'editor');
  assert.equal(normalizeSubpath('/account'), 'account');
  assert.equal(normalizeSubpath('/admin'), 'admin');
  assert.equal(normalizeSubpath('/admin/articles'), 'admin/articles');
  assert.equal(normalizeSubpath('/logs'), 'logs');
  assert.equal(normalizeSubpath('/u/tester'), 'u/tester');
  assert.equal(normalizeSubpath('/login'), 'login');
  assert.equal(normalizeSubpath('/login/'), 'login');
});

test('sanitizeNext accepts only known private routes and rejects unsafe or unknown destinations', () => {
  assert.equal(sanitizeNext('/notes'), '/notes');
  assert.equal(sanitizeNext('/tasks'), '/tasks');
  assert.equal(sanitizeNext('/account'), '/account');
  assert.equal(sanitizeNext('/editor'), '/editor');
  assert.equal(sanitizeNext('/admin/articles'), '/admin/articles');
  assert.equal(sanitizeNext('/logs'), '/logs');
  assert.equal(sanitizeNext('/'), '/');

  // Query params or hash stripped cleanly
  assert.equal(sanitizeNext('/notes?tab=all#tag'), '/notes');

  // Open redirect attempts rejected
  assert.equal(sanitizeNext('https://evil.com'), null);
  assert.equal(sanitizeNext('http://evil.com'), null);
  assert.equal(sanitizeNext('//evil.com'), null);
  assert.equal(sanitizeNext('\\\\evil.com'), null);
  assert.equal(sanitizeNext('javascript:alert(1)'), null);
  assert.equal(sanitizeNext('data:text/html,evil'), null);

  // Unknown / invalid paths rejected
  assert.equal(sanitizeNext('/potato'), null);
  assert.equal(sanitizeNext('/login'), null);
  assert.equal(sanitizeNext('/u/dustin'), null); // public profiles are not private redirect targets
  assert.equal(sanitizeNext('/helper/account'), null); // old subpath no longer accepted as valid private destination
  assert.equal(sanitizeNext('/external/path'), null);
  assert.equal(sanitizeNext(''), null);
  assert.equal(sanitizeNext(null), null);
});

test('pageHref produces canonical paths rooted at BASE_URL', () => {
  assert.equal(pageHref('todos'), '/');
  assert.equal(pageHref('markdown'), '/notes');
  assert.equal(pageHref('articles'), '/editor');
  assert.equal(pageHref('settings'), '/account');
  assert.equal(pageHref('admin'), '/admin');
  assert.equal(pageHref('adminArticles'), '/admin/articles');
  assert.equal(pageHref('logs'), '/logs');
});

test('appPath produces canonical absolute paths rooted at BASE_URL', () => {
  assert.equal(appPath(''), '/');
  assert.equal(appPath('notes'), '/notes');
  assert.equal(appPath('/notes'), '/notes');
  assert.equal(appPath('login?next=%2Faccount'), '/login?next=%2Faccount');
});

test('Nested route navigation does not resolve to /admin/logs', () => {
  // Simulating browser resolving link href on a nested page /admin/articles
  const currentUrl = new URL('https://example.test/admin/articles');
  const targetHref = pageHref('logs');
  const resolvedUrl = new URL(targetHref, currentUrl);
  assert.equal(resolvedUrl.pathname, '/logs');
  assert.notEqual(resolvedUrl.pathname, '/admin/logs');
});

test('brandHtml renders unified brand mark with favicon.svg', () => {
  const html = brandHtml();
  assert.match(html, /class="brand"/);
  assert.match(html, /href="\/"/);
  assert.match(html, /<img class="brand-mark" src="\/favicon\.svg"/);
  assert.match(html, /h<span>elper<\/span>/);
});

test('No hardcoded /helper/ base paths in config, index.html, or router source', () => {
  const viteConfig = fs.readFileSync(path.resolve('vite.config.js'), 'utf8');
  assert.ok(viteConfig.includes("base: '/'"), 'vite.config.js must specify base: "/"');
  assert.ok(!viteConfig.includes("base: '/helper/'"), 'vite.config.js must not contain /helper/ base');

  const indexHtml = fs.readFileSync(path.resolve('index.html'), 'utf8');
  assert.ok(!indexHtml.includes('href="/helper/'), 'index.html must not contain href="/helper/...');
  assert.ok(!indexHtml.includes('src="/helper/'), 'index.html must not contain src="/helper/...');

  const routerSrc = fs.readFileSync(path.resolve('src/router.js'), 'utf8');
  assert.ok(!routerSrc.includes("'/helper'"), 'src/router.js must not contain "/helper" literal');
  assert.ok(!routerSrc.includes("'/helper/'"), 'src/router.js must not contain "/helper/" literal');
});
