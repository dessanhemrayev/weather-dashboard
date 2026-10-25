'use strict';

/**
 * Безопасное построение DOM. Любой текст попадает в узел через textContent
 * (createTextNode), поэтому разметка в названиях городов остаётся обычным текстом.
 * innerHTML в проекте не используется.
 */

/**
 * h('button', {class: 'btn', dataset: {action: 'x'}, 'aria-label': '...'}, 'текст', childNode)
 * Строки в children становятся текстовыми узлами, null/false пропускаются.
 */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name === 'dataset') Object.assign(node.dataset, value);
    else if (name === 'text') node.textContent = value;
    else if (value === true) node.setAttribute(name, '');
    else node.setAttribute(name, String(value));
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) appendChildren(node, child);
    else node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Заменяет содержимое контейнера новыми узлами. */
export function mount(container, ...nodes) {
  container.replaceChildren(...nodes.flat().filter(Boolean));
}
