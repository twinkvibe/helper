import { attachEditor } from './editor.js';
import { renderMarkdown } from './security.js';
import { icon } from './icons.js';

const MAX_BODY = 5000000;
const slugify = value => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'article';
const date = value => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(value));
const excerpt = body => body.replace(/```[\s\S]*?```/g, '').replace(/[#>*_~`\[\]()|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);

export function articleHash(slug) { return `#article=${encodeURIComponent(slug)}`; }
export function publicArticleSlug(hash = location.hash) {
 const value = hash.match(/^#article=([^&]+)$/)?.[1];
 try { return value ? decodeURIComponent(value) : null; } catch { return null; }
}
export async function renderPublicArticle(host, client, slug) {
 host.innerHTML = '<main class="public-article loading"><a class="brand" href="./">h<span>elper</span><i>✳</i></a><p>Открываем публикацию…</p></main>';
 const { data, error } = await client.from('articles').select('title,slug,body,excerpt,cover_url,author_name,author_avatar_url,access,published_at,updated_at').eq('slug', slug).in('access', ['public','unlisted']).maybeSingle();
 if (error || !data) {
  host.innerHTML = '<main class="public-article missing"><a class="brand" href="./">h<span>elper</span><i>✳</i></a><h1>Публикация не найдена</h1><p class="muted">Возможно, ссылка устарела или статья стала черновиком.</p><a class="primary public-login" href="./">Войти в Helper</a></main>';
  return;
 }
 host.innerHTML = '<main class="public-article"><header class="public-header"><a class="brand" href="./">h<span>elper</span><i>✳</i></a><a class="quiet account-link" href="./">Войти</a></header><div class="article-cover article-cover-empty"></div><article class="article-paper"><header class="article-title"><h1></h1><div class="article-byline"></div></header><div class="article-body"></div></article></main>';
 const {data:{session}} = await client.auth.getSession();
 if (session) { const {data:me} = await client.from('profiles').select('username,avatar_url').eq('id',session.user.id).maybeSingle(); if (me) { const link=host.querySelector('.account-link'); link.textContent=`@${me.username}`; if(me.avatar_url){const avatar=document.createElement('img');avatar.className='account-avatar';avatar.src=me.avatar_url;avatar.alt='';avatar.referrerPolicy='no-referrer';link.prepend(avatar);} } }
 if (data.cover_url && /^https:\/\//i.test(data.cover_url)) { const image = document.createElement('img'); image.className='article-cover'; image.src=data.cover_url; image.alt=''; image.referrerPolicy='no-referrer'; host.querySelector('.article-cover').replaceWith(image); }
 host.querySelector('h1').textContent = data.title;
 const byline=host.querySelector('.article-byline'); byline.textContent=`@${data.author_name || 'автор'} · ${date(data.published_at)}`; if(data.author_avatar_url && /^https:\/\//i.test(data.author_avatar_url)){const avatar=document.createElement('img');avatar.className='article-author-avatar';avatar.src=data.author_avatar_url;avatar.alt='';avatar.referrerPolicy='no-referrer';byline.prepend(avatar);}
 host.querySelector('.article-body').innerHTML = renderMarkdown(data.body);
 host.querySelectorAll('.article-body pre > code[class*="language-"]').forEach(code=>{const language=code.className.match(/(?:^|\s)language-([\w+-]+)/)?.[1];if(!language)return;const label=document.createElement('span');label.className='code-language';label.textContent=language;code.parentElement.prepend(label);});
 host.querySelectorAll('.article-body input[type="checkbox"]').forEach(input=>{input.disabled=true;input.setAttribute('aria-disabled','true');});
 document.title = `${data.title} — helper`;
 [['og:title',data.title],['og:description',data.excerpt||excerpt(data.body)],['og:url',location.href],['twitter:title',data.title],['twitter:description',data.excerpt||excerpt(data.body)]].forEach(([property,content])=>{let meta=document.querySelector(`meta[property="${property}"],meta[name="${property}"]`);if(!meta){meta=document.createElement('meta');meta.setAttribute(property.startsWith('twitter:')?'name':'property',property);document.head.append(meta);}meta.content=content;});
 if (data.cover_url && /^https:\/\//i.test(data.cover_url)) { let meta=document.querySelector('meta[property="og:image"]');if(!meta){meta=document.createElement('meta');meta.setAttribute('property','og:image');document.head.append(meta);}meta.content=data.cover_url; }
}

export function mountArticles(host, { client, userId, username, notice, requireSession }) {
 let articles = [], selected = null, editor = null, alive = true;
 const uploadMedia = async file => {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 5 * 1024 * 1024) throw new Error('Выбери PNG, JPEG, WebP или GIF до 5 МБ.');
  const safe=file.name.toLowerCase().replace(/[^a-z0-9._-]+/g,'-'); const path=`${userId}/${crypto.randomUUID()}-${safe}`;
  const {error}=await client.storage.from('article-media').upload(path,file,{contentType:file.type,upsert:false}); if(error) throw new Error('Не удалось загрузить изображение. Примени миграцию хранилища.');
  return client.storage.from('article-media').getPublicUrl(path).data.publicUrl;
 };
 const save = async article => {
  await requireSession();
  const title = article.title.trim();
  if (!title) throw new Error('Добавь заголовок статьи.');
  if (article.body.length > MAX_BODY) throw new Error('Статья слишком большая (максимум 5 млн символов).');
  const payload = { title, slug: article.slug, body: article.body, excerpt: excerpt(article.body), cover_url: article.cover_url.trim() || null, access: article.access, published: article.access !== 'private', published_at: article.access !== 'private' ? (article.published_at || new Date().toISOString()) : null, author_name: username, updated_at:new Date().toISOString() };
  const query = article.id ? client.from('articles').update(payload).eq('id', article.id) : client.from('articles').insert({ ...payload, user_id: userId });
  const { data, error } = await query.select('*');
  if (error || !data?.[0]) throw new Error(error?.code === '23505' ? 'Такая ссылка уже занята — измени адрес.' : 'Не удалось сохранить статью. Проверь подключение.');
  const saved = data[0]; if(article.id) articles=articles.map(x=>x.id===saved.id?saved:x); else {Object.assign(article,saved);articles=[article,...articles.filter(x=>x!==article)];} selected = saved.id; return saved;
 };
 const copy = text => navigator.clipboard?.writeText(text).then(() => notice('Публичная ссылка скопирована.')).catch(() => notice(text));
 const refresh = async () => {
  await requireSession(); const { data, error } = await client.from('articles').select('*').order('updated_at', { ascending: false });
  if (error) throw new Error('Не удалось загрузить статьи. Проверь подключение.'); articles = data || []; render();
 };
 const render = () => {
  if (!alive) return; host.replaceChildren();
  const heading = document.createElement('div'); heading.className = 'work-heading'; heading.append(Object.assign(document.createElement('h1'), { textContent: 'Публикации' }));
  const create = document.createElement('button'); create.className = 'primary'; create.textContent = 'Новая статья'; create.prepend(icon('plus')); create.onclick = () => { const item = { id:null, title:'Без названия', slug:`${slugify('bez-nazvaniya')}-${Math.random().toString(36).slice(2,7)}`, body:'', excerpt:'', cover_url:'', access:'private', published:false }; articles.unshift(item); selected = null; edit(item); }; heading.append(create); host.append(heading);
  const layout = document.createElement('div'); layout.className = 'articles-layout'; const list = document.createElement('aside'); list.className = 'article-list'; const pane = document.createElement('section'); pane.className = 'article-pane'; layout.append(list, pane); host.append(layout);
  const add = article => { const b = document.createElement('button'); b.className = `article-list-item ${article.id === selected ? 'selected' : ''}`; b.innerHTML = `<strong></strong><small>${article.access === 'public' ? 'Общедоступно' : article.access === 'unlisted' ? 'По ссылке' : 'Приватно'}</small>`; b.querySelector('strong').textContent = article.title; b.onclick = () => { selected = article.id; edit(article); }; list.append(b); };
  articles.filter(x => x.id).forEach(add); if (!articles.some(x => x.id === selected)) { if (articles[0]?.id) { selected = articles[0].id; edit(articles[0]); } else pane.innerHTML = '<p class="empty">Создай статью: она будет черновиком, пока ты не опубликуешь её.</p>'; }
  function edit(article) {
   pane.replaceChildren(); const form = document.createElement('form'); form.className = 'article-form'; form.innerHTML = '<label>Заголовок<input name="title" maxlength="180" required></label><div class="article-fields"><label>Адрес статьи<input name="slug" maxlength="80" pattern="[a-z0-9а-яё-]+" required></label><label>Обложка<input name="cover" type="url" placeholder="HTTPS-ссылка или выбери файл"><input name="coverFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif"><img class="cover-preview" alt="" hidden><small class="cover-status"></small></label><label>Доступ<select name="access"><option value="private">Приватно</option><option value="unlisted">Только по ссылке</option><option value="public">Общедоступно</option></select></label></div><div class="article-editor"></div><div class="article-actions"><button class="quiet" type="button" data-copy>Скопировать ссылку</button><button class="primary" type="submit">Сохранить</button></div><p class="notice" role="status"></p>';
   form.elements.title.value = article.title; form.elements.slug.value = article.slug; form.elements.cover.value = article.cover_url || ''; form.elements.access.value = article.access || (article.published ? 'public' : 'private');
   const coverPreview=form.querySelector('.cover-preview'); if(article.cover_url){coverPreview.src=article.cover_url;coverPreview.hidden=false;}
   form.elements.coverFile.onchange=async()=>{const file=form.elements.coverFile.files[0];if(!file)return;const status=form.querySelector('.cover-status');status.textContent='Загружаем обложку…';try{form.elements.cover.value=await uploadMedia(file);coverPreview.src=form.elements.cover.value;coverPreview.hidden=false;status.textContent='Обложка загружена.';}catch(error){status.textContent=error.message;}finally{form.elements.coverFile.value='';}};
   editor = attachEditor(form.querySelector('.article-editor'), { value:article.body, singleBlock:true, onError:m => notice(m, true) });
   form.querySelector('[data-copy]').onclick = () => copy(new URL(articleHash(form.elements.slug.value.trim()), location.href).href);
   form.onsubmit = async event => { event.preventDefault(); const button=form.querySelector('[type=submit]'); button.disabled=true; const status=form.querySelector('.notice'); status.className='notice'; status.textContent='Сохраняем…'; try { article.title=form.elements.title.value; article.slug=slugify(form.elements.slug.value); article.cover_url=form.elements.cover.value; article.access=form.elements.access.value; article.body=editor.getValue(); await save(article); notice(article.access==='private' ? 'Приватная статья сохранена.' : 'Статья сохранена.'); status.textContent='Сохранено.'; } catch (error) { status.textContent=error?.message || 'Не удалось сохранить статью.'; status.classList.add('error'); } finally { button.disabled=false; } };
   pane.append(form);
  }
 };
 refresh().catch(error => { host.textContent = error.message; notice(error.message, true); });
 return () => { alive = false; return true; };
}
