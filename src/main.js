import { createClient } from '@supabase/supabase-js';
import { renderMarkdown, sessionStorageAdapter } from './security';
import './style.css';
const root = document.querySelector('#app');
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
let client, storage, user, profile, page = 'todos', generation = 0;
const $ = (id) => document.getElementById(id);
const escape = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function notice(message, bad = false) { const el = $('notice'); if(el) {el.textContent = message; el.className = bad ? 'notice error' : 'notice';} }
async function action(body) {
 const {data,error} = await client.functions.invoke('account',{body});
 if(error) {
  let message = 'Серверная функция недоступна. Проверьте подключение и настройку Supabase.';
  try { message = (await error.context.json()).error || message; } catch {}
  throw new Error(message);
 }
 if(data?.error) throw new Error(data.error);
 return data;
}
function busy(form, callback) {
 form.addEventListener('submit',async e => {e.preventDefault(); const buttons = [...form.querySelectorAll('button')]; buttons.forEach(b=>b.disabled=true); try {await callback(new FormData(form));} catch(error){notice(error.message,true);} finally {buttons.forEach(b=>b.disabled=false);} });
}
function login() {
 generation++; user = null; profile = null;
 root.innerHTML = `<main class="login"><div class="intro"><a class="brand" href="./">h<span>elper</span><i>✳</i></a><div><p class="eyebrow">ТВОЁ ЛИЧНОЕ ПРОСТРАНСТВО</p><h1>Меньше шума.<br>Больше <em>ясности.</em></h1><p class="muted">Задачи, заметки и мысли.<br>Всё нужное — в одном месте.</p></div><small>01 / Место для главного</small></div><section class="login-card"><span class="badge">ТОЛЬКО ДЛЯ СВОИХ</span><h2>С возвращением</h2><p class="muted">Войди, чтобы продолжить с того же места.</p><form id="login"><label>Логин<input name="username" autocomplete="username" pattern="[A-Za-z0-9_]{3,32}" required placeholder="Твой логин"></label><label>Пароль<input name="password" type="password" autocomplete="current-password" required placeholder="Введи пароль"></label><label class="check"><input name="remember" type="checkbox">Запомнить меня</label><button class="primary">Войти <span>↗</span></button></form><p id="notice" class="notice" role="status" aria-live="polite"></p><small>Нет аккаунта? Обратись к администратору.</small></section></main>`;
 busy($('login'),async f=>{
  storage.setRemember(f.has('remember'));
  const {data,error} = await client.auth.signInWithPassword({email:`${String(f.get('username')).toLowerCase()}@users.helper.invalid`,password:String(f.get('password'))});
  if(error) throw new Error('Не удалось войти. Проверь логин, пароль и подключение.');
  await enter(data.user);
 });
}
async function enter(nextUser) {
 const token = ++generation;
 const {data,error} = await client.from('profiles').select('*').eq('id',nextUser.id).single();
 if(token !== generation) return;
 if(error || !data || data.blocked) {
  await client.auth.signOut({scope:'local'}); login(); notice('Доступ закрыт или аккаунт ещё не настроен.',true); return;
 }
 user = nextUser; profile = data;
 if(profile.must_change_password) page='settings';
 shell();
}
function shell() {
 generation++;
 root.innerHTML = `<div class="workspace"><aside><a class="brand" href="./">h<span>elper</span><i>✳</i></a><p class="eyebrow">ПРОСТРАНСТВО</p><nav>${[['todos','☑','Задачи'],['markdown','✎','Markdown'],['settings','⚙','Аккаунт'],...(profile.role==='admin'?[['admin','♙','Админка']]:[])].map(([id,icon,title])=>`<button data-page="${id}" class="nav ${page===id?'active':''}" ${profile.must_change_password && id!=='settings'?'disabled':''}><span>${icon}</span>${title}</button>`).join('')}</nav><div class="account"><strong>${escape(profile.username)}</strong><small>${profile.role==='admin'?'Администратор':'Участник'}</small><button id="logout" class="quiet">Выйти ↗</button></div></aside><main class="content"><header><span class="eyebrow">HELPER / ${({todos:'ЗАДАЧИ',markdown:'ЗАМЕТКИ',settings:'АККАУНТ',admin:'УПРАВЛЕНИЕ'})[page]}</span><span class="badge">ЛИЧНОЕ</span></header><p id="notice" class="notice" role="status" aria-live="polite"></p><section id="view"></section></main></div>`;
 document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>{page=b.dataset.page;shell();});
 $('logout').onclick=async()=>{const {error}=await client.auth.signOut({scope:'local'});if(error){notice('Не удалось выйти. Повтори попытку.',true);return;}login();};
 ({todos,markdown,settings,admin:adminPage})[page]();
}
async function todos() {
 const token = generation;
 $('view').innerHTML = `<div class="title"><div><p class="eyebrow">ШАГ ЗА ШАГОМ</p><h1>Твои задачи<span class="dot">.</span></h1><p class="muted">Освободи голову. Запиши, что нужно сделать.</p></div><span class="big-icon">↗</span></div><form id="add" class="add"><input name="title" maxlength="500" required aria-label="Новая задача" placeholder="Что в планах?"><button class="primary">+ Добавить</button></form><div class="section-heading"><h3>Список задач</h3><button id="refresh" class="quiet">Обновить</button></div><div id="tasks" class="tasks"><p class="muted">Загружаем задачи…</p></div>`;
 async function refresh(){
  const {data,error}=await client.from('todos').select('*').order('created_at',{ascending:false});
  if(token!==generation)return;
  if(error){$('tasks').textContent='Не удалось загрузить задачи.';notice('Проверь подключение и права доступа.',true);return;}
  $('tasks').replaceChildren();
  if(!data.length){$('tasks').innerHTML='<div class="empty"><span>✓</span><h3>Можно выдохнуть</h3><p class="muted">Добавь первую задачу — начнём с малого.</p></div>';return;}
  for(const task of data){
   const row=document.createElement('div');row.className=`task ${task.done?'done':''}`;
   const label=document.createElement('label');const check=document.createElement('input');check.type='checkbox';check.checked=task.done;
   const title=document.createElement('span');title.textContent=task.title;label.append(check,title);
   const remove=document.createElement('button');remove.className='quiet';remove.textContent='×';remove.setAttribute('aria-label',`Удалить задачу: ${task.title}`);
   check.onchange=async()=>{check.disabled=true;const {data: changed,error}=await client.from('todos').update({done:check.checked}).eq('id',task.id).select('id');if(error || !changed?.length)notice('Не удалось сохранить задачу.',true);await refresh();};
   remove.onclick=async()=>{remove.disabled=true;const {data: changed,error}=await client.from('todos').delete().eq('id',task.id).select('id');if(error || !changed?.length)notice('Не удалось удалить задачу.',true);await refresh();};
   row.append(label,remove);$('tasks').append(row);
  }
 }
 $('refresh').onclick=refresh;
 busy($('add'),async f=>{const title=String(f.get('title')).trim();if(!title)return;const {error}=await client.from('todos').insert({title});if(error)throw new Error('Не удалось добавить задачу. Проверь подключение и права доступа.');if(token!==generation)return;$('add').reset();await refresh();});
 await refresh();
}
function markdown(){
 const noteKey=`helper:markdown:${user.id}`;
 $('view').innerHTML='<div class="title"><div><p class="eyebrow">МЕСТО ДЛЯ МЫСЛЕЙ</p><h1>Чистый лист<span class="dot">.</span></h1><p class="muted">Заметка хранится в этом браузере. Выход из аккаунта её не удалит.</p></div></div><div class="section-heading"><h3>Markdown</h3><span id="saved" class="muted" role="status"></span></div><div class="editor"><textarea id="source" aria-label="Markdown текст" spellcheck="false" placeholder="# Что у тебя на уме?"></textarea><article id="preview" class="preview" aria-label="Предпросмотр"></article></div>';
 let canSave=true;
 try{$('source').value=localStorage.getItem(noteKey)||'';}catch{canSave=false;notice('Хранилище недоступно. Текст не будет сохранён.',true);}
 const render=()=>{$('preview').innerHTML=renderMarkdown($('source').value);};
 $('source').oninput=()=>{render();if(canSave)try{localStorage.setItem(noteKey,$('source').value);$('saved').textContent='Сохранено в браузере';}catch{$('saved').textContent='Не сохранено';notice('Недостаточно места или хранилище недоступно. Скопируй текст перед закрытием.',true);}};
 render();
}
function settings(){
 $('view').innerHTML=`<div class="title"><div><p class="eyebrow">БЕЗОПАСНОСТЬ</p><h1>Твой аккаунт<span class="dot">.</span></h1><p class="muted">${profile.must_change_password?'Для продолжения замени временный пароль.':'Здесь можно изменить пароль.'}</p></div></div><form id="password" class="panel narrow"><label>Текущий пароль<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>Новый пароль<input name="password" type="password" minlength="9" maxlength="128" autocomplete="new-password" required></label><label>Повтори новый пароль<input name="repeat" type="password" minlength="9" maxlength="128" autocomplete="new-password" required></label><small>От 9 до 128 символов.</small><button class="primary">Изменить пароль</button></form>`;
 busy($('password'),async f=>{if(f.get('password')!==f.get('repeat'))throw new Error('Пароли не совпадают.');await action({action:'password',currentPassword:f.get('currentPassword'),password:f.get('password')});page='todos';await enter(user);notice('Пароль изменён.');});
}
async function adminPage(){
 const token=generation;
 $('view').innerHTML='<div class="title"><div><p class="eyebrow">ДОСТУП В ПРОСТРАНСТВО</p><h1>Участники<span class="dot">.</span></h1><p class="muted">Создавай аккаунты и управляй доступом.</p></div></div><form id="create" class="panel"><h3>Новый участник</h3><label>Логин<input name="username" pattern="[a-z0-9_]{3,32}" required autocomplete="off" placeholder="a–z, 0–9, нижнее подчёркивание"></label><label>Временный пароль<input name="password" type="password" minlength="9" maxlength="128" required autocomplete="new-password"></label><button class="primary">Создать аккаунт</button></form><div class="section-heading"><h3>Аккаунты</h3></div><div id="users">Загружаем…</div>';
 const refresh=async()=>{const data=await action({action:'list'});if(token!==generation)return;$('users').replaceChildren();for(const p of data.users){const row=document.createElement('div');row.className='task';const name=document.createElement('span');name.textContent=`${p.username} · ${p.role==='admin'?'администратор':p.blocked?'заблокирован':'участник'}${p.must_change_password?' · ожидает смены пароля':''}`;row.append(name);if(p.role!=='admin'){const block=document.createElement('button');block.className='quiet';block.textContent=p.blocked?'Разблокировать':'Заблокировать';block.onclick=async()=>{block.disabled=true;try{await action({action:'block',id:p.id,blocked:!p.blocked});await refresh();}catch(e){notice(e.message,true);}finally{block.disabled=false;}};const reset=document.createElement('button');reset.className='quiet';reset.textContent='Сбросить пароль';reset.onclick=()=>{const form=document.createElement('form');form.className='panel';form.innerHTML='<label>Новый временный пароль<input type="password" name="password" minlength="9" maxlength="128" autocomplete="new-password" required></label><button class="primary">Сохранить</button><button type="button" class="quiet">Отмена</button>';form.querySelector('[type=button]').onclick=()=>form.remove();busy(form,async f=>{await action({action:'reset',id:p.id,password:f.get('password')});await refresh();notice('Временный пароль установлен.');});row.after(form);reset.disabled=true;form.querySelector('[type=button]').onclick=()=>{form.remove();reset.disabled=false;};};row.append(block,reset);}$('users').append(row);}};
 busy($('create'),async f=>{await action({action:'create',username:f.get('username'),password:f.get('password')});if(token!==generation)return;$('create').reset();await refresh();notice('Аккаунт создан. При первом входе потребуется сменить пароль.');});
 try{await refresh();}catch(e){if(token===generation){$('users').textContent='Список недоступен.';notice(e.message,true);}}
}
async function boot(){
 if(!url || !key){root.innerHTML='<main class="login-card"><h1>Helper</h1><p>Подключение к сервису ещё не настроено.</p></main>';return;}
 try{
  localStorage.setItem('helper:storage-test','1');localStorage.removeItem('helper:storage-test');
  storage=sessionStorageAdapter(localStorage,sessionStorage);
  client=createClient(url,key,{auth:{storage,storageKey:'helper:auth',persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
  client.auth.onAuthStateChange((event)=>{if(event==='SIGNED_OUT')login();});
  root.innerHTML='<main class="login-card"><h1>helper ✳</h1><p>Открываем пространство…</p></main>';
  const {data:{session}}=await client.auth.getSession();
  if(session){const {data:{user:verified},error}=await client.auth.getUser();if(error || !verified){await client.auth.signOut({scope:'local'});login();}else await enter(verified);}else login();
 }catch{root.innerHTML='<main class="login-card"><h1>Не удалось открыть Helper</h1><p>Проверь подключение и разреши хранение данных сайта, затем обнови страницу.</p></main>';}
}
boot();
