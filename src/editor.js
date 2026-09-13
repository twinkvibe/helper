import { marked } from 'marked';
import { renderMarkdown } from './security.js';
import { enhanceDiagrams } from './diagram.js';
const iconPaths={b:'M6 4h7a4 4 0 0 1 0 8H6zm0 8h8a4 4 0 0 1 0 8H6zM6 4v16',i:'M10 4h8M6 20h8M14 4 10 20',s:'M4 12h16M6 7h9a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h9',list:'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',check:'M5 4h14v16H5zM8 9l2 2 4-4M8 16h7',link:'M10 13a5 5 0 0 0 7.07.07l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.15M14 11a5 5 0 0 0-7.07-.07l-2 2A5 5 0 0 0 12 20l1.15-1.15',code:'M8 7 3 12l5 5M16 7l5 5-5 5M14 4l-4 16',block:'M4 5h16v14H4zM8 9l3 3-3 3M13 15h3',quote:'M5 6h14M5 12h10M5 18h7',image:'M4 5h16v14H4zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4M5 17l4-4 3 3 2-2 5 5',h1:'M4 5v14M4 12h8M12 5v14M17 5v14M17 5h3M17 19h3',h2:'M4 5v14M4 12h8M12 5v14M17 5h4M17 12h3M17 19h4',h3:'M4 5v14M4 12h8M12 5v14M17 5h4M17 12h3M17 19h4'};
function svgIcon(name){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');svg.classList.add('toolbar-icon');const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',iconPaths[name]||iconPaths.block);path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','1.8');path.setAttribute('stroke-linecap','round');path.setAttribute('stroke-linejoin','round');svg.append(path);return svg;}
export function markdownBlocks(value) {
 const blocks=marked.lexer(value).map(t=>t.raw);
 return blocks.join('')===value && blocks.length ? blocks : [value];
}
export function attachEditor(host,{value='',onChange=()=>{},onLink=()=>{},onError=()=>{},id='source',imageStore=null}={}) {
 host.innerHTML=`<div class="format-bar" role="toolbar" aria-label="Форматирование Markdown"></div><div class="editor split"><textarea id="${id}" aria-label="Markdown текст" spellcheck="false" placeholder="Начни писать…"></textarea><article class="preview" aria-label="Предпросмотр"></article></div><div class="live-editor" hidden></div><div class="editor-footer"><span class="word-count"></span><span>Ctrl/⌘ B, I, K · Markdown</span></div>`;
 const text=host.querySelector('textarea'),preview=host.querySelector('.preview'),bar=host.querySelector('.format-bar'),live=host.querySelector('.live-editor');
 let active=text,parts=[],mode='split';text.value=value;
 let renderVersion=0;
 const renderInto=(target,value)=>{const version=++renderVersion;const source=imageStore?value.replace(/\((attachment:\/\/[a-zA-Z0-9_-]+)\)/g,(match,url)=>{const data=imageStore.get(url.slice(13));return data?`(${data})`:match;}):value;target.innerHTML=renderMarkdown(source);enhanceDiagrams(target).catch(()=>{}).then(()=>{if(version!==renderVersion)return;});};
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
  const formats=[['h1','Заголовок 1','# ',''],['h2','Заголовок 2','## ',''],['h3','Заголовок 3','### ',''],['b','Жирный · Ctrl/⌘ B','**','**'],['i','Курсив · Ctrl/⌘ I','*','*'],['s','Зачёркнутый','~~','~~'],['list','Список','- ',''],['check','Подзадачи / чеклист','- [ ] ',''],['link','Ссылка · Ctrl/⌘ K','[','](https://example.com)'],['code','Код','`','`'],['block','Блок кода','```\n','\n```'],['quote','Цитата','> ',''],['image','Изображение по HTTPS-ссылке','![','](https://example.com/image.jpg)']];
  formats.forEach(([icon,title,before,after])=>{const b=document.createElement('button');b.type='button';b.className='quiet';b.append(svgIcon(icon));b.title=title;b.setAttribute('aria-label',title);b.onmousedown=e=>e.preventDefault();b.onclick=()=>insert(before,after);bar.append(b);});
 const file=document.createElement('input');file.type='file';file.accept='image/png,image/jpeg,image/webp,image/gif';file.hidden=true;
 async function attachImage(image){
  if(!/^image\/(png|jpeg|webp|gif)$/.test(image.type)||image.size>1024*1024){onError('Выбери PNG, JPEG, WebP или GIF до 1 МБ. Для больших фото можно вставить HTTPS-ссылку.');return;}
  const reader=new FileReader();reader.onload=()=>{if(!host.isConnected)return;try{const data=String(reader.result),reference=imageStore?`attachment://${imageStore.add({name:image.name,type:image.type,data})}`:data;insert('\n![изображение](',')\n',reference);}catch{onError('Не удалось сохранить изображение в заметке.');}};reader.onerror=()=>onError('Не удалось прочитать изображение.');reader.readAsDataURL(image);
 }
 file.onchange=()=>{if(file.files[0])attachImage(file.files[0]);file.value='';};
  const upload=document.createElement('button');upload.type='button';upload.className='quiet';upload.append(svgIcon('image'),document.createTextNode('Фото'));upload.title='Вставить фото с устройства (до 1 МБ)';upload.onmousedown=e=>e.preventDefault();upload.onclick=()=>file.click();bar.append(upload,file);
 host.addEventListener('paste',e=>{const image=[...(e.clipboardData?.files||[])].find(f=>f.type.startsWith('image/'));if(image){e.preventDefault();attachImage(image);}});
 const select=document.createElement('select');select.setAttribute('aria-label','Режим редактора');select.innerHTML='<option value="split">Текст + просмотр</option><option value="live">Одно окно</option>';select.onchange=()=>{mode=select.value;host.querySelector('.editor').hidden=mode==='live';live.hidden=mode!=='live';active=text;if(mode==='live')liveBlocks();};bar.append(select);
 const help=document.createElement('details');help.className='editor-help';help.innerHTML='<summary>Справка по синтаксису</summary><div class="syntax-guide"><p><code># H1</code> … <code>###### H6</code> · <code>**жирный**</code> · <code>*курсив*</code> · <code>~~зачёркнутый~~</code></p><p><code>- пункт</code> · <code>1. пункт</code> · <code>- [ ] задача</code> · <code>&gt; цитата</code> · <code>[ссылка](https://…)</code> · <code>![описание](https://…/image.png)</code></p><p>Таблица: строки с <code>| колонками |</code>. Код: тройные обратные кавычки. Диаграмма: блок кода с языком <code>mermaid</code>. <code>#тег</code> связывает заметки и задачи.</p><p>Enter продолжает список; пустой пункт завершает его. Tab в блоке кода — отступ. В одном окне нажми на абзац, список, таблицу или блок кода для редактирования; при потере фокуса применяется форматирование.</p></div>';host.append(help);
 host.addEventListener('click',e=>{const a=e.target.closest('a');if(a?.getAttribute('href')?.startsWith('#note=')){e.preventDefault();onLink(a.getAttribute('href').slice(6));}});
 text.oninput=()=>{active=text;sync();};text.onkeydown=keydown;text.onfocus=()=>active=text;
 renderInto(preview,value);host.querySelector('.word-count').textContent=`${value.length} символов`;
 return {text,getValue:()=>text.value,getSelection:()=>active.value.slice(active.selectionStart,active.selectionEnd),insertLink:(title,id)=>insert(`[${title.replace(/[\[\]\\]/g,'')}](`,')',`#note=${id}`)};
}
