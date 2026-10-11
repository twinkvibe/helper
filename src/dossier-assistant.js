// Ленивый мост к ИИ-помощнику «Досье».
// Сам помощник живёт на серверной стороне (Supabase Edge Function `account`,
// действие `dossier:analyze`). Здесь только проверка сессии и вызов эндпоинта.
// Если действие на сервере не реализовано, вызывающая сторона покажет понятную ошибку.

export function createDossierAssistant({ client, requireSession = async () => true, endpoint, apiKey = '' }) {
  return async function askAssistant(payload) {
    await requireSession();
    const { data } = await client.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error('Сессия истекла. Войди снова.');

    const response = await fetch(`${endpoint}/functions/v1/account`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: apiKey,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || 'ИИ-помощник недоступен.');
    }
    if (result.notConfigured) {
      throw new Error('ИИ-помощник ещё не настроен на сервере.');
    }
    return result;
  };
}
