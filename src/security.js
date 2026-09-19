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
  const rawHtml = marked.parse(source, { async: false, breaks: true });
  const sanitized = purifier.sanitize(rawHtml, {
    ALLOWED_TAGS: ['p','br','hr','h1','h2','h3','h4','h5','h6','strong','em','del','blockquote','ul','ol','li','pre','code','a','table','thead','tbody','tr','th','td','img','input','span','cite'],
    ALLOWED_ATTR: ['href','title','src','alt','width','height','type','checked','disabled','class'],
    ALLOW_DATA_ATTR: false,
  });
  const doc = windowObject?.document;
  if (!doc) return sanitized;
  const container = doc.createElement('div');
  container.innerHTML = sanitized;
  postProcessMarkdown(container, windowObject);
  return container.innerHTML;
}

export function postProcessMarkdown(container, windowObject = window) {
  const doc = windowObject?.document;
  if (!doc || !container) return container;
  container.querySelectorAll('pre > code[class*="language-"]').forEach(code => {
    const language = code.className.match(/(?:^|\s)language-([\w+-]+)/)?.[1];
    if (!language || code.parentElement.querySelector('.code-language')) return;
    const label = doc.createElement('span');
    label.className = 'code-language';
    label.textContent = language;
    code.parentElement.prepend(label);
    code.parentElement.classList.add('has-code-language');
  });
  container.querySelectorAll('blockquote').forEach(bq => {
    const pList = Array.from(bq.children).filter(el => el.tagName === 'P');
    if (!pList.length) return;
    const lastP = pList[pList.length - 1];
    const text = lastP.textContent.trim();
    const match = text.match(/^—\s*(.+)$/s);
    if (match && match[1].trim()) {
      const cite = doc.createElement('cite');
      cite.className = 'quote-author';
      cite.textContent = match[1].trim();
      lastP.replaceWith(cite);
    }
  });
  return container;
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
