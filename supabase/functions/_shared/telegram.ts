// Minimal Telegram Bot API helpers for Edge Functions.
// Dependency-free and erasable-TypeScript so node --test can import it directly.

type FetchImpl = (input: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

/** Constant-time-ish comparison for the webhook secret header. */
export function verifyWebhook(secret: string, header: string | null | undefined): boolean {
  if (!secret || !header || header.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) {
    diff |= secret.charCodeAt(i) ^ header.charCodeAt(i);
  }
  return diff === 0;
}

/** Splits long text into Telegram-sized chunks (4096 chars). */
export function chunkText(text: string, limit = 4096): string[] {
  const source = String(text || '');
  if (!source) return [''];
  const chunks: string[] = [];
  for (let i = 0; i < source.length; i += limit) {
    chunks.push(source.slice(i, i + limit));
  }
  return chunks;
}

/** Sends a message; attaches inline keyboard to the last chunk only.
 *  Returns sent message IDs (needed to edit questions after answers).
 *  When parse_mode is set and Telegram rejects the markup, retries as plain text. */
export async function sendTelegram(
  token: string,
  chatId: number | string,
  text: string,
  extra: Record<string, unknown> = {},
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
): Promise<number[]> {
  const send = async (body: string, withMarkup: boolean): Promise<number[]> => {
    const ids: number[] = [];
    const chunks = chunkText(body);
    // On plain-text retry the markup flag must not leak back via extra.
    const extraPlain = { ...extra };
    if (!withMarkup) delete extraPlain.parse_mode;
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      const payload: Record<string, unknown> = { chat_id: chatId, text: chunks[i] };
      if (withMarkup) payload.parse_mode = 'HTML';
      if (last) Object.assign(payload, withMarkup ? extra : extraPlain);
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      } as Record<string, unknown>);
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        if (withMarkup && response.status === 400 && /can't parse/i.test(detail)) {
          return send(body, false);
        }
        throw new Error(`telegram ${response.status}: ${detail.slice(0, 120)}`);
      }
      try {
        const data = (await response.json()) as { result?: { message_id?: number } };
        if (typeof data?.result?.message_id === 'number') ids.push(data.result.message_id);
      } catch {
        /* id unknown — editing will fall back to a new message */
      }
    }
    return ids;
  };
  return send(text, Boolean((extra as Record<string, unknown>).parse_mode));
}

/** Escapes raw text for Telegram HTML messages. */
export function escapeTgHtml(text: string): string {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TG_PLACEHOLDER = '~TG~';

/** Converts Markdown to Telegram HTML. Only balanced markup converts;
 *  everything else stays literal (escaped), so output always parses. */
export function markdownToTgHtml(source: string): string {
  const stashed: string[] = [];
  const stash = (html: string): string => {
    stashed.push(html);
    return `${TG_PLACEHOLDER}${stashed.length - 1}${TG_PLACEHOLDER}`;
  };
  let text = String(source || '');
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_all, _lang, code) =>
    stash(`<pre>${escapeTgHtml(String(code).replace(/\n+$/, ''))}</pre>`));
  text = text.replace(/`([^`\n]+)`/g, (_all, code) => stash(`<code>${escapeTgHtml(code)}</code>`));
  text = escapeTgHtml(text);
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  text = text.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  text = text.replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*/g, '$1<i>$2</i>');
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  text = text.replace(new RegExp(`${TG_PLACEHOLDER}(\\d+)${TG_PLACEHOLDER}`, 'g'), (_all, i) => stashed[Number(i)] ?? '');
  return text;
}

/** Best-effort "typing…" indicator. Never throws. */
export async function sendTyping(
  token: string,
  chatId: number | string,
  fetchImpl: FetchImpl = fetch,
): Promise<void> {
  try {
    await fetchImpl(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    });
  } catch {
    /* indicator is cosmetic */
  }
}

export async function answerCallback(
  token: string,
  callbackId: string,
  text = '',
  fetchImpl: FetchImpl = fetch,
): Promise<void> {
  await fetchImpl(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, text: text.slice(0, 200) }),
  });
}

export async function editMessage(
  token: string,
  chatId: number | string,
  messageId: number,
  text: string,
  extra: Record<string, unknown> = {},
  fetchImpl: FetchImpl = fetch,
): Promise<void> {
  await fetchImpl(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: chunkText(text)[0], ...extra }),
  });
}
