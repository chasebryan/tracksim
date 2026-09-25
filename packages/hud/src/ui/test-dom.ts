/**
 * Minimal in-memory DOM used to unit-test the UI panels under vitest's node
 * environment (no jsdom/happy-dom is installed and dependencies may not be
 * added). It implements only the subset the ui/ modules use: element creation,
 * attributes, textContent, hidden/aria state, class lists, child manipulation,
 * a small selector engine (tag, #id, .class, [attr], [attr="v"], descendant
 * combinator, comma lists) and bubbling events with stopPropagation.
 *
 * It deliberately has no `innerHTML`: the panels must never use it.
 */
export type Listener = (event: FakeEvent) => void;

export interface FakeEventInit {
  bubbles?: boolean;
  [key: string]: unknown;
}

export class FakeEvent {
  readonly type: string;
  readonly bubbles: boolean;
  target: FakeElement | null = null;
  currentTarget: FakeElement | null = null;
  defaultPrevented = false;
  propagationStopped = false;

  constructor(type: string, init: FakeEventInit = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? true;
    for (const key of Object.keys(init)) {
      if (key !== 'bubbles') (this as unknown as Record<string, unknown>)[key] = init[key];
    }
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

export class FakeText {
  readonly nodeType = 3;
  parentNode: FakeElement | null = null;
  data: string;

  constructor(data: string) {
    this.data = data;
  }

  get textContent(): string {
    return this.data;
  }

  set textContent(value: string | null) {
    this.data = value ?? '';
  }
}

export type FakeNode = FakeElement | FakeText;

export class FakeClassList {
  private readonly el: FakeElement;

  constructor(el: FakeElement) {
    this.el = el;
  }

  private names(): string[] {
    return (this.el.getAttribute('class') ?? '').split(/\s+/).filter((n) => n.length > 0);
  }

  private write(names: string[]): void {
    if (names.length === 0) this.el.removeAttribute('class');
    else this.el.setAttribute('class', names.join(' '));
  }

  add(...names: string[]): void {
    const cur = this.names();
    for (const n of names) if (!cur.includes(n)) cur.push(n);
    this.write(cur);
  }

  remove(...names: string[]): void {
    this.write(this.names().filter((n) => !names.includes(n)));
  }

  toggle(name: string, force?: boolean): boolean {
    const on = force ?? !this.contains(name);
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }

  contains(name: string): boolean {
    return this.names().includes(name);
  }

  get length(): number {
    return this.names().length;
  }

  toString(): string {
    return this.names().join(' ');
  }
}

interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: { name: string; value: string | null }[];
}

const COMPOUND_RE = /^(\*|[a-zA-Z][\w-]*)?((?:#[\w-]+|\.[\w-]+|\[[^\]]+\])*)$/;
const PART_RE = /#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]"']*)))?\]/g;

function parseCompound(text: string): Compound {
  const m = COMPOUND_RE.exec(text);
  if (!m || text.length === 0) throw new Error(`test-dom: unsupported selector "${text}"`);
  const tag = m[1];
  const c: Compound = { tag: tag && tag !== '*' ? tag.toUpperCase() : null, id: null, classes: [], attrs: [] };
  const rest = m[2] ?? '';
  PART_RE.lastIndex = 0;
  let p: RegExpExecArray | null;
  while ((p = PART_RE.exec(rest)) !== null) {
    if (p[1] !== undefined) c.id = p[1];
    else if (p[2] !== undefined) c.classes.push(p[2]);
    else if (p[3] !== undefined) c.attrs.push({ name: p[3], value: p[4] ?? p[5] ?? p[6] ?? null });
  }
  return c;
}

function parseSelector(selector: string): Compound[][] {
  return selector.split(',').map((chain) => chain.trim().split(/\s+/).map(parseCompound));
}

function matchesCompound(el: FakeElement, c: Compound): boolean {
  if (c.tag !== null && el.tagName !== c.tag) return false;
  if (c.id !== null && el.getAttribute('id') !== c.id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null) return false;
    if (a.value !== null && v !== a.value) return false;
  }
  return true;
}

function matchesChain(el: FakeElement, chain: Compound[]): boolean {
  let i = chain.length - 1;
  if (!matchesCompound(el, chain[i] as Compound)) return false;
  let node = el.parentNode;
  i--;
  while (i >= 0) {
    const c = chain[i] as Compound;
    while (node !== null && !matchesCompound(node, c)) node = node.parentNode;
    if (node === null) return false;
    node = node.parentNode;
    i--;
  }
  return true;
}

export class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly childNodes: FakeNode[] = [];
  readonly ownerDocument: FakeDocument;
  parentNode: FakeElement | null = null;
  readonly style: Record<string, string> = {};
  readonly classList: FakeClassList;
  checked = false;
  disabled = false;
  /** Stand-in for `HTMLInputElement.files`; tests assign plain objects. */
  files: unknown[] | null = null;
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Listener[]>();
  private valueState: string | null = null;
  private selectedState = false;

  constructor(tag: string, ownerDocument: FakeDocument) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.classList = new FakeClassList(this);
  }

  get nodeName(): string {
    return this.tagName;
  }

  // -- reflected attributes ---------------------------------------------------

  get id(): string {
    return this.attrs.get('id') ?? '';
  }

  set id(v: string) {
    this.attrs.set('id', v);
  }

  get className(): string {
    return this.attrs.get('class') ?? '';
  }

  set className(v: string) {
    if (v === '') this.attrs.delete('class');
    else this.attrs.set('class', v);
  }

  get hidden(): boolean {
    return this.attrs.has('hidden');
  }

  set hidden(v: boolean) {
    if (v) this.attrs.set('hidden', '');
    else this.attrs.delete('hidden');
  }

  get title(): string {
    return this.attrs.get('title') ?? '';
  }

  set title(v: string) {
    this.attrs.set('title', v);
  }

  get type(): string {
    return this.attrs.get('type') ?? '';
  }

  set type(v: string) {
    this.attrs.set('type', v);
  }

  get min(): string {
    return this.attrs.get('min') ?? '';
  }

  set min(v: string) {
    this.attrs.set('min', v);
  }

  get max(): string {
    return this.attrs.get('max') ?? '';
  }

  set max(v: string) {
    this.attrs.set('max', v);
  }

  get step(): string {
    return this.attrs.get('step') ?? '';
  }

  set step(v: string) {
    this.attrs.set('step', v);
  }

  get htmlFor(): string {
    return this.attrs.get('for') ?? '';
  }

  set htmlFor(v: string) {
    this.attrs.set('for', v);
  }

  get value(): string {
    if (this.tagName === 'SELECT') {
      const o = this.selectedOption();
      return o ? o.value : '';
    }
    if (this.tagName === 'OPTION') return this.valueState ?? this.attrs.get('value') ?? this.textContent;
    return this.valueState ?? this.attrs.get('value') ?? '';
  }

  set value(v: string) {
    const s = String(v);
    if (this.tagName === 'SELECT') {
      let found = false;
      for (const o of this.options) {
        o.selected = !found && o.value === s;
        if (o.selected) found = true;
      }
      return;
    }
    this.valueState = s;
  }

  get selected(): boolean {
    return this.selectedState;
  }

  set selected(v: boolean) {
    this.selectedState = v;
  }

  get options(): FakeElement[] {
    return this.children.filter((c) => c.tagName === 'OPTION');
  }

  get selectedIndex(): number {
    const opts = this.options;
    const i = opts.findIndex((o) => o.selected);
    if (i >= 0) return i;
    return opts.length > 0 ? 0 : -1;
  }

  set selectedIndex(i: number) {
    this.options.forEach((o, j) => {
      o.selected = j === i;
    });
  }

  private selectedOption(): FakeElement | null {
    const opts = this.options;
    return opts.find((o) => o.selected) ?? opts[0] ?? null;
  }

  // -- content ------------------------------------------------------------------

  get textContent(): string {
    let s = '';
    for (const c of this.childNodes) s += c instanceof FakeText ? c.data : c.textContent;
    return s;
  }

  set textContent(v: string | null) {
    this.clearChildren();
    const s = v ?? '';
    if (s !== '') this.appendChild(new FakeText(s));
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
  }

  get childElementCount(): number {
    return this.children.length;
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get lastElementChild(): FakeElement | null {
    const c = this.children;
    return c[c.length - 1] ?? null;
  }

  get nextSibling(): FakeNode | null {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i + 1] ?? null;
  }

  get isConnected(): boolean {
    let n: FakeElement = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument.documentElement;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  appendChild<T extends FakeNode>(node: T): T {
    return this.insertBefore(node, null);
  }

  append(...nodes: (FakeNode | string)[]): void {
    for (const n of nodes) this.appendChild(typeof n === 'string' ? new FakeText(n) : n);
  }

  prepend(...nodes: (FakeNode | string)[]): void {
    let ref = this.firstChild;
    for (const n of nodes) {
      const node = typeof n === 'string' ? new FakeText(n) : n;
      this.insertBefore(node, ref);
      ref = node.parentNode === this ? (this.childNodes[this.childNodes.indexOf(node) + 1] ?? null) : ref;
    }
  }

  insertBefore<T extends FakeNode>(node: T, ref: FakeNode | null): T {
    if (node === (ref as FakeNode)) return node;
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    if (ref === null) {
      this.childNodes.push(node);
    } else {
      const idx = this.childNodes.indexOf(ref);
      if (idx < 0) throw new Error('test-dom: insertBefore reference is not a child');
      this.childNodes.splice(idx, 0, node);
    }
    return node;
  }

  removeChild<T extends FakeNode>(node: T): T {
    const idx = this.childNodes.indexOf(node);
    if (idx < 0) throw new Error('test-dom: removeChild of a non-child');
    this.childNodes.splice(idx, 1);
    node.parentNode = null;
    return node;
  }

  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  replaceChildren(...nodes: (FakeNode | string)[]): void {
    this.clearChildren();
    this.append(...nodes);
  }

  private clearChildren(): void {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes.length = 0;
  }

  contains(node: FakeNode | null): boolean {
    let n: FakeNode | null = node;
    while (n) {
      if (n === this) return true;
      n = n.parentNode;
    }
    return false;
  }

  // -- queries ------------------------------------------------------------------

  matches(selector: string): boolean {
    return parseSelector(selector).some((chain) => matchesChain(this, chain));
  }

  closest(selector: string): FakeElement | null {
    let n: FakeElement | null = this;
    while (n) {
      if (n.matches(selector)) return n;
      n = n.parentNode;
    }
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    const chains = parseSelector(selector);
    return this.findFirst((el) => chains.some((chain) => matchesChain(el, chain)));
  }

  querySelectorAll(selector: string): FakeElement[] {
    const chains = parseSelector(selector);
    const out: FakeElement[] = [];
    this.walk((el) => {
      if (chains.some((chain) => matchesChain(el, chain))) out.push(el);
    });
    return out;
  }

  /** Depth-first visit of every descendant element (not this element). */
  walk(visit: (el: FakeElement) => void): void {
    for (const c of this.childNodes) {
      if (c instanceof FakeElement) {
        visit(c);
        c.walk(visit);
      }
    }
  }

  private findFirst(pred: (el: FakeElement) => boolean): FakeElement | null {
    for (const c of this.childNodes) {
      if (!(c instanceof FakeElement)) continue;
      if (pred(c)) return c;
      const inner = c.findFirst(pred);
      if (inner) return inner;
    }
    return null;
  }

  // -- events -------------------------------------------------------------------

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type);
    if (list) {
      if (!list.includes(listener)) list.push(listener);
    } else {
      this.listeners.set(type, [listener]);
    }
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const i = list.indexOf(listener);
    if (i >= 0) list.splice(i, 1);
  }

  dispatchEvent(event: FakeEvent): boolean {
    event.target = this;
    let node: FakeElement | null = this;
    while (node) {
      event.currentTarget = node;
      const list = node.listeners.get(event.type);
      if (list) for (const fn of [...list]) fn(event);
      if (event.propagationStopped || !event.bubbles) break;
      node = node.parentNode;
    }
    event.currentTarget = null;
    return !event.defaultPrevented;
  }

  /** Browser-like click: no-op when disabled; checkboxes toggle and fire input + change. */
  click(): void {
    if (this.disabled) return;
    if (this.tagName === 'INPUT' && this.type === 'checkbox') {
      this.checked = !this.checked;
      const ev = new FakeEvent('click');
      this.dispatchEvent(ev);
      if (ev.defaultPrevented) {
        this.checked = !this.checked;
        return;
      }
      this.dispatchEvent(new FakeEvent('input'));
      this.dispatchEvent(new FakeEvent('change'));
      return;
    }
    this.dispatchEvent(new FakeEvent('click'));
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  blur(): void {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }
}

export class FakeDocument {
  readonly nodeType = 9;
  readonly documentElement: FakeElement;
  readonly head: FakeElement;
  readonly body: FakeElement;
  activeElement: FakeElement | null = null;

  constructor() {
    this.documentElement = new FakeElement('html', this);
    this.head = this.documentElement.appendChild(new FakeElement('head', this));
    this.body = this.documentElement.appendChild(new FakeElement('body', this));
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }

  getElementById(id: string): FakeElement | null {
    return this.documentElement.querySelector(`#${id}`);
  }

  querySelector(selector: string): FakeElement | null {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.documentElement.querySelectorAll(selector);
  }
}

/**
 * Install a fresh FakeDocument as `globalThis.document` so the panels'
 * `document.createElement` calls resolve. Returns the document; call
 * `uninstallFakeDom()` in `afterEach`.
 */
export function installFakeDom(): FakeDocument {
  const doc = new FakeDocument();
  (globalThis as { document?: unknown }).document = doc;
  return doc;
}

export function uninstallFakeDom(): void {
  delete (globalThis as { document?: unknown }).document;
}

/** Dispatch a bubbling event of `type` on `el` with optional extra properties (e.g. `{ key: 'Enter' }`). */
export function fire(el: FakeElement, type: string, init: FakeEventInit = {}): FakeEvent {
  const ev = new FakeEvent(type, init);
  el.dispatchEvent(ev);
  return ev;
}

/** Look up `[data-testid="id"]` under `root`, throwing when absent so tests fail loudly. */
export function byTestId(root: FakeElement | FakeDocument, id: string): FakeElement {
  const el = root.querySelector(`[data-testid="${id}"]`);
  if (!el) throw new Error(`test-dom: no element with data-testid="${id}"`);
  return el;
}
