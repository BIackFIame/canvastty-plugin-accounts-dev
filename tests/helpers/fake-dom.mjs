// A minimal DOM for running the bundled settings page (settings/accounts.js) in node:vm: elements with children,
// properties, dataset, attributes and event listeners — just what the page's el()/button() helpers use. No layout, no
// network, no real browser.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.text = '';
    this.ownValue = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
  }
  /** A select's value is its chosen option's (the first one unless one is selected), as in a browser. */
  get value() {
    if (this.tagName !== 'SELECT' || this.ownValue !== '') return this.ownValue;
    const options = this.children.filter(child => typeof child !== 'string' && child.tagName === 'OPTION');
    return (options.find(option => option.selected) ?? options[0])?.value ?? '';
  }
  set value(value) { this.ownValue = String(value); }
  get textContent() { return this.text + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.text = ''; this.children = [...nodes]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] ?? []).filter(entry => entry !== listener); }
  /** Runs the listeners and waits for what they return (the page's handlers are async). */
  async dispatch(type) { await Promise.all((this.listeners[type] ?? []).map(listener => listener({ type, target: this }))); }
  /** Every element below this one, depth first. */
  *walk() { for (const child of this.children) if (typeof child !== 'string') { yield child; yield* child.walk(); } }
  find(predicate) { for (const node of this.walk()) if (predicate(node)) return node; return null; }
  named(name) { return this.find(node => node.name === name); }
}

/**
 * Loads the page with `host` as window.CanvasTTYPlugin. Returns the #app and #status elements and the context.
 */
export function loadPage(pagePath, host) {
  const app = new FakeElement('main');
  const status = new FakeElement('output');
  const document = {
    documentElement: { lang: 'en' },
    createElement: tag => new FakeElement(tag),
    querySelector: selector => selector === '#app' ? app : selector === '#status' ? status : null
  };
  const context = vm.createContext({ document, structuredClone, console, setTimeout, clearTimeout, Promise, Date, Intl, URL, JSON, Math });
  context.window = context;
  context.CanvasTTYPlugin = host;
  vm.runInContext(readFileSync(pagePath, 'utf8'), context, { filename: pagePath });
  return { app, status, context };
}

/** Lets the page's pending promises (requests, loads, renders) settle. */
export const settle = async (rounds = 20) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); };
