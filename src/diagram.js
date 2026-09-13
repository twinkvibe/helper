import createDOMPurify from 'dompurify';

let mermaidPromise;
let diagramId = 0;

export async function enhanceDiagrams(container, windowObject = window) {
  const blocks = [...container.querySelectorAll('pre > code.language-mermaid')];
  if (!blocks.length) return;
  mermaidPromise ||= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'dark',
      suppressErrorRendering: true,
    });
    return mermaid;
  });
  const mermaid = await mermaidPromise;
  const purifier = createDOMPurify(windowObject);
  for (const code of blocks) {
    if (!code.isConnected) continue;
    const source = code.textContent;
    try {
      const { svg } = await mermaid.render(`helper-diagram-${++diagramId}`, source);
      if (!code.isConnected) continue;
      const figure = windowObject.document.createElement('figure');
      figure.className = 'mermaid-diagram';
      figure.innerHTML = purifier.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['foreignObject', 'script'],
        FORBID_ATTR: ['onload', 'onclick', 'onerror'],
      });
      code.parentElement.replaceWith(figure);
    } catch {
      code.parentElement.classList.add('mermaid-error');
      code.parentElement.setAttribute('title', 'Ошибка синтаксиса Mermaid');
    }
  }
}
