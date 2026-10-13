// ==UserScript==
// @name         Clues by Sam – Scenario Notes
// @namespace    cluesbysam-scenario-notes
// @version      1.1.1
// @description  Post-it style "what if" boards beside the Clues by Sam grid. Assume someone is innocent or criminal, paint the consequences red/green, browse scenarios per board state. Note-taking only – it never deduces anything. Unofficial fan-made add-on.
// @author       mrironcarbon
// @license      MIT
// @homepageURL  https://github.com/mrironcarbon/cluesbysam-scenarios
// @supportURL   https://github.com/mrironcarbon/cluesbysam-scenarios/issues
// @downloadURL  https://raw.githubusercontent.com/mrironcarbon/cluesbysam-scenarios/main/clues-by-sam-scenarios.user.js
// @updateURL    https://raw.githubusercontent.com/mrironcarbon/cluesbysam-scenarios/main/clues-by-sam-scenarios.user.js
// @match        https://cluesbysam.com/*
// @match        https://www.cluesbysam.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Constants
   * ------------------------------------------------------------------ */
  const NS = 'cbs-sc';
  const INNOCENT = 'innocent';
  const CRIMINAL = 'criminal';
  const TILE_W = 66; // scenario column width in both styles
  const TILE_H = 42; // minimal-style row height
  const AXIS = 14; // column letters / row numbers
  const GAP = 4;
  const PAD = 8;
  const PAD_AXIS = 6; // board padding on the sides that carry the labels
  const TITLE_H = 28;
  const WIN_BORDER = 2;
  const CARD_W = 87; // the game's card size, used until the real board can be measured
  const CARD_H = 118;
  const SIDE_GAP = 24; // board edge -> scenario column
  const STACK_GAP = 14; // between stacked scenarios
  const MAX_PUZZLES = 60; // older puzzles' notes are pruned
  const ARM_MS = 2500; // two-click confirmation window
  const TAG_RE = /--tag-color:\s*var\(--tag-color-(\d+)\)/;

  /* ------------------------------------------------------------------ *
   * Storage: userscript storage when granted, page localStorage otherwise
   * ------------------------------------------------------------------ */
  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  const store = {
    get(key, fallback) {
      try {
        if (hasGM) return GM_getValue(key, fallback);
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        if (hasGM) GM_setValue(key, value);
        else localStorage.setItem(key, JSON.stringify(value));
      } catch (err) {
        console.warn('[scenario notes] could not save', err);
      }
    },
    del(key) {
      try {
        if (!hasGM) localStorage.removeItem(key);
        else if (typeof GM_deleteValue === 'function') GM_deleteValue(key);
        else GM_setValue(key, null);
      } catch {
        /* nothing to clean up */
      }
    },
  };

  // style: 'minimal' (compact name tiles) or 'full' (scaled copy of the game's cards).
  const settings = { links: false, style: 'minimal', emojis: true, clues: true, ...store.get(`${NS}:settings`, {}) };
  const saveSettings = () => store.set(`${NS}:settings`, settings);

  /* ------------------------------------------------------------------ *
   * Reading the real board
   * ------------------------------------------------------------------ */
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const cap = s => s.replace(/(^|[\s-])\p{L}/gu, m => m.toUpperCase());

  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  function tagIndex(el) {
    const m = el ? TAG_RE.exec(el.getAttribute('style') || '') : null;
    return m ? Number(m[1]) : 0;
  }

  /** Snapshot of the game grid, or null while no grid is on the page. */
  function readBoard() {
    const grid = document.getElementById('grid');
    const els = grid ? [...grid.querySelectorAll('.card')] : [];
    if (!els.length) return null;
    const cards = els.map((el, idx) => {
      const text = sel => (el.querySelector(sel)?.textContent || '').trim();
      const coord = /^([A-Z])(\d+)$/.exec(text('.coord'));
      const flipped = el.classList.contains('flipped');
      const tagEls = el.querySelectorAll('.tag');
      const hintEl = flipped ? el.querySelector('.hint') : null;
      return {
        el,
        idx,
        name: text('h3.name'),
        profession: text('.profession'),
        face: text('.face'),
        col: coord ? coord[1].charCodeAt(0) - 65 : idx % 4,
        row: coord ? Number(coord[2]) - 1 : Math.floor(idx / 4),
        verdict: !flipped
          ? null
          : el.classList.contains(CRIMINAL)
            ? CRIMINAL
            : el.classList.contains(INNOCENT)
              ? INNOCENT
              : null,
        // The game renders clues as HTML; the class carries the "non-clue" styling preference.
        hint: hintEl ? { html: hintEl.innerHTML, cls: hintEl.className, text: hintEl.textContent.trim() } : null,
        consumed: el.classList.contains('consumed'),
        tags: [tagIndex(tagEls[0]), tagIndex(tagEls[1])],
      };
    });
    const known = cards.filter(c => c.verdict);
    return {
      grid,
      cards,
      cardW: els[0].offsetWidth || CARD_W,
      cardH: els[0].offsetHeight || CARD_H,
      // Same people in the same seats = same puzzle, whichever URL it was opened from.
      key: hash(cards.map(c => `${c.name}/${c.profession}`).join('|')),
      cols: Math.max(...cards.map(c => c.col)) + 1,
      rows: Math.max(...cards.map(c => c.row)) + 1,
      // A "step" is one board state: it advances when someone is identified.
      step: known.map(c => c.idx).join(','),
      count: known.length,
    };
  }

  const knownOf = board =>
    Object.fromEntries(board.cards.filter(c => c.verdict).map(c => [c.idx, c.verdict]));
  const tagsOf = board =>
    Object.fromEntries(board.cards.filter(c => c.tags[0] || c.tags[1]).map(c => [c.idx, [...c.tags]]));
  const consumedOf = board => board.cards.filter(c => c.consumed).map(c => c.idx);

  /* ------------------------------------------------------------------ *
   * Persisted puzzle record
   *   cards[i]: { name, profession, col, row, face, hint }
   *   scenario: { id, n, step, count, createdAt, base, marks, known, tags, consumed, pos, min, closed }
   * ------------------------------------------------------------------ */
  const puzzleKey = key => `${NS}:p:${key}`;

  function loadPuzzle(board) {
    const saved = store.get(puzzleKey(board.key), null);
    const p = saved && saved.v === 1 ? saved : { v: 1, key: board.key, scenarios: [], view: null };
    p.cols = board.cols;
    p.rows = board.rows;
    p.cards = board.cards.map((c, i) => ({
      ...p.cards?.[i],
      name: c.name,
      profession: c.profession,
      col: c.col,
      row: c.row,
    }));
    refreshCards(p, board);
    return p;
  }

  /** Copies faces and clues from the board. Clues are kept once seen, so earlier board states can show them. */
  function refreshCards(p, board) {
    let changed = false;
    board.cards.forEach((c, i) => {
      const pc = p.cards[i];
      if (pc.face !== c.face) {
        pc.face = c.face;
        changed = true;
      }
      if (c.hint && JSON.stringify(pc.hint) !== JSON.stringify(c.hint)) {
        pc.hint = c.hint;
        changed = true;
      }
    });
    return changed;
  }

  function saveSoon() {
    S.dirty = true;
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(flushSave, 300);
  }

  function flushSave() {
    clearTimeout(S.saveTimer);
    const p = S.puzzle;
    if (!S.dirty || !p) return;
    S.dirty = false;
    const index = store.get(`${NS}:index`, {});
    if (p.scenarios.length) {
      p.updatedAt = Date.now();
      store.set(puzzleKey(p.key), p);
      index[p.key] = p.updatedAt;
      const byAge = Object.keys(index).sort((a, b) => index[b] - index[a]);
      for (const old of byAge.slice(MAX_PUZZLES)) {
        store.del(puzzleKey(old));
        delete index[old];
      }
    } else {
      store.del(puzzleKey(p.key));
      delete index[p.key];
    }
    store.set(`${NS}:index`, index);
  }

  /* ------------------------------------------------------------------ *
   * Runtime state
   * ------------------------------------------------------------------ */
  const S = {
    board: null, // latest readBoard()
    boardSig: '',
    puzzle: null,
    picking: null, // id of the scenario waiting for its base person
    wins: new Map(), // scenario id -> { root, title, board, tiles, key }
    anchor: { x: 0, y: 0, w: 0, h: 0 }, // grid rect in layer coordinates
    gridSig: '',
    z: 1,
    cardsRev: 0, // bumped when faces or clues change, so open windows re-render
    dirty: false,
    saveTimer: 0,
  };
  const byId = id => S.puzzle?.scenarios.find(sc => sc.id === id) || null;
  const viewedStep = () => S.puzzle.view ?? S.board.step;

  /* ------------------------------------------------------------------ *
   * DOM helpers
   * ------------------------------------------------------------------ */
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...children.flat().filter(c => c != null && c !== false));
    return el;
  }

  const ICONS = {
    prev: '<path d="M10 3.5 5.5 8l4.5 4.5"/>',
    next: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
    plus: '<path d="M8 3.5v9M3.5 8h9"/>',
    eye: '<path d="M1.8 8S4 4 8 4s6.2 4 6.2 4S12 12 8 12 1.8 8 1.8 8Z"/><circle cx="8" cy="8" r="1.7"/>',
    link: '<path d="m6.6 9.4 2.8-2.8"/><path d="m7.4 4.6.9-.9a2.6 2.6 0 0 1 3.7 3.7l-.9.9"/><path d="m8.6 11.4-.9.9A2.6 2.6 0 0 1 4 8.6l.9-.9"/>',
    star: '<path d="m8 2.2 1.8 3.7 4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4L2.2 6.5l4-.6Z"/>',
    clear: '<path d="M3.3 8a4.7 4.7 0 1 0 1.4-3.3"/><path d="M3.2 2.4v2.8H6"/>',
    min: '<path d="M4 11.5h8"/>',
    restore: '<rect x="4" y="4" width="8" height="8" rx="1.5"/>',
    trash: '<path d="M3 4.5h10M6.3 4.5V3h3.4v1.5M4.6 4.5l.6 8.5h5.6l.6-8.5"/>',
    close: '<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>',
    settings: '<path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6"/><circle cx="10" cy="4.5" r="1.5"/><circle cx="6" cy="11.5" r="1.5"/>',
  };
  const icon = name =>
    `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  const button = (act, iconName, title, label) =>
    h('button', {
      type: 'button',
      class: 'cbs-btn',
      'data-act': act,
      title,
      'aria-label': title,
      html: icon(iconName) + (label != null ? `<span>${label}</span>` : ''),
    });

  /** First click arms a destructive button, a second click within ARM_MS confirms. */
  function confirmed(btn) {
    if (btn.classList.contains('cbs-armed')) return true;
    const title = btn.title;
    btn.classList.add('cbs-armed');
    btn.title = 'Click again to confirm';
    setTimeout(() => {
      btn.classList.remove('cbs-armed');
      btn.title = title;
    }, ARM_MS);
    return false;
  }

  /* ------------------------------------------------------------------ *
   * Styles – colours come from the game's own theme variables
   * ------------------------------------------------------------------ */
  const CSS = `
#cbs-sc-layer{position:absolute;left:0;top:0;width:0;height:0;z-index:15;font-family:var(--app-font,sans-serif);color:var(--text,#eee);line-height:1.2;-webkit-user-select:none;user-select:none}
#cbs-sc-layer[hidden],#cbs-sc-layer [hidden]{display:none!important}
#cbs-sc-layer *{box-sizing:border-box}
#cbs-sc-layer .cbs-links{position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none;z-index:0}
#cbs-sc-layer .cbs-link{fill:none;stroke:currentColor;stroke-width:2;stroke-opacity:.45;stroke-dasharray:7 5;stroke-linecap:round}
#cbs-sc-layer .cbs-ring{fill:none;stroke:currentColor;stroke-width:2;stroke-opacity:.5}
#cbs-sc-layer .cbs-dot{fill:currentColor;fill-opacity:.6}
#cbs-sc-layer .cbs-btn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:24px;height:24px;padding:0 5px;border-radius:6px;color:inherit;opacity:.75;cursor:pointer;font:inherit;font-size:12.5px;line-height:1;white-space:nowrap}
#cbs-sc-layer .cbs-btn:hover:not(:disabled){opacity:1;background:var(--background-highlight,rgba(127,127,127,.2))}
#cbs-sc-layer .cbs-btn:focus-visible{outline:2px solid var(--text-muted,#999)}
#cbs-sc-layer .cbs-btn:disabled{opacity:.25;cursor:default}
#cbs-sc-layer .cbs-btn.cbs-on{opacity:1;background:var(--border-button,#555)}
#cbs-sc-layer .cbs-btn.cbs-armed{opacity:1;color:#fff;background:var(--criminal,#c66464)}
#cbs-sc-layer .cbs-toolbar{position:absolute;z-index:1000000;display:flex;align-items:center;gap:2px;padding:3px;background:var(--modal-bg,#242830);border:1px solid var(--border-button,#4a4b55);border-radius:9px;box-shadow:0 2px 10px rgba(0,0,0,.25);white-space:nowrap}
#cbs-sc-layer .cbs-sep{width:1px;align-self:stretch;margin:2px 3px;background:var(--border-button,#4a4b55)}
#cbs-sc-layer .cbs-btn.cbs-step{flex-direction:column;gap:1px;min-width:54px;height:28px}
#cbs-sc-layer .cbs-step-count{font-size:12.5px;font-weight:700}
#cbs-sc-layer .cbs-step-when{font-size:9px;letter-spacing:.06em;text-transform:uppercase;opacity:.75}
#cbs-sc-layer .cbs-step.cbs-past .cbs-step-when{opacity:1;color:var(--warn,#bc9300)}
#cbs-sc-layer .cbs-panel{position:absolute;top:calc(100% + 6px);left:50%;translate:-50% 0;width:340px;padding:10px 12px;font-size:12px;line-height:1.45;text-align:left;white-space:normal;background:var(--modal-bg,#242830);border:1px solid var(--border-button,#4a4b55);border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.35);cursor:default}
#cbs-sc-layer .cbs-panel ul{list-style:none;margin:0;padding:0;text-align:left}
#cbs-sc-layer .cbs-panel li{margin:0 0 5px}
#cbs-sc-layer .cbs-panel svg{vertical-align:-2px}
#cbs-sc-layer .cbs-panel strong{font-weight:700}
#cbs-sc-layer .cbs-panel .cbs-muted{display:block;margin-top:6px}
#cbs-sc-layer .cbs-settings{width:260px}
#cbs-sc-layer .cbs-heading{margin:0 0 4px;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;opacity:.7}
#cbs-sc-layer .cbs-opt{display:flex;align-items:flex-start;gap:7px;padding:3px 0;cursor:pointer}
#cbs-sc-layer .cbs-opt input{margin:2px 0 0;accent-color:var(--innocent,#58a284);cursor:inherit}
#cbs-sc-layer .cbs-opt small{display:block;font-size:11px;opacity:.65}
#cbs-sc-layer .cbs-opt.cbs-sub{padding-left:21px}
#cbs-sc-layer .cbs-opt.cbs-off{opacity:.4;cursor:default}
#cbs-sc-layer .cbs-win{position:absolute;--cbs-accent:transparent;background:var(--bg,#1a1d24);border:${WIN_BORDER}px solid var(--border-button,#4a4b55);border-radius:10px;box-shadow:0 8px 22px rgba(0,0,0,.35)}
#cbs-sc-layer .cbs-win.cbs-picking{border-style:dashed;border-color:var(--text-muted,#a6acb8)}
#cbs-sc-layer .cbs-title{display:flex;align-items:center;gap:1px;height:${TITLE_H}px;padding:0 3px 0 8px;background:var(--modal-bg,#242830);border-bottom:1px solid var(--border-button,#4a4b55);border-radius:8px 8px 0 0;box-shadow:inset 4px 0 0 var(--cbs-accent);cursor:grab;touch-action:none}
#cbs-sc-layer .cbs-win.cbs-dragging .cbs-title{cursor:grabbing}
#cbs-sc-layer .cbs-win.cbs-min .cbs-title{border-bottom:0;border-radius:8px}
#cbs-sc-layer .cbs-win.cbs-min .cbs-board{display:none}
#cbs-sc-layer .cbs-num{margin-right:5px;font-size:11px;opacity:.6}
#cbs-sc-layer .cbs-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}
#cbs-sc-layer .cbs-muted{opacity:.65;font-style:italic}
#cbs-sc-layer .cbs-chip{display:inline-block;padding:0 5px;border-radius:4px;font-weight:700;line-height:17px;text-transform:capitalize}
#cbs-sc-layer .cbs-chip.cbs-innocent{background:var(--background-innocent);color:var(--text-innocent);box-shadow:inset 0 0 0 1px var(--border-innocent)}
#cbs-sc-layer .cbs-chip.cbs-criminal{background:var(--background-criminal);color:var(--text-criminal);box-shadow:inset 0 0 0 1px var(--border-criminal)}
#cbs-sc-layer .cbs-title .cbs-btn{min-width:22px;width:22px;height:22px;padding:0}
#cbs-sc-layer .cbs-board{display:grid;gap:${GAP}px;padding:${PAD_AXIS}px ${PAD}px ${PAD}px ${PAD_AXIS}px}
#cbs-sc-layer .cbs-axis{display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:700;color:var(--text-muted,#a6acb8)}
#cbs-sc-layer .cbs-tile{position:relative;cursor:pointer}
#cbs-sc-layer .cbs-tile:not(.cbs-known):hover{filter:brightness(1.15)}
#cbs-sc-layer .cbs-tile.cbs-base{outline:2px solid var(--cbs-accent);outline-offset:1px}
#cbs-sc-layer .cbs-tile.cbs-base::before{content:'\\2605';position:absolute;z-index:3;left:3px;top:1px;font-size:9px;line-height:9px}
body.left-handed #cbs-sc-layer .cbs-tile.cbs-base::before{left:auto;right:3px}
#cbs-sc-layer .cbs-win.cbs-picking .cbs-tile:not(.cbs-known){cursor:crosshair}
#cbs-sc-layer .cbs-win.cbs-picking .cbs-tile:not(.cbs-known):hover{outline:2px dashed var(--text-muted,#a6acb8);outline-offset:1px}
#cbs-sc-layer .cbs-compact{overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;border:1px solid var(--border-neutral,#4a4b55);border-radius:5px;background:var(--card-bg,#322f3b);color:var(--text,#eee)}
#cbs-sc-layer .cbs-name{width:100%;padding:1px 2px 2px;overflow:hidden;text-align:center;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:700;line-height:14px;text-transform:capitalize;background:var(--background-highlight,rgba(0,0,0,.17))}
#cbs-sc-layer .cbs-compact.cbs-long .cbs-name{font-size:10.5px}
#cbs-sc-layer .cbs-prof{max-width:100%;padding:0 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9.5px;line-height:11px;opacity:.7}
#cbs-sc-layer .cbs-compact.cbs-innocent{background:var(--background-innocent);border-color:var(--border-innocent);color:var(--text-innocent)}
#cbs-sc-layer .cbs-compact.cbs-innocent .cbs-name{background:var(--background-highlight-innocent)}
#cbs-sc-layer .cbs-compact.cbs-criminal{background:var(--background-criminal);border-color:var(--border-criminal);color:var(--text-criminal)}
#cbs-sc-layer .cbs-compact.cbs-criminal .cbs-name{background:var(--background-highlight-criminal)}
#cbs-sc-layer .cbs-compact.cbs-known{opacity:.45;cursor:default}
#cbs-sc-layer .cbs-tag{position:absolute;right:-9px;width:18px;height:18px;rotate:45deg;pointer-events:none}
#cbs-sc-layer .cbs-tag.cbs-t0{top:-9px}
#cbs-sc-layer .cbs-tag.cbs-t1{bottom:-9px}
body.left-handed #cbs-sc-layer .cbs-tag{right:auto;left:-9px}
#cbs-sc-layer .cbs-card{zoom:var(--cbs-card-zoom,.76)}
#cbs-sc-layer .cbs-card *{box-sizing:content-box}
#cbs-sc-layer .cbs-card.cbs-known{cursor:default}
#cbs-sc-layer .cbs-card.cbs-base{outline-width:3px;outline-offset:2px}
#cbs-sc-layer .cbs-card.cbs-base::before{top:auto;bottom:4px;left:5px;font-size:13px;line-height:13px}
body.left-handed #cbs-sc-layer .cbs-card.cbs-base::before{left:auto;right:5px}
#cbs-sc-layer .cbs-tip{display:none;position:absolute;left:8px;right:8px;top:calc(100% + 6px);padding:6px 8px;font-size:11.5px;line-height:1.35;background:var(--modal-bg,#242830);border:1px solid var(--border-button,#4a4b55);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.3);pointer-events:none}
#cbs-sc-layer .cbs-win.cbs-picking .cbs-tip{display:block}
`;

  const HELP_HTML = `
<ul>
  <li><strong>Left-click</strong> a person: innocent · <strong>right-click</strong>: criminal · the same click again clears.</li>
  <li>${icon('star')} or <strong>Shift+click</strong>: choose who the scenario is about (its base).</li>
  <li>Drag a title bar to move a scenario; double-click it to minimize.</li>
  <li>${icon('clear')} clears marks and ${icon('trash')} deletes (click twice). ${icon('close')} closes; ${icon('eye')} reopens closed ones.</li>
  <li>${icon('prev')}${icon('next')} browse scenarios from earlier board states. ${icon('plus')} starts one for the current board.</li>
  <li>${icon('link')} draws faint links from each scenario to its base person on the board.</li>
  <li>${icon('settings')} switches between the minimal look and a full mini copy of the board, with character emojis and clues.</li>
</ul>
<span class="cbs-muted">Columns and rows are labelled like the board. Corner tags and dimmed clues mirror the board. In the minimal look, people already revealed are faded.</span>`;

  /* ------------------------------------------------------------------ *
   * Toolbar
   * ------------------------------------------------------------------ */
  let layer, svg, toolbar, help, settingsPanel, stepBtn, stepCount, stepWhen, btnPrev, btnNext, btnReopen, btnLinks;

  function buildUI() {
    layer = h('div', { id: 'cbs-sc-layer', hidden: true });
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'cbs-links');

    btnPrev = button('prev', 'prev', 'Scenarios from the previous board state');
    stepCount = h('span', { class: 'cbs-step-count' });
    stepWhen = h('span', { class: 'cbs-step-when' });
    stepBtn = h('button', { type: 'button', class: 'cbs-btn cbs-step', 'data-act': 'now' }, stepCount, stepWhen);
    btnNext = button('next', 'next', 'Scenarios from the next board state');
    btnReopen = button('reopen', 'eye', 'Reopen closed scenarios', '');
    btnLinks = button('links', 'link', 'Links from scenarios to their person on the board');
    help = h('div', { class: 'cbs-panel', hidden: true, html: HELP_HTML });
    settingsPanel = buildSettings();
    toolbar = h(
      'div',
      { class: 'cbs-toolbar' },
      btnPrev,
      stepBtn,
      btnNext,
      h('span', { class: 'cbs-sep' }),
      button('new', 'plus', 'New scenario for the current board', 'Scenario'),
      btnReopen,
      btnLinks,
      button('settings', 'settings', 'Scenario look'),
      h('button', { type: 'button', class: 'cbs-btn', 'data-act': 'help', title: 'How it works', text: '?' }),
      help,
      settingsPanel,
    );
    toolbar.addEventListener('click', onToolbarClick);
    layer.append(svg, toolbar);
    document.body.append(layer);
  }

  function buildSettings() {
    const option = (type, name, value, label, detail, sub) =>
      h(
        'label',
        { class: sub ? 'cbs-opt cbs-sub' : 'cbs-opt' },
        h('input', { type, name, value }),
        h('span', {}, label, detail ? h('small', { text: detail }) : null),
      );
    const panel = h(
      'div',
      { class: 'cbs-panel cbs-settings', hidden: true },
      h('div', { class: 'cbs-heading', text: 'Scenario look' }),
      option('radio', 'cbs-style', 'minimal', 'Minimal', 'Compact name tiles'),
      option('radio', 'cbs-style', 'full', 'Full', 'Mini copy of the game board'),
      option('checkbox', 'emojis', '', 'Character emojis', null, true),
      option('checkbox', 'clues', '', 'Clues', null, true),
    );
    panel.addEventListener('change', e => {
      const input = e.target;
      if (input.name === 'cbs-style') settings.style = input.value;
      else settings[input.name] = input.checked;
      saveSettings();
      renderSettings();
      if (S.puzzle && S.board) render();
    });
    return panel;
  }

  function renderSettings() {
    for (const input of settingsPanel.querySelectorAll('input')) {
      if (input.type === 'radio') {
        input.checked = input.value === settings.style;
        continue;
      }
      // Emojis and clues are parts of the full look.
      input.checked = !!settings[input.name];
      input.disabled = settings.style !== 'full';
      input.closest('.cbs-opt').classList.toggle('cbs-off', input.disabled);
    }
  }

  function onToolbarClick(e) {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act || !S.puzzle) return;
    if (act === 'prev') navigate(-1);
    else if (act === 'next') navigate(1);
    else if (act === 'now') showStep(S.board.step);
    else if (act === 'new') createScenario();
    else if (act === 'reopen') reopenClosed();
    else if (act === 'links') {
      settings.links = !settings.links;
      saveSettings();
      renderToolbar();
      drawLinks();
    } else if (act === 'help' || act === 'settings') {
      const [panel, other] = act === 'help' ? [help, settingsPanel] : [settingsPanel, help];
      other.hidden = true;
      panel.hidden = !panel.hidden;
      if (!panel.hidden && panel === settingsPanel) renderSettings();
    }
  }

  /** Board states that have scenarios, plus the current one, oldest first. */
  function stepList() {
    const steps = new Map();
    for (const sc of S.puzzle.scenarios) {
      const s = steps.get(sc.step);
      if (s) s.first = Math.min(s.first, sc.createdAt);
      else steps.set(sc.step, { step: sc.step, count: sc.count, first: sc.createdAt });
    }
    if (!steps.has(S.board.step)) {
      steps.set(S.board.step, { step: S.board.step, count: S.board.count, first: Infinity });
    }
    return [...steps.values()].sort((a, b) => a.count - b.count || a.first - b.first);
  }

  function renderToolbar() {
    const list = stepList();
    const step = viewedStep();
    const i = list.findIndex(s => s.step === step);
    const isNow = step === S.board.step;
    const total = S.board.cards.length;
    const inStep = S.puzzle.scenarios.filter(sc => sc.step === step);
    const closed = inStep.filter(sc => sc.closed).length;
    stepCount.textContent = `${list[i].count}/${total}`;
    stepWhen.textContent = isNow ? 'now' : 'past';
    stepBtn.classList.toggle('cbs-past', !isNow);
    stepBtn.title =
      `${isNow ? 'Current board' : 'Earlier board'}: ${list[i].count} of ${total} identified, ` +
      `${inStep.length} scenario${inStep.length === 1 ? '' : 's'}` +
      (isNow ? '' : '\nClick to jump to the current board');
    btnPrev.disabled = i <= 0;
    btnNext.disabled = i >= list.length - 1;
    btnReopen.hidden = closed === 0;
    btnReopen.title = `Reopen ${closed} closed scenario${closed === 1 ? '' : 's'}`;
    btnReopen.lastElementChild.textContent = String(closed);
    btnLinks.classList.toggle('cbs-on', settings.links);
    btnLinks.setAttribute('aria-pressed', String(settings.links));
  }

  function navigate(delta) {
    const list = stepList();
    const i = list.findIndex(s => s.step === viewedStep());
    showStep(list[clamp(i + delta, 0, list.length - 1)].step);
  }

  function showStep(step) {
    S.puzzle.view = step === S.board.step ? null : step;
    saveSoon();
    render();
  }

  function reopenClosed() {
    const step = viewedStep();
    for (const sc of S.puzzle.scenarios) if (sc.step === step) sc.closed = false;
    saveSoon();
    render();
  }

  /* ------------------------------------------------------------------ *
   * Scenarios
   * ------------------------------------------------------------------ */
  function createScenario() {
    const p = S.puzzle;
    const b = S.board;
    // A new scenario always belongs to the current board; other board states' windows go away.
    p.view = null;
    render();
    const sameStep = p.scenarios.filter(sc => sc.step === b.step);
    const sc = {
      id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      n: Math.max(0, ...sameStep.map(s => s.n)) + 1,
      step: b.step,
      count: b.count,
      createdAt: Date.now(),
      base: null,
      marks: {},
      known: knownOf(b),
      tags: tagsOf(b),
      consumed: consumedOf(b),
      pos: freeSlot(),
      min: false,
      closed: false,
    };
    p.scenarios.push(sc);
    S.picking = sc.id;
    saveSoon();
    render();
  }

  /** Row height in the current look; full-look cards are the game's cards scaled to TILE_W. */
  const rowHeight = () => (settings.style === 'full' ? (S.board.cardH * TILE_W) / S.board.cardW : TILE_H);
  const winWidth = cols => PAD_AXIS + AXIS + cols * (TILE_W + GAP) + PAD + 2 * WIN_BORDER;
  const winHeight = rows => TITLE_H + 1 + PAD_AXIS + AXIS + rows * (rowHeight() + GAP) + PAD + 2 * WIN_BORDER;

  /** Next free spot beside the board: right column, left column, then a cascade. */
  function freeSlot() {
    const a = S.anchor;
    const W = winWidth(S.puzzle.cols);
    const H = winHeight(S.puzzle.rows);
    const docW = document.documentElement.clientWidth;
    const taken = [...S.wins.values()].map(({ root }) => ({
      x: root.offsetLeft - a.x,
      y: root.offsetTop - a.y,
      w: root.offsetWidth,
      h: root.offsetHeight,
    }));
    const overlaps = s => taken.some(t => s.dx < t.x + t.w && s.dx + W > t.x && s.dy < t.y + t.h && s.dy + H > t.y);
    const fits = s => a.x + s.dx >= 0 && a.x + s.dx + W <= docW;
    const rows = Math.max(1, Math.floor((a.h + STACK_GAP) / (H + STACK_GAP)));
    const slots = [];
    for (let r = 0; r < rows; r++) {
      slots.push({ dx: a.w + SIDE_GAP, dy: r * (H + STACK_GAP) }, { dx: -SIDE_GAP - W, dy: r * (H + STACK_GAP) });
    }
    const free = slots.find(s => fits(s) && !overlaps(s));
    if (free) return free;
    const first = slots.find(fits) || slots[0];
    for (let k = 1; k <= 20; k++) {
      const s = { dx: first.dx + 22 * k, dy: first.dy + 22 * k };
      if (!taken.some(t => Math.abs(t.x - s.dx) < 8 && Math.abs(t.y - s.dy) < 8)) return s;
    }
    return first;
  }

  function onTile(e, id, verdict) {
    const tile = e.target.closest('.cbs-tile');
    if (!tile) return;
    e.preventDefault(); // keeps the browser menu away on right-click
    const sc = byId(id);
    const idx = Number(tile.dataset.idx);
    if (!sc || sc.known[idx]) return;
    const same = sc.marks[idx] === verdict;
    if (S.picking === id || e.shiftKey) {
      // Choosing the base person: the same click on the current base removes it.
      if (sc.base === idx && same) {
        delete sc.marks[idx];
        sc.base = null;
      } else {
        sc.marks[idx] = verdict;
        sc.base = idx;
      }
      if (S.picking === id) S.picking = null;
    } else if (same) {
      delete sc.marks[idx];
      if (sc.base === idx) sc.base = null;
    } else {
      sc.marks[idx] = verdict;
    }
    saveSoon();
    render();
  }

  function onWindowButton(e, id) {
    const btn = e.target.closest('.cbs-btn');
    const sc = byId(id);
    if (!btn || !sc) return;
    const act = btn.dataset.act;
    if (act === 'base') {
      S.picking = S.picking === id ? null : id;
      if (S.picking === id) sc.min = false; // the tiles must be visible to pick from
    } else if (act === 'clear') {
      if (!confirmed(btn)) return;
      const keep = sc.base != null && sc.marks[sc.base];
      sc.marks = keep ? { [sc.base]: keep } : {};
    } else if (act === 'min') {
      sc.min = !sc.min;
    } else if (act === 'delete') {
      if (!confirmed(btn)) return;
      S.puzzle.scenarios = S.puzzle.scenarios.filter(s => s !== sc);
    } else if (act === 'close') {
      sc.closed = true;
    } else {
      return;
    }
    saveSoon();
    render();
  }

  function raise(el) {
    el.style.zIndex = String(++S.z);
  }

  function startDrag(e, id) {
    if (e.button !== 0 || e.target.closest('.cbs-btn')) return;
    const w = S.wins.get(id);
    if (!w) return;
    const { root, title } = w;
    const start = { x: e.clientX, y: e.clientY, left: root.offsetLeft, top: root.offsetTop };
    let moved = false;
    title.setPointerCapture(e.pointerId);
    root.classList.add('cbs-dragging');
    const move = ev => {
      moved ||= Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 2;
      if (!moved) return;
      root.style.left = `${start.left + ev.clientX - start.x}px`;
      root.style.top = `${Math.max(0, start.top + ev.clientY - start.y)}px`;
      drawLinks();
    };
    const end = () => {
      title.removeEventListener('pointermove', move);
      title.removeEventListener('pointerup', end);
      title.removeEventListener('pointercancel', end);
      root.classList.remove('cbs-dragging');
      const sc = byId(id);
      if (!sc || !moved) return;
      // Stored relative to the board so notes follow it when the page reflows.
      sc.pos = { dx: root.offsetLeft - S.anchor.x, dy: root.offsetTop - S.anchor.y };
      saveSoon();
      layout();
    };
    title.addEventListener('pointermove', move);
    title.addEventListener('pointerup', end);
    title.addEventListener('pointercancel', end);
  }

  /* ------------------------------------------------------------------ *
   * Scenario windows
   * ------------------------------------------------------------------ */
  function buildWindow(id) {
    const title = h('div', { class: 'cbs-title' });
    const board = h('div', { class: 'cbs-board' });
    const tip = h('div', {
      class: 'cbs-tip',
      text: 'Click the person this scenario is about – left-click: innocent, right-click: criminal. Esc skips.',
    });
    const root = h('div', { class: 'cbs-win', 'data-id': id }, title, board, tip);
    root.addEventListener('pointerdown', () => raise(root), true);
    title.addEventListener('pointerdown', e => startDrag(e, id));
    title.addEventListener('click', e => onWindowButton(e, id));
    title.addEventListener('dblclick', e => {
      const sc = byId(id);
      if (!sc || e.target.closest('.cbs-btn')) return;
      sc.min = !sc.min;
      saveSoon();
      render();
    });
    board.addEventListener('click', e => onTile(e, id, INNOCENT));
    board.addEventListener('contextmenu', e => onTile(e, id, CRIMINAL));
    const w = { root, title, board, tiles: [], key: '' };
    S.wins.set(id, w);
    layer.append(root);
    raise(root);
    return w;
  }

  function renderWindow(sc) {
    const w = S.wins.get(sc.id) || buildWindow(sc.id);
    const picking = S.picking === sc.id;
    const look = settings.style === 'full' ? ['full', settings.emojis, settings.clues] : ['minimal'];
    const key = JSON.stringify([sc.n, sc.base, sc.marks, sc.known, sc.tags, sc.consumed, sc.min, picking, look, S.cardsRev]);
    if (w.key === key) return;
    w.key = key;
    const verdict = sc.base != null ? sc.marks[sc.base] : null;
    w.root.classList.toggle('cbs-min', !!sc.min);
    w.root.classList.toggle('cbs-picking', picking);
    w.root.style.setProperty('--cbs-accent', verdict ? `var(--${verdict})` : 'transparent');
    renderTitle(w, sc, verdict, picking);
    renderTiles(w, sc);
  }

  function renderTitle(w, sc, verdict, picking) {
    const text = h('span', { class: 'cbs-text' });
    const card = verdict ? S.puzzle.cards[sc.base] : null;
    if (picking) {
      text.classList.add('cbs-muted');
      text.textContent = 'Pick the person…';
    } else if (card) {
      text.append('If ', h('span', { class: `cbs-chip cbs-${verdict}`, text: card.name }), ` is ${verdict}`);
      text.title = `If ${cap(card.name)} is ${verdict}`;
    } else {
      text.classList.add('cbs-muted');
      text.textContent = 'No base person';
    }
    const baseBtn = button('base', 'star', picking ? 'Stop picking (Esc)' : 'Choose who this scenario is about');
    baseBtn.classList.toggle('cbs-on', picking);
    w.title.replaceChildren(
      h('span', { class: 'cbs-num', text: `#${sc.n}` }),
      text,
      baseBtn,
      button('clear', 'clear', 'Clear marks (keeps the base) – click twice'),
      button('min', sc.min ? 'restore' : 'min', sc.min ? 'Restore' : 'Minimize'),
      button('delete', 'trash', 'Delete scenario – click twice'),
      button('close', 'close', 'Close (reopen it from the toolbar)'),
    );
  }

  const colLetter = col => String.fromCharCode(65 + col);
  const coordOf = card => `${colLetter(card.col)}${card.row + 1}`;

  function tileProps(card, idx, sc, classes) {
    const known = sc.known[idx];
    const who = `${coordOf(card)} ${cap(card.name)} (${card.profession})`;
    let title;
    if (known) {
      title = `${who} – revealed ${known}${card.hint?.text ? `: “${card.hint.text}”` : ''}`;
    } else {
      const mark = sc.marks[idx];
      const state = mark ? `marked ${mark}${sc.base === idx ? ', scenario base' : ''}` : 'unmarked';
      title = `${who} – ${state}\nLeft-click: innocent · Right-click: criminal · Shift+click: make base`;
    }
    return { class: classes.join(' '), 'data-idx': idx, style: `grid-area:${card.row + 2}/${card.col + 2}`, title };
  }

  /** Minimal look: name and profession on a tile coloured like the board. */
  function compactTile(card, idx, sc) {
    const known = sc.known[idx];
    const verdict = known || sc.marks[idx];
    const classes = ['cbs-tile', 'cbs-compact'];
    if (verdict) classes.push(`cbs-${verdict}`);
    if (known) classes.push('cbs-known');
    if (sc.base === idx) classes.push('cbs-base');
    if (card.name.length > 7) classes.push('cbs-long');
    const tags = (sc.tags[idx] || []).map((t, corner) =>
      t
        ? h('i', {
            class: `cbs-tag cbs-t${corner}`,
            style: `background-color:var(--tag-color-${t});background-image:var(--tag-pattern-${t},none);background-size:var(--tag-pattern-size-${t},auto)`,
          })
        : null,
    );
    return h(
      'div',
      tileProps(card, idx, sc, classes),
      h('div', { class: 'cbs-name', text: card.name }),
      h('div', { class: 'cbs-prof', text: card.profession }),
      tags,
    );
  }

  /** Corner tag exactly as the game renders it. */
  const gameTag = t =>
    h('div', {
      'aria-hidden': 'true',
      class: 'tag',
      style: t
        ? `--tag-pattern:var(--tag-pattern-${t});--tag-pattern-size:var(--tag-pattern-size-${t});--tag-color:var(--tag-color-${t});--tag-color-hover:var(--tag-color-${t})`
        : '--tag-pattern:none;--tag-pattern-size:auto',
    });

  /**
   * Full look: the game's own card markup, so the game's stylesheet draws it, scaled down with CSS zoom.
   * Revealed people get the card back with their clue; marked people keep the card front in the mark's colour.
   */
  function gameCard(card, idx, sc) {
    const known = sc.known[idx];
    const verdict = known || sc.marks[idx];
    const classes = ['card', 'cbs-tile', 'cbs-card', known ? 'flipped' : 'unflipped'];
    if (verdict) classes.push(verdict);
    if (known) classes.push('cbs-known');
    if (known && sc.consumed?.includes(idx)) classes.push('consumed');
    if (sc.base === idx) classes.push('cbs-base');
    const face = settings.emojis ? h('p', { class: 'face', text: card.face }) : null;
    const name = h('div', { class: 'name' }, h('h3', { class: 'name', text: card.name }));
    const profession = h('p', { class: 'profession', text: card.profession });
    const body = known
      ? h(
          'div',
          { class: `card-back ${known}` },
          face,
          name,
          profession,
          h('hr', { 'aria-hidden': 'true' }),
          // Clue HTML comes from the game's own card, which renders it the same way. With clues hidden the
          // card keeps the divider and an empty clue line, as the game does for a revealed card without one.
          h('p', settings.clues && card.hint ? { class: card.hint.cls, html: card.hint.html } : { class: 'hint' }),
        )
      : h('div', { class: 'card-front' }, face, name, profession);
    const tags = sc.tags[idx] || [0, 0];
    return h(
      'div',
      tileProps(card, idx, sc, classes),
      h('p', { class: 'coord', text: coordOf(card) }),
      body,
      h('div', {}, gameTag(tags[0]), gameTag(tags[1])),
    );
  }

  function renderTiles(w, sc) {
    const { cards, cols, rows } = S.puzzle;
    const full = settings.style === 'full';
    w.root.style.width = `${winWidth(cols)}px`; // minimized windows keep their width
    w.board.style.gridTemplateColumns = `${AXIS}px repeat(${cols}, ${TILE_W}px)`;
    w.board.style.gridTemplateRows = `${AXIS}px repeat(${rows}, ${full ? 'auto' : `${TILE_H}px`})`;
    const labels = [
      ...Array.from({ length: cols }, (_, c) =>
        h('div', { class: 'cbs-axis', style: `grid-area:1/${c + 2}`, text: colLetter(c) }),
      ),
      ...Array.from({ length: rows }, (_, r) => h('div', { class: 'cbs-axis', style: `grid-area:${r + 2}/1`, text: r + 1 })),
    ];
    w.tiles = cards.map((card, idx) => (full ? gameCard : compactTile)(card, idx, sc));
    w.board.replaceChildren(...labels, ...w.tiles);
  }

  /* ------------------------------------------------------------------ *
   * Rendering & layout
   * ------------------------------------------------------------------ */
  function render() {
    if (!S.board || !S.puzzle) return;
    const p = S.puzzle;
    if (p.view != null && (p.view === S.board.step || !p.scenarios.some(sc => sc.step === p.view))) {
      p.view = null;
    }
    const step = viewedStep();
    layer.style.setProperty('--cbs-card-zoom', String(TILE_W / S.board.cardW));
    const shown = new Set();
    for (const sc of p.scenarios) {
      if (sc.step !== step || sc.closed) continue;
      shown.add(sc.id);
      renderWindow(sc);
    }
    for (const [id, w] of S.wins) {
      if (shown.has(id)) continue;
      w.root.remove();
      S.wins.delete(id);
    }
    if (S.picking && !shown.has(S.picking)) S.picking = null;
    renderToolbar();
    layout();
  }

  function layout() {
    if (!S.board || layer.hidden) return;
    const L = layer.getBoundingClientRect();
    const g = S.board.grid.getBoundingClientRect();
    const a = { x: g.left - L.left, y: g.top - L.top, w: g.width, h: g.height };
    const maxX = document.documentElement.clientWidth - L.left - 4;
    S.anchor = a;
    S.gridSig = [a.x, a.y, a.w, a.h, maxX].join();
    toolbar.style.left = `${clamp(a.x + a.w / 2 - toolbar.offsetWidth / 2, 4, maxX - toolbar.offsetWidth)}px`;
    toolbar.style.top = `${Math.max(4, a.y - toolbar.offsetHeight - 10)}px`;
    for (const [id, w] of S.wins) {
      const sc = byId(id);
      if (!sc || w.root.classList.contains('cbs-dragging')) continue;
      w.root.style.left = `${clamp(a.x + sc.pos.dx, 4, maxX - w.root.offsetWidth)}px`;
      w.root.style.top = `${Math.max(4, a.y + sc.pos.dy)}px`;
    }
    drawLinks();
  }

  /**
   * Faint curve from each scenario to its base person's real tile, coloured by the assumption.
   * Where a curve passes over other cards it is faded further so clues stay readable.
   */
  function drawLinks() {
    const out = [];
    if (settings.links && S.board && S.puzzle) {
      const L = layer.getBoundingClientRect();
      const rel = el => {
        const r = el.getBoundingClientRect();
        return { left: r.left - L.left, top: r.top - L.top, right: r.right - L.left, bottom: r.bottom - L.top, w: r.width, h: r.height };
      };
      const n = v => Math.round(v * 10) / 10;
      for (const [id, w] of S.wins) {
        const sc = byId(id);
        const verdict = sc && sc.base != null ? sc.marks[sc.base] : null;
        const target = verdict ? S.board.cards[sc.base] : null;
        if (!target) continue;
        const win = rel(w.root);
        const t = rel(target.el);
        const tx = t.left + t.w / 2;
        const ty = t.top + t.h / 2;
        const from = !sc.min && w.tiles[sc.base] ? rel(w.tiles[sc.base]) : null;
        let d = '';
        let sx = 0;
        let sy = 0;
        if (win.right <= t.left - 6 || win.left >= t.right + 6) {
          const leftOfTile = win.right <= t.left;
          sx = leftOfTile ? win.right : win.left;
          sy = clamp(from ? from.top + from.h / 2 : win.top + TITLE_H / 2, win.top + 8, win.bottom - 8);
          const ex = leftOfTile ? t.left - 4 : t.right + 4;
          const mx = (sx + ex) / 2;
          d = `M${n(sx)},${n(sy)} C${n(mx)},${n(sy)} ${n(mx)},${n(ty)} ${n(ex)},${n(ty)}`;
        } else if (win.bottom <= t.top - 6 || win.top >= t.bottom + 6) {
          const aboveTile = win.bottom <= t.top;
          sy = aboveTile ? win.bottom : win.top;
          sx = clamp(from ? from.left + from.w / 2 : tx, win.left + 8, win.right - 8);
          const ey = aboveTile ? t.top - 4 : t.bottom + 4;
          const my = (sy + ey) / 2;
          d = `M${n(sx)},${n(sy)} C${n(sx)},${n(my)} ${n(tx)},${n(my)} ${n(tx)},${n(ey)}`;
        }
        out.push(
          `<g style="color:var(--${verdict})">` +
            (d
              ? `<path class="cbs-link" mask="url(#cbs-sc-under-cards)" d="${d}"/><circle class="cbs-dot" cx="${n(sx)}" cy="${n(sy)}" r="3"/>`
              : '') +
            `<rect class="cbs-ring" x="${n(t.left - 4)}" y="${n(t.top - 4)}" width="${n(t.w + 8)}" height="${n(t.h + 8)}" rx="9"/></g>`,
        );
      }
      if (out.length) {
        const holes = S.board.cards
          .map(c => rel(c.el))
          .map(r => `<rect x="${n(r.left)}" y="${n(r.top)}" width="${n(r.w)}" height="${n(r.h)}" rx="6"/>`)
          .join('');
        out.unshift(
          '<mask id="cbs-sc-under-cards" maskUnits="userSpaceOnUse" x="-20000" y="-20000" width="60000" height="60000">' +
            `<rect x="-20000" y="-20000" width="60000" height="60000" fill="#fff"/><g fill="#000" fill-opacity=".75">${holes}</g></mask>`,
        );
      }
    }
    svg.innerHTML = out.join('');
  }

  /* ------------------------------------------------------------------ *
   * Syncing with the game
   * ------------------------------------------------------------------ */
  function sync() {
    const b = readBoard();
    if (!b) {
      layer.hidden = true;
      S.board = null;
      return;
    }
    const wasHidden = layer.hidden;
    layer.hidden = false;
    const sig = [b.key, b.step, JSON.stringify(b.cards.map(c => [c.tags, c.consumed, c.face, c.hint]))].join('|');
    const prev = S.board;
    S.board = b;
    if (sig === S.boardSig && prev && prev.grid === b.grid && !wasHidden) return;
    S.boardSig = sig;

    if (!S.puzzle || S.puzzle.key !== b.key) {
      flushSave();
      for (const w of S.wins.values()) w.root.remove();
      S.wins.clear();
      S.picking = null;
      S.puzzle = loadPuzzle(b);
    } else if (prev && prev.key === b.key && prev.step !== b.step) {
      // Someone was identified. Keep showing the scenarios that were on screen;
      // they are hidden once a new scenario is started for the new board.
      const p = S.puzzle;
      if (p.view == null && p.scenarios.some(sc => sc.step === prev.step && !sc.closed)) p.view = prev.step;
      saveSoon();
    }

    if (refreshCards(S.puzzle, b)) {
      S.cardsRev++;
      saveSoon();
    }

    // Scenarios of the current board mirror its tags and dimmed clues; older ones keep what they had.
    const live = JSON.stringify({ tags: tagsOf(b), consumed: consumedOf(b) });
    for (const sc of S.puzzle.scenarios) {
      if (sc.step !== b.step || JSON.stringify({ tags: sc.tags, consumed: sc.consumed }) === live) continue;
      Object.assign(sc, JSON.parse(live));
      saveSoon();
    }
    render();
  }

  let syncQueued = false;
  function queueSync() {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(() => {
      syncQueued = false;
      sync();
    });
  }

  /** Catches board moves that no mutation or resize reports (fonts, banners, completion zoom). */
  function watchGrid() {
    if (!S.board) return;
    if (!S.board.grid.isConnected) return queueSync();
    const L = layer.getBoundingClientRect();
    const g = S.board.grid.getBoundingClientRect();
    const maxX = document.documentElement.clientWidth - L.left - 4;
    if ([g.left - L.left, g.top - L.top, g.width, g.height, maxX].join() !== S.gridSig) layout();
  }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (help && !help.hidden) help.hidden = true;
    if (settingsPanel && !settingsPanel.hidden) settingsPanel.hidden = true;
    if (S.picking) {
      S.picking = null;
      render();
    }
  }

  function start() {
    if (document.getElementById('cbs-sc-layer')) return;
    document.head.append(h('style', { id: 'cbs-sc-style', text: CSS }));
    buildUI();
    const root = document.getElementById('root') || document.body;
    new MutationObserver(queueSync).observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
      characterData: true,
    });
    window.addEventListener('resize', layout);
    document.addEventListener('keydown', onKey);
    window.addEventListener('pagehide', flushSave);
    document.addEventListener('visibilitychange', () => document.hidden && flushSave());
    setInterval(watchGrid, 700);
    sync();
  }

  start();
})();
