export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  'https://helper.slutvibe.site',
  'https://twinkvibe.github.io',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
  'http://localhost:5173',
  'http://localhost:4173',
]);

export function normalizeOrigin(origin?: string | null): string {
  if (!origin) return '';
  return origin.trim().replace(/\/+$/, '');
}

export function isAllowedOrigin(origin?: string | null): boolean {
  const norm = normalizeOrigin(origin);
  return norm !== '' && ALLOWED_ORIGINS.has(norm);
}

export function getCorsHeaders(origin?: string | null): Record<string, string> {
  const norm = normalizeOrigin(origin);
  if (!norm || !ALLOWED_ORIGINS.has(norm)) {
    return {};
  }
  return {
    'Access-Control-Allow-Origin': norm,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

export function handleCorsPreflight(req: Request): Response {
  const origin = req.headers.get('origin');
  const norm = normalizeOrigin(origin);

  if (!isAllowedOrigin(origin)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: {
        'Content-Type': 'application/json',
        'Vary': 'Origin',
        'Cache-Control': 'no-store',
      },
    });
  }

  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': norm,
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Vary': 'Origin',
      'Cache-Control': 'no-store',
    },
  });
}

export function createCorsResponse(
  status: number,
  body: unknown,
  origin?: string | null,
  extraHeaders: Record<string, string> = {}
): Response {
  const norm = normalizeOrigin(origin);
  const isAllowed = isAllowedOrigin(origin);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  };

  if (isAllowed) {
    headers['Access-Control-Allow-Origin'] = norm;
    headers['Access-Control-Allow-Headers'] = 'authorization, apikey, content-type, x-client-info';
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
  }

  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}
