import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChain, buildAttempts, chatComplete, runToolLoop } from '../supabase/functions/_shared/ai.ts';

const CHAIN_JSON = JSON.stringify({
  providers: [
    { name: 'agentrouter', baseUrl: 'https://agentrouter.org/v1/', apiKey: 'sk-test-1', models: ['deepseek-v4-flash'] },
    { name: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk-test-2', models: ['m1', 'm2'] },
    { name: 'broken', baseUrl: '', apiKey: 'x', models: ['m'] },
  ],
});

test('AI chain parses providers in order and skips incomplete entries', () => {
  const chain = parseChain(CHAIN_JSON, {});
  assert.equal(chain.providers.length, 2);
  assert.equal(chain.providers[0].name, 'agentrouter');
  assert.equal(chain.providers[0].baseUrl, 'https://agentrouter.org/v1');
  assert.deepEqual(buildAttempts(chain).map(a => `${a.provider}/${a.model}`), [
    'agentrouter/deepseek-v4-flash',
    'groq/m1',
    'groq/m2',
  ]);
});

test('AI chain appends legacy single-provider vars last', () => {
  const chain = parseChain('', { apiKey: 'sk-legacy', baseUrl: '', model: '' });
  assert.equal(chain.providers.length, 1);
  assert.equal(chain.providers[0].name, 'legacy');
  assert.equal(chain.providers[0].baseUrl, 'https://api.openai.com/v1');
  assert.deepEqual(chain.providers[0].models, ['gpt-4o-mini']);
});

test('AI chain with no secrets yields zero attempts', () => {
  assert.deepEqual(buildAttempts(parseChain('not-json', {})), []);
  assert.deepEqual(buildAttempts(parseChain('', {})), []);
});

function stubFetch(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => JSON.stringify(next.body),
      json: async () => next.body,
    };
  };
  return { fetch, calls };
}

test('AI chatComplete returns the first usable answer', async () => {
  const chain = parseChain(CHAIN_JSON, {});
  const { fetch, calls } = stubFetch([
    { status: 404, body: { error: 'nope' } },
    { status: 200, body: { choices: [{ message: { content: '  привет  ' } }] } },
  ]);
  const result = await chatComplete(chain, [{ role: 'user', content: 'ping' }], {}, fetch);
  assert.equal(result.text, 'привет');
  assert.equal(result.provider, 'groq');
  assert.equal(result.model, 'm1');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.model, 'deepseek-v4-flash');
  assert.match(calls[0].url, /agentrouter\.org\/v1\/chat\/completions/);
});

test('AI chatComplete skips the whole provider on 401', async () => {
  const chain = parseChain(JSON.stringify({
    providers: [
      { name: 'first', baseUrl: 'https://one.test', apiKey: 'k1', models: ['a', 'b'] },
      { name: 'second', baseUrl: 'https://two.test', apiKey: 'k2', models: ['c'] },
    ],
  }), {});
  const { fetch, calls } = stubFetch([
    { status: 401, body: { error: 'bad key' } },
    { status: 200, body: { choices: [{ message: { content: 'ok' } }] } },
  ]);
  const result = await chatComplete(chain, [{ role: 'user', content: 'ping' }], {}, fetch);
  assert.equal(result.provider, 'second');
  assert.equal(result.model, 'c');
  // 401 on first/a jumps straight to second — first/b must never be called.
  assert.deepEqual(calls.map(c => c.body.model), ['a', 'c']);
});

test('AI chatComplete throws AI_UNAVAILABLE when everything fails', async () => {
  const chain = parseChain(CHAIN_JSON, {});
  const { fetch } = stubFetch([
    new Error('down'),
    { status: 500, body: {} },
    { status: 200, body: { choices: [] } },
  ]);
  await assert.rejects(chatComplete(chain, [{ role: 'user', content: 'ping' }], { attemptTimeoutMs: 100 }, fetch), /AI_UNAVAILABLE/);
});

test('AI chatComplete throws AI_NOT_CONFIGURED without providers', async () => {
  await assert.rejects(chatComplete(parseChain('', {}), [], {}, async () => { throw new Error('must not fetch'); }), /AI_NOT_CONFIGURED/);
});

const SEARCH_TOOL = [{
  type: 'function',
  function: {
    name: 'dossier_search_people',
    description: 'search',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
}];

test('AI tool loop calls the executor and answers with dossier data', async () => {
  const chain = parseChain(JSON.stringify({
    providers: [{ name: 'p', baseUrl: 'https://ai.test', apiKey: 'k', models: ['m'] }],
  }), {});
  const bodies = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (bodies.length === 1) {
      return {
        ok: true, status: 200,
        text: async () => 't1', json: async () => ({ choices: [{ message: {
          content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'dossier_search_people', arguments: '{"query":"Руслан"}' } }],
        } }] }),
      };
    }
    return {
      ok: true, status: 200,
      text: async () => 't2', json: async () => ({ choices: [{ message: { content: 'Руслан — одногруппник.' } }] }),
    };
  };
  const calls = [];
  const result = await runToolLoop(
    chain,
    [{ role: 'user', content: 'что по Руслану' }],
    {
      tools: SEARCH_TOOL,
      execute: async (name, args) => { calls.push({ name, args }); return [{ name: 'Руслан' }]; },
    },
    fetch,
  );
  assert.equal(result.text, 'Руслан — одногруппник.');
  assert.deepEqual(calls, [{ name: 'dossier_search_people', args: { query: 'Руслан' } }]);
  assert.equal(bodies.length, 2);
  assert.ok(Array.isArray(bodies[0].tools), 'Tools must be sent to the model');
  assert.equal(bodies[1].messages.at(-1).role, 'tool');
  assert.match(bodies[1].messages.at(-1).content, /Руслан/);
});

test('AI tool loop suspends on ask_user and resumes after the answer', async () => {
  const chain = parseChain(JSON.stringify({
    providers: [{ name: 'p', baseUrl: 'https://ai.test', apiKey: 'k', models: ['m'] }],
  }), {});
  const ASK_TOOL = [{
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'ask',
      parameters: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question', 'options'] },
    },
  }];
  const bodies = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const hasToolResult = body.messages.some(m => m.role === 'tool');
    if (!hasToolResult) {
      return {
        ok: true, status: 200, text: async () => 't',
        json: async () => ({ choices: [{ message: {
          content: '',
          tool_calls: [{ id: 'a1', type: 'function', function: { name: 'ask_user', arguments: '{"question":"О ком речь?","options":["Руслан","Костя"]}' } }],
        } }] }),
      };
    }
    return {
      ok: true, status: 200, text: async () => 't',
      json: async () => ({ choices: [{ message: { content: 'Понял, смотрю Руслана.' } }] }),
    };
  };
  const execute = async (name) => {
    if (name === 'ask_user') {
      const { ASK_SUSPEND } = await import('../supabase/functions/_shared/ai.ts');
      return { [ASK_SUSPEND]: { question: 'О ком речь?', options: ['Руслан', 'Костя'] } };
    }
    throw new Error(`unexpected tool ${name}`);
  };
  const suspended = await runToolLoop(chain, [{ role: 'user', content: 'что по нему' }], { tools: ASK_TOOL, execute }, fetch);
  assert.equal(suspended.suspended, true);
  assert.equal(suspended.question, 'О ком речь?');
  assert.deepEqual(suspended.options, ['Руслан', 'Костя']);
  assert.equal(suspended.toolCallId, 'a1');
  assert.ok(Array.isArray(suspended.history));
  // Resume with the user's button answer.
  const resumed = await runToolLoop(chain, [
    ...suspended.history,
    { role: 'tool', content: '{"answer":"Руслан"}', tool_call_id: 'a1' },
  ], { tools: ASK_TOOL, execute }, fetch);
  assert.equal(resumed.text, 'Понял, смотрю Руслана.');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].messages.at(-1).role, 'tool');
  assert.match(bodies[1].messages.at(-1).content, /Руслан/);
});

test('AI tool loop surfaces executor errors to the model and still answers', async () => {
  const chain = parseChain(JSON.stringify({
    providers: [{ name: 'p', baseUrl: 'https://ai.test', apiKey: 'k', models: ['m'] }],
  }), {});
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (!body.messages.some(m => m.role === 'tool')) {
      return {
        ok: true, status: 200,
        text: async () => 't', json: async () => ({ choices: [{ message: {
          content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'nope', arguments: 'not-json' } }],
        } }] }),
      };
    }
    return {
      ok: true, status: 200,
      text: async () => 't', json: async () => ({ choices: [{ message: { content: 'Готово без инструментов.' } }] }),
    };
  };
  const seen = [];
  const result = await runToolLoop(
    chain, [{ role: 'user', content: 'привет' }],
    { tools: SEARCH_TOOL, execute: async (name) => { seen.push(name); throw new Error('boom'); } },
    fetch,
  );
  assert.equal(result.text, 'Готово без инструментов.');
  assert.deepEqual(seen, ['nope']);
});
