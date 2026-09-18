import createDOMPurify from 'dompurify';
import { marked } from 'marked';
export function renderMarkdown(source, windowObject = window) {
  const purifier = createDOMPurify(windowObject);
  purifier.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') || '';
      if (!/^https:\/\//i.test(src) && !/^(\.\.?\/|\/(?!\/))/.test(src) && !/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src)) node.removeAttribute('src');
      const alt = node.getAttribute('alt') || '';
      const size = alt.match(/(?:^|\|)(\d{1,4})(?:x(\d{1,4}))?$/);
      if (size) {
        node.setAttribute('width', String(Math.min(Number(size[1]), 1600)));
        if (size[2]) node.setAttribute('height', String(Math.min(Number(size[2]), 1200)));
        node.setAttribute('alt', alt.slice(0, size.index).replace(/\|$/, ''));
      }
      node.setAttribute('loading', 'lazy');
      node.setAttribute('referrerpolicy', 'no-referrer');
    }
    if (node.tagName === 'INPUT') {
      if (node.getAttribute('type') !== 'checkbox') { node.remove(); return; }
      node.removeAttribute('disabled');
    }
  });
  return purifier.sanitize(marked.parse(source, { async: false, breaks: true }), {
    ALLOWED_TAGS: ['p','br','hr','h1','h2','h3','h4','h5','h6','strong','em','del','blockquote','ul','ol','li','pre','code','a','table','thead','tbody','tr','th','td','img','input','span'],
    ALLOWED_ATTR: ['href','title','src','alt','width','height','type','checked','disabled','class'],
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
