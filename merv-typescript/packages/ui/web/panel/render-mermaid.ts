const MAX_MERMAID_LENGTH = 12_000;
let library: Promise<typeof import('mermaid')> | undefined;
let initialized: 'light' | 'dark' | undefined,
  serial = 0;
/** A diagram in the panel's own tones, light or dark as the panel wears. */
const TONES = {
  dark: {
    background: '#111110',
    primaryColor: '#2b303d',
    primaryTextColor: '#dfe2e6',
    primaryBorderColor: '#8aa6e6',
    lineColor: '#8aa6e6',
    secondaryColor: '#252931',
    tertiaryColor: '#111110',
    mainBkg: '#2b303d',
    textColor: '#dfe2e6',
    nodeBorder: '#8aa6e6',
    clusterBkg: '#111110',
    clusterBorder: '#4a5263',
    edgeLabelBackground: '#111110',
    titleColor: '#dfe2e6',
  },
  light: {
    background: '#ffffff',
    primaryColor: '#eef2fb',
    primaryTextColor: '#1f2125',
    primaryBorderColor: '#2f5bd3',
    lineColor: '#2f5bd3',
    secondaryColor: '#f4f5f7',
    tertiaryColor: '#ffffff',
    mainBkg: '#eef2fb',
    textColor: '#1f2125',
    nodeBorder: '#2f5bd3',
    clusterBkg: '#f4f5f7',
    clusterBorder: '#c3c8cf',
    edgeLabelBackground: '#ffffff',
    titleColor: '#1f2125',
  },
};

/** Diagrams are local and inert. Configuration, links, images, and CSS URLs stay readable code. */
function canRenderMermaid(text: string): boolean {
  return (
    text.length <= MAX_MERMAID_LENGTH &&
    !/^\s*---/.test(text) &&
    !/%%\{|^\s*click\s|\b(?:https?|data|blob|file|javascript|vbscript):|\/\/|\b(?:img|image|href|src)\s*[:=]|url\s*\(|!\[/im.test(
      text,
    ) &&
    (text.match(/[\n;]/g)?.length ?? 0) <= 320
  );
}

function safeCss(css: string): boolean {
  // CSS escapes could disguise a resource URL; diagram styling does not need them.
  return (
    !/\\|@import|@font-face/i.test(css) &&
    !/url\s*\(/i.test(css.replace(/url\(\s*["']?#[\w:.-]+["']?\s*\)/gi, ''))
  );
}

function localSvg(svg: string): string | undefined {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = document.documentElement;
  if (root.localName !== 'svg' || document.querySelector('parsererror')) return;
  // Strict Mermaid already sanitizes. Also remove resource-bearing SVG features and links.
  for (const node of Array.from(
    root.querySelectorAll(
      'script,foreignObject,image,iframe,object,embed,animate,animateMotion,animateTransform,set',
    ),
  ))
    node.remove();
  for (const node of Array.from(root.querySelectorAll('a')))
    node.replaceWith(...Array.from(node.childNodes));
  for (const node of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (node.localName === 'style' && !safeCss(node.textContent ?? '')) return;
    for (const attribute of Array.from(node.attributes)) {
      if (
        /^on/i.test(attribute.name) ||
        (/(?:^|:)href$/i.test(attribute.name) && !attribute.value.startsWith('#'))
      )
        node.removeAttribute(attribute.name);
      if (
        /^(?:style|fill|stroke|filter|clip-path|mask|marker-start|marker-mid|marker-end)$/.test(
          attribute.name,
        ) &&
        !safeCss(attribute.value)
      )
        return;
    }
  }
  return new XMLSerializer().serializeToString(root);
}

export async function renderMermaid(
  text: string,
  signal?: AbortSignal,
  theme: 'light' | 'dark' = 'dark',
): Promise<string | undefined> {
  if (signal?.aborted || !canRenderMermaid(text) || typeof document === 'undefined') return;
  let container: HTMLDivElement | undefined;
  try {
    const { default: mermaid } = await (library ??= import('mermaid').catch((error) => {
      library = undefined;
      throw error;
    }));
    if (signal?.aborted) return;
    if (initialized !== theme) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: theme === 'light' ? 'default' : 'dark',
        htmlLabels: false,
        fontFamily: 'Geist Sans, sans-serif',
        maxTextSize: MAX_MERMAID_LENGTH,
        maxEdges: 160,
        flowchart: { htmlLabels: false, useMaxWidth: false },
        themeVariables: {
          darkMode: theme === 'dark',
          ...TONES[theme],
          fontFamily: 'Geist Sans, sans-serif',
        },
      });
      initialized = theme;
    }
    container = document.createElement('div');
    container.style.cssText =
      'position:fixed;left:-100000px;top:0;width:1200px;visibility:hidden;pointer-events:none';
    container.setAttribute('aria-hidden', 'true');
    document.body.append(container);
    const { svg } = await mermaid.render(`merv-diagram-${++serial}`, text, container);
    if (signal?.aborted) return;
    return localSvg(svg);
  } catch {
    return;
  } finally {
    container?.remove();
  }
}
