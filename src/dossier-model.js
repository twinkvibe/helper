// Чистые функции для раздела «Досье». Без DOM и Supabase — удобно тестировать.
import { tagsIn } from './notes.js';

/** Разбирает строку тегов ("#проект, идеи  #важное") в нормализованный массив (<=20). */
export function parseTagInput(value = '') {
  const raw = String(value)
    .split(/[\s,;]+/)
    .map(token => token.replace(/^#+/, '').trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(raw)].slice(0, 20);
}

/** Готовит теги для input: "#проект #идеи". */
export function formatTagsInput(tags = []) {
  return (tags || []).map(tag => `#${tag}`).join(' ');
}

/** Собирает уникальные теги из людей и записей (нижний регистр), по алфавиту. */
export function collectTags(people = [], entries = []) {
  const set = new Set();
  [...people, ...entries].forEach(item =>
    (item.tags || []).forEach(tag => set.add(String(tag).toLowerCase())),
  );
  return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru'));
}

/** Фильтрация людей по тексту и тегу. */
export function filterPeople(people = [], { query = '', tag = '' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const wanted = String(tag || '').toLowerCase();
  return people.filter(person => {
    const tags = (person.tags || []).map(t => String(t).toLowerCase());
    if (wanted && !tags.includes(wanted)) return false;
    if (!q) return true;
    const haystack = [
      person.name,
      (person.aliases || []).join(' '),
      person.relation,
      person.bio,
      tags.join(' '),
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

/** Записи: сначала по дате события, потом по дате создания; новые сверху. */
export function sortEntries(entries = []) {
  return [...entries].sort((a, b) => {
    const av = String(a.occurred_at || a.created_at || '');
    const bv = String(b.occurred_at || b.created_at || '');
    return bv.localeCompare(av);
  });
}

/** Поиск по записи (заголовок, текст, теги). Пустой запрос — совпадает всё. */
export function entryMatches(entry, query = '') {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const haystack = `${entry.title || ''} ${entry.body || ''} ${(entry.tags || []).join(' ')}`.toLowerCase();
  return haystack.includes(q);
}

/** Безопасный путь фото: <uid>/<entryId>/<рандом>-<имя>. Первая папка = uid (нужно для RLS). */
export function mediaPath(userId, entryId, filename, salt = '') {
  const safe = String(filename || 'photo')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-80) || 'photo';
  const stamp = `${Date.now().toString(36)}${String(salt).replace(/[^a-z0-9]/gi, '').slice(0, 6)}`;
  return `${userId}/${entryId}/${stamp}-${safe}`;
}

/** Короткая метка размера файла. */
export function formatBytes(bytes) {  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} КБ`;
  return `${(value / (1024 * 1024)).toFixed(1)} МБ`;
}

/** Дата события для интерфейса. Возвращает null, если значения нет. */
export function formatOccurredAt(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** Теги записи: явные + найденные в Markdown-тексте. */
export function entryTags(entry) {
  return [...new Set([...(entry.tags || []), ...tagsIn(entry.body || '')])];
}

export const MEDIA_LIMITS = {
  image: 5 * 1024 * 1024,
  video: 25 * 1024 * 1024,
  doc: 10 * 1024 * 1024,
};

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);
const DOC_TYPES = new Set([
  'application/pdf', 'text/plain', 'text/markdown', 'text/csv',
  'application/zip', 'application/x-zip-compressed',
]);

/**
 * Определяет тип загружаемого файла: 'image' | 'video' | 'doc'.
 * Бросает понятную ошибку, если тип или размер не подходят.
 */
export function classifyUpload(file, limits = {}) {
  const { imageMax = MEDIA_LIMITS.image, videoMax = MEDIA_LIMITS.video, docMax = MEDIA_LIMITS.doc } = limits;
  if (!file || typeof file.type !== 'string' || !(file.size > 0)) {
    throw new Error('Пустой файл.');
  }
  if (IMAGE_TYPES.has(file.type)) {
    if (file.size > imageMax) throw new Error(`Фото до ${formatBytes(imageMax)}.`);
    return 'image';
  }
  if (VIDEO_TYPES.has(file.type)) {
    if (file.size > videoMax) throw new Error(`Видео: MP4 или WebM до ${formatBytes(videoMax)}.`);
    return 'video';
  }
  if (DOC_TYPES.has(file.type)) {
    if (file.size > docMax) throw new Error(`Файлы: PDF, TXT, MD, CSV, ZIP до ${formatBytes(docMax)}.`);
    return 'doc';
  }
  throw new Error('Принимаются фото (PNG, JPEG, WebP, GIF), видео (MP4, WebM) и файлы (PDF, TXT, MD, CSV, ZIP).');
}

/** Инициалы для аватарки-заглушки. */
export function initials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const MAX_FACTS = 30;

/** Нормализует факты [{key, value}]: trim, пустые вон, лимиты длины и количества. */
export function normalizeFacts(list = []) {
  const out = [];
  for (const item of list || []) {
    const key = String(item?.key ?? '').trim().slice(0, 60);
    const value = String(item?.value ?? '').trim().slice(0, 500);
    if (!key && !value) continue;
    out.push({ key, value });
    if (out.length >= MAX_FACTS) break;
  }
  return out;
}

/** Ключ календарного дня (локальный) для группировки ленты. '' — без даты. */
export function dayKey(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Подпись дня для заголовка группы. */
export function dayLabel(key) {
  if (!key) return 'Без даты';
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const text = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Группирует записи по дням (по дате события, иначе по дате создания). Новые дни сверху. */
export function groupEntriesByDay(entries = []) {
  const groups = new Map();
  sortEntries(entries).forEach(entry => {
    const key = dayKey(entry.occurred_at || entry.created_at);
    if (!groups.has(key)) groups.set(key, { key, label: dayLabel(key), entries: [] });
    groups.get(key).entries.push(entry);
  });
  return [...groups.values()].sort((a, b) => {
    if (!a.key) return 1;
    if (!b.key) return -1;
    return b.key.localeCompare(a.key);
  });
}
