import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { renderMarkdown, sessionStorageAdapter } from '../src/security.js';
import { publicArticleSlug, articleHash } from '../src/articles.js';
test('Markdown strips active content and permits safe images and checklists',()=>{
 const {window}=new JSDOM('');
 const html=renderMarkdown('# Hello\n\n**bold**\n\n- [ ] item\n\n![local](/image/example.png)\n\n<script>alert(1)</script><img src="https://images.test/x.png" onerror="alert(1)"><iframe src="https://evil.test"></iframe><a href="javascript:alert(1)">bad</a><svg onload="alert(1)"></svg><form><input autofocus onfocus="alert(1)"></form>',window);
 assert.match(html,/<h1>Hello<\/h1>/);assert.match(html,/<strong>bold<\/strong>/);
 assert.match(html,/<img src="https:\/\/images\.test\/x\.png"/);
 assert.match(html,/<img src="\/image\/example\.png"/);
 assert.match(html,/<input type="checkbox">/);
 assert.doesNotMatch(html,/<input[^>]*disabled/);
 assert.doesNotMatch(html,/<script|<iframe|<svg|<form|onerror|onload|javascript:/i);
});
test('Public article links use a hash and decode safely',()=>{
 assert.equal(articleHash('komandy-bota'),'#article=komandy-bota');
 assert.equal(publicArticleSlug('#article=komandy-bota'),'komandy-bota');
 assert.equal(publicArticleSlug('#article=%D0%BA%D0%BE%D0%BC%D0%B0%D0%BD%D0%B4%D1%8B'),'команды');
 assert.equal(publicArticleSlug('#article=x&evil=1'),null);
});
test('CommonMark emphasis stays semantic and image dimensions are applied',()=>{
 const {window}=new JSDOM('');
 const html=renderMarkdown('_You **can** combine them_\n\n![Фото|320x180](https://images.test/photo.png)',window);
 assert.match(html,/<em>You <strong>can<\/strong> combine them<\/em>/);
 assert.doesNotMatch(html,/<a[^>]*>You/);
 assert.match(html,/<img[^>]*width="320"[^>]*height="180"/);
 assert.match(html,/alt="Фото"/);
});
test('A single newline is visible as a line break in formatted text',()=>{
 const {window}=new JSDOM('');
 const html=renderMarkdown('**Пенис**\n**Не Пенис**',window);
 assert.match(html,/<strong>Пенис<\/strong><br>\n?<strong>Не Пенис<\/strong>/);
});
test('Markdown keeps emphasis semantics',()=>{
  const {window}=new JSDOM('');
  const html=renderMarkdown('_You **can** combine them_',window);
  assert.match(html,/<em>You <strong>can<\/strong> combine them<\/em>/);
});
test('Remember me controls persistence, logout removes tokens but preserves notes',()=>{
 const {window}=new JSDOM('',{url:'https://example.test'});
 const {localStorage:l,sessionStorage:s}=window;
 const store=sessionStorageAdapter(l,s);
 l.setItem('helper:markdown:user','private note');
 store.setRemember(false);store.setItem('helper:auth','temporary');assert.equal(s.getItem('helper:auth'),'temporary');assert.equal(l.getItem('helper:auth'),null);
 store.setRemember(true);assert.equal(s.getItem('helper:auth'),null);store.setItem('helper:auth','persistent');assert.equal(l.getItem('helper:auth'),'persistent');
 const reload=sessionStorageAdapter(l,s);assert.equal(reload.getItem('helper:auth'),'persistent');
 reload.removeItem('helper:auth');assert.equal(reload.getItem('helper:auth'),null);assert.equal(l.getItem('helper:markdown:user'),'private note');
});
test('Content Security Policy in index.html allows blob: in img-src for local image editing', () => {
  const html = fs.readFileSync(path.resolve('index.html'), 'utf-8');
  const dom = new JSDOM(html);
  const meta = dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  assert.ok(meta, 'index.html must define Content-Security-Policy meta tag');
  const csp = meta.getAttribute('content') || '';
  const imgSrcMatch = csp.match(/img-src\s+([^;]+)/i);
  assert.ok(imgSrcMatch, 'CSP must contain img-src directive');
  const imgSrcDirectives = imgSrcMatch[1].split(/\s+/).filter(Boolean);
  assert.ok(imgSrcDirectives.includes("'self'"), "img-src must allow 'self'");
  assert.ok(imgSrcDirectives.includes('https:'), 'img-src must allow https:');
  assert.ok(imgSrcDirectives.includes('data:'), 'img-src must allow data:');
  assert.ok(imgSrcDirectives.includes('blob:'), 'img-src must allow blob: for URL.createObjectURL');
});
