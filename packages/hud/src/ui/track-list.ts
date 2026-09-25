/**
 * Track list: one card per track keyed by track id, created/updated/removed
 * in place and kept in snapshot order. Filter buttons hide cards by label
 * (`state.labelFilter`); clicking a card toggles `state.selectedTrackId` and
 * notifies `handlers.selectTrack`; the per-card label menu sends
 * `{type:'track.label'}` commands.
 */
import type { TrackLabel, TrackSnapshot, TrackStatus } from '@tracksim/sim';
import type { FrameMessage, GlobeRenderOptions, HudHandlers, HudViewState } from '../contracts';
import { barCell, h, hiddenCell, pressedCell, textEl, type BarCell, type FlagCell, type TextCell } from './dom';
import { degrees, fixed, km, percent, speed } from './format';

export type LabelFilter = GlobeRenderOptions['labelFilter'];

export const LABELS: readonly TrackLabel[] = ['friendly', 'unknown', 'hostile', 'decoy'];
export const FILTERS: readonly LabelFilter[] = ['all', 'friendly', 'unknown', 'hostile', 'decoy'];

/** Short tag shown on the card and the label-menu buttons. */
export const LABEL_TAGS: Readonly<Record<TrackLabel, string>> = {
  friendly: 'FRD',
  unknown: 'UNK',
  hostile: 'HOS',
  decoy: 'DCY',
};

export interface TrackList {
  readonly listEl: HTMLElement;
  update(frame: FrameMessage): void;
  /** Number of cards currently in the DOM. */
  size(): number;
}

interface Card {
  id: number;
  el: HTMLElement;
  label: TrackLabel;
  status: TrackStatus;
  tag: TextCell;
  statusText: TextCell;
  range: TextCell;
  bearing: TextCell;
  spd: TextCell;
  quality: BarCell;
  qualityText: TextCell;
  confidence: TextCell;
  age: TextCell;
  selected: FlagCell;
  hidden: FlagCell;
}

/** Build the filter bar and list into `root`. */
export function createTrackList(root: HTMLElement, handlers: HudHandlers, state: HudViewState): TrackList {
  const cards = new Map<number, Card>();
  /** Cards in DOM order. */
  const order: Card[] = [];

  const listEl = h('div', { class: 'track-list', 'data-testid': 'track-list', role: 'list' });

  const visible = (label: TrackLabel): boolean => state.labelFilter === 'all' || state.labelFilter === label;

  const filterButtons = FILTERS.map((f) => {
    const el = h('button', { type: 'button', class: `btn btn--filter btn--${f}`, 'data-testid': `filter-${f}` }, [f]);
    const pressed = pressedCell(el, state.labelFilter === f);
    el.addEventListener('click', () => {
      state.labelFilter = f;
      applyFilter();
    });
    return { filter: f, el, pressed };
  });

  const applyFilter = (): void => {
    for (const b of filterButtons) b.pressed.set(b.filter === state.labelFilter);
    for (const c of order) c.hidden.set(!visible(c.label));
  };

  const filterBar = h('div', { class: 'track-filters', role: 'group', 'aria-label': 'Label filter' }, filterButtons.map((b) => b.el));
  root.append(filterBar, listEl);

  const select = (id: number | null): void => {
    const prev = state.selectedTrackId;
    if (prev !== null) cards.get(prev)?.selected.set(false);
    state.selectedTrackId = id;
    if (id !== null) cards.get(id)?.selected.set(true);
    handlers.selectTrack(id);
  };

  const makeCard = (t: TrackSnapshot): Card => {
    const tag = textEl('span', { class: `tag tag--${t.label}` }, LABEL_TAGS[t.label]);
    const statusText = textEl('span', { class: 'track-card__status' }, t.status);
    const range = textEl('span', { class: 'v', 'data-testid': 'track-range' }, '--');
    const bearing = textEl('span', { class: 'v', 'data-testid': 'track-bearing' }, '--');
    const spd = textEl('span', { class: 'v', 'data-testid': 'track-speed' }, '--');
    const quality = barCell('bar');
    const qualityText = textEl('span', { class: 'v', 'data-testid': 'track-quality' }, '--');
    const confidence = textEl('span', { class: 'v', 'data-testid': 'track-label-confidence' }, '--');
    const age = textEl('span', { class: 'v v--dim', 'data-testid': 'track-age' }, '--');

    const menu = h('div', { class: 'label-menu', role: 'group', 'aria-label': `Label track ${t.id}` });
    for (const label of LABELS) {
      const b = h(
        'button',
        { type: 'button', class: `btn btn--label btn--${label}`, 'data-testid': `track-label-${label}`, 'data-label': label, title: `Label as ${label}` },
        [LABEL_TAGS[label]],
      );
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        handlers.command({ type: 'track.label', trackId: t.id, label });
      });
      menu.appendChild(b);
    }

    const el = h(
      'article',
      { class: `track-card track-card--${t.label} status-${t.status}`, 'data-testid': 'track-card', 'data-track-id': String(t.id), role: 'listitem', tabindex: '0' },
      [
        h('header', { class: 'track-card__head' }, [h('span', { class: 'track-card__id' }, [`#${t.id}`]), tag.el, statusText.el, age.el]),
        h('div', { class: 'track-card__row' }, [range.el, bearing.el, spd.el]),
        h('div', { class: 'track-card__row track-card__row--bar' }, [
          h('span', { class: 'k' }, ['q']),
          quality.el,
          qualityText.el,
          h('span', { class: 'k' }, ['conf']),
          confidence.el,
        ]),
        menu,
      ],
    );
    el.addEventListener('click', () => select(state.selectedTrackId === t.id ? null : t.id));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select(state.selectedTrackId === t.id ? null : t.id);
      }
    });

    const card: Card = {
      id: t.id,
      el,
      label: t.label,
      status: t.status,
      tag,
      statusText,
      range,
      bearing,
      spd,
      quality,
      qualityText,
      confidence,
      age,
      selected: pressedSelection(el, state.selectedTrackId === t.id),
      hidden: hiddenCell(el, !visible(t.label)),
    };
    listEl.appendChild(el);
    cards.set(t.id, card);
    order.push(card);
    return card;
  };

  const render = (card: Card, t: TrackSnapshot): void => {
    if (t.label !== card.label) {
      card.el.classList.remove(`track-card--${card.label}`);
      card.el.classList.add(`track-card--${t.label}`);
      card.tag.el.classList.remove(`tag--${card.label}`);
      card.tag.el.classList.add(`tag--${t.label}`);
      card.label = t.label;
      card.tag.set(LABEL_TAGS[t.label]);
      card.hidden.set(!visible(t.label));
    }
    if (t.status !== card.status) {
      card.el.classList.remove(`status-${card.status}`);
      card.el.classList.add(`status-${t.status}`);
      card.status = t.status;
      card.statusText.set(t.status);
    }
    card.range.set(km(t.range, 1));
    card.bearing.set(degrees(t.bearing, 1));
    card.spd.set(speed(t.speed, 0));
    card.quality.set(t.quality);
    card.qualityText.set(fixed(t.quality, 2));
    card.confidence.set(percent(t.labelConfidence));
    card.age.set(`${t.hits}/${t.ageScans}`);
    card.selected.set(state.selectedTrackId === t.id);
  };

  return {
    listEl,
    size: () => order.length,
    update(frame: FrameMessage): void {
      const tracks = frame.snapshot.tracks;
      let i = 0;
      for (; i < tracks.length; i++) {
        const t = tracks[i] as TrackSnapshot;
        const card = cards.get(t.id) ?? makeCard(t);
        if (order[i] !== card) {
          order.splice(order.indexOf(card), 1);
          order.splice(i, 0, card);
          listEl.insertBefore(card.el, order[i + 1]?.el ?? null);
        }
        render(card, t);
      }
      // Every surviving card now sits at an index < i; the tail is gone from the snapshot.
      if (order.length > i) {
        let lostSelection = false;
        for (const c of order.splice(i)) {
          c.el.remove();
          cards.delete(c.id);
          if (state.selectedTrackId === c.id) lostSelection = true;
        }
        if (lostSelection) select(null);
      }
      for (const b of filterButtons) b.pressed.set(b.filter === state.labelFilter);
    },
  };
}

/** `aria-selected` + `is-selected` class, written together. */
function pressedSelection(el: HTMLElement, initial: boolean): FlagCell {
  let last = initial;
  const write = (on: boolean): void => {
    el.setAttribute('aria-selected', on ? 'true' : 'false');
    el.classList.toggle('is-selected', on);
  };
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
