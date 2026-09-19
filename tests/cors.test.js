import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ALLOWED_ORIGINS,
  normalizeOrigin,
  isAllowedOrigin,
  getCorsHeaders,
  handleCorsPreflight,
  createCorsResponse,
} from '../supabase/functions/account/cors.ts';

test('CORS: allowed origin set contains custom production domain, legacy pages, and localhost', () => {
  assert.ok(ALLOWED_ORIGINS.has('https://helper.slutvibe.site'), 'helper.slutvibe.site must be allowed');
  assert.ok(ALLOWED_ORIGINS.has('https://twinkvibe.github.io'), 'twinkvibe.github.io must be allowed');
  assert.ok(ALLOWED_ORIGINS.has('http://127.0.0.1:5173'), '127.0.0.1:5173 must be allowed');
  assert.ok(ALLOWED_ORIGINS.has('http://127.0.0.1:4173'), '127.0.0.1:4173 must be allowed');
  assert.ok(ALLOWED_ORIGINS.has('http://localhost:5173'), 'localhost:5173 must be allowed');
  assert.ok(ALLOWED_ORIGINS.has('http://localhost:4173'), 'localhost:4173 must be allowed');
});

test('CORS: isAllowedOrigin validates allowed origins and rejects unknown or malicious origins', () => {
  // Accepted origins
  assert.equal(isAllowedOrigin('https://helper.slutvibe.site'), true);
  assert.equal(isAllowedOrigin('https://helper.slutvibe.site/'), true);
  assert.equal(isAllowedOrigin('https://twinkvibe.github.io'), true);
  assert.equal(isAllowedOrigin('https://twinkvibe.github.io/'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:5173'), true);
  assert.equal(isAllowedOrigin('http://localhost:5173'), true);

  // Rejected unknown origins
  assert.equal(isAllowedOrigin('https://evil.test'), false);
  assert.equal(isAllowedOrigin('http://localhost:3000'), false);
  assert.equal(isAllowedOrigin('https://twinkvibe.github.io.evil.test'), false);
  assert.equal(isAllowedOrigin('https://helper.slutvibe.site.attacker.test'), false);
  assert.equal(isAllowedOrigin(''), false);
  assert.equal(isAllowedOrigin(null), false);
  assert.equal(isAllowedOrigin(undefined), false);
});

test('CORS: OPTIONS preflight returns 204 with correct ACAO for allowed origins', () => {
  const checkPreflight = (origin) => {
    const req = new Request('https://api.supabase.co/functions/v1/account', {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, apikey, content-type',
      },
    });
    const res = handleCorsPreflight(req);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), normalizeOrigin(origin));
    assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
    assert.match(res.headers.get('Access-Control-Allow-Headers') || '', /authorization/);
    assert.match(res.headers.get('Access-Control-Allow-Headers') || '', /apikey/);
    assert.equal(res.headers.get('Vary'), 'Origin');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  };

  checkPreflight('https://helper.slutvibe.site');
  checkPreflight('https://twinkvibe.github.io');
  checkPreflight('http://127.0.0.1:5173');
  checkPreflight('http://localhost:5173');
});

test('CORS: OPTIONS preflight rejects unknown origin with 403 and without spoofing ACAO', async () => {
  const req = new Request('https://api.supabase.co/functions/v1/account', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://evil.test',
      'access-control-request-method': 'POST',
    },
  });
  const res = handleCorsPreflight(req);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null, 'Must NOT emit ACAO for unknown origin');
  assert.equal(res.headers.get('Vary'), 'Origin');
  const data = await res.json();
  assert.equal(data.error, 'Origin not allowed');
});

test('CORS: OPTIONS preflight rejects missing origin with 403 without ACAO', () => {
  const req = new Request('https://api.supabase.co/functions/v1/account', {
    method: 'OPTIONS',
  });
  const res = handleCorsPreflight(req);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
});

test('CORS: POST response sets correct ACAO for allowed origins and omits for unknown origins', () => {
  // Allowed custom domain
  const resCustom = createCorsResponse(200, { ok: true }, 'https://helper.slutvibe.site');
  assert.equal(resCustom.headers.get('Access-Control-Allow-Origin'), 'https://helper.slutvibe.site');
  assert.equal(resCustom.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
  assert.equal(resCustom.headers.get('Vary'), 'Origin');

  // Allowed legacy github pages
  const resPages = createCorsResponse(200, { ok: true }, 'https://twinkvibe.github.io');
  assert.equal(resPages.headers.get('Access-Control-Allow-Origin'), 'https://twinkvibe.github.io');

  // Allowed localhost
  const resLocal = createCorsResponse(200, { ok: true }, 'http://127.0.0.1:5173');
  assert.equal(resLocal.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:5173');

  // Unknown origin: MUST NOT emit ACAO, and MUST NOT fallback to twinkvibe.github.io
  const resEvil = createCorsResponse(403, { error: 'Origin not allowed' }, 'https://evil.test');
  assert.equal(resEvil.headers.get('Access-Control-Allow-Origin'), null, 'Must not emit ACAO for unknown origin');

  // Empty origin (non-browser or server call)
  const resNone = createCorsResponse(200, { ok: true }, '');
  assert.equal(resNone.headers.get('Access-Control-Allow-Origin'), null, 'Must not emit ACAO when origin is empty');
});

test('CORS: source code invariants guarantee no wildcard ACAO and no fallback spoofing', () => {
  const corsSrc = fs.readFileSync(path.resolve('supabase/functions/account/cors.ts'), 'utf-8');
  const indexSrc = fs.readFileSync(path.resolve('supabase/functions/account/index.ts'), 'utf-8');

  // No wildcard
  assert.doesNotMatch(corsSrc, /Access-Control-Allow-Origin['"]?\s*:\s*['"]\*/, 'Wildcard ACAO is forbidden');
  assert.doesNotMatch(indexSrc, /Access-Control-Allow-Origin['"]?\s*:\s*['"]\*/, 'Wildcard ACAO is forbidden');

  // No fallback to twinkvibe.github.io
  assert.doesNotMatch(corsSrc, /:\s*['"]https:\/\/twinkvibe\.github\.io['"]/, 'No fallback to twinkvibe.github.io allowed');
  assert.doesNotMatch(indexSrc, /:\s*['"]https:\/\/twinkvibe\.github\.io['"]/, 'No fallback to twinkvibe.github.io allowed');

  // helper.slutvibe.site is explicitly in cors source
  assert.match(corsSrc, /https:\/\/helper\.slutvibe\.site/);
});
