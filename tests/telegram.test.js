import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { verifyWebhook, chunkText, sendTelegram, markdownToTgHtml, escapeTgHtml } from '../supabase/functions/_shared/telegram.ts';
import { renderAsk, renderAskAnswered, truncateLabel, parseAskCallback, ASK_CUSTOM_LIMIT, ASK_MAX_OPTIONS } from '../supabase/functions/_shared/quiz.ts';

test('Telegram webhook secret accepts only the exact token', () => {
  assert.equal(verifyWebhook('secret-123', 'secret-123'), true);
  assert.equal(verifyWebhook('secret-123', 'secret-124'), false);
  assert.equal(verifyWebhook('secret-123', 'secret-1234'), false);
  assert.equal(verifyWebhook('secret-123', ''), false);
  assert.equal(verifyWebhook('secret-123', null), false);
  assert.equal(verifyWebhook('', 'anything'), false);
});

test('Telegram long messages split into 4096-char chunks', () => {
  assert.deepEqual(chunkText(''), ['']);
  assert.equal(chunkText('a'.repeat(4096)).length, 1);
  assert.equal(chunkText('a'.repeat(4097)).length, 2);
  assert.equal(chunkText('a'.repeat(9000)).length, 3);
});

test('Telegram sender posts every chunk and surfaces API errors', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => 'ok', json: async () => ({ ok: true }) };
  };
  await sendTelegram('tok', 123, 'b'.repeat(5000), { reply_markup: { inline_keyboard: [] } }, fetch);
  assert.equal(calls.length, 2);
  assert.ok(!('reply_markup' in calls[0]), 'Keyboard must ride on the last chunk only');
  assert.ok('reply_markup' in calls[1]);
  assert.equal(calls[0].chat_id, 123);

  const failing = async () => ({ ok: false, status: 429, text: async () => 'too many', json: async () => ({}) });
  await assert.rejects(sendTelegram('tok', 123, 'hi', {}, failing), /telegram 429/);
});

test('Telegram ask renders options in text and as one-button rows', () => {
  const ask = renderAsk('Что сделать?', ['Показать', 'Изменить', 'Удалить']);
  assert.match(ask.text, /Что сделать\?/);
  assert.match(ask.text, /1\. Показать/);
  assert.match(ask.text, /3\. Удалить/);
  // 3 options + custom variant row.
  assert.equal(ask.extra.reply_markup.inline_keyboard.length, 4);
  for (const row of ask.extra.reply_markup.inline_keyboard) {
    for (const button of row) {
      assert.ok(button.callback_data.length <= 64, 'Callback data must fit Telegram limits');
    }
  }
  assert.equal(ask.extra.reply_markup.inline_keyboard[0][0].callback_data, 'ask:0');
  assert.equal(ask.extra.reply_markup.inline_keyboard[3][0].callback_data, 'ask:c');
  const noCustom = renderAsk('Вопрос?', ['Да', 'Нет'], false);
  assert.equal(noCustom.extra.reply_markup.inline_keyboard.length, 2);
  assert.ok(noCustom.extra.reply_markup.inline_keyboard.flat().every(b => b.callback_data !== 'ask:c'));
});

test('Telegram ask truncates long labels and renders the answered state', () => {
  assert.equal(truncateLabel('  много   пробелов  '), 'много пробелов');
  const long = truncateLabel('я'.repeat(100));
  assert.ok(long.length <= ASK_CUSTOM_LIMIT);
  assert.match(long, /…$/);
  const done = renderAskAnswered('Что сделать?', ['Показать', 'Изменить'], 'Свой длинный вариант');
  assert.match(done.text, /→ Свой длинный вариант/);
  assert.ok(!('extra' in done), 'Answered state removes the keyboard');
});

test('Telegram ask callbacks parse strictly', () => {
  assert.deepEqual(parseAskCallback('ask:0'), { index: 0 });
  assert.deepEqual(parseAskCallback('ask:3'), { index: 3 });
  assert.deepEqual(parseAskCallback('ask:c'), { custom: true });
  assert.equal(parseAskCallback('ask:10'), null);
  assert.equal(parseAskCallback('ask:x'), null);
  assert.equal(parseAskCallback('q:rus-act:show'), null);
  assert.equal(parseAskCallback('done:123'), null);
  assert.equal(parseAskCallback(''), null);
  assert.ok(ASK_MAX_OPTIONS >= 2);
});

test('Telegram markdown converts to HTML and escapes the rest', () => {
  assert.equal(markdownToTgHtml('**Руслан** (b1kasuro)'), '<b>Руслан</b> (b1kasuro)');
  assert.match(markdownToTgHtml('- **Отношения:** Друг'), /<b>Отношения:<\/b> Друг/);
  assert.match(markdownToTgHtml('*курсив* и ~~зачёркнуто~~'), /<i>курсив<\/i> и <s>зачёркнуто<\/s>/);
  assert.match(markdownToTgHtml('`код` и\n```js\nalert(1)\n```'), /<code>код<\/code>.*<pre>alert\(1\)<\/pre>/s);
  assert.match(markdownToTgHtml('[Сайт](https://example.test/x?a=1&b=2)'), /<a href="https:\/\/example\.test\/x\?a=1&amp;b=2">Сайт<\/a>/);
  assert.match(markdownToTgHtml('# Заголовок'), /<b>Заголовок<\/b>/);
  // Escaping first: no tag injection, no broken entities.
  assert.equal(markdownToTgHtml('<script>alert(1)</script> & "кавычки"'), '&lt;script&gt;alert(1)&lt;/script&gt; &amp; "кавычки"');
  // Unbalanced markers stay literal and harmless.
  assert.equal(markdownToTgHtml('5 * 3 = 15 звёзд *'), '5 * 3 = 15 звёзд *');
  assert.equal(escapeTgHtml('a&b<c>d'), 'a&amp;b&lt;c&gt;d');
});

test('Telegram sender falls back to plain text on parse errors', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    if (calls.length === 1) {
      return { ok: false, status: 400, text: async () => `{"ok":false,"description":"Bad Request: can't parse entities"}`, json: async () => ({}) };
    }
    return { ok: true, status: 200, text: async () => 'ok', json: async () => ({ ok: true, result: { message_id: 7 } }) };
  };
  const ids = await sendTelegram('tok', 1, '<b>hi</b>', { parse_mode: 'HTML' }, fetch);
  assert.deepEqual(ids, [7]);
  assert.equal(calls[0].parse_mode, 'HTML');
  assert.ok(!('parse_mode' in calls[1]), 'Retry must go as plain text');
});

test('Telegram pending migration keeps quiz state owner-only', () => {
  const sql = fs.readFileSync(path.resolve('supabase/migrations/20260927_telegram_quiz.sql'), 'utf8');
  assert.match(sql, /alter table public\.telegram_pending enable row level security/);
  assert.match(sql, /revoke all on public\.telegram_pending from anon, authenticated/);
  assert.doesNotMatch(sql, /grant\s+\S+\s+on\s+\S+\s+to\s+anon/);
  assert.match(sql, /telegram_links l where l\.user_id/, 'Pending must be scoped through the linked chat');
  assert.match(sql, /not blocked and not must_change_password/);
});

test('DB schema: supabase/schema.sql is in sync with telegram quiz migration', () => {
  const schema = fs.readFileSync(path.resolve('supabase/schema.sql'), 'utf8');
  assert.match(schema, /create table public\.telegram_pending/);
  assert.match(schema, /Active users manage own telegram pending/);
});

test('Telegram migration keeps links and history owner-only', () => {
  const sql = fs.readFileSync(path.resolve('supabase/migrations/20260926_telegram.sql'), 'utf8');
  for (const table of ['telegram_links', 'telegram_history']) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`), `${table} must have RLS`);
    assert.match(sql, new RegExp(`revoke all on public\\.${table} from anon, authenticated`), `${table} must revoke anon`);
  }
  assert.doesNotMatch(sql, /grant\s+\S+\s+on\s+\S+\s+to\s+anon/, 'Telegram must never grant to anon');
  assert.match(sql, /code_hash/, 'Link code must be stored hashed, never plaintext');
  assert.doesNotMatch(sql, /code\s+text[^_]/, 'No plaintext code column allowed');
  assert.match(sql, /not blocked and not must_change_password/, 'Telegram RLS must check the active profile');
});

test('DB schema: supabase/schema.sql is in sync with telegram migration', () => {
  const schema = fs.readFileSync(path.resolve('supabase/schema.sql'), 'utf8');
  assert.match(schema, /create table public\.telegram_links/);
  assert.match(schema, /create table public\.telegram_history/);
  assert.match(schema, /Active users manage own telegram link/);
  assert.match(schema, /telegram_history_chat/);
});

test('Telegram function verifies webhook secret and never trusts client state', () => {
  const src = fs.readFileSync(path.resolve('supabase/functions/telegram/index.ts'), 'utf8');
  assert.match(src, /X-Telegram-Bot-Api-Secret-Token/, 'Must verify the Telegram secret header');
  assert.match(src, /verifyWebhook/, 'Must use the shared verifier');
  assert.match(src, /row\.user_id !== link\.user_id/, 'Task callbacks must verify ownership server-side');
  assert.match(src, /\.eq\('user_id', link\.user_id\)/, 'Queries must be scoped to the linked owner');
  assert.match(src, /runToolLoop/, 'AI chat must run the tool loop, not a bare completion');
  assert.match(src, /dossier_add_person/, 'AI must be able to add people');
  assert.match(src, /dossier_update_person/, 'AI must be able to edit people');
  assert.match(src, /ownedPerson/, 'Person tools must verify ownership server-side');
  assert.match(src, /ask_user/, 'AI must be able to ask clarifying questions');
  assert.match(src, /parseAskCallback/, 'Ask answers must arrive only via button callbacks');
  assert.match(src, /resumeAsk/, 'Suspended loops must resume after button answers');
  assert.doesNotMatch(src, /renderQuiz|parseQuizCallback|QUIZ_DEFS/, 'Demo quiz must be gone');
  assert.doesNotMatch(src, /bot\d{6,}:[A-Za-z0-9_-]{20,}/, 'Function source must not hardcode a bot token value');
});
