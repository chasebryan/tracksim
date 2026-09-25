/**
 * Small DOM helpers shared by the HUD panels: terse element creation and
 * "cells" — writers that remember the last value they wrote and touch the
 * DOM only when the value changes, so `update()` is cheap at 60 fps.
 *
 * Dynamic data is always written through `textContent`, never `innerHTML`.
 */

export type Child = Node | string;

/** Create an element with attributes and children (strings become text nodes). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  if (children.length > 0) el.append(...children);
  return el;
}

/** A `<button type="button">` with a test id and click handler. */
export function button(label: string, testId: string, onClick: () => void, className = 'btn'): HTMLButtonElement {
  const el = h('button', { type: 'button', class: className, 'data-testid': testId }, [label]);
  el.addEventListener('click', onClick);
  return el;
}

export interface TextCell {
  readonly el: HTMLElement;
  set(text: string): void;
}

/** Writes `textContent` only when the text differs from the last write. */
export function textCell(el: HTMLElement, initial = ''): TextCell {
  let last = initial;
  el.textContent = initial;
  return {
    el,
    set(text: string): void {
      if (text !== last) {
        last = text;
        el.textContent = text;
      }
    },
  };
}

/** Create a text element and its cell in one go. */
export function textEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  initial = '',
): TextCell {
  return textCell(h(tag, attrs), initial);
}

export interface FlagCell {
  set(on: boolean): void;
  get(): boolean;
}

function flagCell(initial: boolean, write: (on: boolean) => void): FlagCell {
  let last = initial;
  write(initial);
  return {
    set(on: boolean): void {
      if (on !== last) {
        last = on;
        write(on);
      }
    },
    get: () => last,
  };
}

/** Reflects a boolean into `aria-pressed="true"|"false"` (always present, so tests can read either state). */
export function pressedCell(el: HTMLElement, initial = false): FlagCell {
  return flagCell(initial, (on) => el.setAttribute('aria-pressed', on ? 'true' : 'false'));
}

/** Reflects a boolean into the `hidden` attribute. */
export function hiddenCell(el: HTMLElement, initial = true): FlagCell {
  return flagCell(initial, (on) => {
    el.hidden = on;
  });
}

/** Toggles one class name. */
export function classCell(el: HTMLElement, name: string, initial = false): FlagCell {
  return flagCell(initial, (on) => el.classList.toggle(name, on));
}

export interface AttrCell {
  set(value: string): void;
}

/** Writes an attribute only when its value changes. */
export function attrCell(el: HTMLElement, name: string, initial: string): AttrCell {
  let last = initial;
  el.setAttribute(name, initial);
  return {
    set(value: string): void {
      if (value !== last) {
        last = value;
        el.setAttribute(name, value);
      }
    },
  };
}

export interface BarCell {
  readonly el: HTMLElement;
  /** Set the fill as a fraction in [0, 1]; writes `style.width` in whole percent. */
  set(fraction: number): void;
}

/** A horizontal bar: `<div class="bar"><div class="bar__fill"></div></div>`. */
export function barCell(className = 'bar'): BarCell {
  const fill = h('div', { class: `${className}__fill` });
  const el = h('div', { class: className }, [fill]);
  let last = -1;
  const cell: BarCell = {
    el,
    set(fraction: number): void {
      const pct = Number.isFinite(fraction) ? Math.round(Math.min(1, Math.max(0, fraction)) * 100) : 0;
      if (pct !== last) {
        last = pct;
        fill.style.width = `${pct}%`;
      }
    },
  };
  cell.set(0);
  return cell;
}
