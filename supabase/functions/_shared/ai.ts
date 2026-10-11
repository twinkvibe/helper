// Shared AI provider chain for Edge Functions.
// Tries providers and models in order, skips dead ones, throws when all fail.
// Pure dependency-free module: importable from Deno and from node tests.
// (Keep to erasable TypeScript syntax so node --test can import it directly.)

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};
export type ToolDef = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};
export type ToolCall = { id: string; name: string; args: Record<string, unknown> };
export type AiProvider = { name: string; baseUrl: string; apiKey: string; models: string[] };
export type AiChain = { providers: AiProvider[] };
export type AiAttempt = { provider: string; baseUrl: string; apiKey: string; model: string };
export type AiResult = { text: string; provider: string; model: string };
export type ChatOptions = {
  maxTokens?: number;
  temperature?: number;
  attemptTimeoutMs?: number;
  deadlineMs?: number;
};

const clean = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Parses the AI_CHAIN secret plus legacy single-provider vars into an ordered chain. */
export function parseChain(
  chainJson: string | null | undefined,
  legacy: { apiKey?: string | null; baseUrl?: string | null; model?: string | null } = {},
): AiChain {
  const providers: AiProvider[] = [];
  if (chainJson) {
    try {
      const parsed = JSON.parse(chainJson) as { providers?: unknown };
      const list = Array.isArray(parsed?.providers) ? parsed.providers : [];
      for (const item of list) {
        const record = item as Record<string, unknown>;
        const baseUrl = clean(record?.baseUrl).replace(/\/+$/, '');
        const apiKey = clean(record?.apiKey);
        const models = Array.isArray(record?.models)
          ? (record.models as unknown[]).map(clean).filter(Boolean)
          : [];
        if (!baseUrl || !apiKey || !models.length) continue;
        providers.push({ name: clean(record?.name) || baseUrl, baseUrl, apiKey, models });
      }
    } catch {
      /* malformed secret — fall through to legacy */
    }
  }
  const legacyKey = clean(legacy.apiKey);
  if (legacyKey) {
    providers.push({
      name: 'legacy',
      baseUrl: clean(legacy.baseUrl).replace(/\/+$/, '') || 'https://api.openai.com/v1',
      apiKey: legacyKey,
      models: [clean(legacy.model) || 'gpt-4o-mini'],
    });
  }
  return { providers };
}

/** Flattens the chain into an ordered attempt list: provider by provider, model by model. */
export function buildAttempts(chain: AiChain): AiAttempt[] {
  const attempts: AiAttempt[] = [];
  for (const provider of chain.providers || []) {
    for (const model of provider.models || []) {
      attempts.push({ provider: provider.name, baseUrl: provider.baseUrl, apiKey: provider.apiKey, model });
    }
  }
  return attempts;
}

type FetchImpl = (input: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

/** Runs the chain until the first usable answer. Throws Error('AI_UNAVAILABLE') when all fail. */
export async function chatComplete(
  chain: AiChain,
  messages: ChatMessage[],
  opts: ChatOptions = {},
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
): Promise<AiResult> {
  const raw = await chatCompleteRaw(chain, messages, opts, fetchImpl);
  if (!raw.content) {
    const error = new Error('AI_UNAVAILABLE') as Error & { status?: number };
    throw error;
  }
  return { text: raw.content, provider: raw.provider, model: raw.model };
}

type RawResult = { content: string; toolCalls: ToolCall[]; provider: string; model: string };

async function postAttempt(
  fetchImpl: FetchImpl,
  attempt: AiAttempt,
  payload: Record<string, unknown>,
  attemptTimeoutMs: number,
): Promise<{ status: number; data: unknown } | null> {
  try {
    const response = await fetchImpl(`${attempt.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${attempt.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(attemptTimeoutMs),
    } as Record<string, unknown>);
    if (!response.ok) return { status: response.status, data: null };
    return { status: 200, data: await response.json().catch(() => ({})) };
  } catch {
    return null;
  }
}

function readMessage(data: unknown): { content: string; toolCalls: ToolCall[] } {
  const message = (data as { choices?: Array<{ message?: Record<string, unknown> }> })
    ?.choices?.[0]?.message;
  const content = typeof message?.content === 'string' ? message.content.trim() : '';
  const toolCalls: ToolCall[] = [];
  const rawCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  for (const call of rawCalls as Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>) {
    const name = typeof call?.function?.name === 'string' ? call.function.name : '';
    if (!name) continue;
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(typeof call?.function?.arguments === 'string' ? call.function.arguments : '{}');
      if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
    } catch {
      /* broken args — pass empty object */
    }
    toolCalls.push({ id: typeof call?.id === 'string' ? call.id : '', name, args });
  }
  return { content, toolCalls };
}

/** Single pass over the chain, returns raw content plus any tool calls. */
export async function chatCompleteRaw(
  chain: AiChain,
  messages: ChatMessage[],
  opts: ChatOptions & { tools?: ToolDef[] } = {},
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
): Promise<RawResult> {
  const attempts = buildAttempts(chain);
  if (!attempts.length) throw new Error('AI_NOT_CONFIGURED');
  const maxTokens = opts.maxTokens ?? 900;
  const temperature = opts.temperature ?? 0.3;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? 15000;
  const deadline = Date.now() + (opts.deadlineMs ?? 55000);
  const payloadBase: Record<string, unknown> = {
    temperature,
    max_tokens: maxTokens,
    messages,
  };
  if (opts.tools?.length) payloadBase.tools = opts.tools;

  let index = 0;
  let lastStatus = 0;
  while (index < attempts.length) {
    if (Date.now() > deadline) break;
    const attempt = attempts[index];
    const result = await postAttempt(fetchImpl, attempt, { ...payloadBase, model: attempt.model }, attemptTimeoutMs);
    if (result && result.status === 200) {
      const { content, toolCalls } = readMessage(result.data);
      if (content || toolCalls.length) {
        return { content, toolCalls, provider: attempt.provider, model: attempt.model };
      }
    } else if (result) {
      lastStatus = result.status;
      // Bad key — don't waste time on the rest of this provider's models.
      if (result.status === 401 || result.status === 403) {
        const nextProvider = attempts.findIndex((a, i) => i > index && a.provider !== attempt.provider);
        index = nextProvider === -1 ? attempts.length : nextProvider;
        continue;
      }
    }
    index++;
  }
  const error = new Error('AI_UNAVAILABLE') as Error & { status?: number };
  if (lastStatus) error.status = lastStatus;
  throw error;
}

/** Marker key: a tool executor returns { [ASK_SUSPEND]: { question, options } }
 *  to pause the loop until the user answers via buttons (see quiz.ts). */
export const ASK_SUSPEND = '__ask_user_suspend';

export type AskSuspendRequest = {
  question: string;
  options: string[];
  allowCustom?: boolean;
};

export type SuspendedAsk = {
  suspended: true;
  question: string;
  options: string[];
  allowCustom: boolean;
  toolCallId: string;
  toolName: string;
  history: ChatMessage[];
};

/** Agentic loop: runs tool calls until the model answers with plain text.
 *  Returns SuspendedAsk when a tool asks the user a clarifying question —
 *  the caller persists history, collects the answer, appends it as the tool
 *  result message, and calls runToolLoop again to resume. */
export async function runToolLoop(
  chain: AiChain,
  messages: ChatMessage[],
  opts: ChatOptions & {
    tools: ToolDef[];
    execute: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    maxIterations?: number;
  },
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
): Promise<AiResult | SuspendedAsk> {
  const history: ChatMessage[] = [...messages];
  const maxIterations = opts.maxIterations ?? 6;
  let last: RawResult | null = null;
  for (let i = 0; i < maxIterations; i++) {
    const raw = await chatCompleteRaw(chain, history, opts, fetchImpl);
    last = raw;
    if (!raw.toolCalls.length) {
      if (raw.content) return { text: raw.content, provider: raw.provider, model: raw.model };
      break;
    }
    history.push({
      role: 'assistant',
      content: raw.content,
      tool_calls: raw.toolCalls.map(call => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    });
    for (const call of raw.toolCalls) {
      let result: unknown;
      try {
        result = await opts.execute(call.name, call.args);
      } catch (err) {
        result = { error: (err as Error)?.message || 'tool failed' };
      }
      const suspend = (result as Record<string, unknown> | null)?.[ASK_SUSPEND] as AskSuspendRequest | undefined;
      if (suspend && typeof suspend === 'object') {
        const options = Array.isArray(suspend.options)
          ? suspend.options.filter(o => typeof o === 'string').map(o => (o as string).trim()).filter(Boolean).slice(0, 4)
          : [];
        return {
          suspended: true,
          question: typeof suspend.question === 'string' ? suspend.question.slice(0, 500) : '',
          options,
          allowCustom: suspend.allowCustom !== false,
          toolCallId: call.id,
          toolName: call.name,
          history,
        };
      }
      history.push({
        role: 'tool',
        content: JSON.stringify(result).slice(0, 4000),
        tool_call_id: call.id,
      });
    }
  }
  if (last?.content) return { text: last.content, provider: last.provider, model: last.model };
  throw new Error('AI_UNAVAILABLE');
}
