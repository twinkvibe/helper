import { marked } from 'marked';
import { renderMarkdown } from './security.js';
import { enhanceDiagrams } from './diagram.js';
export function markdownBlocks(value) {
 const blocks=marked.lexer(value).map(t=>t.raw);
 return blocks.join('')===value && blocks.length ? blocks : [value];
}
export function attachEditor(host,{value='',onChange=()=>{},onLink=()=>{},onError=()=>{},id='source'}={}) {
 host.innerHTML=`<div class="format-bar" role="toolbar" aria-label="Форматирование Markdown"></div><div class="editor split"><textarea id="${id}" aria-label="Markdown текст" spellcheck="false" placeholder="Начни писать…"></textarea><article class="preview" aria-label="Предпросмотр"></article></div><div class="live-editor" hidden></div><div class="editor-footer"><span class="word-count"></span><span>Ctrl/⌘ B, I, K · Markdown</span></div>`;
 const text=host.querySelector('textarea'),preview=host.querySelector('.preview'),bar=host.querySelector('.format-bar'),live=host.querySelector('.live-editor');
 let active=text,parts=[],mode='split';text.value=value;
 let renderVersion=0;
 const renderInto=(target,value)=>{const version=++renderVersion;target.innerHTML=renderMarkdown(value);enhanceDiagrams(target).catch(()=>{}).then(()=>{if(version!==renderVersion)return;});};
 const emit=()=>{renderInto(preview,text.value);host.querySelector('.word-count').textContent=`${text.value.trim()?text.value.trim().split(/\s+/).length:0} слов · ${text.value.length} символов`;onChange(text.value);};
 function sync(){if(active!==text){parts[Number(active.dataset.block)]=active.value;text.value=parts.join('');}emit();}
 function insert(before,after='',placeholder='текст') {
  if(!active.isConnected)active=text;
  const start=active.selectionStart,end=active.selectionEnd,selection=active.value.slice(start,end)||placeholder;
  active.setRangeText(before+selection+after,start,end,'select');active.focus();sync();
 }
 function keydown(e){
  const input=e.currentTarget;active=input;
  if((e.ctrlKey||e.metaKey)&&!e.altKey){const f={b:['**','**'],i:['*','*'],k:['[','](https://example.com)']}[e.key.toLowerCase()];if(f){e.preventDefault();insert(...f);return;}}
  const start=input.selectionStart,end=input.selectionEnd,preceding=input.value.slice(0,start),line=preceding.slice(preceding.lastIndexOf('\n')+1);
  if(e.key==='Tab' && (preceding.match(/^```/gm)||[]).length%2){e.preventDefault();input.setRangeText('  ',start,end,'end');sync();}
  if(e.key==='Enter'&&start===end){const m=line.match(/^(\s*)([-*]|\d+\.)(\s+)(\[[ xX]\]\s+)?(.*)$/);if(m){e.preventDefault();if(!m[5].trim())input.setRangeText('',start-line.length,end,'end');else input.setRangeText(`\n${m[1]}${/\d/.test(m[2])?`${parseInt(m[2])+1}.`:m[2]} ${m[4]?'[ ] ':''}`,start,end,'end');sync();}}
 }
 function liveBlocks(){
  parts=markdownBlocks(text.value);live.replaceChildren();active=text;
  parts.forEach((part,i)=>{
   const row=document.createElement('div');row.className='live-block preview';row.tabIndex=0;row.setAttribute('aria-label',`Редактировать блок ${i+1}`);
   const render=()=>{renderInto(row,parts[i]);if(!row.textContent&&!row.querySelector('img,figure'))row.innerHTML='<span class="muted">Пустая строка — нажми, чтобы писать</span>';row.classList.remove('editing');};
   const edit=()=>{if(row.classList.contains('editing'))return;row.classList.add('editing');row.replaceChildren();const input=document.createElement('textarea');input.setAttribute('aria-label',`Markdown блока ${i+1}`);input.value=parts[i];input.dataset.block=String(i);input.rows=Math.max(3,Math.min(24,input.value.split('\n').length+1));row.append(input);active=input;input.oninput=()=>{active=input;sync();};input.onkeydown=keydown;input.onblur=()=>{parts[i]=input.value;text.value=parts.join('');emit();render();};input.focus();};
   row.onclick=e=>{if(!e.target.closest('a'))edit();};row.onkeydown=e=>{if(e.target===row&&(e.key==='Enter'||e.key===' ')){e.preventDefault();edit();}};render();live.append(row);
  });
  const add=document.createElement('button');add.type='button';add.className='quiet';add.textContent='+ Абзац';add.onclick=()=>{text.value=text.value.replace(/\n*$/,'')+'\n\n';text.value+=' ';emit();liveBlocks();live.querySelectorAll('.live-block')[parts.length-1].click();};live.append(add);
 }
 const formats=[['H1','Заголовок 1','# ',''],['H2','Заголовок 2','## ',''],['H3','Заголовок 3','### ',''],['B','Жирный · Ctrl/⌘ B','**','**'],['I','Курсив · Ctrl/⌘ I','*','*'],['S','Зачёркнутый','~~','~~'],['•','Список','- ',''],['☑','Подзадачи / чеклист','- [ ] ',''],['↗','Ссылка · Ctrl/⌘ K','[','](https://example.com)'],['‹›','Код','`','`'],['{ }','Блок кода','```\n','\n```'],['❞','Цитата','> ',''],['▧','Изображение по HTTPS-ссылке','![','](https://example.com/image.jpg)']];
 formats.forEach(([label,title,before,after])=>{const b=document.createElement('button');b.type='button';b.className='quiet';b.textContent=label;b.title=title;b.setAttribute('aria-label',title);b.onmousedown=e=>e.preventDefault();b.onclick=()=>insert(before,after);bar.append(b);});
 const file=document.createElement('input');file.type='file';file.accept='image/png,image/jpeg,image/webp,image/gif';file.hidden=true;
 async function attachImage(image){
  if(!/^image\/(png|jpeg|webp|gif)$/.test(image.type)||image.size>1024*1024){onError('Выбери PNG, JPEG, WebP или GIF до 1 МБ. Для больших фото можно вставить HTTPS-ссылку.');return;}
  const reader=new FileReader();reader.onload=()=>{if(!host.isConnected)return;insert('\n![изображение](',')\n',String(reader.result));};reader.onerror=()=>onError('Не удалось прочитать изображение.');reader.readAsDataURL(image);
 }
 file.onchange=()=>{if(file.files[0])attachImage(file.files[0]);file.value='';};
 const upload=document.createElement('button');upload.type='button';upload.className='quiet';upload.textContent='Фото';upload.title='Вставить фото с устройства (до 1 МБ)';upload.onmousedown=e=>e.preventDefault();upload.onclick=()=>file.click();bar.append(upload,file);
 host.addEventListener('paste',e=>{const image=[...(e.clipboardData?.files||[])].find(f=>f.type.startsWith('image/'));if(image){e.preventDefault();attachImage(image);}});
 const select=document.createElement('select');select.setAttribute('aria-label','Режим редактора');select.innerHTML='<option value="split">Текст + просмотр</option><option value="live">Одно окно</option>';select.onchange=()=>{mode=select.value;host.querySelector('.editor').hidden=mode==='live';live.hidden=mode!=='live';active=text;if(mode==='live')liveBlocks();};bar.append(select);
 const help=document.createElement('details');help.className='editor-help';help.innerHTML='<summary>Справка по синтаксису</summary><div class="syntax-guide"><p><code># H1</code> … <code>###### H6</code> · <code>**жирный**</code> · <code>*курсив*</code> · <code>~~зачёркнутый~~</code></p><p><code>- пункт</code> · <code>1. пункт</code> · <code>- [ ] задача</code> · <code>&gt; цитата</code> · <code>[ссылка](https://…)</code> · <code>![описание](https://…/image.png)</code></p><p>Таблица: строки с <code>| колонками |</code>. Код: тройные обратные кавычки. Диаграмма: блок кода с языком <code>mermaid</code>. <code>#тег</code> связывает заметки и задачи.</p><p>Enter продолжает список; пустой пункт завершает его. Tab в блоке кода — отступ. В одном окне нажми на абзац, список, таблицу или блок кода для редактирования; при потере фокуса применяется форматирование.</p></div>';host.append(help);
 host.addEventListener('click',e=>{const a=e.target.closest('a');if(a?.getAttribute('href')?.startsWith('#note=')){e.preventDefault();onLink(a.getAttribute('href').slice(6));}});
 text.oninput=()=>{active=text;sync();};text.onkeydown=keydown;text.onfocus=()=>active=text;
 renderInto(preview,value);host.querySelector('.word-count').textContent=`${value.length} символов`;
 return {text,getValue:()=>text.value,getSelection:()=>active.value.slice(active.selectionStart,active.selectionEnd),insertLink:(title,id)=>insert(`[${title.replace(/[\[\]\\]/g,'')}](`,')',`#note=${id}`)};
}
