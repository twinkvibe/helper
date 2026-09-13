import { createClient } from 'npm:@supabase/supabase-js@2';
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const allowed = new Set(['https://twinkvibe.github.io', 'http://127.0.0.1:5173', 'http://127.0.0.1:4173']);
Deno.serve(async (req) => {
 const origin = req.headers.get('origin') || '';
 const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowed.has(origin) ? origin : 'https://twinkvibe.github.io', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin', 'Cache-Control': 'no-store' };
 const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {status, headers});
 if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers});
 if (req.method !== 'POST') return reply(405, {error:'Метод не поддерживается'});
 try {
  const token = req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return reply(401, {error:'Войдите в аккаунт'});
  const {data: {user}, error: authError} = await admin.auth.getUser(token);
  if (authError || !user) return reply(401, {error:'Сессия истекла'});
  const {data: me, error: profileError} = await admin.from('profiles').select('*').eq('id',user.id).single();
  if(profileError || !me || me.blocked) return reply(403, {error:'Доступ закрыт'});
  const raw = await req.text();
  if (raw.length > 4096) return reply(413, {error:'Слишком большой запрос'});
  const body = JSON.parse(raw);
  const passwordValid = (p: unknown) => typeof p === 'string' && p.length >= 12 && p.length <= 128;
  if(body.action === 'password') {
   if(!passwordValid(body.password)) return reply(400,{error:'Пароль: от 12 до 128 символов'});
   // Reauthenticate with the current password, including temporary first-login passwords.
   const verifier = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {auth:{persistSession:false,autoRefreshToken:false}});
   const {data: verified,error} = await verifier.auth.signInWithPassword({email:user.email!,password:body.currentPassword || ''});
   if(error || verified.user?.id !== user.id) return reply(400,{error:'Текущий пароль неверен'});
   await verifier.auth.signOut({scope:'local'});
   if(body.password === body.currentPassword) return reply(400,{error:'Новый пароль должен отличаться'});
   const updated = await admin.auth.admin.updateUserById(user.id,{password:body.password});
   if(updated.error) return reply(400,{error:'Не удалось изменить пароль'});
   const saved = await admin.from('profiles').update({must_change_password:false}).eq('id',user.id);
   if(saved.error) throw saved.error;
   return reply(200,{ok:true});
  }
  if(me.role !== 'admin' || me.must_change_password) return reply(403,{error:'Нужны права администратора'});
  if(body.action === 'list') {
   const {data,error} = await admin.from('profiles').select('id,username,role,blocked,must_change_password,created_at').order('created_at');
   if(error) throw error;
   return reply(200,{users:data});
  }
  if(body.action === 'create') {
   if(typeof body.username !== 'string' || !/^[a-z0-9_]{3,32}$/.test(body.username) || !passwordValid(body.password)) return reply(400,{error:'Логин: 3–32 символа a–z, 0–9, _. Пароль: 12–128 символов'});
   const {data,error} = await admin.auth.admin.createUser({email:`${body.username}@users.helper.invalid`,password:body.password,email_confirm:true});
   if(error || !data.user) return reply(400,{error:'Не удалось создать аккаунт. Проверьте логин и пароль'});
   const saved = await admin.from('profiles').insert({id:data.user.id,username:body.username});
   if(saved.error) { await admin.auth.admin.deleteUser(data.user.id); throw saved.error; }
   return reply(200,{ok:true});
  }
  if(typeof body.id !== 'string' || body.id === user.id) return reply(400,{error:'Нельзя выполнить это действие над собой'});
  const {data: target,error: targetError} = await admin.from('profiles').select('id,role').eq('id',body.id).single();
  if(targetError || !target || target.role === 'admin') return reply(403,{error:'Аккаунт недоступен для изменения'});
  if(body.action === 'block' && typeof body.blocked === 'boolean') {
   // Database flag is authoritative even for access tokens issued before the block.
   const {error} = await admin.from('profiles').update({blocked:body.blocked}).eq('id',target.id);
   if(error) throw error;
   return reply(200,{ok:true});
  }
  if(body.action === 'reset' && passwordValid(body.password)) {
   const locked = await admin.from('profiles').update({must_change_password:true}).eq('id',target.id);
   if(locked.error) throw locked.error;
   const {error} = await admin.auth.admin.updateUserById(target.id,{password:body.password});
   if(error) return reply(400,{error:'Не удалось сбросить пароль; доступ остаётся ограничен до смены пароля'});
   return reply(200,{ok:true});
  }
  return reply(400,{error:'Неизвестное действие'});
 } catch { return reply(500,{error:'Не удалось выполнить запрос. Проверьте настройку сервиса'}); }
});
