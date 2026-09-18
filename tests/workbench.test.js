import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { filterTasks, loadNotes, parseTaskQuery, saveNotes, tagsIn } from '../src/notes.js';
import { attachEditor } from '../src/editor.js';
import { mountWorkbench } from '../src/workbench.js';

test('Tasks sort into open and completed groups and share Unicode tags', () => {
  const tasks = [
    {id:'done',title:'Готово',description:'#проект',done:true,priority:0,list_name:'Работа'},
    {id:'low',title:'Позже',description:'',done:false,priority:0,list_name:'Работа',due_date:'2026-09-20',tags:['проект']},
    {id:'high',title:'Сейчас',description:'Связано с #проект',done:false,priority:2,list_name:'Работа',due_date:'2026-09-19'},
  ];
  assert.deepEqual(filterTasks(tasks).map(t=>t.id),['high','low','done']);
  assert.deepEqual(filterTasks(tasks,{status:'done'}).map(t=>t.id),['done']);
  assert.deepEqual(filterTasks(tasks,{status:'open',tag:'проект'}).map(t=>t.id),['high','low']);
  assert.deepEqual(filterTasks(tasks,{query:'сейчас #проект'}).map(t=>t.id),['high']);
  assert.deepEqual(parseTaskQuery('  срочно #Проект #дом  '),{text:'срочно',tags:['проект','дом']});
  assert.deepEqual(tagsIn('Текст #Проект #идея #Проект'),['проект','идея']);
});

test('Multiple named notes persist and legacy Markdown is migrated without deletion', () => {
  const {window}=new JSDOM('',{url:'https://example.test'});
  window.localStorage.setItem('helper:markdown:user','# старая заметка');
  const data=loadNotes(window.localStorage,'user');
  assert.equal(data.notes[0].title,'Заметка');
  data.notes.push({id:'second',title:'План.md',body:'[Первая](#note='+data.notes[0].id+')',deleted:false});
  saveNotes(window.localStorage,'user',data);
  assert.equal(loadNotes(window.localStorage,'user').notes.length,2);
  assert.equal(window.localStorage.getItem('helper:markdown:user'),'# старая заметка');
});

test('Editor uses a single textarea source and completely removes live/block editor', () => {
  const dom = new JSDOM('<section id="editor"></section>', {url:'https://example.test/helper/'});
  const names=['window','document','localStorage'];
  const previous=Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage}))Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});
  const host = document.querySelector('#editor');
  attachEditor(host, { value: '# Заголовок\n\nПараграф' });
  assert.equal(host.querySelectorAll('textarea').length, 1);
  assert.equal(host.querySelector('.live-editor'), null);
  assert.equal(host.querySelector('.live-block'), null);
  dom.window.close();for(const name of names){if(previous[name])Object.defineProperty(globalThis,name,previous[name]);else delete globalThis[name];}
});

test('Editor resolves local attachment references without exposing data URLs', () => {
  const dom = new JSDOM('<section id="editor"></section>', {url:'https://example.test/helper/'});
  const names=['window','document','localStorage'];
  const previous=Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage}))Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});
  const source='![Фото](attachment://image-1)';
  attachEditor(document.querySelector('#editor'),{value:source,imageStore:{get:id=>id==='image-1'?'data:image/png;base64,AAAA':undefined}});
  assert.equal(document.querySelector('.preview img').getAttribute('src'),'data:image/png;base64,AAAA');
  assert.equal(document.querySelector('textarea').value,source);
  dom.window.close();for(const name of names){if(previous[name])Object.defineProperty(globalThis,name,previous[name]);else delete globalThis[name];}
});

test('Switching editor -> split -> editor preserves exact Markdown source', () => {
  const dom = new JSDOM('<section id="editor"></section>', {url:'https://example.test/helper/'});
  const names=['window','document','localStorage'];
  const previous=Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage}))Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});
  const host = document.querySelector('#editor');
  const source = '# Заголовок\n\nСтрока 1\nСтрока 2\n\n> Цитата\n';
  const editor = attachEditor(host, { value: source });
  const modeSelect = host.querySelector('.mode-select');
  const preview = host.querySelector('.preview');
  const splitControl = host.querySelector('.split-control');

  assert.equal(preview.hidden, true);
  assert.equal(splitControl.hidden, true);
  assert.equal(editor.getValue(), source);

  // Switch to split
  modeSelect.value = 'split';
  modeSelect.dispatchEvent(new dom.window.Event('change'));
  assert.equal(preview.hidden, false);
  assert.equal(splitControl.hidden, false);
  assert.equal(editor.getValue(), source);

  // Switch back to editor
  modeSelect.value = 'editor';
  modeSelect.dispatchEvent(new dom.window.Event('change'));
  assert.equal(preview.hidden, true);
  assert.equal(splitControl.hidden, true);
  assert.equal(editor.getValue(), source);

  dom.window.close();for(const name of names){if(previous[name])Object.defineProperty(globalThis,name,previous[name]);else delete globalThis[name];}
});

test('Split slider affects only split mode and editor preferences are restored from localStorage', () => {
  const dom = new JSDOM('<section id="editor"></section>', {url:'https://example.test/helper/'});
  const names=['window','document','localStorage'];
  const previous=Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage}))Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});

  dom.window.localStorage.setItem('helper:editor:view', 'split');
  dom.window.localStorage.setItem('helper:editor:split', '65');

  const host = document.querySelector('#editor');
  attachEditor(host, { value: 'Тестовый текст' });
  const editorBox = host.querySelector('.editor');
  const splitControl = host.querySelector('.split-control');
  const splitInput = splitControl.querySelector('input');

  assert.equal(splitControl.hidden, false);
  assert.equal(splitInput.value, '65');
  assert.match(editorBox.style.gridTemplateColumns, /65fr/);

  // Adjust slider
  splitInput.value = '40';
  splitInput.dispatchEvent(new dom.window.Event('input'));
  assert.match(editorBox.style.gridTemplateColumns, /40fr/);
  assert.equal(dom.window.localStorage.getItem('helper:editor:split'), '40');

  dom.window.close();for(const name of names){if(previous[name])Object.defineProperty(globalThis,name,previous[name]);else delete globalThis[name];}
});

test('Enter/list behavior continues list item and does not lose text', () => {
  const dom = new JSDOM('<section id="editor"></section>', {url:'https://example.test/helper/'});
  const names=['window','document','localStorage'];
  const previous=Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage}))Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});

  const host = document.querySelector('#editor');
  const editor = attachEditor(host, { value: '- [ ] Первая задача' });
  const textarea = host.querySelector('textarea');
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

  assert.equal(editor.getValue(), '- [ ] Первая задача\n- [ ] ');

  // Pressing Enter on empty list item exits list
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(editor.getValue(), '- [ ] Первая задача\n');

  dom.window.close();for(const name of names){if(previous[name])Object.defineProperty(globalThis,name,previous[name]);else delete globalThis[name];}
});

test('Preview checklist renders, toggles state, and supports undo/redo', () => {
  const dom = new JSDOM('<section id="editor"></section>', {url:'https://example.test/helper/'});
  const names=['window','document','localStorage'];
  const previous=Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage}))Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});

  const host = document.querySelector('#editor');
  attachEditor(host, { value: '- [ ] Сделать дело' });
  const checkbox = host.querySelector('.preview input[type="checkbox"]');
  assert.ok(checkbox);
  checkbox.click();
  assert.equal(host.querySelector('textarea').value, '- [x] Сделать дело');

  // Undo
  host.querySelector('textarea').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  assert.equal(host.querySelector('textarea').value, '- [ ] Сделать дело');

  // Redo
  host.querySelector('textarea').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }));
  assert.equal(host.querySelector('textarea').value, '- [x] Сделать дело');

  dom.window.close();for(const name of names){if(previous[name])Object.defineProperty(globalThis,name,previous[name]);else delete globalThis[name];}
});

test('Workbench checks the session before loading and separates task states', async () => {
  const dom=new JSDOM('<section id="view"></section>',{url:'https://example.test/helper/'});
  const names=['window','document','localStorage','location'];
  const previous=Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,location:dom.window.location}))Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});
  let checks=0;
  const rows=[
    {id:'open',title:'Открытая',description:'',done:false,priority:0,list_name:'Входящие',tags:[]},
    {id:'done',title:'Готовая',description:'',done:true,priority:0,list_name:'Входящие',tags:[]},
  ];
  const client={from(){return {select(){return this;},order:async()=>({data:rows})};}};
  const cleanup=mountWorkbench(document.querySelector('#view'),{client,userId:'user',notice(){},requireSession:async()=>{checks++;}});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(checks,1);
  assert.match(document.querySelector('#tasks').textContent,/Невыполненные · 1/);
  assert.match(document.querySelector('#tasks').textContent,/Выполненные · 1/);
  cleanup(true);dom.window.close();for(const name of names){if(previous[name])Object.defineProperty(globalThis,name,previous[name]);else delete globalThis[name];}
});
