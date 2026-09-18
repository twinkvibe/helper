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
 const { data, error } = await client.from('articles').select('title,slug,body,excerpt,cover_url,author_name,published_at,updated_at').eq('slug', slug).eq('published', true).maybeSingle();
 if (error || !data) {
  host.innerHTML = '<main class="public-article missing"><a class="brand" href="./">h<span>elper</span><i>✳</i></a><h1>Публикация не найдена</h1><p class="muted">Возможно, ссылка устарела или статья стала черновиком.</p><a class="primary public-login" href="./">Войти в Helper</a></main>';
  return;
 }
 host.innerHTML = '<main class="public-article"><header class="public-header"><a class="brand" href="./">h<span>elper</span><i>✳</i></a><a class="quiet" href="./">Войти</a></header><div class="article-cover article-cover-empty"></div><article class="article-paper"><p class="eyebrow"></p><h1></h1><div class="article-byline"></div><div class="article-body"></div></article></main>';
 if (data.cover_url && /^https:\/\//i.test(data.cover_url)) { const image = document.createElement('img'); image.className='article-cover'; image.src=data.cover_url; image.alt=''; image.referrerPolicy='no-referrer'; host.querySelector('.article-cover').replaceWith(image); }
 host.querySelector('.eyebrow').textContent = `ПУБЛИКАЦИЯ · ${date(data.published_at)}`;
 host.querySelector('h1').textContent = data.title;
 host.querySelector('.article-byline').textContent = data.author_name ? `Автор: ${data.author_name}` : '';
 host.querySelector('.article-body').innerHTML = renderMarkdown(data.body);
}

export function mountArticles(host, { client, userId, username, notice, requireSession }) {
 let articles = [], selected = null, editor = null, alive = true;
 const save = async article => {
  await requireSession();
  const title = article.title.trim();
  if (!title) throw new Error('Добавь заголовок статьи.');
  if (article.body.length > MAX_BODY) throw new Error('Статья слишком большая (максимум 5 млн символов).');
  const payload = { title, slug: article.slug, body: article.body, excerpt: excerpt(article.body), cover_url: article.cover_url.trim() || null, published: article.published, published_at: article.published ? (article.published_at || new Date().toISOString()) : null, author_name: username, updated_at:new Date().toISOString() };
  const query = article.id ? client.from('articles').update(payload).eq('id', article.id) : client.from('articles').insert({ ...payload, user_id: userId });
  const { data, error } = await query.select('*');
  if (error || !data?.[0]) throw new Error(error?.code === '23505' ? 'Такая ссылка уже занята — измени адрес.' : 'Не удалось сохранить статью. Проверь подключение.');
  const saved = data[0]; articles = article.id ? articles.map(x => x.id === saved.id ? saved : x) : [saved, ...articles]; selected = saved.id; return saved;
 };
 const copy = text => navigator.clipboard?.writeText(text).then(() => notice('Публичная ссылка скопирована.')).catch(() => notice(text));
 const refresh = async () => {
  await requireSession(); const { data, error } = await client.from('articles').select('*').order('updated_at', { ascending: false });
  if (error) throw new Error('Не удалось загрузить статьи. Проверь подключение.'); articles = data || []; render();
 };
 const render = () => {
  if (!alive) return; host.replaceChildren();
  const heading = document.createElement('div'); heading.className = 'work-heading'; heading.append(Object.assign(document.createElement('h1'), { textContent: 'Публикации' }));
  const create = document.createElement('button'); create.className = 'primary'; create.textContent = 'Новая статья'; create.prepend(icon('plus')); create.onclick = () => { const item = { id:null, title:'Без названия', slug:`${slugify('bez-nazvaniya')}-${Math.random().toString(36).slice(2,7)}`, body:'', excerpt:'', cover_url:'', published:false }; articles.unshift(item); selected = null; edit(item); }; heading.append(create); host.append(heading);
  const layout = document.createElement('div'); layout.className = 'articles-layout'; const list = document.createElement('aside'); list.className = 'article-list'; const pane = document.createElement('section'); pane.className = 'article-pane'; layout.append(list, pane); host.append(layout);
  const add = article => { const b = document.createElement('button'); b.className = `article-list-item ${article.id === selected ? 'selected' : ''}`; b.innerHTML = `<strong></strong><small>${article.published ? 'Опубликовано' : 'Черновик'}</small>`; b.querySelector('strong').textContent = article.title; b.onclick = () => { selected = article.id; edit(article); }; list.append(b); };
  articles.filter(x => x.id).forEach(add); if (!articles.some(x => x.id === selected)) { if (articles[0]?.id) { selected = articles[0].id; edit(articles[0]); } else pane.innerHTML = '<p class="empty">Создай статью: она будет черновиком, пока ты не опубликуешь её.</p>'; }
  function edit(article) {
   pane.replaceChildren(); const form = document.createElement('form'); form.className = 'article-form'; form.innerHTML = '<label>Заголовок<input name="title" maxlength="180" required></label><div class="article-fields"><label>Адрес статьи<input name="slug" maxlength="80" pattern="[a-z0-9а-яё-]+" required></label><label>Обложка (HTTPS URL)<input name="cover" type="url" placeholder="https://…"></label></div><div class="article-editor"></div><div class="article-actions"><label class="check"><input name="published" type="checkbox">Опубликовать и открыть всем по ссылке</label><button class="quiet" type="button" data-copy>Скопировать ссылку</button><button class="primary">Сохранить</button></div><p class="notice" role="status"></p>';
   form.elements.title.value = article.title; form.elements.slug.value = article.slug; form.elements.cover.value = article.cover_url || ''; form.elements.published.checked = article.published;
   editor = attachEditor(form.querySelector('.article-editor'), { value:article.body, onError:m => notice(m, true) });
   form.querySelector('[data-copy]').onclick = () => copy(new URL(articleHash(form.elements.slug.value.trim()), location.href).href);
   form.onsubmit = async event => { event.preventDefault(); const button=form.querySelector('[type=submit]'); button.disabled=true; try { article.title=form.elements.title.value; article.slug=slugify(form.elements.slug.value); article.cover_url=form.elements.cover.value; article.published=form.elements.published.checked; article.body=editor.getValue(); await save(article); notice(article.published ? 'Статья опубликована.' : 'Черновик сохранён.'); render(); } catch (error) { form.querySelector('.notice').textContent=error.message; form.querySelector('.notice').classList.add('error'); } finally { button.disabled=false; } };
   pane.append(form);
  }
 };
 refresh().catch(error => { host.textContent = error.message; notice(error.message, true); });
 return () => { alive = false; return true; };
}
