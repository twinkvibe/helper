import { createClient } from 'npm:@supabase/supabase-js@2';
import { parseChain, runToolLoop, ASK_SUSPEND, type ChatMessage } from '../_shared/ai.ts';
import { sendTelegram, answerCallback, editMessage as edit, verifyWebhook, markdownToTgHtml, sendTyping } from '../_shared/telegram.ts';
import { renderAsk, renderAskAnswered, parseAskCallback } from '../_shared/quiz.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const ok = () => new Response(JSON.stringify({ ok: true }), {
  headers: { 'Content-Type': 'application/json' },
});

/** Единая отправка: Markdown конвертируется в Telegram HTML,
 *  при битой разметке sendTelegram сам падает обратно в plain text. */
async function say(
  token: string,
  chatId: number | string,
  markdown: string,
  extra: Record<string, unknown> = {},
): Promise<number[]> {
  return sendTelegram(token, chatId, markdownToTgHtml(markdown), { ...extra, parse_mode: 'HTML' });
}

const HELP = [
  'Команды:',
  '/tasks — открытые задачи (кнопки ✓ выполняют)',
  '/add текст — быстрая задача во Входящие',
  '/ask текст — спросить ИИ (помнит контекст беседы)',
  '/dossier имя — карточка человека и последние события',
  '/clear — очистить контекст беседы',
  '/cancel — отменить ожидание ответа',
  '/unlink — отвязать этот чат',
  '/help — эта справка',
  '',
  'Просто текст — тоже вопрос ИИ. Фото с подписью — запись в досье.',
  'Уточняющие вопросы я задаю сам — кнопками.',
].join('\n');

const str = (value: unknown, cap = 500): string =>
  typeof value === 'string' ? value.slice(0, cap) : '';
const strArray = (value: unknown, cap = 20): string[] =>
  Array.isArray(value) ? value.filter(v => typeof v === 'string').map(v => (v as string).slice(0, 120)).slice(0, cap) : [];

const AI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'dossier_list_people',
      description: 'Список всех людей в досье: id, имя, кто это, статус отношений.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dossier_search_people',
      description: 'Найти людей в досье по имени или псевдониму.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Имя или его часть' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dossier_get_person',
      description: 'Полная карточка человека: статусы, факты, заметки, связанные люди.',
      parameters: {
        type: 'object',
        properties: { person_id: { type: 'string', description: 'ID человека из поиска или списка' } },
        required: ['person_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dossier_person_entries',
      description: 'События человека: заголовки, даты, тексты. Новые сверху.',
      parameters: {
        type: 'object',
        properties: {
          person_id: { type: 'string' },
          limit: { type: 'number', description: 'Сколько событий, максимум 10' },
        },
        required: ['person_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dossier_add_person',
      description: 'Добавить нового человека в досье. Возвращает его ID.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          relation: { type: 'string', description: 'Кто это: одногруппник, сосед…' },
          relationship: { type: 'string', description: 'Статус отношений глазами владельца' },
          facts: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } } } },
          bio: { type: 'string', description: 'Заметки о человеке' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dossier_update_person',
      description: 'Изменить карточку человека. Неуказанные поля не меняются.',
      parameters: {
        type: 'object',
        properties: {
          person_id: { type: 'string' },
          name: { type: 'string' },
          relation: { type: 'string' },
          relationship: { type: 'string' },
          facts: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } } } },
          bio: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['person_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dossier_add_entry',
      description: 'Записать событие в досье и привязать участников по их ID.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string', description: 'Что произошло, факты и детали' },
          occurred_at: { type: 'string', description: 'Когда было, ISO-дата или пусто' },
          tags: { type: 'array', items: { type: 'string' } },
          person_ids: { type: 'array', items: { type: 'string' }, description: 'ID участников' },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tasks_list',
      description: 'Открытые задачи владельца.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Сколько, максимум 10' } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tasks_add',
      description: 'Добавить задачу во Входящие.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Задать пользователю уточняющий вопрос, когда без ответа неясно, что делать. Вопрос уходит кнопками, выполнение ждёт выбора. Используй, когда есть развилка: непонятно о ком/чём речь, какое действие выбрать, каких деталей не хватает.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Текст вопроса' },
          options: { type: 'array', items: { type: 'string' }, description: 'От 2 до 4 коротких вариантов ответа' },
          allow_custom: { type: 'boolean', description: 'Разрешить свой вариант текстом. По умолчанию true.' },
        },
        required: ['question', 'options'],
        additionalProperties: false,
      },
    },
  },
];

type Link = { user_id: string; chat_id: number };

async function getLink(chatId: number): Promise<Link | null> {
  const { data } = await admin.from('telegram_links').select('user_id,chat_id').eq('chat_id', chatId).maybeSingle();
  const row = data as { user_id?: string; chat_id?: number } | null;
  if (!row?.user_id) return null;
  return { user_id: row.user_id, chat_id: chatId };
}

function sha256hex(text: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(digest =>
    [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  );
}

async function aiChain() {
  return parseChain(Deno.env.get('AI_CHAIN'), {
    apiKey: Deno.env.get('AI_API_KEY'),
    baseUrl: Deno.env.get('AI_BASE_URL'),
    model: Deno.env.get('AI_MODEL'),
  });
}

async function loadHistory(userId: string, chatId: number, limit = 12) {
  const { data } = await admin
    .from('telegram_history')
    .select('role,text')
    .eq('user_id', userId)
    .eq('chat_id', chatId)
    .order('id', { ascending: false })
    .limit(limit);
  const rows = ((data || []) as Array<{ role: string; text: string }>).reverse();
  return rows
    .filter(r => (r.role === 'user' || r.role === 'assistant') && r.text)
    .map(r => ({ role: r.role as 'user' | 'assistant', content: r.text.slice(0, 2000) }));
}

async function saveHistory(userId: string, chatId: number, role: 'user' | 'assistant', text: string) {
  try {
    await admin.from('telegram_history').insert({ user_id: userId, chat_id: chatId, role, text: text.slice(0, 4000) });
    const { data } = await admin
      .from('telegram_history')
      .select('id')
      .eq('chat_id', chatId)
      .order('id', { ascending: false })
      .limit(100);
    const ids = ((data || []) as Array<{ id: number }>).map(r => r.id);
    if (ids.length > 30) {
      await admin.from('telegram_history').delete().in('id', ids.slice(30));
    }
  } catch (err) {
    console.error('history save failed:', err);
  }
}

function tasksMessage(tasks: Array<{ id: string; title: string }>) {
  if (!tasks.length) return { text: 'Открытых задач нет. /add текст — добавить.', extra: {} };
  const text = 'Открытые задачи:\n' + tasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
  const keyboard = tasks.map(t => [{ text: `✓ ${t.title.slice(0, 24)}`, callback_data: `done:${t.id}` }]);
  return { text, extra: { reply_markup: { inline_keyboard: keyboard } } };
}

async function sendTasks(token: string, link: Link) {
  const { data } = await admin
    .from('todos')
    .select('id,title')
    .eq('user_id', link.user_id)
    .eq('done', false)
    .order('created_at', { ascending: false })
    .limit(10);
  const msg = tasksMessage(((data || []) as Array<{ id: string; title: string }>));
  await say(token, link.chat_id, msg.text, msg.extra);
}

/** Карточка досье текстом. Возвращает false, если человек не найден. */
async function sendDossierCard(token: string, chatId: number, userId: string, query: string): Promise<boolean> {
  const cleanQuery = query.trim().slice(0, 120);
  if (!cleanQuery) {
    await say(token, chatId, 'Использование: /dossier Костя');
    return false;
  }
  const { data: people } = await admin
    .from('dossier_people')
    .select('id,name,relation,relationship,facts')
    .eq('user_id', userId)
    .ilike('name', `%${cleanQuery}%`)
    .limit(3);
  const found = ((people || []) as Array<Record<string, unknown>>)[0];
  if (!found) {
    await say(token, chatId, `Никого похожего на «${cleanQuery}» в досье нет.`);
    return false;
  }
  const lines = [`${found.name}`, found.relation ? `Кто: ${found.relation}` : '', found.relationship ? `Отношения: ${found.relationship}` : ''];
  const facts = Array.isArray(found.facts) ? (found.facts as Array<{ key?: string; value?: string }>).slice(0, 10) : [];
  for (const fact of facts) {
    if (fact?.key || fact?.value) lines.push(`• ${fact.key || '—'}: ${fact.value || '—'}`);
  }
  const { data: entries } = await admin
    .from('dossier_entries')
    .select('id,title,occurred_at')
    .eq('user_id', userId)
    .order('occurred_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(50);
  const { data: entryLinks } = await admin
    .from('dossier_entry_people')
    .select('entry_id')
    .eq('person_id', found.id as string);
  const linkedIds = new Set(((entryLinks || []) as Array<{ entry_id: string }>).map(r => r.entry_id));
  const recent = ((entries || []) as Array<{ id: string; title: string; occurred_at: string | null }>)
    .filter(e => linkedIds.has(e.id))
    .slice(0, 3);
  if (recent.length) {
    lines.push('', 'Последние события:');
    for (const e of recent) {
      const when = e.occurred_at ? new Date(e.occurred_at).toLocaleDateString('ru-RU') : '';
      lines.push(`• ${e.title}${when ? ` (${when})` : ''}`);
    }
  } else {
    lines.push('', 'Событий пока нет.');
  }
  await say(token, chatId, lines.filter(l => l !== '').join('\n'));
  return true;
}

async function handleCommand(token: string, link: Link, command: string, arg: string) {
  const chatId = link.chat_id;
  if (command === '/help' || command === '/start') {
    await say(token, chatId, HELP);
    return;
  }
  if (command === '/tasks') {
    await sendTasks(token, link);
    return;
  }
  if (command === '/add') {
    const title = arg.trim().slice(0, 500);
    if (!title) {
      await say(token, chatId, 'Использование: /add Купить молоко');
      return;
    }
    const { error } = await admin.from('todos').insert({ user_id: link.user_id, title, list_name: 'Входящие' });
    await say(token, chatId, error ? 'Не удалось добавить задачу.' : `✓ «${title}» — во Входящих.`);
    return;
  }
  if (command === '/unlink') {
    await admin.from('telegram_links').update({ chat_id: null }).eq('user_id', link.user_id);
    await say(token, chatId, 'Чат отвязан. Новый код — в разделе Аккаунт на сайте.');
    return;
  }
  if (command === '/dossier') {
    await sendDossierCard(token, chatId, link.user_id, arg);
    return;
  }
  if (command === '/clear') {
    await admin.from('telegram_history').delete().eq('user_id', link.user_id).eq('chat_id', chatId);
    await say(token, chatId, 'Контекст очищен 🧹 Начнём с чистого листа.');
    return;
  }
  if (command === '/cancel') {
    await clearPending(chatId);
    await say(token, chatId, 'Отменено.');
    return;
  }
  // /ask explicitly, or anything else falls through to free-text AI below.
  await handleAiChat(token, link, command === '/ask' ? arg : `${command} ${arg}`.trim());
}

async function ownedPerson(userId: string, personId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(personId)) return null;
  const { data } = await admin.from('dossier_people').select('*').eq('id', personId).maybeSingle();
  const row = data as Record<string, unknown> | null;
  if (!row || row.user_id !== userId) return null;
  return row;
}

/** Исполнитель инструментов ИИ. Все запросы строго в пределах владельца чата. */
async function executeTool(userId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const uid = (table: string) => admin.from(table);
  switch (name) {
    case 'dossier_list_people': {
      const { data } = await uid('dossier_people')
        .select('id,name,relation,relationship').eq('user_id', userId).order('name').limit(50);
      return data || [];
    }
    case 'dossier_search_people': {
      const query = str(args.query, 120);
      if (!query) return { error: 'пустой запрос' };
      const { data } = await uid('dossier_people')
        .select('id,name,aliases,relation,relationship').eq('user_id', userId).ilike('name', `%${query}%`).limit(10);
      return data || [];
    }
    case 'dossier_get_person': {
      const person = await ownedPerson(userId, str(args.person_id));
      if (!person) return { error: 'человек не найден' };
      const { data: links } = await uid('dossier_person_links').select('label,linked_person_id').eq('person_id', person.id as string);
      const linkedIds = ((links || []) as Array<{ linked_person_id: string; label: string }>).map(l => l.linked_person_id);
      let linkedNames: Array<{ name: unknown; label: string }> = [];
      if (linkedIds.length) {
        const { data: targets } = await uid('dossier_people').select('id,name').eq('user_id', userId).in('id', linkedIds);
        const byId = new Map(((targets || []) as Array<{ id: string; name: string }>).map(t => [t.id, t.name]));
        linkedNames = ((links || []) as Array<{ linked_person_id: string; label: string }>)
          .map(l => ({ name: byId.get(l.linked_person_id) || '?', label: l.label || '' }));
      }
      return { ...person, user_id: undefined, linked: linkedNames };
    }
    case 'dossier_person_entries': {
      const person = await ownedPerson(userId, str(args.person_id));
      if (!person) return { error: 'человек не найден' };
      const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
      const { data: entryLinks } = await uid('dossier_entry_people').select('entry_id').eq('person_id', person.id as string);
      const ids = ((entryLinks || []) as Array<{ entry_id: string }>).map(r => r.entry_id);
      if (!ids.length) return [];
      const { data: entries } = await uid('dossier_entries')
        .select('title,body,occurred_at,tags').eq('user_id', userId).in('id', ids)
        .order('occurred_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(limit);
      return ((entries || []) as Array<Record<string, unknown>>).map(e => ({
        ...e,
        body: typeof e.body === 'string' ? e.body.slice(0, 1500) : '',
      }));
    }
    case 'dossier_add_person': {
      const personName = str(args.name, 120).trim();
      if (!personName) return { error: 'нужно имя' };
      const facts = Array.isArray(args.facts)
        ? (args.facts as Array<{ key?: unknown; value?: unknown }>)
          .map(f => ({ key: str(f?.key, 60), value: str(f?.value, 500) }))
          .filter(f => f.key || f.value).slice(0, 30)
        : [];
      const { data, error } = await uid('dossier_people').insert({
        user_id: userId,
        name: personName,
        relation: str(args.relation, 120),
        relationship: str(args.relationship, 120),
        facts,
        bio: str(args.bio, 20000),
        tags: strArray(args.tags).map(t => t.replace(/^#+/, '').toLowerCase()),
      }).select('id').maybeSingle();
      if (error || !(data as { id?: string } | null)?.id) return { error: 'не удалось добавить' };
      return { id: (data as { id: string }).id, name: personName };
    }
    case 'dossier_update_person': {
      const person = await ownedPerson(userId, str(args.person_id));
      if (!person) return { error: 'человек не найден' };
      const patch: Record<string, unknown> = {};
      if (args.name !== undefined) {
        const personName = str(args.name, 120).trim();
        if (!personName) return { error: 'имя не может быть пустым' };
        patch.name = personName;
      }
      for (const field of ['relation', 'relationship', 'bio'] as const) {
        if (args[field] !== undefined) patch[field] = str(args[field], field === 'bio' ? 20000 : 120);
      }
      if (args.tags !== undefined) patch.tags = strArray(args.tags).map(t => t.replace(/^#+/, '').toLowerCase());
      if (args.facts !== undefined) {
        if (!Array.isArray(args.facts)) return { error: 'facts должен быть списком' };
        patch.facts = (args.facts as Array<{ key?: unknown; value?: unknown }>)
          .map(f => ({ key: str(f?.key, 60), value: str(f?.value, 500) }))
          .filter(f => f.key || f.value).slice(0, 30);
      }
      if (!Object.keys(patch).length) return { error: 'нечего менять' };
      const { error } = await uid('dossier_people').update(patch).eq('id', person.id as string);
      if (error) return { error: 'не удалось сохранить' };
      return { ok: true, updated: Object.keys(patch) };
    }
    case 'dossier_add_entry': {
      const title = str(args.title, 300).trim();
      if (!title) return { error: 'нужен заголовок' };
      let occurred: string | null = null;
      if (typeof args.occurred_at === 'string' && args.occurred_at) {
        const date = new Date(args.occurred_at);
        if (!Number.isNaN(date.getTime())) occurred = date.toISOString();
      }
      const entryId = crypto.randomUUID();
      const { error } = await uid('dossier_entries').insert({
        id: entryId,
        user_id: userId,
        title,
        body: str(args.body, 20000),
        occurred_at: occurred,
        tags: strArray(args.tags).map(t => t.replace(/^#+/, '').toLowerCase()),
        attachments: [],
      });
      if (error) return { error: 'не удалось записать событие' };
      const personIds = Array.isArray(args.person_ids) ? args.person_ids.filter(id => typeof id === 'string') : [];
      const verified: string[] = [];
      for (const id of personIds.slice(0, 10)) {
        if (await ownedPerson(userId, id)) verified.push(id);
      }
      if (verified.length) {
        await uid('dossier_entry_people').insert(
          verified.map(personId => ({ entry_id: entryId, person_id: personId, user_id: userId })),
        );
      }
      return { ok: true, id: entryId, linked_people: verified.length };
    }
    case 'tasks_list': {
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 10);
      const { data } = await uid('todos').select('id,title').eq('user_id', userId).eq('done', false)
        .order('created_at', { ascending: false }).limit(limit);
      return data || [];
    }
    case 'tasks_add': {
      const title = str(args.title, 500).trim();
      if (!title) return { error: 'нужен текст задачи' };
      const { error } = await uid('todos').insert({ user_id: userId, title, list_name: 'Входящие' });
      if (error) return { error: 'не удалось добавить' };
      return { ok: true, title };
    }
    case 'tasks_done': {
      const taskId = str(args.task_id);
      if (!/^[0-9a-f-]{36}$/i.test(taskId)) return { error: 'плохой id' };
      const { data: task } = await uid('todos').select('id,user_id').eq('id', taskId).maybeSingle();
      const row = task as { id?: string; user_id?: string } | null;
      if (!row?.id || row.user_id !== userId) return { error: 'задача не найдена' };
      await uid('todos').update({ done: true }).eq('id', taskId);
      return { ok: true };
    }
    default:
      return { error: `неизвестный инструмент ${name}` };
  }
}

type PendingRow = {
  chat_id: number;
  kind: string;
  qid: string;
  message_id: number;
  data: { apply?: string; person?: string; stage?: string; customLabel?: string };
};

async function getPending(chatId: number): Promise<PendingRow | null> {
  const { data } = await admin.from('telegram_pending').select('*').eq('chat_id', chatId).maybeSingle();
  const row = data as PendingRow | null;
  if (!row) return null;
  // Протухшее ожидание (старше часа) не поднимаем.
  if (row.created_at && Date.now() - new Date(String((row as unknown as Record<string, unknown>).created_at)).getTime() > 3600 * 1000) {
    await clearPending(chatId);
    return null;
  }
  return row;
}

async function setPending(chatId: number, row: { kind: string; qid: string; message_id: number; data: Record<string, unknown> }) {
  await admin.from('telegram_pending').upsert({ chat_id: chatId, ...row }, { onConflict: 'chat_id' });
}

async function clearPending(chatId: number) {
  await admin.from('telegram_pending').delete().eq('chat_id', chatId);
}

type AskPendingData = {
  history?: ChatMessage[];
  toolCallId?: string;
  toolName?: string;
  question?: string;
  options?: string[];
  allowCustom?: boolean;
  suspendCount?: number;
  stage?: string;
};

/** Продолжает диалог после ответа на уточняющий вопрос (или начинает новый). */
async function continueChat(
  token: string,
  link: Link,
  messages: ChatMessage[],
  suspendCount: number,
) {
  const chain = await aiChain();
  if (!chain.providers.length) {
    await say(token, link.chat_id, 'ИИ не настроен: задай секрет AI_CHAIN в настройках функции.');
    return;
  }
  await sendTyping(token, link.chat_id);
  const executor = async (toolName: string, toolArgs: Record<string, unknown>): Promise<unknown> => {
    if (toolName === 'ask_user') {
      if (suspendCount >= 2) {
        return { answer: 'Пользователь не выбрал вариант. Действуй по своему усмотрению.' };
      }
      const question = str(toolArgs.question, 500).trim();
      const options = Array.isArray(toolArgs.options)
        ? (toolArgs.options as unknown[]).filter(o => typeof o === 'string')
          .map(o => (o as string).trim()).filter(Boolean).slice(0, 4)
        : [];
      if (!question || options.length < 2) return { error: 'Нужен вопрос и 2-4 варианта ответа' };
      return { [ASK_SUSPEND]: { question, options, allowCustom: toolArgs.allow_custom !== false } };
    }
    return executeTool(link.user_id, toolName, toolArgs);
  };
  let answer;
  try {
    answer = await runToolLoop(chain, messages, {
      maxTokens: 900,
      temperature: 0.4,
      tools: AI_TOOLS,
      execute: executor,
    });
  } catch {
    await say(token, link.chat_id, '⚠️ Все ИИ-провайдеры недоступны. Попробуй позже.');
    return;
  }
  if ('suspended' in answer) {
    await setPending(link.chat_id, {
      kind: 'ask',
      qid: '',
      message_id: 0,
      data: {
        history: answer.history,
        toolCallId: answer.toolCallId,
        toolName: answer.toolName,
        question: answer.question,
        options: answer.options,
        allowCustom: answer.allowCustom,
        suspendCount: suspendCount + 1,
      },
    });
    const rendered = renderAsk(answer.question, answer.options, answer.allowCustom);
    const ids = await say(token, link.chat_id, rendered.text, rendered.extra);
    await admin.from('telegram_pending').update({ message_id: ids[0] || 0 }).eq('chat_id', link.chat_id);
    return;
  }
  await saveHistory(link.user_id, link.chat_id, 'assistant', answer.text);
  await say(token, link.chat_id, answer.text);
}

/** Возобновляет приостановленный цикл ответом пользователя. */
async function resumeAsk(
  token: string,
  link: Link,
  pending: PendingRow,
  messageId: number,
  answerLabel: string,
) {
  const data = (pending.data || {}) as AskPendingData;
  const history = Array.isArray(data.history) ? data.history : [];
  const resumed: ChatMessage[] = [
    ...history,
    {
      role: 'tool',
      content: JSON.stringify({ answer: answerLabel }).slice(0, 4000),
      tool_call_id: String(data.toolCallId || ''),
    },
  ];
  await clearPending(link.chat_id);
  if (messageId) {
    try {
      await edit(token, link.chat_id, messageId, markdownToTgHtml(renderAskAnswered(
        String(data.question || 'Вопрос'),
        Array.isArray(data.options) ? data.options : [],
        answerLabel,
      ).text), { parse_mode: 'HTML' });
    } catch {
      /* сообщение уже не правится — ответ уйдёт новым */
    }
  }
  await continueChat(token, link, resumed, Number(data.suspendCount) || 0);
}

/** Кнопки уточняющего вопроса ask:<index> / ask:c. Отвечать можно только кнопкой. */
async function handleAskCallback(
  token: string,
  link: Link,
  callbackId: string,
  messageId: number,
  parsed: { index: number } | { custom: true },
) {
  const chatId = link.chat_id;
  const pending = await getPending(chatId);
  const data = (pending?.data || {}) as AskPendingData;
  if (!pending || pending.kind !== 'ask' || !Array.isArray(data.history)) {
    await answerCallback(token, callbackId, 'Вопрос протух. Спроси ещё раз.');
    return;
  }
  if ('custom' in parsed) {
    if (data.allowCustom === false) {
      await answerCallback(token, callbackId, 'Свой вариант здесь недоступен.');
      return;
    }
    await admin.from('telegram_pending').update({
      data: { ...data, stage: 'await_text' },
    }).eq('chat_id', chatId);
    await answerCallback(token, callbackId, '');
    await say(token, chatId, 'Напиши свой вариант одним сообщением (или /cancel).');
    return;
  }
  const options = Array.isArray(data.options) ? data.options : [];
  const answerLabel = options[parsed.index];
  if (answerLabel === undefined) {
    await answerCallback(token, callbackId, 'Нет такого варианта.');
    return;
  }
  await answerCallback(token, callbackId, '');
  await resumeAsk(token, link, pending, messageId, answerLabel);
}

/** Свободный текст в ответ на вопрос (только после кнопки «Свой вариант»). */
async function handleAskText(token: string, link: Link, pending: PendingRow, text: string) {
  const data = (pending.data || {}) as AskPendingData;
  if (data.stage !== 'await_text') {
    await clearPending(link.chat_id);
    return;
  }
  const label = text.trim().slice(0, 200);
  if (!label) {
    await say(token, link.chat_id, 'Пустое сообщение. Напиши вариант текстом или /cancel.');
    return;
  }
  await resumeAsk(token, link, pending, pending.message_id, label);
}

async function handleAiChat(token: string, link: Link, text: string) {
  const input = text.trim().slice(0, 3000);
  if (!input) {
    await say(token, link.chat_id, 'Пустое сообщение. /help — список команд.');
    return;
  }
  const history = await loadHistory(link.user_id, link.chat_id);
  await saveHistory(link.user_id, link.chat_id, 'user', input);
  await continueChat(token, link, [
    {
      role: 'system',
      content: [
        'Ты помощник личного пространства helper. Отвечай по-русски, кратко и по делу.',
        'У тебя есть инструменты: читай досье (люди, события, факты), добавляй и правь записи, веди задачи.',
        'Когда спрашивают про человека или событие — сначала ищи в досье, не гадай.',
        'Если человека нет в досье — так и скажи и предложи добавить.',
        'После изменений кратко перечисли, что сделал.',
        'Если для ответа нужна развилка — вызывай ask_user: вопрос уйдёт кнопками, выполнение продолжится после выбора.',
        'Не проси писать ответы обычным текстом, если есть ask_user.',
      ].join(' '),
    },
    ...history,
    { role: 'user', content: input },
  ], 0);
}

async function handlePhoto(token: string, link: Link, photos: Array<{ file_id: string; file_size?: number }>, caption: string) {
  const biggest = [...photos].sort((a, b) => (b.file_size || 0) - (a.file_size || 0))[0];
  if (!biggest) return;
  if ((biggest.file_size || 0) > 5 * 1024 * 1024) {
    await say(token, link.chat_id, 'Фото больше 5 МБ — сожми и пришли ещё раз.');
    return;
  }
  try {
    const metaRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${biggest.file_id}`);
    const meta = (await metaRes.json()) as { ok?: boolean; result?: { file_path?: string } };
    const filePath = meta?.result?.file_path;
    if (!filePath) throw new Error('no file_path');
    const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!fileRes.ok) throw new Error(`download ${fileRes.status}`);
    const bytes = new Uint8Array(await fileRes.arrayBuffer());
    const entryId = crypto.randomUUID();
    const storagePath = `${link.user_id}/telegram/${entryId}/${biggest.file_id}.jpg`;
    const { error: uploadError } = await admin.storage.from('dossier-media').upload(storagePath, bytes, {
      contentType: 'image/jpeg',
      upsert: false,
    });
    if (uploadError) throw uploadError;
    const title = (caption.trim().split('\n')[0] || 'Фото из Telegram').slice(0, 300);
    const { error: insertError } = await admin.from('dossier_entries').insert({
      id: entryId,
      user_id: link.user_id,
      title,
      body: caption.trim().slice(0, 20000),
      attachments: [{ path: storagePath, name: 'Фото из Telegram', type: 'image/jpeg', size: bytes.length }],
    });
    if (insertError) throw insertError;
    await say(token, link.chat_id, `✓ Сохранено в досье: «${title}». Участников добавь на сайте.`);
  } catch (err) {
    console.error('photo save failed:', err);
    await say(token, link.chat_id, 'Не удалось сохранить фото в досье.');
  }
}

async function handleCallback(token: string, callback: {
  id: string; data?: string; message?: { message_id?: number };
  from?: { id?: number };
}) {
  const chatId = (callback.from?.id ?? 0) as number;
  const messageId = callback.message?.message_id;
  const data = callback.data || '';
  const link = await getLink(chatId);
  if (!link) {
    await answerCallback(token, callback.id, 'Чат не привязан.');
    return;
  }
  const ask = parseAskCallback(data);
  if (ask) {
    if (!messageId) {
      await answerCallback(token, callback.id, 'Кнопка без сообщения.');
      return;
    }
    if ('custom' in ask) {
      const pending = await getPending(chatId);
      const pdata = (pending?.data || {}) as { allowCustom?: boolean };
      if (!pending || pending.kind !== 'ask') {
        await answerCallback(token, callback.id, 'Вопрос протух. Спроси ещё раз.');
        return;
      }
      if (pdata.allowCustom === false) {
        await answerCallback(token, callback.id, 'Свой вариант здесь недоступен.');
        return;
      }
      await admin.from('telegram_pending').update({
        data: { ...(pdata as Record<string, unknown>), stage: 'await_text' },
      }).eq('chat_id', chatId);
      await answerCallback(token, callback.id, '');
      await say(token, chatId, 'Напиши свой вариант одним сообщением (или /cancel).');
      return;
    }
    await handleAskCallback(token, link, callback.id, messageId, ask);
    return;
  }
  const match = data.match(/^done:([0-9a-f-]{36})$/i);
  if (!match || !messageId) {
    await answerCallback(token, callback.id, 'Неизвестная кнопка.');
    return;
  }
  const { data: task } = await admin.from('todos').select('id,user_id,title').eq('id', match[1]).maybeSingle();
  const row = task as { id?: string; user_id?: string; title?: string } | null;
  if (!row?.id || row.user_id !== link.user_id) {
    await answerCallback(token, callback.id, 'Задача не найдена.');
    return;
  }
  // Re-read done state to toggle honestly (double-tap = back to open).
  const { data: fresh } = await admin.from('todos').select('done').eq('id', row.id).maybeSingle();
  const done = !(fresh as { done?: boolean } | null)?.done;
  await admin.from('todos').update({ done }).eq('id', row.id);
  await answerCallback(token, callback.id, done ? 'Выполнено ✓' : 'Снова открыта');
  try {
    const { data } = await admin
      .from('todos')
      .select('id,title')
      .eq('user_id', link.user_id)
      .eq('done', false)
      .order('created_at', { ascending: false })
      .limit(10);
    const msg = tasksMessage(((data || []) as Array<{ id: string; title: string }>));
    await edit(token, chatId, messageId, msg.text, msg.extra);
  } catch (err) {
    console.error('task list refresh failed:', err);
  }
}

async function handleUpdate(update: {
  message?: {
    chat?: { id?: number };
    text?: string;
    caption?: string;
    photo?: Array<{ file_id: string; file_size?: number }>;
  };
  callback_query?: { id: string; data?: string; message?: { message_id?: number }; from?: { id?: number } };
}, token: string) {
  if (update.callback_query) {
    await handleCallback(token, update.callback_query);
    return;
  }
  const message = update.message;
  const chatId = message?.chat?.id;
  if (!chatId) return;

  const link = await getLink(chatId);
  const rawText = (message?.text || '').trim();

  if (!link) {
    const startMatch = rawText.match(/^\/start\s+(\d{6})\s*$/);
    if (startMatch) {
      const hash = await sha256hex(startMatch[1]);
      const { data } = await admin
        .from('telegram_links')
        .select('user_id,code_expires')
        .eq('code_hash', hash)
        .is('chat_id', null)
        .maybeSingle();
      const row = data as { user_id?: string; code_expires?: string } | null;
      if (row?.user_id && row.code_expires && new Date(row.code_expires).getTime() > Date.now()) {
        await admin.from('telegram_links')
          .update({ chat_id: chatId, code_hash: null, code_expires: null })
          .eq('user_id', row.user_id);
        await say(token, chatId, `Готово, чат привязан. ${HELP}`);
      } else {
        await say(token, chatId, 'Код неверный или истёк (живёт 10 минут). Получи новый в разделе Аккаунт на сайте.');
      }
    } else {
      await say(token, chatId, 'Привет! Привяжи аккаунт: получи код в разделе Аккаунт на сайте и отправь /start 123456');
    }
    return;
  }

  if (message?.photo?.length) {
    await handlePhoto(token, link, message.photo, message.caption || '');
    return;
  }
  if (!rawText) return;

  const space = rawText.indexOf(' ');
  const command = (space === -1 ? rawText : rawText.slice(0, space)).split('@')[0];
  const arg = space === -1 ? '' : rawText.slice(space + 1);
  if (command.startsWith('/')) {
    // Команда отменяет ожидание ответа на вопрос.
    await clearPending(chatId);
    await handleCommand(token, link, command, arg);
    return;
  }
  const pending = await getPending(chatId);
  if (pending && pending.kind === 'ask' && (pending.data as { stage?: string } | null)?.stage === 'await_text') {
    await handleAskText(token, link, pending, rawText.slice(0, 2000));
    return;
  }
  if (pending) await clearPending(chatId);
  await handleAiChat(token, link, rawText.slice(0, 3000));
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return ok();
  const secret = Deno.env.get('WEBHOOK_SECRET') || '';
  if (!verifyWebhook(secret, req.headers.get('X-Telegram-Bot-Api-Secret-Token'))) {
    return new Response('forbidden', { status: 403 });
  }
  const token = Deno.env.get('BOT_TOKEN') || '';
  if (!token) return ok();
  let update: Parameters<typeof handleUpdate>[0];
  try {
    update = await req.json();
  } catch {
    return ok();
  }
  try {
    await handleUpdate(update, token);
  } catch (err) {
    console.error('telegram update failed:', err);
  }
  return ok();
});
