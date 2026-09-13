import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderMarkdown, sessionStorageAdapter } from '../src/security.js';
test('Markdown strips active content and permits safe images and checklists',()=>{
 const {window}=new JSDOM('');
 const html=renderMarkdown('# Hello\n\n**bold**\n\n- [ ] item\n\n![local](/image/example.png)\n\n<script>alert(1)</script><img src="https://images.test/x.png" onerror="alert(1)"><iframe src="https://evil.test"></iframe><a href="javascript:alert(1)">bad</a><svg onload="alert(1)"></svg><form><input autofocus onfocus="alert(1)"></form>',window);
 assert.match(html,/<h1>Hello<\/h1>/);assert.match(html,/<strong>bold<\/strong>/);
 assert.match(html,/<img src="https:\/\/images\.test\/x\.png"/);
 assert.match(html,/<img src="\/image\/example\.png"/);
 assert.match(html,/<input disabled="" type="checkbox">/);
 assert.doesNotMatch(html,/<script|<iframe|<svg|<form|onerror|onload|javascript:/i);
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
