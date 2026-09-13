import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { sessionStorageAdapter, renderMarkdown } from '../src/security.js';
const source=fs.readFileSync(new URL('../src/main.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replaceAll('import.meta.env.VITE_SUPABASE_URL',JSON.stringify('https://example.supabase.co')).replaceAll('import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY',JSON.stringify('public-test-key'));
const tick=()=>new Promise(r=>setTimeout(r,20));
async function app(profile){
 const dom=new JSDOM('<div id="app"></div>',{url:'https://example.test/helper/',runScripts:'outside-only'});
 const chain={select(){return this;},eq(){return this;},async single(){return {data:profile};},async order(){return {data:[{id:'todo',title:'<img src=x onerror=alert(1)>',done:false}]};}};
 const fake={auth:{async getSession(){return {data:{session:null}};},onAuthStateChange(){},async signInWithPassword(){return {data:{user:{id:'user'}}};}},from(){return chain;}};
 dom.window.createClient=()=>fake;dom.window.sessionStorageAdapter=sessionStorageAdapter;dom.window.renderMarkdown=(s)=>renderMarkdown(s,dom.window);
 dom.window.eval(source);await tick();
 const form=dom.window.document.querySelector('#login');
 form.elements.username.value='dustin';form.elements.password.value='temporary';
 form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
 return dom;
}
test('Temporary-password account is restricted to password change UI',async()=>{
 const dom=await app({username:'dustin',role:'admin',must_change_password:true,blocked:false});
 assert.ok(dom.window.document.querySelector('#password'));
 assert.ok(dom.window.document.querySelector('[data-page=admin]').disabled);
 assert.equal(dom.window.document.querySelector('#tasks'),null);dom.window.close();
});
test('Member tasks are rendered as text and Markdown survives navigation',async()=>{
 const dom=await app({username:'member',role:'member',must_change_password:false,blocked:false});
 const d=dom.window.document;
 assert.equal(d.querySelector('[data-page=admin]'),null);
 assert.equal(d.querySelector('#tasks img'),null);
 assert.match(d.querySelector('#tasks').textContent,/<img/);
 d.querySelector('[data-page=markdown]').click();
 d.querySelector('#source').value='# Saved';d.querySelector('#source').dispatchEvent(new dom.window.Event('input'));
 assert.equal(dom.window.localStorage.getItem('helper:markdown:user'),'# Saved');
 d.querySelector('[data-page=settings]').click();d.querySelector('[data-page=markdown]').click();
 assert.equal(d.querySelector('#source').value,'# Saved');dom.window.close();
});
