import { attachEditor } from './editor.js';
import { loadNotes, saveNotes, tagsIn, filterTasks } from './notes.js';
const notebooks=new Map();
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const button=(text,fn,cls='quiet')=>{const b=el('button',cls,text);b.type='button';b.onclick=fn;return b;};
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const download=(name,text,type='text/markdown')=>{const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
export function mountWorkbench(host,{client,userId,initial='todos',notice,requireSession=async()=>true}) {
 let alive=true,section=initial,tasks=[],selectedTask=null,notebook,storageError=false,unsaved=false,taskDirty=false,undo=null;
 const filters={status:'all',list:'',tag:'',query:'',todayOnly:false};
 let noteSearch='',trash=false,editor;
 try {notebook=notebooks.get(userId)||loadNotes(localStorage,userId);notebooks.set(userId,notebook);}catch(e){storageError=true;notebook={version:1,notes:[],selected:null};notice(e.message,true);}
 const activeNotes=()=>notebook.notes.filter(n=>!n.deleted);
 const save=()=>{if(storageError)return false;try{saveNotes(localStorage,userId,notebook);unsaved=false;return true;}catch{unsaved=true;notice('Не удалось сохранить заметки: хранилище заполнено или недоступно. Экспортируй данные перед закрытием.',true);return false;}};
 const beforeUnload=e=>{if(unsaved||taskDirty){e.preventDefault();e.returnValue='';}};
 window.addEventListener('beforeunload',beforeUnload);
 const leave=()=>!(unsaved||taskDirty)||window.confirm('Есть несохранённые изменения. Всё равно перейти?');
 async function changeTask(id,patch){await requireSession();const {data,error}=await client.from('todos').update(patch).eq('id',id).select('*');if(error||!data?.length)throw new Error('Не удалось сохранить задачу. Проверь сеть и SQL-обновление базы.');tasks=tasks.map(t=>t.id===id?data[0]:t);return data[0];}
 async function createTask(payload){await requireSession();const {data,error}=await client.from('todos').insert(payload).select('*');if(error||!data?.length)throw new Error('Не удалось создать задачу. Проверь сеть и SQL-обновление базы.');tasks.unshift(data[0]);return data[0];}
 async function run(fn,b){if(b)b.disabled=true;try{await fn();}catch(e){if(alive)notice(e.message,true);}finally{if(b)b.disabled=false;}}
 async function refresh(){try{await requireSession();}catch{return;}const {data,error}=await client.from('todos').select('*').order('created_at',{ascending:false});if(!alive)return;if(error){notice('Не удалось загрузить задачи. Проверь подключение.',true);return;}tasks=data.map(t=>({...t,list_name:t.list_name||'Входящие'}));if(section==='todos')renderTasks();else renderRelated();}
 function navigate(next){if(!leave())return;section=next;render();}
 function openNote(id){const note=notebook.notes.find(n=>n.id===id);if(!note){notice('Этой заметки нет в этом браузере. Импортируй резервную копию с исходного устройства.',true);return;}if(note.deleted){notice('Заметка в корзине. Восстанови её в разделе заметок.',true);return;}if(!leave())return;notebook.selected=id;save();section='markdown';render();}
 function render(){
  if(!alive)return;host.replaceChildren();
  const top=el('div','work-heading');top.append(el('h1','',section==='todos'?'Задачи':'Заметки'),button(section==='todos'?'Заметки →':'← Задачи',()=>navigate(section==='todos'?'markdown':'todos')));host.append(top);
  if(section==='todos')renderTasks();else renderNotes();
 }
 function ensureArea(){let area=host.querySelector('.work-area');if(!area){area=el('div','work-area');host.append(area);}area.replaceChildren();return area;}
 function renderTasks(){
  if(!alive||section!=='todos')return;
  const focusId=document.activeElement?.id,caret=document.activeElement?.selectionStart;
  const area=ensureArea();
  const tools=el('div','task-controls');
  const query=el('input');query.id='task-search';query.placeholder='Поиск задач';query.setAttribute('aria-label','Поиск задач');query.value=filters.query;query.oninput=()=>{filters.query=query.value;renderTasks();};
  const list=el('select');list.setAttribute('aria-label','Список задач');list.append(new window.Option('Все списки',''));[...new Set(['Входящие',...tasks.map(t=>t.list_name)])].forEach(v=>list.append(new window.Option(v,v)));list.value=filters.list;list.onchange=()=>{filters.list=list.value;renderTasks();};
  const tag=el('input');tag.id='task-tag';tag.placeholder='#тег';tag.setAttribute('aria-label','Фильтр по тегу');tag.value=filters.tag;tag.oninput=()=>{filters.tag=tag.value.replace(/^#/,'').toLowerCase();renderTasks();};
  tools.append(query,list,tag,button(filters.todayOnly?'Все даты':'Сегодня',()=>{filters.todayOnly=!filters.todayOnly;renderTasks();}),button('Обновить',()=>run(refresh)));area.append(tools);
  const add=el('form','add');add.id='add';const title=el('input');title.name='title';title.placeholder='Добавить задачу';title.maxLength=500;title.required=true;title.setAttribute('aria-label','Новая задача');const submit=el('button','primary','+ Добавить');add.append(title,submit);add.onsubmit=e=>{e.preventDefault();const value=title.value.trim();if(!value)return;run(async()=>{await createTask({title:value,list_name:filters.list||'Входящие',tags:filters.tag?[filters.tag]:[]});if(alive){renderTasks();host.querySelector('#add input')?.focus();}},submit);};area.append(add);
  const tabs=el('div','status-tabs');[['all','Все'],['open','Невыполненные'],['done','Выполненные']].forEach(([id,label])=>tabs.append(button(label,()=>{filters.status=id;renderTasks();},filters.status===id?'selected':'quiet')));area.append(tabs);
  if(undo){const bar=el('div','undo');bar.append(el('span','',undo.label),button('Отменить',b=>run(async()=>{await undo.apply();undo=null;if(alive)renderTasks();},b.currentTarget)));area.append(bar);}
  const visible=filterTasks(tasks,{...filters,today:today()});
  const rows=el('div','tasks');rows.id='tasks';area.append(rows);
  for(const done of [false,true]){
   const group=visible.filter(t=>t.done===done);if(!group.length)continue;
   const details=el('details','task-group');details.open=true;details.append(el('summary','',`${done?'Выполненные':'Невыполненные'} · ${group.length}`));rows.append(details);
   group.forEach(task=>{
    const row=el('div',`task ${task.done?'done':''}`),check=el('input');check.type='checkbox';check.checked=task.done;check.setAttribute('aria-label',`Выполнено: ${task.title}`);
    check.onchange=()=>run(async()=>{await changeTask(task.id,{done:check.checked});undo={label:'Статус изменён',apply:()=>changeTask(task.id,{done:task.done})};if(alive)renderTasks();},check);
    const body=el('div','task-body');body.append(button(task.title,()=>taskDetails(task),'task-title'));
    const meta=el('div','task-meta');meta.append(el('span','',task.list_name));if(task.due_date)meta.append(el('span',!task.done&&task.due_date<today()?'overdue':'',task.due_date));if(task.priority)meta.append(el('span','',task.priority===2?'Высокий приоритет':'Средний приоритет'));
    const checks=[...(task.description||'').matchAll(/^\s*- \[([ xX])\]/gm)];if(checks.length)meta.append(el('span','',`☑ ${checks.filter(m=>m[1]!==' ').length}/${checks.length}`));
    [...new Set([...(task.tags||[]),...tagsIn(task.description)])].forEach(t=>meta.append(button('#'+t,()=>{filters.tag=t;renderTasks();},'tag')));
    if(task.note_id)meta.append(button('↗ Заметка',()=>openNote(task.note_id),'tag'));body.append(meta);
    row.append(check,body,button('Удалить',e=>run(async()=>{await requireSession();const {data,error}=await client.from('todos').delete().eq('id',task.id).select('id');if(error||!data?.length)throw new Error('Не удалось удалить задачу.');tasks=tasks.filter(t=>t.id!==task.id);undo={label:'Задача удалена',apply:()=>createTask(task)};if(alive)renderTasks();},e.currentTarget)));details.append(row);
   });
  }
  if(!visible.length)rows.append(el('p','empty','Нет задач по выбранным условиям.'));
  if(filters.tag){const related=activeNotes().filter(n=>tagsIn(n.body).includes(filters.tag));const box=el('div','related');box.append(el('h3','',`Заметки с #${filters.tag}`));related.forEach(n=>box.append(button(n.title,()=>openNote(n.id),'tag')));if(!related.length)box.append(el('p','muted','В этом браузере нет заметок с таким тегом.'));area.append(box);}
  if(focusId){const input=host.querySelector('#'+focusId);if(input){input.focus();if(caret!==null&&input.setSelectionRange)input.setSelectionRange(caret,caret);}}
 }
 function taskDetails(task){
  selectedTask=task.id;const dialog=el('dialog','task-dialog');
  dialog.innerHTML='<form method="dialog" class="detail-form"><div class="section-heading"><h2>Задача</h2><button type="button" class="quiet close">Закрыть</button></div><label>Название<input name="title" maxlength="500" required></label><div class="detail-fields"><label>Список<input name="list_name" maxlength="80" required list="task-lists"></label><datalist id="task-lists"></datalist><label>Срок<input type="date" name="due_date"></label><label>Приоритет<select name="priority"><option value="0">Обычный</option><option value="1">Средний</option><option value="2">Высокий</option></select></label></div><label>Теги<input name="tags" placeholder="#проект #идеи"></label><label>Связанная заметка<select name="note_id"><option value="">Без заметки</option></select></label><div class="task-editor"></div><p class="muted">Описание и фотографии сохраняются вместе с задачей в Supabase. Подзадачи: - [ ] и - [x].</p><button type="submit" class="primary">Сохранить задачу</button><p class="detail-status" role="status"></p></form>';
  const form=dialog.querySelector('form');for(const name of ['title','list_name','due_date','priority'])form.elements[name].value=task[name]??(name==='list_name'?'Входящие':'');
  form.elements.tags.value=(task.tags||[]).map(t=>'#'+t).join(' ');
  [...new Set(tasks.map(t=>t.list_name))].forEach(v=>dialog.querySelector('datalist').append(new window.Option(v,v)));
  activeNotes().forEach(n=>form.elements.note_id.append(new window.Option(n.title,n.id)));
  if(task.note_id&&!activeNotes().some(n=>n.id===task.note_id))form.elements.note_id.append(new window.Option('Недоступна в этом браузере',task.note_id));form.elements.note_id.value=task.note_id||'';
  const md=attachEditor(dialog.querySelector('.task-editor'),{value:task.description||'',id:'task-description',onChange:()=>taskDirty=true,onLink:()=>{dialog.querySelector('.detail-status').textContent='Сначала сохрани и закрой задачу, затем открой связанную заметку.';},onError:m=>dialog.querySelector('.detail-status').textContent=m});
  form.addEventListener('input',()=>taskDirty=true);
  const close=()=>{if(taskDirty&&!window.confirm('Закрыть без сохранения изменений задачи?'))return;taskDirty=false;dialog.close();dialog.remove();selectedTask=null;};dialog.querySelector('.close').onclick=close;dialog.oncancel=e=>{e.preventDefault();close();};
  form.onsubmit=async e=>{e.preventDefault();const b=form.querySelector('[type=submit]');b.disabled=true;try{const title=form.elements.title.value.trim(),list=form.elements.list_name.value.trim();if(!title||!list)throw new Error('Заполни название и список.');if(md.getValue().length>5000000)throw new Error('Описание слишком большое (максимум 5 млн символов).');await changeTask(task.id,{title,list_name:list,due_date:form.elements.due_date.value||null,priority:Number(form.elements.priority.value),tags:tagsIn(form.elements.tags.value),note_id:form.elements.note_id.value||null,description:md.getValue()});taskDirty=false;dialog.close();dialog.remove();selectedTask=null;if(alive)renderTasks();}catch(error){dialog.querySelector('.detail-status').textContent=error.message;}finally{b.disabled=false;}};
  host.append(dialog);dialog.showModal();
 }
  function newNote(title='Без названия',body='') {const note={id:crypto.randomUUID(),title,body,deleted:false,attachments:[]};notebook.notes.push(note);notebook.selected=note.id;save();return note;}
  function migrateEmbeddedImages(note){
   let changed=false;
   const body=note.body.replace(/!\[([^\]]*)\]\((data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+)\)/gi,(match,alt,data)=>{
    note.attachments||(note.attachments=[]);
    const existing=note.attachments.find(image=>image.data===data);
    const id=existing?.id||crypto.randomUUID();
    if(!existing)note.attachments.push({id,name:'изображение',type:data.slice(5,data.indexOf(';')),data});
    changed=true;return `![${alt}](attachment://${id})`;
   });
   if(changed)note.body=body;
   return changed;
  }
  function exportAll(){download('helper-notes.json',JSON.stringify(notebook,null,2),'application/json');}
 function renderNotes(){
  const area=ensureArea();if(storageError){area.append(el('p','error','Не удалось открыть локальные заметки. Исходные данные не изменены.'));return;}
  const actions=el('div','note-actions');actions.append(button('+ Заметка',()=>{trash=false;newNote();renderNotes();},'primary'),button('Импорт .md / .json',()=>importFile.click()),button('Экспорт всех',exportAll),button(trash?'Все заметки':'Корзина',()=>{trash=!trash;renderNotes();}));
  const importFile=el('input');importFile.type='file';importFile.accept='.md,.markdown,.json';importFile.hidden=true;importFile.onchange=async()=>{const f=importFile.files[0];if(!f)return;if(f.size>6000000){notice('Файл слишком большой (до 6 МБ).',true);return;}try{const text=await f.text();if(!alive)return;if(f.name.endsWith('.json')){const data=JSON.parse(text);if(data.version!==1||!Array.isArray(data.notes)||data.notes.some(n=>typeof n.id!=='string'||typeof n.title!=='string'||typeof n.body!=='string'))throw new Error('Неверный формат резервной копии.');if(data.notes.some(n=>notebook.notes.some(x=>x.id===n.id)))throw new Error('В копии есть уже существующие ID. Импорт отменён, чтобы не перезаписать заметки.');notebook.notes.push(...data.notes);notebook.selected=data.selected;save();}else newNote(f.name.replace(/\.(md|markdown)$/i,''),text);trash=false;renderNotes();}catch(e){notice(e.message,true);}};actions.append(importFile);area.append(actions);
  const layout=el('div','notes-layout'),side=el('div','note-sidebar'),main=el('div','note-main');layout.append(side,main);area.append(layout);
  const search=el('input');search.placeholder='Поиск текста или #тега';search.setAttribute('aria-label','Поиск заметок');search.value=noteSearch;side.append(search);const links=el('div','note-list');side.append(links);
  function listNotes(){links.replaceChildren();notebook.notes.filter(n=>Boolean(n.deleted)===trash&&`${n.title} ${n.body}`.toLowerCase().includes(noteSearch.toLowerCase())).forEach(n=>{links.append(button(n.title+(n.title.endsWith('.md')?'':'.md'),()=>{notebook.selected=n.id;save();renderNotes();},n.id===notebook.selected?'note-item selected':'note-item'));});}
  search.oninput=()=>{noteSearch=search.value;listNotes();};listNotes();
  let note=notebook.notes.find(n=>n.id===notebook.selected&&Boolean(n.deleted)===trash);
  if(!note){note=notebook.notes.find(n=>Boolean(n.deleted)===trash);if(note){notebook.selected=note.id;save();}}
   if(!note){main.append(el('p','empty',trash?'Корзина пуста.':'Создай заметку или импортируй Markdown-файл.'));return;}
   if(trash){main.append(el('h2','',note.title),button('Восстановить',()=>{note.deleted=false;save();trash=false;renderNotes();},'primary'));return;}
   if(migrateEmbeddedImages(note))save();
   const title=el('input');title.className='note-title';title.value=note.title;title.maxLength=150;title.setAttribute('aria-label','Название заметки');title.oninput=()=>{note.title=title.value;save();listNotes();};main.append(title);
  const tools=el('div','note-actions');tools.append(button('Скачать .md',()=>download((note.title||'Заметка').replace(/[/\\]/g,'_')+'.md',note.body)),button('Ссылка',()=>{const link=new URL(location.href);link.hash=`note=${note.id}`;navigator.clipboard?.writeText(link.href).then(()=>notice('Ссылка скопирована. Она открывает заметку только в браузере с её локальными данными.')).catch(()=>notice(link.href));}),button('В корзину',()=>{note.deleted=true;save();renderNotes();}));main.append(tools);
  const insert=el('select');insert.setAttribute('aria-label','Вставить ссылку на заметку');insert.append(new window.Option('Ссылка на заметку…',''));activeNotes().filter(n=>n.id!==note.id).forEach(n=>insert.append(new window.Option(n.title,n.id)));insert.onchange=()=>{const n=activeNotes().find(n=>n.id===insert.value);if(n)editor.insertLink(n.title,n.id);insert.value='';};tools.append(insert);
   const md=el('div');main.append(md);const saved=el('p','muted');saved.id='saved';saved.textContent=unsaved?'Не сохранено':'Хранится в этом браузере';
   const imageStore={get:id=>note.attachments?.find(image=>image.id===id)?.data,add:image=>{const item={id:crypto.randomUUID(),name:image.name,type:image.type,data:image.data};(note.attachments||(note.attachments=[])).push(item);if(!save())throw new Error('Не удалось сохранить изображение. Экспортируй заметки и освободи место в хранилище.');return item.id;}};
   editor=attachEditor(md,{value:note.body,imageStore,onChange:body=>{note.body=body;saved.textContent=save()?'Сохранено в браузере':'Не сохранено — экспортируй заметки';renderRelated();},onLink:openNote,onError:m=>notice(m,true)});
  tools.append(button('Выделенное → задача',e=>run(async()=>{const selection=editor.getSelection().trim();if(!selection)throw new Error('Выдели текст в редакторе, чтобы создать задачу.');const task=await createTask({title:selection.replace(/^\s*[-*] \[[ xX]\]\s*/,'').split('\n')[0].slice(0,500),description:selection,note_id:note.id,tags:tagsIn(note.body),list_name:'Входящие'});if(alive){notice('Задача создана и связана с заметкой.');renderRelated();}},e.currentTarget)));
  main.append(saved,el('div','related'));renderRelated();
 }
 function renderRelated(){if(!alive||section!=='markdown')return;const box=host.querySelector('.note-main .related'),note=notebook.notes.find(n=>n.id===notebook.selected);if(!box||!note)return;box.replaceChildren();const tags=tagsIn(note.body);tags.forEach(t=>box.append(button('#'+t,()=>{filters.tag=t;section='todos';render();},'tag')));box.append(el('h3','', 'Связанные задачи'));const related=tasks.filter(t=>t.note_id===note.id||tags.some(tag=>[...(t.tags||[]),...tagsIn(t.description)].includes(tag)));related.forEach(t=>box.append(button(`${t.done?'✓':'○'} ${t.title}`,()=>{section='todos';render();taskDetails(t);},'related-task')));if(!related.length)box.append(el('p','muted','Свяжи задачу с этой заметкой или добавь одинаковый #тег.'));const backlinks=activeNotes().filter(n=>n.id!==note.id&&n.body.includes(`#note=${note.id}`));if(backlinks.length){box.append(el('h3','','Ссылки на эту заметку'));backlinks.forEach(n=>box.append(button(n.title,()=>openNote(n.id),'tag')));}}
 const hash=()=>{const id=location.hash.match(/^#note=([a-zA-Z0-9-]+)$/)?.[1];if(id)openNote(id);};
 window.addEventListener('hashchange',hash);render();hash();refresh();
 return (force=false)=>{if(!force&&!leave())return false;alive=false;window.removeEventListener('hashchange',hash);window.removeEventListener('beforeunload',beforeUnload);host.querySelector('dialog')?.remove();return true;};
}
