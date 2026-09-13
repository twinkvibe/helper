import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { filterTasks, loadNotes, saveNotes, tagsIn } from '../src/notes.js';
import { attachEditor, markdownBlocks } from '../src/editor.js';
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

test('Single-window editor splits Markdown into whole semantic blocks', () => {
  const source='# Заголовок\n\n- пункт 1\n- пункт 2\n\n```mermaid\ngraph TD\n A-->B\n```\n';
  const blocks=markdownBlocks(source);
  assert.equal(blocks.join(''),source);
  assert.ok(blocks.some(block=>block.includes('- пункт 2')));
  assert.ok(blocks.some(block=>block.includes('```mermaid')));
});

test('Editor resolves local attachment references without exposing data URLs', () => {
  const dom = new JSDOM('<section id="editor"></section>', {url:'https://example.test/helper/'});
  const names=['window','document'];
  const previous=Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document}))Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});
  const source='![Фото](attachment://image-1)';
  attachEditor(document.querySelector('#editor'),{value:source,imageStore:{get:id=>id==='image-1'?'data:image/png;base64,AAAA':undefined}});
  assert.equal(document.querySelector('.preview img').getAttribute('src'),'data:image/png;base64,AAAA');
  assert.equal(document.querySelector('textarea').value,source);
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
