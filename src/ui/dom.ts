export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function requireElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`找不到必要介面元素：${selector}`);
  }
  return element;
}

export function formatSeconds(milliseconds: number): string {
  return Math.max(0, milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0);
}

export function uniqueId(prefix: string): string {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function setPressed(button: HTMLButtonElement, pressed: boolean): void {
  button.setAttribute('aria-pressed', String(pressed));
  button.classList.toggle('is-active', pressed);
}

export function requestAppFullscreen(element: HTMLElement): Promise<void> {
  if (document.fullscreenElement) {
    return document.exitFullscreen();
  }
  return element.requestFullscreen({ navigationUI: 'hide' });
}

