export function tagsIn(text = '') {
 return [...new Set([...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{1,40})/gu)].map(m => m[1].toLowerCase()))].slice(0,20);
}
export function loadNotes(storage, userId) {
 const key = `helper:notes:${userId}`;
 const raw = storage.getItem(key);
 if(raw !== null) {
  const data = JSON.parse(raw);
  if(data.version !== 1 || !Array.isArray(data.notes) || data.notes.some(n => typeof n.id !== 'string' || typeof n.title !== 'string' || typeof n.body !== 'string')) throw new Error('Не удалось прочитать заметки. Данные сохранены в браузере; не очищай хранилище.');
  return data;
 }
 const legacy = storage.getItem(`helper:markdown:${userId}`);
 const data = {version:1, selected:null, notes:[]};
 if(legacy !== null) {
  const note={id:crypto.randomUUID(),title:'Заметка',body:legacy,deleted:false};
  data.notes.push(note);data.selected=note.id;
 }
 // Never delete the legacy copy; write the migrated collection before returning.
 storage.setItem(key,JSON.stringify(data));
 return data;
}
export function saveNotes(storage, userId, data) { storage.setItem(`helper:notes:${userId}`,JSON.stringify(data)); }
export function filterTasks(tasks,{status='all',list='',tag='',query='',todayOnly=false,today=''}={}) {
 return tasks.filter(t=>(status==='all'||t.done===(status==='done')) && (!list||t.list_name===list) && (!tag||[...(t.tags||[]),...tagsIn(t.description)].includes(tag)) && (!query||`${t.title} ${t.description||''}`.toLowerCase().includes(query.toLowerCase())) && (!todayOnly||(!t.done && t.due_date && t.due_date<=today))).sort((a,b)=>Number(a.done)-Number(b.done)||(b.priority||0)-(a.priority||0)||(a.due_date||'9999').localeCompare(b.due_date||'9999'));
}
