// Agent clarifying questions: the model asks, the user answers ONLY via inline
// buttons (options are also listed in the message text, but tapping a button
// is the only way to answer). Custom free text goes through a "Свой вариант"
// button first, then a confirmation tap.
// Dependency-free and erasable-TypeScript so node --test can import it directly.

export const ASK_CUSTOM_LIMIT = 40;
export const ASK_MAX_OPTIONS = 4;

/** Shortens free text into a button label. */
export function truncateLabel(text: string, limit = ASK_CUSTOM_LIMIT): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  return clean.slice(0, limit - 1).trimEnd() + '…';
}

export type AskRender = {
  text: string;
  extra: { reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } };
};

/** Renders a clarifying question: numbered options in text + one button per row. */
export function renderAsk(question: string, options: string[], allowCustom = true): AskRender {
  const cleanQuestion = String(question || '').trim().slice(0, 500) || 'Уточни, пожалуйста:';
  const cleanOptions = (options || []).map(o => String(o || '').trim()).filter(Boolean).slice(0, ASK_MAX_OPTIONS);
  const numbered = cleanOptions.map((option, i) => `${i + 1}. ${option}`).join('\n');
  const text = numbered ? `${cleanQuestion}\n${numbered}` : cleanQuestion;
  const rows = cleanOptions.map((option, i) => [{ text: truncateLabel(option), callback_data: `ask:${i}` }]);
  if (allowCustom) {
    rows.push([{ text: 'Свой вариант', callback_data: 'ask:c' }]);
  }
  return { text, extra: { reply_markup: { inline_keyboard: rows } } };
}

/** Renders the answered state: chosen option appended, keyboard removed. */
export function renderAskAnswered(question: string, options: string[], answerLabel: string): { text: string } {
  const numbered = (options || []).map((option, i) => `${i + 1}. ${option}`).join('\n');
  const base = numbered ? `${question}\n${numbered}` : question;
  return { text: `${base}\n→ ${answerLabel}` };
}

/** Parses ask callbacks: ask:<option index> or ask:c (custom). */
export function parseAskCallback(data: string): { index: number } | { custom: true } | null {
  const match = /^ask:([0-9]|c)$/.exec(String(data || ''));
  if (!match) return null;
  if (match[1] === 'c') return { custom: true };
  return { index: Number(match[1]) };
}
