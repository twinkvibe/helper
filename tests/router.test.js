import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, sanitizeNext, pageHref, normalizeSubpath, brandHtml } from '../src/router.js';

test('Route resolver distinguishes known private routes, login, and unknown 404 routes', () => {
  assert.deepEqual(parseRoute('/helper/'), { type: 'private', page: 'todos', subpath: '' });
  assert.deepEqual(parseRoute('/helper'), { type: 'private', page: 'todos', subpath: '' });
  assert.deepEqual(parseRoute('/helper/tasks'), { type: 'private', page: 'todos', subpath: 'tasks' });
  assert.deepEqual(parseRoute('/helper/tasks/'), { type: 'private', page: 'todos', subpath: 'tasks' });
  assert.deepEqual(parseRoute('/helper/notes'), { type: 'private', page: 'markdown', subpath: 'notes' });
  assert.deepEqual(parseRoute('/helper/editor'), { type: 'private', page: 'articles', subpath: 'editor' });
  assert.deepEqual(parseRoute('/helper/account'), { type: 'private', page: 'settings', subpath: 'account' });
  assert.deepEqual(parseRoute('/helper/admin'), { type: 'private', page: 'admin', subpath: 'admin' });
  assert.deepEqual(parseRoute('/helper/admin/articles'), { type: 'private', page: 'adminArticles', subpath: 'admin/articles' });
  assert.deepEqual(parseRoute('/helper/logs'), { type: 'private', page: 'logs', subpath: 'logs' });

  // Public author profile
  assert.deepEqual(parseRoute('/helper/u/dustin'), { type: 'publicProfile', username: 'dustin', subpath: 'u/dustin' });
  assert.deepEqual(parseRoute('/helper/u/ivan_123'), { type: 'publicProfile', username: 'ivan_123', subpath: 'u/ivan_123' });

  // Login
  assert.deepEqual(parseRoute('/helper/login'), { type: 'login' });
  assert.deepEqual(parseRoute('/helper/login/'), { type: 'login' });

  // Unknown 404 routes
  assert.deepEqual(parseRoute('/helper/potato'), { type: '404', subpath: 'potato' });
  assert.deepEqual(parseRoute('/helper/something/random'), { type: '404', subpath: 'something/random' });
  assert.deepEqual(parseRoute('/outside'), { type: '404', subpath: '/outside' });
});

test('sanitizeNext accepts only known private routes and rejects unsafe or unknown destinations', () => {
  assert.equal(sanitizeNext('/helper/notes'), '/helper/notes');
  assert.equal(sanitizeNext('/helper/tasks'), '/helper/tasks');
  assert.equal(sanitizeNext('/helper/account'), '/helper/account');
  assert.equal(sanitizeNext('/helper/admin/articles'), '/helper/admin/articles');
  assert.equal(sanitizeNext('/helper/'), '/helper/');

  // Query params or hash stripped cleanly
  assert.equal(sanitizeNext('/helper/notes?tab=all#tag'), '/helper/notes');

  // Open redirect attempts rejected
  assert.equal(sanitizeNext('https://evil.com'), null);
  assert.equal(sanitizeNext('http://evil.com'), null);
  assert.equal(sanitizeNext('//evil.com'), null);
  assert.equal(sanitizeNext('\\\\evil.com'), null);
  assert.equal(sanitizeNext('javascript:alert(1)'), null);
  assert.equal(sanitizeNext('data:text/html,evil'), null);

  // Unknown / invalid paths rejected
  assert.equal(sanitizeNext('/helper/potato'), null);
  assert.equal(sanitizeNext('/helper/login'), null);
  assert.equal(sanitizeNext('/helper/u/dustin'), null); // public profiles are not private redirect targets
  assert.equal(sanitizeNext('/external/path'), null);
  assert.equal(sanitizeNext(''), null);
  assert.equal(sanitizeNext(null), null);
});

test('pageHref produces relative paths within /helper/', () => {
  assert.equal(pageHref('todos'), './');
  assert.equal(pageHref('markdown'), './notes');
  assert.equal(pageHref('articles'), './editor');
  assert.equal(pageHref('settings'), './account');
  assert.equal(pageHref('admin'), './admin');
  assert.equal(pageHref('adminArticles'), './admin/articles');
  assert.equal(pageHref('logs'), './logs');
});

test('brandHtml renders unified brand mark with favicon.svg', () => {
  const html = brandHtml();
  assert.match(html, /class="brand"/);
  assert.match(html, /<img class="brand-mark" src=".*favicon\.svg"/);
  assert.match(html, /h<span>elper<\/span>/);
});
