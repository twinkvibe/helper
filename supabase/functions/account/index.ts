import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  handleCorsPreflight,
  isAllowedOrigin,
  createCorsResponse,
} from './cors.ts';
import { parseChain, chatComplete } from '../_shared/ai.ts';
import { sendTelegram } from '../_shared/telegram.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');

  if (req.method === 'OPTIONS') {
    return handleCorsPreflight(req);
  }

  if (origin && !isAllowedOrigin(origin)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: {
        'Content-Type': 'application/json',
        'Vary': 'Origin',
        'Cache-Control': 'no-store',
      },
    });
  }

  const reply = (status: number, body: unknown) =>
    createCorsResponse(status, body, origin);

  if (req.method !== 'POST') return reply(405, { error: 'Метод не поддерживается' });

  try {
    const token = req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) return reply(401, { error: 'Войдите в аккаунт' });

    const { data: { user }, error: authError } = await admin.auth.getUser(token);
    if (authError || !user) return reply(401, { error: 'Сессия истекла' });

    const { data: me, error: profileError } = await admin.from('profiles').select('*').eq('id', user.id).single();
    if (profileError || !me || me.blocked) return reply(403, { error: 'Доступ закрыт' });

    const raw = await req.text();
    if (raw.length > 8192) return reply(413, { error: 'Слишком большой запрос' });
    const body = JSON.parse(raw);
    const passwordValid = (p: unknown) => typeof p === 'string' && p.length >= 9 && p.length <= 128;

    const logAudit = async (action: string, entity: string, entityId: string | null, details: Record<string, unknown>) => {
      try {
        await admin.from('audit_logs').insert({
          actor_id: user.id,
          action,
          entity,
          entity_id: entityId,
          details,
        });
      } catch (err) {
        console.error('Failed to write audit log:', err);
      }
    };

    // User's own password change
    if (body.action === 'password') {
      if (!passwordValid(body.password)) return reply(400, { error: 'Пароль: от 9 до 128 символов' });
      const verifier = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_ANON_KEY')!,
        { auth: { persistSession: false, autoRefreshToken: false } }
      );
      const { data: verified, error } = await verifier.auth.signInWithPassword({
        email: user.email!,
        password: body.currentPassword || '',
      });
      if (error || verified.user?.id !== user.id) return reply(400, { error: 'Текущий пароль неверен' });
      await verifier.auth.signOut({ scope: 'local' });
      if (body.password === body.currentPassword) return reply(400, { error: 'Новый пароль должен отличаться' });
      const updated = await admin.auth.admin.updateUserById(user.id, { password: body.password });
      if (updated.error) return reply(400, { error: 'Не удалось изменить пароль' });
      const saved = await admin.from('profiles').update({ must_change_password: false }).eq('id', user.id);
      if (saved.error) throw saved.error;
      await logAudit('password_change', 'profiles', user.id, {});
      return reply(200, { ok: true });
    }

    const aiChain = () => parseChain(Deno.env.get('AI_CHAIN'), {
      apiKey: Deno.env.get('AI_API_KEY'),
      baseUrl: Deno.env.get('AI_BASE_URL'),
      model: Deno.env.get('AI_MODEL'),
    });

    // Best-effort Telegram ping to the owner's linked chat. Never throws.
    const notifyLinkedChat = async (ownerId: string, text: string) => {
      try {
        const token = Deno.env.get('BOT_TOKEN');
        if (!token) return;
        const { data: link } = await admin
          .from('telegram_links')
          .select('chat_id')
          .eq('user_id', ownerId)
          .maybeSingle();
        const chatId = (link as { chat_id?: number | null } | null)?.chat_id;
        if (!chatId) return;
        await sendTelegram(token, chatId, text);
      } catch (err) {
        console.error('Telegram notify failed:', err);
      }
    };

    const runAi = async (messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) => {
      const chain = aiChain();
      if (!chain.providers.length) return { notConfigured: true as const };
      try {
        return await chatComplete(chain, messages, { maxTokens: 900, temperature: 0.3 });
      } catch (err) {
        console.error('AI chain failed:', (err as Error)?.message);
        return null;
      }
    };

    // Dossier AI assistant — available to every active authenticated user.
    if (body.action === 'dossier:analyze') {
      const text = typeof body.body === 'string' ? body.body.trim() : '';
      if (!text) return reply(400, { error: 'Опиши событие, чтобы ИИ было что разобрать' });
      if (text.length > 12000) return reply(413, { error: 'Слишком большой текст для ИИ' });

      const answer = await runAi([
        {
          role: 'system',
          content: [
            'Ты аккуратный помощник для личного досье.',
            'Помогаешь восстановить и упорядочить воспоминания о событиях.',
            'Отделяй подтверждённые факты от предположений и догадок и явно помечай неуверенность.',
            'Не выдумывай детали. Если данных не хватает, перечисли конкретные уточняющие вопросы.',
            'Отвечай по-русски, кратко и по делу. Форматируй ответ в Markdown.',
          ].join(' '),
        },
        { role: 'user', content: `Заголовок: ${typeof body.title === 'string' ? body.title : ''}\n\n${text}` },
      ]);
      if (answer && 'notConfigured' in answer) return reply(200, { notConfigured: true });
      if (!answer) {
        await notifyLinkedChat(user.id, '⚠️ ИИ-помощник: все провайдеры недоступны. Проверь ключи и повтори позже.');
        return reply(502, { error: 'ИИ-помощник временно недоступен. Уведомление отправлено в Telegram.' });
      }
      await logAudit('dossier_ai_analyze', 'dossier', null, { chars: text.length, provider: answer.provider, model: answer.model });
      return reply(200, { text: answer.text, provider: answer.provider, model: answer.model });
    }

    // Dossier AI review — checks a person's profile: relationship status, facts, open questions.
    if (body.action === 'dossier:review') {
      const person = body.person && typeof body.person === 'object' ? body.person : {};
      const name = typeof person.name === 'string' ? person.name.slice(0, 120) : '';
      if (!name.trim()) return reply(400, { error: 'Укажи имя человека' });

      const entries = Array.isArray(body.entries) ? body.entries.slice(0, 20) : [];
      const entryText = entries
        .map((e: any) => {
          const title = typeof e?.title === 'string' ? e.title.slice(0, 200) : '';
          const bodyText = typeof e?.body === 'string' ? e.body.slice(0, 2000) : '';
          return `— ${title}\n${bodyText}`.trim();
        })
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 12000);

      const profile = [
        `Имя: ${name}`,
        `Кто это: ${typeof person.relation === 'string' ? person.relation.slice(0, 120) : ''}`,
        `Статус отношений (как видит владелец): ${typeof person.relationship === 'string' ? person.relationship.slice(0, 120) : ''}`,
        `Известные факты: ${JSON.stringify(person.facts || []).slice(0, 2000)}`,
        `Заметки: ${typeof person.bio === 'string' ? person.bio.slice(0, 2000) : ''}`,
      ].join('\n');

      const answer = await runAi([
        {
          role: 'system',
          content: [
            'Ты аккуратный помощник для личного досье.',
            'Проверь карточку человека: статус отношений и известные факты.',
            'Предложи конкретные правки, если статус противоречит записям.',
            'Отдели подтверждённое от предположений, не выдумывай детали.',
            'Закончи списком уточняющих вопросов.',
            'Отвечай по-русски, кратко, в Markdown.',
          ].join(' '),
        },
        { role: 'user', content: `${profile}\n\nЗаписи:\n${entryText || '(записей пока нет)'}` },
      ]);
      if (answer && 'notConfigured' in answer) return reply(200, { notConfigured: true });
      if (!answer) {
        await notifyLinkedChat(user.id, '⚠️ ИИ-помощник: все провайдеры недоступны. Проверь ключи и повтори позже.');
        return reply(502, { error: 'ИИ-помощник временно недоступен. Уведомление отправлено в Telegram.' });
      }
      await logAudit('dossier_ai_review', 'dossier', null, { chars: entryText.length, provider: answer.provider, model: answer.model });
      return reply(200, { text: answer.text, provider: answer.provider, model: answer.model });
    }

    // Telegram linking: one-time 6-digit code, 10 minutes to live.
    if (body.action === 'telegram:code') {
      const digits = new Uint32Array(1);
      crypto.getRandomValues(digits);
      const code = String(100000 + (digits[0] % 900000));
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
      const codeHash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
      const codeExpires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const { data: existing } = await admin.from('telegram_links').select('user_id').eq('user_id', user.id).maybeSingle();
      const row = { user_id: user.id, code_hash: codeHash, code_expires: codeExpires };
      const saved = existing
        ? await admin.from('telegram_links').update(row).eq('user_id', user.id)
        : await admin.from('telegram_links').insert(row);
      if (saved.error) throw saved.error;
      await logAudit('telegram_code', 'telegram', null, {});
      return reply(200, { code });
    }

    // Telegram unlink: forget the chat, keep the row for future codes.
    if (body.action === 'telegram:unlink') {
      const cleared = await admin.from('telegram_links').update({ chat_id: null }).eq('user_id', user.id);
      if (cleared.error) throw cleared.error;
      await logAudit('telegram_unlink', 'telegram', null, {});
      return reply(200, { ok: true });
    }

    // Login ping to the owner's Telegram. Best-effort, always 200.
    if (body.action === 'notify:login') {
      const when = new Date().toLocaleString('ru-RU');
      await notifyLinkedChat(user.id, `🔑 Вход в helper: @${me.username} · ${when}`);
      return reply(200, { ok: true });
    }

    // Client error ping to the owner's Telegram. Best-effort, always 200.
    if (body.action === 'notify:error') {
      const message = typeof body.message === 'string' ? body.message.slice(0, 300) : 'Неизвестная ошибка';
      const context = typeof body.context === 'string' ? body.context.slice(0, 120) : '';
      await notifyLinkedChat(user.id, `❗ Ошибка helper${context ? ` (${context})` : ''}: ${message}`);
      return reply(200, { ok: true });
    }

    // Admin privileges required for all subsequent operations
    if (me.role !== 'admin' || me.must_change_password) return reply(403, { error: 'Нужны права администратора' });

    // List audit logs with enriched actor identity
    if (body.action === 'logs:list') {
      const { data: logs, error: logsError } = await admin
        .from('audit_logs')
        .select('id,actor_id,action,entity,entity_id,details,created_at')
        .order('created_at', { ascending: false })
        .limit(300);
      if (logsError) throw logsError;

      const actorIds = [...new Set((logs || []).map((l: any) => l.actor_id).filter(Boolean))];
      const actorMap = new Map<string, { username: string; display_name: string | null; avatar_url: string | null }>();
      if (actorIds.length > 0) {
        const { data: actors } = await admin
          .from('profiles')
          .select('id,username,display_name,avatar_url')
          .in('id', actorIds);
        for (const a of actors || []) {
          actorMap.set(a.id, { username: a.username, display_name: a.display_name, avatar_url: a.avatar_url });
        }
      }
      const enriched = (logs || []).map((l: any) => ({
        ...l,
        actor: l.actor_id ? (actorMap.get(l.actor_id) || null) : null,
      }));
      return reply(200, { logs: enriched });
    }

    // List all users
    if (body.action === 'list') {
      const { data, error } = await admin
        .from('profiles')
        .select('id,username,display_name,avatar_url,role,blocked,must_change_password,created_at')
        .order('created_at');
      if (error) throw error;
      return reply(200, { users: data });
    }

    // Create a new user
    if (body.action === 'create') {
      if (typeof body.username !== 'string' || !/^[a-z0-9_]{3,32}$/.test(body.username) || !passwordValid(body.password)) {
        return reply(400, { error: 'Логин: 3–32 символа a–z, 0–9, _. Пароль: 9–128 символов' });
      }
      let displayName: string | null = null;
      if (typeof body.display_name === 'string') {
        const trimmed = body.display_name.trim();
        if (trimmed.length > 80) {
          return reply(400, { error: 'Отображаемое имя: до 80 символов' });
        }
        displayName = trimmed.length > 0 ? trimmed : null;
      }
      const { data, error } = await admin.auth.admin.createUser({
        email: `${body.username}@users.helper.invalid`,
        password: body.password,
        email_confirm: true,
      });
      if (error || !data.user) return reply(400, { error: 'Не удалось создать аккаунт. Проверьте логин и пароль' });
      const saved = await admin.from('profiles').insert({
        id: data.user.id,
        username: body.username,
        display_name: displayName,
      });
      if (saved.error) {
        await admin.auth.admin.deleteUser(data.user.id);
        throw saved.error;
      }
      await logAudit('user_create', 'profiles', data.user.id, {
        username: body.username,
        changed_fields: ['user'],
        before: null,
        after: { username: body.username, role: 'member' },
      });
      return reply(200, { ok: true });
    }

    // Admin Articles Moderation: list all articles
    if (body.action === 'articles:list') {
      const { data: articles, error } = await admin
        .from('articles')
        .select('id,title,slug,excerpt,cover_url,access,published,published_at,created_at,updated_at,user_id,author_name,author_avatar_url')
        .order('updated_at', { ascending: false });
      if (error) throw error;

      const userIds = [...new Set((articles || []).map((a: any) => a.user_id))];
      const { data: profs } = await admin
        .from('profiles')
        .select('id,username,display_name,avatar_url')
        .in('id', userIds);
      const profMap = new Map((profs || []).map((p: any) => [p.id, p]));

      const enriched = (articles || []).map((a: any) => {
        const p = profMap.get(a.user_id);
        return {
          ...a,
          author_display_name: p?.display_name || null,
          author_avatar_url: p?.avatar_url || a.author_avatar_url,
          author_username: p?.username || a.author_name,
        };
      });
      return reply(200, { articles: enriched });
    }

    // Admin Articles Moderation: change access level
    if (body.action === 'articles:access') {
      if (typeof body.id !== 'string') return reply(400, { error: 'Укажите ID статьи' });
      const access = body.access;
      if (!['public', 'unlisted', 'private'].includes(access)) return reply(400, { error: 'Недопустимый уровень доступа' });

      const { data: current, error: curError } = await admin
        .from('articles')
        .select('id,title,slug,access,published_at')
        .eq('id', body.id)
        .maybeSingle();
      if (curError) throw curError;
      if (!current) return reply(404, { error: 'Статья не найдена' });

      const published = access !== 'private';
      const updates: Record<string, unknown> = { access, published, updated_at: new Date().toISOString() };
      if (published) {
        if (!current.published_at) updates.published_at = new Date().toISOString();
      } else {
        updates.published_at = null;
      }

      const { data: updated, error } = await admin
        .from('articles')
        .update(updates)
        .eq('id', body.id)
        .select('id,title,slug')
        .maybeSingle();
      if (error) throw error;
      if (!updated) return reply(404, { error: 'Статья не найдена' });

      await logAudit('admin_article_access', 'articles', updated.id, {
        title: updated.title,
        slug: updated.slug,
        changed_fields: ['access'],
        before: { access: current.access },
        after: { access },
      });
      return reply(200, { ok: true });
    }

    // Admin Articles Moderation: delete article
    if (body.action === 'articles:delete') {
      if (typeof body.id !== 'string') return reply(400, { error: 'Укажите ID статьи' });
      const { data: art, error: findError } = await admin
        .from('articles')
        .select('id,title,slug,access')
        .eq('id', body.id)
        .maybeSingle();
      if (findError) throw findError;
      if (!art) return reply(404, { error: 'Статья не найдена' });

      const { error } = await admin.from('articles').delete().eq('id', body.id);
      if (error) throw error;

      await logAudit('admin_article_delete', 'articles', body.id, {
        title: art.title,
        slug: art.slug,
        changed_fields: ['article'],
        before: { title: art.title, slug: art.slug, access: art.access },
        after: null,
      });
      return reply(200, { ok: true });
    }

    // Target user operations require body.id
    if (typeof body.id !== 'string') return reply(400, { error: 'Укажите ID пользователя' });
    if (body.id === user.id) return reply(400, { error: 'Нельзя применить это действие к своему аккаунту' });

    const { data: target, error: targetError } = await admin
      .from('profiles')
      .select('id,username,role,blocked,must_change_password')
      .eq('id', body.id)
      .single();
    if (targetError || !target) return reply(404, { error: 'Пользователь не найден' });

    const getActiveAdminCount = async (excludeId?: string): Promise<number> => {
      let query = admin.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin').eq('blocked', false);
      if (excludeId) query = query.neq('id', excludeId);
      const { count, error } = await query;
      if (error) throw error;
      return count ?? 0;
    };

    const getTotalAdminCount = async (excludeId?: string): Promise<number> => {
      let query = admin.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin');
      if (excludeId) query = query.neq('id', excludeId);
      const { count, error } = await query;
      if (error) throw error;
      return count ?? 0;
    };

    // Role management
    if (body.action === 'role') {
      if (body.role !== 'admin' && body.role !== 'member') return reply(400, { error: 'Недопустимая роль' });
      if (target.role === 'admin' && body.role === 'member') {
        const remainingActive = await getActiveAdminCount(target.id);
        if (remainingActive < 1) return reply(400, { error: 'Нельзя понизить последнего активного администратора' });
      }
      const { error } = await admin.from('profiles').update({ role: body.role }).eq('id', target.id);
      if (error) throw error;
      await logAudit('role_change', 'profiles', target.id, {
        username: target.username,
        changed_fields: ['role'],
        before: { role: target.role },
        after: { role: body.role },
      });
      return reply(200, { ok: true });
    }

    // Block / unblock
    if (body.action === 'block' && typeof body.blocked === 'boolean') {
      if (body.blocked && target.role === 'admin') {
        const remainingActive = await getActiveAdminCount(target.id);
        if (remainingActive < 1) return reply(400, { error: 'Нельзя заблокировать последнего активного администратора' });
      }
      const { error } = await admin.from('profiles').update({ blocked: body.blocked }).eq('id', target.id);
      if (error) throw error;
      await logAudit(body.blocked ? 'block' : 'unblock', 'profiles', target.id, {
        username: target.username,
        changed_fields: ['blocked'],
        before: { blocked: target.blocked },
        after: { blocked: body.blocked },
      });
      return reply(200, { ok: true });
    }

    // Password reset
    if (body.action === 'reset' && passwordValid(body.password)) {
      // 1. Security-first: lock account until password is changed
      const locked = await admin.from('profiles').update({ must_change_password: true }).eq('id', target.id);
      if (locked.error) throw locked.error;

      // 2. Update password in Auth
      const { error: authErr } = await admin.auth.admin.updateUserById(target.id, { password: body.password });
      if (authErr) {
        console.error('Auth password reset failed after locking profile:', authErr);
        // Explicitly retain the restrictive state to protect against unauthorized access
        return reply(500, {
          error: 'Не удалось сбросить пароль; доступ остаётся ограничен до повторного сброса.',
        });
      }

      await logAudit('password_reset', 'profiles', target.id, {
        username: target.username,
        changed_fields: ['must_change_password'],
        before: { must_change_password: target.must_change_password },
        after: { must_change_password: true },
      });
      return reply(200, { ok: true });
    }

    // Delete user account
    if (body.action === 'delete') {
      if (target.role === 'admin') {
        const totalAdmins = await getTotalAdminCount(target.id);
        if (totalAdmins < 1) return reply(400, { error: 'Нельзя удалить последнего администратора' });
      }

      // Supabase Auth and Storage are separate microservices without a distributed 2PC transaction.
      // Safe order of operations:
      // 1. Clean user-owned storage objects FIRST using strictly server-validated target.id prefix.
      // 2. If storage listing or removal fails, abort before deleting user, allowing admin to retry safely.
      // 3. Delete Auth user (which cascades into public.profiles, todos, articles in PostgreSQL).
      const userMediaPrefix = target.id;
      const pageSize = 100;
      let offset = 0;
      const filesToDelete: string[] = [];

      while (true) {
        const { data: files, error: listErr } = await admin.storage
          .from('article-media')
          .list(userMediaPrefix, { limit: pageSize, offset });

        if (listErr) {
          console.error('Storage list failed during account deletion:', listErr);
          return reply(500, { error: 'Не удалось проверить хранилище медиафайлов; удаление отменено' });
        }

        if (!files || files.length === 0) break;

        for (const file of files) {
          if (file.name) {
            filesToDelete.push(`${userMediaPrefix}/${file.name}`);
          }
        }

        if (files.length < pageSize) break;
        offset += files.length;
      }

      if (filesToDelete.length > 0) {
        for (let i = 0; i < filesToDelete.length; i += pageSize) {
          const batch = filesToDelete.slice(i, i + pageSize);
          const { error: removeErr } = await admin.storage.from('article-media').remove(batch);
          if (removeErr) {
            console.error('Storage remove failed during account deletion:', removeErr);
            return reply(500, { error: 'Не удалось очистить медиафайлы; удаление аккаунта отменено' });
          }
        }
      }

      const { error: delErr } = await admin.auth.admin.deleteUser(target.id);
      if (delErr) {
        console.error('Auth user delete failed:', delErr);
        return reply(500, { error: 'Не удалось удалить аккаунт из системы авторизации' });
      }

      await logAudit('account_delete', 'users', target.id, {
        username: target.username,
        changed_fields: ['user'],
        before: { username: target.username, role: target.role },
        after: null,
      });
      return reply(200, { ok: true });
    }

    return reply(400, { error: 'Неизвестное действие' });
  } catch (err: any) {
    console.error('Edge function error:', err);
    const msg = typeof err?.message === 'string' && err.message.includes('последнего активного администратора')
      ? err.message
      : 'Не удалось выполнить запрос. Проверьте настройку сервиса';
    return reply(400, { error: msg });
  }
});
