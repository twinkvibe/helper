import createDOMPurify from 'dompurify';
import { marked } from 'marked';
export function renderMarkdown(source, windowObject = window) {
  const purifier = createDOMPurify(windowObject);
  return purifier.sanitize(marked.parse(source, { async: false }), {
    ALLOWED_TAGS: ['p','br','hr','h1','h2','h3','h4','h5','h6','strong','em','del','blockquote','ul','ol','li','pre','code','a','table','thead','tbody','tr','th','td'],
    ALLOWED_ATTR: ['href','title'],
    ALLOW_DATA_ATTR: false,
  });
}
export function sessionStorageAdapter(local, session) {
  const preferenceKey = 'helper:remember';
  return {
    setRemember(remember) {
      local.removeItem('helper:auth');
      session.removeItem('helper:auth');
      local.setItem(preferenceKey, remember ? 'yes' : 'no');
    },
    getItem(key) { return local.getItem(preferenceKey) === 'yes' ? local.getItem(key) : session.getItem(key); },
    setItem(key, value) { (local.getItem(preferenceKey) === 'yes' ? local : session).setItem(key, value); },
    removeItem(key) { local.removeItem(key); session.removeItem(key); },
  };
}
