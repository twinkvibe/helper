import { marked } from 'marked';
import { renderMarkdown } from './security.js';
import { enhanceDiagrams } from './diagram.js';
import { icon } from './icons.js';
export function markdownBlocks(value) {
 const blocks=marked.lexer(value).map(t=>t.raw);
 return blocks.join('')===value && blocks.length ? blocks : [value];
}
export function attachEditor(host,{value='',onChange=()=>{},onLink=()=>{},onError=()=>{},id='source',imageStore=null}={}) {
 host.innerHTML=`<div class="format-bar" role="toolbar" aria-label="Форматирование Markdown"></div><div class="editor split"><textarea id="${id}" aria-label="Markdown текст" spellcheck="false" placeholder="Начни писать…"></textarea><article class="preview" aria-label="Предпросмотр"></article></div><div class="live-editor" hidden></div><div class="editor-footer"><span class="word-count"></span><span>Ctrl/⌘ B, I, K · Markdown</span></div>`;
 const text=host.querySelector('textarea'),preview=host.querySelector('.preview'),bar=host.querySelector('.format-bar'),live=host.querySelector('.live-editor');
 let active=text,parts=[],mode='live';text.value=value;
 let undoStack=[],redoStack=[],lastValue=value;
 const remember=()=>{if(text.value===lastValue)return;undoStack.push(lastValue);if(undoStack.length>150)undoStack.shift();redoStack=[];lastValue=text.value;};
 const restore=value=>{text.value=value;lastValue=value;parts=mode==='live'?markdownBlocks(value):parts;active=text;emit();if(mode==='live')liveBlocks();else text.focus();};
 let renderVersion=0;
 const renderInto=(target,value)=>{const version=++renderVersion;const source=imageStore?value.replace(/\((attachment:\/\/[a-zA-Z0-9_-]+)\)/g,(match,url)=>{const data=imageStore.get(url.slice(13));return data?`(${data})`:match;}):value;target.innerHTML=renderMarkdown(source);enhanceDiagrams(target).catch(()=>{}).then(()=>{if(version!==renderVersion)return;});};
 const emit=()=>{renderInto(preview,text.value);host.querySelector('.word-count').textContent=`${text.value.trim()?text.value.trim().split(/\s+/).length:0} слов · ${text.value.length} символов`;onChange(text.value);};
 function sync(){if(active!==text){parts[Number(active.dataset.block)]=active.value;text.value=parts.join('');}remember();emit();}
 function insert(before,after='',placeholder='текст') {
  if(mode==='live'&&active===text)live.querySelector('.live-block')?.click();
  if(!active.isConnected)active=text;
  const start=active.selectionStart,end=active.selectionEnd,selection=active.value.slice(start,end)||placeholder;
  active.setRangeText(before+selection+after,start,end,'select');active.focus();sync();
 }
 function keydown(e){
  const input=e.currentTarget;active=input;
  if((e.ctrlKey||e.metaKey)&&!e.altKey&&e.key.toLowerCase()==='z'){e.preventDefault();if(e.shiftKey){if(redoStack.length){undoStack.push(lastValue);restore(redoStack.pop());}}else if(undoStack.length){redoStack.push(lastValue);restore(undoStack.pop());}return;}
  if((e.ctrlKey||e.metaKey)&&!e.altKey&&e.key.toLowerCase()==='y'){e.preventDefault();if(redoStack.length){undoStack.push(lastValue);restore(redoStack.pop());}return;}
  if((e.ctrlKey||e.metaKey)&&!e.altKey){const f={b:['**','**'],i:['*','*'],k:['[','](https://example.com)']}[e.key.toLowerCase()];if(f){e.preventDefault();insert(...f);return;}}
  const start=input.selectionStart,end=input.selectionEnd,preceding=input.value.slice(0,start),line=preceding.slice(preceding.lastIndexOf('\n')+1);
  if(e.key==='Tab' && (preceding.match(/^```/gm)||[]).length%2){e.preventDefault();input.setRangeText('  ',start,end,'end');sync();}
  if(e.key==='Enter'&&start===end){const m=line.match(/^(\s*)([-*]|\d+\.)(\s+)(\[[ xX]\]\s+)?(.*)$/);e.preventDefault();if(m){if(!m[5].trim())input.setRangeText('',start-line.length,end,'end');else input.setRangeText(`\n${m[1]}${/\d/.test(m[2])?`${parseInt(m[2])+1}.`:m[2]} ${m[4]?'[ ] ':''}`,start,end,'end');}else input.setRangeText('\n',start,end,'end');sync();return;}
 }
 function liveBlocks(){
  parts=markdownBlocks(text.value);live.replaceChildren();active=text;
  parts.forEach((part,i)=>{
   const row=document.createElement('div');row.className='live-block preview';row.tabIndex=0;row.setAttribute('aria-label',`Редактировать блок ${i+1}`);
   const render=()=>{renderInto(row,parts[i]);row.classList.remove('editing');};
   const edit=()=>{if(row.classList.contains('editing'))return;row.classList.add('editing');row.replaceChildren();const input=document.createElement('textarea');input.setAttribute('aria-label',`Markdown блока ${i+1}`);input.value=parts[i];input.dataset.block=String(i);input.rows=Math.max(1,Math.min(16,input.value.split('\n').length));row.append(input);active=input;input.oninput=()=>{active=input;sync();};input.onkeydown=keydown;input.onblur=()=>{parts[i]=input.value;text.value=parts.join('');remember();emit();render();};input.focus();};
   row.onclick=e=>{const checkbox=e.target.closest('input[type="checkbox"]');if(checkbox){e.preventDefault();toggleChecklist(row,checkbox);return;}if(!e.target.closest('a'))edit();};row.onkeydown=e=>{if(e.target===row&&(e.key==='Enter'||e.key===' ')){e.preventDefault();edit();}};render();live.append(row);
  });
  live.onclick=e=>{if(e.target===live){const blocks=live.querySelectorAll('.live-block');blocks[blocks.length-1]?.click();}};
 }
  const formats=[['h1','Заголовок 1','# ',''],['h2','Заголовок 2','## ',''],['h3','Заголовок 3','### ',''],['bold','Жирный · Ctrl/⌘ B','**','**'],['italic','Курсив · Ctrl/⌘ I','*','*'],['strike','Зачёркивание','~~','~~'],['list','Список','- ',''],['checklist','Подзадачи / чеклист','- [ ] ',''],['link','Ссылка · Ctrl/⌘ K','[','](https://example.com)'],['code','Код','`','`'],['codeBlock','Блок кода','```\n','\n```'],['quote','Цитата','> ',''],['image','Изображение по HTTPS-ссылке','![описание|640](',')','https://example.com/image.jpg']];
  formats.forEach(([iconName,title,before,after,placeholder])=>{const b=document.createElement('button');b.type='button';b.className='icon-button';b.append(icon(iconName));b.title=title;b.setAttribute('aria-label',title);b.onmousedown=e=>e.preventDefault();b.onclick=()=>insert(before,after,placeholder);bar.append(b);});
 const file=document.createElement('input');file.type='file';file.accept='image/png,image/jpeg,image/webp,image/gif';file.hidden=true;
 async function attachImage(image){
  if(!/^image\/(png|jpeg|webp|gif)$/.test(image.type)||image.size>1024*1024){onError('Выбери PNG, JPEG, WebP или GIF до 1 МБ. Для больших фото можно вставить HTTPS-ссылку.');return;}
  if(!imageStore){onError('Для изображения в задаче вставь HTTPS-ссылку. Локальные фото доступны в заметках.');return;}
  const reader=new FileReader();reader.onload=()=>{if(!host.isConnected)return;try{const data=String(reader.result),reference=`attachment://${imageStore.add({name:image.name,type:image.type,data})}`;insert('\n![изображение|640](',')\n',reference);}catch{onError('Не удалось сохранить изображение в заметке.');}};reader.onerror=()=>onError('Не удалось прочитать изображение.');reader.readAsDataURL(image);
 }
 file.onchange=()=>{if(file.files[0])attachImage(file.files[0]);file.value='';};
  if(imageStore){const upload=document.createElement('button');upload.type='button';upload.className='icon-button image-upload';upload.append(icon('imagePlus'),document.createTextNode('Фото'));upload.title='Вставить фото с устройства (до 1 МБ)';upload.onmousedown=e=>e.preventDefault();upload.onclick=()=>file.click();bar.append(upload,file);}
 host.addEventListener('paste',e=>{const image=[...(e.clipboardData?.files||[])].find(f=>f.type.startsWith('image/'));if(image){e.preventDefault();attachImage(image);}});
 host.addEventListener('dragover',e=>{if(imageStore&&[...(e.dataTransfer?.items||[])].some(item=>item.type.startsWith('image/'))){e.preventDefault();host.classList.add('drag-image');}});
 host.addEventListener('dragleave',()=>host.classList.remove('drag-image'));
 host.addEventListener('drop',e=>{host.classList.remove('drag-image');const image=[...(e.dataTransfer?.files||[])].find(item=>item.type.startsWith('image/'));if(image){e.preventDefault();attachImage(image);}});
 const select=document.createElement('select');select.setAttribute('aria-label','Режим редактора');select.innerHTML='<option value="live">Одно окно</option><option value="split">Текст + просмотр</option>';select.value='live';host.querySelector('.editor').hidden=true;live.hidden=false;select.onchange=()=>{mode=select.value;host.querySelector('.editor').hidden=mode==='live';live.hidden=mode!=='live';active=text;if(mode==='live')liveBlocks();};bar.append(select);
 const split=document.createElement('label');split.className='split-control';split.title='Ширина редактора и предпросмотра';split.innerHTML='<span>Ширина</span><input type="range" min="30" max="70" value="50" aria-label="Ширина редактора">';split.querySelector('input').oninput=e=>host.querySelector('.editor').style.gridTemplateColumns=`minmax(0,${e.target.value}fr) minmax(0,${100-e.target.value}fr)`;bar.append(split);
 const help=document.createElement('details');help.className='editor-help';help.innerHTML='<summary>Справка по синтаксису</summary><div class="syntax-guide"><p><code># H1</code> … <code>###### H6</code> · <code>**жирный**</code> · <code>*курсив*</code> · <code>~~зачёркнутый~~</code></p><p><code>- пункт</code> · <code>1. пункт</code> · <code>- [ ] задача</code> · <code>&gt; цитата</code> · <code>[ссылка](https://…)</code></p><p>Фото: <code>![описание|640](адрес)</code>. Число после <code>|</code> — ширина в пикселях, например <code>320</code> или <code>640x480</code>.</p><p>Таблица: строки с <code>| колонками |</code>. Код: тройные обратные кавычки. Диаграмма: блок кода с языком <code>mermaid</code>. <code>#тег</code> связывает заметки и задачи.</p><p>Enter продолжает список; пустой пункт завершает его. Tab в блоке кода — отступ. В одном окне нажми на абзац, список, таблицу или блок кода для редактирования; при потере фокуса применяется форматирование.</p></div>';host.append(help);
 host.addEventListener('click',e=>{const a=e.target.closest('a');if(a?.getAttribute('href')?.startsWith('#note=')){e.preventDefault();onLink(a.getAttribute('href').slice(6));}});
 text.oninput=()=>{active=text;sync();};text.onkeydown=keydown;text.onfocus=()=>active=text;
 function toggleChecklist(row,checkbox){const block=Number(row.querySelector('textarea')?.dataset.block??[...live.querySelectorAll('.live-block')].indexOf(row));let source=mode==='live'?parts[block]:text.value;const target=checkbox;const siblings=[...row.querySelectorAll('input[type="checkbox"]')];const index=siblings.indexOf(target);let seen=-1,changed=false;source=source.replace(/^(\s*(?:[-*+]|\d+\.)\s+)\[([ xX])\]/gm,(all,prefix,state)=>{seen++;if(seen===index){changed=true;return `${prefix}[${state.trim()?' ':'x'}]`;}return all;});if(!changed)return;undoStack.push(lastValue);redoStack=[];if(mode==='live'){parts[block]=source;text.value=parts.join('');}else text.value=source;lastValue=text.value;emit();if(mode==='live')liveBlocks();}
 preview.addEventListener('click',e=>{if(e.target.matches('input[type="checkbox"]')){e.preventDefault();const checks=[...preview.querySelectorAll('input[type="checkbox"]')],index=checks.indexOf(e.target);let seen=-1;undoStack.push(lastValue);redoStack=[];text.value=text.value.replace(/^(\s*(?:[-*+]|\d+\.)\s+)\[([ xX])\]/gm,(all,prefix,state)=>{seen++;return seen===index?`${prefix}[${state.trim()?' ':'x'}]`:all;});lastValue=text.value;emit();}});
 if(mode==='live')liveBlocks();
 renderInto(preview,value);host.querySelector('.word-count').textContent=`${value.length} символов`;
 return {text,getValue:()=>text.value,getSelection:()=>active.value.slice(active.selectionStart,active.selectionEnd),insertLink:(title,id)=>insert(`[${title.replace(/[\[\]\\]/g,'')}](`,')',`#note=${id}`)};
}
