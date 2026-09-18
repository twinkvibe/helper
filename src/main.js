import { createClient } from '@supabase/supabase-js';
import { sessionStorageAdapter } from './security.js';
import { mountWorkbench } from './workbench.js';
import { mountArticles, publicArticleSlug, renderPublicArticle } from './articles.js';
import { icon } from './icons.js';
import './style.css';
import './workbench.css';
const root = document.querySelector('#app');
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const pageFromPath = () => ({admin:'admin',editor:'articles',tasks:'todos',notes:'markdown',account:'settings',logs:'logs'}[location.pathname.replace(/^\/helper\/?/,'').replace(/\/$/,'')] || 'todos');
const pageHref = page => page === 'todos' ? './' : `./${({articles:'editor',markdown:'notes',settings:'account',todos:'tasks'}[page] || page)}`;
let client, storage, user, profile, page = pageFromPath(), generation = 0, cleanupView = null, authTimer = null, expiring = false, authMessage = '';
const $ = (id) => document.getElementById(id);
const escape = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function notice(message, bad = false) { const el = $('notice'); if(el) {el.textContent = message; el.className = bad ? 'notice error' : 'notice';} }
function scheduleSessionCheck(session) {
 clearTimeout(authTimer);
 if(!session?.expires_at)return;
 const delay=Math.max(1000,session.expires_at*1000-Date.now()-30000);
 authTimer=setTimeout(async()=>{
  const {data,error}=await client.auth.refreshSession();
  if(error||!data.session){expireSession();return;}
  scheduleSessionCheck(data.session);
 },delay);
}
async function expireSession(message='Сессия истекла. Войди снова.') {
 if(expiring||!user)return;
 expiring=true;authMessage=message;clearTimeout(authTimer);
 try{await client.auth.signOut({scope:'local'});}finally{if(user)login();expiring=false;}
}
async function requireSession() {
 const {data:{session},error}=await client.auth.getSession();
 if(error||!session){await expireSession();throw new Error('Сессия истекла.');}
 if(session.expires_at*1000-Date.now()<60000){
  const refreshed=await client.auth.refreshSession();
  if(refreshed.error||!refreshed.data.session){await expireSession();throw new Error('Сессия истекла.');}
  scheduleSessionCheck(refreshed.data.session);
 }
 return true;
}
async function action(body) {
 await requireSession();
 const {data,error} = await client.functions.invoke('account',{body});
 if(error) {
  let message = 'Серверная функция недоступна. Проверьте подключение и настройку Supabase.';
  try { message = (await error.context.json()).error || message; } catch {}
  if(/сесси|jwt|unauthor/i.test(message)){await expireSession();throw new Error('Сессия истекла. Войди снова.');}
  throw new Error(message);
 }
 if(data?.error) throw new Error(data.error);
 return data;
}
function busy(form, callback) {
 form.addEventListener('submit',async e => {e.preventDefault(); const buttons = [...form.querySelectorAll('button')]; buttons.forEach(b=>b.disabled=true); try {await callback(new FormData(form));} catch(error){notice(error.message,true);} finally {buttons.forEach(b=>b.disabled=false);} });
}
function login() {
 if(cleanupView) cleanupView(true);
 cleanupView = null;
 generation++; user = null; profile = null;
 root.innerHTML = `<main class="login"><div class="intro"><a class="brand" href="./">h<span>elper</span><i>✳</i></a><div><p class="eyebrow">ТВОЁ ЛИЧНОЕ ПРОСТРАНСТВО</p><h1>Меньше шума.<br>Больше <em>ясности.</em></h1><p class="muted">Задачи, заметки и мысли.<br>Всё нужное — в одном месте.</p></div><small>01 / Место для главного</small></div><section class="login-card"><span class="badge">ТОЛЬКО ДЛЯ СВОИХ</span><h2>С возвращением</h2><p class="muted">Войди, чтобы продолжить с того же места.</p><form id="login"><label>Логин<input name="username" autocomplete="username" pattern="[A-Za-z0-9_]{3,32}" required placeholder="Твой логин"></label><label>Пароль<input name="password" type="password" autocomplete="current-password" required placeholder="Введи пароль"></label><label class="check"><input name="remember" type="checkbox">Запомнить меня</label><button class="primary">Войти <span>↗</span></button></form><p id="notice" class="notice" role="status" aria-live="polite"></p><small>Нет аккаунта? Обратись к администратору.</small></section></main>`;
 if(authMessage){notice(authMessage,true);authMessage='';}
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
 if(cleanupView && cleanupView() === false) return;
 cleanupView = null;
 generation++;
 root.innerHTML = `<div class="workspace"><aside><a class="brand" href="./">h<span>elper</span><i>✳</i></a><nav>${[['todos','tasks','Задачи'],['markdown','note','Заметки'],['articles','articles','Публикации'],['settings','settings','Аккаунт'],...(profile.role==='admin'?[['admin','users','Админка'],['logs','logs','Логи']]:[])].map(([id,iconName,title])=>`<a data-page="${id}" href="${pageHref(id)}" class="nav ${page===id?'active':''}" ${profile.must_change_password && id!=='settings'?'aria-disabled="true" tabindex="-1"':''}><span data-nav-icon="${iconName}"></span>${title}</a>`).join('')}</nav><div class="account"><strong>${escape(profile.username)}</strong><small>${profile.role==='admin'?'Администратор':'Участник'}</small><button id="logout" class="quiet"><span data-nav-icon="logout"></span>Выйти</button></div></aside><main class="content"><p id="notice" class="notice" role="status" aria-live="polite"></p><section id="view"></section></main></div>`;
 document.querySelectorAll('[data-nav-icon]').forEach(slot=>slot.replaceChildren(icon(slot.dataset.navIcon)));
 document.querySelectorAll('[data-page]').forEach(b=>b.onclick=e=>{if(b.getAttribute('aria-disabled')==='true'){e.preventDefault();return;}const next=b.dataset.page;if(next===page){e.preventDefault();return;}if(cleanupView&&cleanupView()===false){e.preventDefault();return;}cleanupView=null;page=next;});
 $('logout').onclick=async()=>{if(cleanupView&&cleanupView()===false)return;cleanupView=null;const {error}=await client.auth.signOut({scope:'local'});if(error){shell();notice('Не удалось выйти. Повтори попытку.',true);return;}login();};
 ({todos,markdown,articles,settings,admin:adminPage,logs})[page]();
}
async function todos() {
 cleanupView = mountWorkbench($('view'), {client, userId:user.id, initial:'todos', notice, requireSession});
}
function markdown(){
 cleanupView = mountWorkbench($('view'), {client, userId:user.id, initial:'markdown', notice, requireSession});
}
function articles(){ cleanupView = mountArticles($('view'), {client, userId:user.id, username:profile.username, notice, requireSession}); }
async function logs(){
 $('view').innerHTML='<div class="title"><div><h1>Логи</h1><p class="muted">Изменения задач и публикаций, записанные на сервере.</p></div></div><div class="audit-note">IP входов и полный журнал авторизации находятся в Supabase → Authentication → Logs. Браузер не может достоверно передать серверу IP.</div><div id="audit" class="audit-list">Загружаем…</div>';
 try { await requireSession(); const {data,error}=await client.from('audit_logs').select('id,actor_id,action,entity,entity_id,details,created_at').order('created_at',{ascending:false}).limit(300); if(error)throw error; const list=$('audit');list.replaceChildren(); if(!data?.length){list.textContent='Записей пока нет.';return;} data.forEach(item=>{const row=document.createElement('article');row.className='audit-row';const title=document.createElement('strong');title.textContent=`${item.action} · ${item.entity}`;const meta=document.createElement('small');meta.textContent=`${new Date(item.created_at).toLocaleString('ru-RU')} · ${item.actor_id||'система'}${item.entity_id?` · ${item.entity_id}`:''}`;const details=document.createElement('p');details.textContent=Object.entries(item.details||{}).map(([key,value])=>`${key}: ${String(value)}`).join(' · ');row.append(title,meta,details);list.append(row);}); } catch(error) { $('audit').textContent='Не удалось загрузить логи.'; notice('Не удалось загрузить логи. Проверь миграцию и права администратора.',true); }
}
function settings(){
 $('view').innerHTML=`<div class="title"><div><h1>Аккаунт</h1><p class="muted">${profile.must_change_password?'Для продолжения замени временный пароль.':'Здесь можно изменить пароль.'}</p></div></div><form id="avatar" class="panel narrow"><label>Аватарка<input name="file" type="file" accept="image/png,image/jpeg,image/webp,image/gif"><small>PNG, JPEG, WebP или GIF до 5 МБ.</small></label><p class="notice" role="status"></p></form><form id="password" class="panel narrow"><label>Текущий пароль<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>Новый пароль<input name="password" type="password" minlength="9" maxlength="128" autocomplete="new-password" required></label><label>Повтори новый пароль<input name="repeat" type="password" minlength="9" maxlength="128" autocomplete="new-password" required></label><small>От 9 до 128 символов.</small><button class="primary">Изменить пароль</button></form>`;
 $('avatar').elements.file.onchange=async()=>{const file=$('avatar').elements.file.files[0];if(!file)return;const status=$('avatar').querySelector('.notice');try{if(!/^image\/(png|jpeg|webp|gif)$/.test(file.type)||file.size>5*1024*1024)throw new Error('Выбери PNG, JPEG, WebP или GIF до 5 МБ.');const path=`${user.id}/avatar-${crypto.randomUUID()}`;const uploaded=await client.storage.from('article-media').upload(path,file,{contentType:file.type,upsert:true});if(uploaded.error)throw uploaded.error;const avatar=client.storage.from('article-media').getPublicUrl(path).data.publicUrl;const saved=await client.rpc('set_profile_avatar',{avatar});if(saved.error)throw saved.error;profile.avatar_url=avatar;status.textContent='Аватарка сохранена.';}catch(error){status.textContent=error.message||'Не удалось сохранить аватарку.';}finally{$('avatar').elements.file.value='';}};
 busy($('password'),async f=>{if(f.get('password')!==f.get('repeat'))throw new Error('Пароли не совпадают.');await action({action:'password',currentPassword:f.get('currentPassword'),password:f.get('password')});page='todos';await enter(user);notice('Пароль изменён.');});
}
async function adminPage(){
 const token=generation;
 $('view').innerHTML='<div class="title"><div><h1>Участники</h1><p class="muted">Создавай аккаунты и управляй доступом.</p></div></div><form id="create" class="panel"><h3>Новый участник</h3><label>Логин<input name="username" pattern="[a-z0-9_]{3,32}" required autocomplete="off" placeholder="a–z, 0–9, нижнее подчёркивание"></label><label>Временный пароль<input name="password" type="password" minlength="9" maxlength="128" required autocomplete="new-password"></label><button class="primary">Создать аккаунт</button></form><div class="section-heading"><h3>Аккаунты</h3></div><div id="users">Загружаем…</div>';
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
  const reportClientError=(message,context='window')=>{if(client)client.rpc('record_client_error',{error_message:String(message).slice(0,500),error_context:context}).catch(()=>{});};
  window.addEventListener('error',event=>reportClientError(event.message||'Неизвестная ошибка', 'window'));
  window.addEventListener('unhandledrejection',event=>reportClientError(event.reason?.message||event.reason||'Необработанное обещание', 'promise'));
  client.auth.onAuthStateChange((event,session)=>{setTimeout(()=>{if(event==='SIGNED_OUT'){clearTimeout(authTimer);login();}else if(session)scheduleSessionCheck(session);},0);});
  const checkWhenActive=()=>{if(document.visibilityState==='visible'&&user)requireSession().catch(()=>{});};
  document.addEventListener('visibilitychange',checkWhenActive);
  window.addEventListener('focus',checkWhenActive);
  root.innerHTML='<main class="login-card"><h1>helper ✳</h1><p>Открываем пространство…</p></main>';
  const publicSlug=publicArticleSlug();
  if(publicSlug){await renderPublicArticle(root,client,publicSlug);return;}
  const {data:{session}}=await client.auth.getSession();
  if(session){scheduleSessionCheck(session);const {data:{user:verified},error}=await client.auth.getUser();if(error || !verified){authMessage='Сессия истекла. Войди снова.';await client.auth.signOut({scope:'local'});login();}else await enter(verified);}else login();
 }catch{root.innerHTML='<main class="login-card"><h1>Не удалось открыть Helper</h1><p>Проверь подключение и разреши хранение данных сайта, затем обнови страницу.</p></main>';}
}
boot();
