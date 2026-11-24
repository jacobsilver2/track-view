// Track View: DOM wiring. Shows one channel's whole chain (input → instrument → inserts →
// sends → output, fader pinned right) and follows LUNA's selected track unless pinned.
// Plugins show their own UA GUI (plugin-gui.js) where the user's install has one; the rest as a
// knob list.

const L = AddOnLogic;
const $ = (id) => document.getElementById(id);
const PREFS_KEY = 'com.jacobsilver.track_view:prefs';
const prefs = Object.assign({ follow: true, view: 'gui', folded: {}, mode: {}, hide: {} }, safeJSON(localStorage.getItem(PREFS_KEY)));
const savePrefs = () => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
function safeJSON(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }

let luna, session, channel;
let channelProps = null;       // L.liveProps for the shown channel
let tapeMachines = [];         // the session's tape machines
const PROP_NAMES = ['channel_strip_order', 'tape_ordering', 'tape_machine_uid', 'has_preamp', 'sidechain_enabled',
  'sidechain_stereo_collapse', 'transpose', 'midi_input_channel'];
let sessionOffs = [];          // live for the session
let channelOffs = [];          // live for the shown channel (structure listeners)
const chainB = new Luna.Bindings();   // the cards on screen
const stripB = new Luna.Bindings();   // the pinned strip

const say = (text, err = false) => { const s = $('status'); s.textContent = text; s.classList.toggle('error', err); };
const report = (e) => { console.error(e); say(String(e?.message || e), true); };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// ======================================================================== menus & tips

function showMenu(x, y, items) {
  const m = $('menu');
  m.replaceChildren();
  for (const it of items) {
    if (it === '-') { m.append(el('div', 'sep')); continue; }
    if (it.header) { m.append(el('div', 'hdr', it.header)); continue; }
    const row = el('div', 'mi' + (it.checked ? ' checked' : '') + (it.disabled ? ' disabled' : ''));
    row.append(el('span', null, it.label));
    if (it.kbd) row.append(el('span', 'kbd', it.kbd));
    if (!it.disabled) row.onclick = (e) => { e.stopPropagation(); hideMenu(); Promise.resolve().then(it.action).catch(report); };
    m.append(row);
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
}
function hideMenu() { $('menu').hidden = true; }
function menuUnder(button, items) { const r = button.getBoundingClientRect(); showMenu(r.left, r.bottom + 2, items); }
addEventListener('pointerdown', (e) => { if (!$('menu').contains(e.target)) hideMenu(); }, true);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (!$('menu').hidden) { hideMenu(); e.preventDefault(); } else if (!$('overlay').hidden) { closeOverlay(); e.preventDefault(); } }
});
addEventListener('blur', hideMenu);

function showTip(x, y, title, value) {
  const t = $('tip');
  t.replaceChildren(el('div', 't', title), el('div', 'v', value || '—'));
  t.hidden = false;
  const r = t.getBoundingClientRect();
  t.style.left = Math.max(4, Math.min(x + 14, innerWidth - r.width - 4)) + 'px';
  t.style.top = Math.max(4, Math.min(y - r.height - 8, innerHeight - r.height - 4)) + 'px';
}
const hideTip = () => { $('tip').hidden = true; };

// ======================================================================== knobs

/**
 * The wheel turns a control, unless the chain is being scrolled (PluginGui.scrolling): a
 * sideways wheel, or one that started scrolling a moment ago, passes on to the chain. Wheel
 * moves within half a second are one touch, so one undo step. `controlAt(e)` names the control
 * under the pointer (null: let the wheel scroll).
 */
function wheelable(node, controlAt, { tip } = {}) {
  let active = null, endTimer = 0, acc = 0, pending = null, raf = 0;
  const end = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; flush(); } active?.end(); active = null; hideTip(); };
  const flush = () => { raf = 0; if (pending && active) active.normalized.set(pending.v).catch(report); pending = null; };
  node.addEventListener('wheel', (e) => {
    if (!active && PluginGui.scrolling(e)) return;
    const c = active ?? controlAt(e);
    if (!c) return;
    e.preventDefault(); e.stopPropagation();
    if (!active) { active = c; acc = 0; c.begin(); }
    clearTimeout(endTimer); endTimer = setTimeout(end, 500);
    const dy = (e.deltaMode === 1 ? 16 : 1) * (Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX);
    const n = L.steps(c);
    let v = pending?.v ?? c.normalized.value ?? 0;
    if (n > 1 && n < 64) {
      acc += dy;
      if (Math.abs(acc) < 40) return;
      v = L.stepValue(Math.min(n - 1, Math.max(0, L.stepOf(v, n) + (acc < 0 ? 1 : -1))), n);
      acc = 0;
    } else {
      v = Math.min(1, Math.max(0, v - dy * (e.altKey ? 0.0002 : 0.001)));
    }
    pending = { v };
    if (!raf) raf = requestAnimationFrame(flush);
    tip?.(e, c);
  }, { passive: false });
}

/** A LUNA knob for a control: drag up/down, keys, double-click resets (Luna.bindDrag). */
function knobFor(control, { pan = false, bipolar = false, bindings, label } = {}) {
  const k = el('div', 'knob' + (pan ? ' pan' : '') + (bipolar || pan ? ' bipolar' : ''));
  k.append(el('div', 'arc'), el('div', 'cap'));
  const b = Luna.bindDrag(k, control, {
    bindings, label, pixelsPerUnit: 180,
    render: (v) => k.style.setProperty('--v', String(v ?? 0)),
    onBegin: (e) => showTip(e.clientX, e.clientY, label || control.name.value || '', control.display.value),
    onEnd: hideTip,
    onError: report,
  });
  let wheeling = false;
  wheelable(k, () => control, { tip: () => { wheeling = true; } });
  bindings?.on(control.display, () => {
    if (b.active || wheeling) { const r = k.getBoundingClientRect(); showTip(r.right, r.top + 10, label || control.name.value || '', control.display.value); }
  });
  k.addEventListener('pointerleave', () => { if (wheeling) { wheeling = false; hideTip(); } });
  return k;
}

// ======================================================================== cards

function cardShell(type, key, { title, section, color } = {}) {
  const card = el('div', `card ${type}`);
  card.dataset.key = key;
  const head = el('div', 'card-head');
  card.append(head);
  if (section) head.append(el('span', 'section', section));
  return { card, head };
}

function foldKey(c) { return `${c.type}:${c.slot?.pluginId.value ?? ''}:${c.key}`; }

/**
 * The plugin area's height, from the chain's wrapper: the wrapper's height never depends on the
 * chain's content, so a horizontal scrollbar coming or going cannot resize the cards (that fed
 * back into itself and froze the page inside LUNA). The chain always reserves the scrollbar.
 */
const SCROLLBAR = 10;
function bodyHeight() {
  return Math.max(60, $('chainWrap').clientHeight - SCROLLBAR - 18 - 2 - 24 - 12);
}

const SECTION = { recfx: 'Rec FX', midifx: 'MIDI FX', tape: 'Tape', console: 'Console', summing: 'Summing' };

/** How a plugin card shows its plugin: its own UA GUI, or a parameter list. */
function cardMode(c) {
  const slot = cardSlot(c);
  const modeKey = slot?.pluginId.value ?? '';
  const gui = slot && !slot.isEmpty ? PluginGui.known(modeKey) : null;   // undefined while asking
  const chosen = prefs.mode[modeKey] ?? (prefs.view === 'list' ? 'list' : 'gui');
  return { slot, gui, mode: chosen === 'gui' && gui ? 'gui' : 'list', modeKey };
}
/** The slot a plugin card stands for (an `alias.console` insert stands for the console slot). */
const cardSlot = (c) => (c.type === 'console' && c.console ? c.console : c.slot);

/**
 * A plugin card: inserts, the instrument, record and MIDI FX, tape, console and summing.
 * `B` is the card's own Bindings: a card whose plugin, view and fold are unchanged is kept
 * across rebuilds (renderChain), so its plugin GUI never reloads.
 */
function pluginCard(c, B) {
  const { slot, gui, mode, modeKey } = cardMode(c);
  const { card, head } = cardShell(c.type, c.key);
  const fk = foldKey(c);
  const folded = !!prefs.folded[fk];
  card.classList.toggle('folded', folded);

  const fold = el('button', 'icon-btn fold'); fold.title = folded ? 'Open' : 'Fold';
  fold.onclick = () => { prefs.folded[fk] = !folded; savePrefs(); requestChain(true); };

  const power = el('button', 'power');
  const renderPower = () => {
    const inn = L.isIn(slot);
    power.classList.toggle('off', !inn);
    card.classList.toggle('bypassed', !inn);
    power.title = inn ? 'Bypass' : 'Turn on';
  };
  if (slot && !slot.isEmpty) {
    power.onclick = () => L.toggleIn(slot).catch(report);
    B.on(slot.in, renderPower);
    // SDK 3.1.2: Effect.in's value moves but its onChange never fires, and it can lag its
    // bypass control; so the card reads and follows the control itself (L.isIn).
    if (slot.bypass) B.on(slot.bypass.normalized, renderPower);
    renderPower();
  } else power.disabled = true;

  const title = el('button', 'card-title', c.name || (c.type === 'instrument' ? 'No Instrument' : '—'));
  const renderOpen = () => title.classList.toggle('open', slot?.editorOpen.value === true);
  if (slot && !slot.isEmpty) {
    title.title = 'Show or hide the plugin window';
    title.onclick = () => (slot.editorOpen.value ? slot.closeEditor() : slot.openEditor()).catch(report);
    B.on(slot.editorOpen, renderOpen); renderOpen();
  } else if (c.type === 'instrument') {
    title.onclick = () => openPicker(c.slot, 'Choose Instrument');
  }

  const preset = el('span', 'preset');
  const renderPreset = () => {
    preset.textContent = slot?.presetName.value || '';
    preset.classList.toggle('dirty', slot?.presetDirty.value === true);
  };
  if (slot && !slot.isEmpty) {
    B.on(slot.presetName, renderPreset); B.on(slot.presetDirty, renderPreset); renderPreset();
    preset.title = 'Presets';
    preset.onclick = () => openPresets(slot, c.name);
  }

  const chev = el('button', 'icon-btn chev'); chev.title = 'Device menu';
  const menu = () => deviceMenu(c, slot, { gui, mode, modeKey, fk, folded });
  chev.onclick = () => menuUnder(chev, menu());
  head.append(fold, power);
  if (SECTION[c.type]) head.append(el('span', `tag tag-${c.type}`, SECTION[c.type]));
  head.append(title);
  // A tape card on a track names its multitrack tape machine.
  if (c.type === 'tape' && channel instanceof Luna.Track && channelProps?.tape_machine_uid) {
    const m = el('button', 'machine');
    const rm = () => {
      const uid = channelProps.tape_machine_uid.value;
      m.textContent = tapeMachines.find((x) => x.uid === uid)?.name ?? 'No Machine';
      m.classList.toggle('none', !uid);
    };
    B.on(channelProps.tape_machine_uid, rm); rm();
    m.title = 'Tape machine';
    m.onclick = () => menuUnder(m, tapeMenu());
    head.append(m);
  }
  if (slot?.sidechainInUse.value) { const sc = el('span', 'tag tag-sc', 'SC'); sc.title = 'Sidechain in use'; head.append(sc); }
  head.append(preset, chev);
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, menu()); });

  const err = slot?.pluginError.value ?? slot?.pluginLicenseError.value;
  if (err) { card.classList.add('error'); title.title = err; }

  const body = el('div', 'card-body');
  card.append(body);
  if (folded) return card;
  if (err) {
    const msg = el('div', 'card-error', err === 'mixer.missing_plug-in' ? 'Plugin not installed' : String(err));
    msg.title = String(err);
    card.append(msg);
  }

  if (!slot || slot.isEmpty) {
    // An empty instrument slot.
    body.classList.add('util');
    const b = el('button', 'pill add'); b.title = 'Choose Instrument';
    b.onclick = () => openPicker(c.slot, 'Choose Instrument');
    body.append(el('div', 'lbl', 'Instrument'), b);
    card.style.width = '150px';
    return card;
  }

  if (mode === 'gui' && gui) {
    body.classList.add('gui');
    const f = PluginGui.frame(gui, slot.path, bodyHeight());
    body.append(f.el);
    const size = (h) => { card.style.width = Math.max(140, f.resize(h) + 14) + 'px'; };
    size(bodyHeight());
    card._resize = size;
  } else {
    body.append(paramList(slot, B));
    const n = L.listedParams(slot).length;
    const rows = Math.max(1, Math.floor((bodyHeight() + 12 - 12) / 72));
    card.style.width = Math.min(560, Math.max(170, Math.ceil(n / rows) * 68 + 20)) + 'px';
  }
  return card;
}

/** What makes a plugin card look different: a change here rebuilds that card alone. */
function cardSignature(c) {
  const { slot, gui, mode } = cardMode(c);
  return JSON.stringify([
    c.type, c.key, c.name, slot?.pluginId.value ?? '', slot?.pluginError.value ?? '', slot?.pluginLicenseError.value ?? '',
    slot?.params.map((p) => p.name.value).join('|') ?? '', mode, gui ? 1 : gui === null ? 0 : '?', !!prefs.folded[foldKey(c)],
    slot?.sidechainInUse.value === true,
    mode === 'list' ? bodyHeight() : 0,     // a list re-flows; a GUI rescales in place
  ]);
}

function tapeMenu() {
  const uid = channelProps.tape_machine_uid.value;
  return [{ header: 'Tape Machine' },
    ...tapeMachines.map((m) => ({ label: m.name, checked: m.uid === uid, action: () => channelProps.tape_machine_uid.set(m.uid) })),
    { label: 'None', checked: !uid, action: () => channelProps.tape_machine_uid.set(null) }];
}

function deviceMenu(c, slot, { gui, mode, modeKey, fk, folded }) {
  const items = [];
  const filled = slot && !slot.isEmpty;
  if (filled) {
    items.push({ label: slot.editorOpen.value ? 'Hide Plugin Window' : 'Show Plugin Window', action: () => (slot.editorOpen.value ? slot.closeEditor() : slot.openEditor()) });
    items.push({ label: L.isIn(slot) ? 'Bypass' : 'Turn On', action: () => L.toggleIn(slot) });
    items.push('-');
    items.push({ label: 'Show Plugin GUI', checked: mode === 'gui', disabled: !gui, action: () => { prefs.mode[modeKey] = 'gui'; savePrefs(); return requestChain(true); } });
    items.push({ label: 'Show Parameters', checked: mode === 'list', action: () => { prefs.mode[modeKey] = 'list'; savePrefs(); return requestChain(true); } });
    items.push({ label: folded ? 'Open Card' : 'Fold Card', action: () => { prefs.folded[fk] = !folded; savePrefs(); return requestChain(true); } });
    items.push('-');
    items.push({ label: 'Presets…', action: () => openPresets(slot, c.name) });
    items.push({ label: 'Previous Preset', action: () => slot.previousPreset() });
    items.push({ label: 'Next Preset', action: () => slot.nextPreset() });
  }
  if (c.type === 'tape' && channel instanceof Luna.Track && channelProps?.tape_machine_uid) items.push('-', ...tapeMenu());
  const kind = c.type === 'instrument' ? 'Instrument' : SECTION[c.type] ?? null;
  if (slot) {
    items.push('-');
    items.push({ label: filled ? 'Replace…' : 'Choose…', action: () => openPicker(slot, kind ? `${filled ? 'Replace' : 'Choose'} ${kind}` : `Replace ${c.name}`) });
    if (c.type === 'insert') {
      const after = L.emptySlotAfter(channel, slot);
      items.push({ label: 'Add Device After…', disabled: !after, action: () => openPicker(after, 'Add Device') });
    }
    if (filled) items.push({ label: kind ? `Remove ${kind}` : 'Remove', action: () => slot.clear() });
  }
  return items;
}

/** A card's parameters as LUNA knobs, switches and choice buttons. */
function paramList(slot, B = chainB) {
  const grid = el('div', 'params');
  const fill = () => {
    grid.replaceChildren();
    for (const p of L.listedParams(slot)) {
      const cell = el('div', 'param');
      const name = el('div', 'pname', p.name.value ?? p.id);
      name.title = p.name.value ?? p.id;
      const val = el('div', 'pval');
      const renderVal = () => { val.textContent = String(p.display.value ?? '').trim(); };
      B.on(p.display, renderVal); renderVal();
      const steps = L.steps(p);
      if (steps === 2) {
        const b = el('button', 'lbtn lit-yellow pbtn', 'ON');
        const r = () => { b.classList.toggle('on', (p.normalized.value ?? 0) >= 0.5); b.textContent = String(p.display.value ?? '').trim().slice(0, 6) || 'ON'; };
        B.on(p.normalized, r); B.on(p.display, r); r();
        b.onclick = () => L.toggleParam(p).catch(report);
        cell.append(name, b);
      } else if (steps > 2 && steps <= 48) {
        const b = el('button', 'lbtn pmenu');
        B.on(p.display, () => { b.textContent = String(p.display.value ?? '').trim(); });
        b.textContent = String(p.display.value ?? '').trim();
        b.onclick = () => {
          const words = p.displayValues.value || [];
          const cur = L.stepOf(p.normalized.value ?? 0, steps);
          menuUnder(b, [{ header: p.name.value ?? '' }, ...Array.from({ length: steps }, (_, i) => ({ label: String(words[i] ?? i + 1), checked: i === cur, action: () => L.pickStep(p, i) }))]);
        };
        cell.append(name, b, val);
        val.hidden = true;
      } else {
        cell.append(name, knobFor(p, { bindings: B, label: p.name.value }), val);
      }
      grid.append(cell);
    }
    if (!grid.children.length) grid.append(el('div', 'lbl', slot.params.length ? 'No parameters' : 'Loading…'));
  };
  fill();
  return grid;
}

/** A small knob with its label and LUNA's display under it. */
function knobCell(control, label, opts = {}) {
  const cell = el('div', 'knobcell');
  const v = el('div', 'pval');
  // A bare number with a long tail (the delay reads "0.000000") is shown to two places.
  const rv = () => { const t = String(control.display.value ?? '').trim(); v.textContent = /^-?\d+\.\d{3,}$/.test(t) ? Number(t).toFixed(2) : t; };
  chainB.on(control.display, rv); rv();
  cell.append(el('div', 'lbl', label), knobFor(control, { bindings: chainB, label: opts.title ?? label, ...opts }), v);
  return cell;
}

/** A lit switch for a boolean engine property (L.liveProps), one undo step per click. */
function propSwitch(prop, text, title, cls = 'lit-yellow') {
  const b = el('button', `lbtn ${cls}`, text);
  b.title = title;
  const r = () => b.classList.toggle('on', prop.value === true);
  chainB.on(prop, r); r();
  b.onclick = () => prop.set(!prop.value).catch(report);
  return b;
}

function inputCard() {
  const { card, head } = cardShell('input', 'input', { section: 'Input' });
  const body = el('div', 'card-body util');
  card.append(body);
  const info = L.input(channel);
  const isInstrument = channel.trackType.value === 'instrument';
  if (channelProps?.has_preamp?.value) {
    const pre = el('span', 'tag tag-pre', 'PRE');
    pre.title = 'This input has an Apollo preamp (set its gain in UA Console)';
    head.append(pre);
  }
  const pill = el('div', 'pill dim', info.name);
  pill.title = 'Input (change it in LUNA)';
  body.append(pill);

  const row = el('div', 'row');
  if (info.trim) row.append(knobCell(info.trim, 'Trim', { title: 'Input Trim', bipolar: true }));
  if (info.delay) row.append(knobCell(info.delay, 'Delay', { title: 'Delay (latency offset)', bipolar: true }));
  const col = el('div', 'knobcell');
  col.style.gap = '4px';
  for (const pol of info.polarity) {
    const b = el('button', 'lbtn lit-yellow', 'Ø');
    b.title = pol.name.value ?? 'Polarity';
    const r = () => b.classList.toggle('on', pol.on);
    chainB.on(pol.real, r); r();
    b.onclick = () => pol.toggle().catch(report);
    col.append(b);
  }
  if (info.link) {
    const b = el('button', 'lbtn lit-yellow', 'LINK');
    b.title = 'Link the left and right trims';
    const r = () => b.classList.toggle('on', info.link.on);
    chainB.on(info.link.real, r); r();
    b.onclick = () => info.link.toggle().catch(report);
    col.append(b);
  }
  if (channel.inputMonitor && !isInstrument) {
    const m = el('button', 'lbtn lit-blue', 'I');
    m.title = 'Input monitor';
    const r = () => m.classList.toggle('on', channel.inputMonitor.value === true);
    chainB.on(channel.inputMonitor, r); r();
    m.onclick = () => channel.inputMonitor.set(!channel.inputMonitor.value).catch(report);
    col.append(m);
  }
  if (col.children.length) row.append(col);
  body.append(row);

  // Instrument tracks: the MIDI channel they listen on and their transpose.
  if (isInstrument && channelProps) {
    const midi = el('div', 'row midi');
    const ch = el('button', 'pill');
    const rc = () => { const v = channelProps.midi_input_channel.value; ch.textContent = v ? `Ch ${v}` : 'All Ch'; };
    chainB.on(channelProps.midi_input_channel, rc); rc();
    ch.title = 'MIDI channel';
    ch.onclick = () => menuUnder(ch, [{ header: 'MIDI Channel' },
      { label: 'All Channels', checked: !channelProps.midi_input_channel.value, action: () => channelProps.midi_input_channel.set(0) },
      ...Array.from({ length: 16 }, (_, i) => ({ label: `Channel ${i + 1}`, checked: channelProps.midi_input_channel.value === i + 1, action: () => channelProps.midi_input_channel.set(i + 1) }))]);
    const tr = channelProps.transpose;
    const down = el('button', 'lbtn', '−'), up = el('button', 'lbtn', '+'), tv = el('span', 'pval');
    const rt = () => { const v = tr.value ?? 0; tv.textContent = `${v > 0 ? '+' : ''}${v} st`; };
    chainB.on(tr, rt); rt();
    down.title = 'Transpose down'; up.title = 'Transpose up';
    down.onclick = () => tr.set(Math.max(-48, (tr.value ?? 0) - 1)).catch(report);
    up.onclick = () => tr.set(Math.min(48, (tr.value ?? 0) + 1)).catch(report);
    tv.title = 'Transpose (double-click resets)';
    tv.ondblclick = () => tr.set(0).catch(report);
    midi.append(ch, down, tv, up);
    body.append(el('div', 'lbl', 'MIDI'), midi);
  }
  body.append(el('div', 'lbl', (info.format || '').toUpperCase()));
  card.style.width = (info.delay ? 176 : 132) + 'px';
  return card;
}

/** An empty extension slot (tape, console, summing, record or MIDI FX): a narrow tile that adds one. */
function stubCard(c) {
  const card = el('div', `card stub stub-${c.kind}`);
  card.dataset.key = c.key;
  card.title = `Add ${c.label}`;
  card.append(el('div', 'plus'), el('div', 'lbl', c.label));
  card.onclick = () => openPicker(c.slot, `Add ${c.label}`);
  return card;
}

/**
 * The channel's sidechain: its switch, mono fold, input trim, the sidechain filter slot and
 * which inserts listen to it. With nothing set up it is a stub that turns it on.
 */
function sidechainCard(c) {
  const users = L.sidechainUsers(luna, channel);
  const filter = c.slot;
  const on = channelProps?.sidechain_enabled?.value === true;
  if (!on && filter.isEmpty && !users.some((u) => u.inUse)) {
    const stub = el('div', 'card stub stub-sidechain');
    stub.dataset.key = 'sidechain';
    stub.title = 'Turn on this channel\'s sidechain input';
    stub.append(el('div', 'plus'), el('div', 'lbl', 'Sidechain'));
    stub.onclick = () => channelProps?.sidechain_enabled?.set(true).catch(report);
    return stub;
  }
  const { card } = cardShell('sidechain', 'sidechain', { section: 'Sidechain' });
  const body = el('div', 'card-body util');
  card.append(body);
  card.style.width = '150px';
  const sw = el('div', 'row');
  if (channelProps?.sidechain_enabled) sw.append(propSwitch(channelProps.sidechain_enabled, 'ON', 'Sidechain input on'));
  if (channelProps?.sidechain_stereo_collapse) sw.append(propSwitch(channelProps.sidechain_stereo_collapse, 'MONO', 'Fold the sidechain to mono'));
  body.append(sw);
  const trim = channel.controls.items.find((x) => x.id === 'sidechain_input_trim');
  if (trim) body.append(knobCell(trim, 'SC Trim', { title: 'Sidechain Trim', bipolar: true }));
  body.append(el('div', 'lbl', 'Filter'));
  if (filter.isEmpty) {
    const add = el('button', 'pill add'); add.title = 'Add a sidechain filter';
    add.onclick = () => openPicker(filter, 'Sidechain Filter');
    body.append(add);
  } else {
    const row = el('div', 'row');
    const pw = el('button', 'power');
    const rp = () => pw.classList.toggle('off', !L.isIn(filter));
    chainB.on(filter.in, rp); if (filter.bypass) chainB.on(filter.bypass.normalized, rp); rp();
    pw.onclick = () => L.toggleIn(filter).catch(report);
    const nm = el('button', 'pill', L.pluginName(luna, filter));
    nm.title = 'Show the filter\'s window';
    nm.onclick = () => (filter.editorOpen.value ? filter.closeEditor() : filter.openEditor()).catch(report);
    nm.oncontextmenu = (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, [
      { label: 'Replace…', action: () => openPicker(filter, 'Sidechain Filter') }, { label: 'Remove Filter', action: () => filter.clear() }]); };
    row.append(pw, nm);
    body.append(row);
  }
  if (users.length) {
    body.append(el('div', 'lbl', 'Keyed'));
    for (const u of users) {
      const r = el('div', 'sc-user' + (u.inUse ? ' on' : ''), u.name);
      r.title = u.inUse ? 'Listening to a sidechain' : 'Can take a sidechain (choose its source in the plugin header in LUNA)';
      body.append(r);
    }
  }
  return card;
}

/**
 * A fader with LUNA's scale marks and a level meter, as the strip and each send strip draw it.
 * The cap and meter move by transform only (docs/DRAWING.md). Returns the parts to place.
 */
function buildFader(g, B, meterOf, { label = 'Volume', peakText = false } = {}) {
  const area = el('div', 'fader-area');
  const scale = el('div', 'scale');
  const fader = el('div', 'fader');
  const track = el('div', 'track'), cap = el('div', 'cap');
  fader.append(track, cap);
  const meter = el('div', 'meter');
  area.append(scale, fader, meter);
  const travel = () => Math.max(10, fader.clientHeight - 41);
  const placeCap = (v) => { cap.style.transform = `translateY(${(1 - (v ?? 0)) * travel()}px)`; };
  let tipAt = null;
  const tip = () => { if (tipAt) showTip(tipAt.x, tipAt.y, label, g.display.value); };
  const drag = Luna.bindDrag(fader, g, {
    bindings: B, label, pixelsPerUnit: 160, render: placeCap, onError: report,
    onBegin: (e) => { const r = fader.getBoundingClientRect(); tipAt = { x: r.right, y: e.clientY }; tip(); },
    onEnd: () => { tipAt = null; hideTip(); },
  });
  wheelable(fader, () => g, { tip: (e) => { tipAt = { x: fader.getBoundingClientRect().right, y: e.clientY }; tip(); } });
  fader.addEventListener('pointerleave', () => { if (!drag.active) { tipAt = null; hideTip(); } });
  B.on(g.display, tip);      // the tip follows the value while dragging or wheeling
  const marks = () => {
    scale.replaceChildren();
    const taper = g.taper.value;
    if (!taper) return;
    const t = travel();
    let last = -Infinity;
    for (const db of taper.marks({ compact: t < 120 })) {
      const y = 20.5 + (1 - taper.toNormalized(db)) * t;
      if (y - last < 11) continue;      // never let two labels touch
      last = y;
      const sp = el('span', null, db <= taper.minDb ? '∞' : String(Math.abs(db)));
      sp.style.top = `${y}px`;
      scale.append(sp);
    }
  };
  B.on(g.taper, marks);

  // Meter: one or two streams, a peak hold, the clip light.
  const m = meterOf();
  const streams = [];
  const n = Math.max(1, Math.min(2, m?.streams || 2));
  for (let i = 0; i < n; i++) {
    const st = el('div', 'stream'), iEl = el('i'), u = el('u'), b = el('b');
    iEl.append(u); st.append(iEl, b); meter.append(st);
    streams.push({ i: iEl, u, b });
  }
  const peak = el('div', 'peak', '');
  meter.append(peak);
  let hold = 0, lastText = '', lastClip = false;
  const clamp = (x) => Math.min(1, Math.max(0, x ?? 0));
  if (m) B.add(m.onChange(() => {
    const lv = m.level.value || [], pk = m.peak.value || [];
    streams.forEach((st, k) => {
      const v = clamp(lv[k] ?? lv[0]);
      st.i.style.transform = `translateY(${(1 - v) * 100}%)`;
      st.u.style.transform = `translateY(${-(1 - v) * 100}%)`;
      st.b.style.transform = `translateY(${(1 - clamp(pk[k] ?? pk[0])) * 100}%)`;
    });
    const mx = Math.max(0, ...pk.map((x) => x ?? 0));
    hold = Math.max(mx, hold * 0.995);
    const db = 60 * hold - 60;
    const t = hold > 0.001 ? db.toFixed(1) : '';
    if (t !== lastText) { lastText = t; peak.textContent = t; }
    const clip = (m.clip.value || []).some((x) => x);
    if (clip !== lastClip) { lastClip = clip; meter.classList.toggle('clip', clip); }
  }));
  peak.title = 'Peak hold (click to reset)';
  peak.onclick = () => { hold = 0; lastText = ''; peak.textContent = ''; meter.classList.remove('clip'); };

  const gain = el('div', 'gain');
  const rg = () => { gain.textContent = g.display.value ?? ''; };
  B.on(g.display, rg); rg();
  gain.title = 'Double-click to type a level';
  gain.ondblclick = () => {
    const input = el('input');
    input.value = String(g.real.value ?? 0);
    gain.replaceChildren(input); input.select(); input.focus();
    const done = B.hold();
    let finished = false;
    const finish = (commit) => {
      if (finished) return; finished = true;
      if (commit) { const v = parseFloat(input.value); if (Number.isFinite(v)) g.real.set(v).catch(report); }
      done(); rg();
    };
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
    input.onblur = () => finish(true);
  };
  const after = () => { placeCap(g.normalized.value); marks(); };
  requestAnimationFrame(after);
  return { area, gain, after };
}

/** The sends, each drawn as a small channel strip: destination, pan, PRE, mute, fader, meter. */
function sendsCard() {
  const { card } = cardShell('sends', 'sends', { section: 'Sends' });
  const body = el('div', 'card-body sends-body');
  card.append(body);
  const sends = L.sends(channel);
  for (const send of sends) {
    const st = el('div', 'sstrip');
    const bus = session.buses.byId(send.busUid.value);
    st.style.setProperty('--dest', bus ? L.cssColor(bus.color.value) : '#7d8a93');
    const dest = el('button', 'dest', send.destinations.value?.map((d) => d.name).join(', ') || '—');
    dest.title = 'Change or remove this send';
    dest.onclick = () => menuUnder(dest, [
      { header: `Send ${(send.index ?? 0) + 1}` },
      ...L.buses(session, channel).filter((b) => !b.isMaster).map((b) => ({ label: b.name.value ?? b.id, checked: send.busUid.value === b.id, action: () => send.retarget(b.id) })),
      '-',
      { label: 'Remove Send', action: () => send.unassign() },
    ]);
    const pans = el('div', 'pans');
    for (const [i, p] of send.pans.entries()) pans.append(knobFor(p, { pan: true, bindings: chainB, label: send.pans.length > 1 ? (i ? 'Send Pan R' : 'Send Pan L') : 'Send Pan' }));
    const btns = el('div', 'sbtns');
    const pre = el('button', 'sbtn pre', 'PRE');
    pre.title = 'Pre-fader';
    const rp = () => pre.classList.toggle('on', send.preFader.on);
    chainB.on(send.preFader.real, rp); rp();
    pre.onclick = () => send.preFader.toggle().catch(report);
    const mute = el('button', 'sbtn mute', 'M');
    mute.title = 'Mute this send';
    const rm = () => { mute.classList.toggle('on', send.mute.on); st.classList.toggle('muted', send.mute.on); };
    chainB.on(send.mute.real, rm); rm();
    mute.onclick = () => send.mute.toggle().catch(report);
    btns.append(pre, mute);
    const f = buildFader(send.gain, chainB, () => send.meter, { label: 'Send Level' });
    const plate = el('div', 'nameplate', `SEND ${(send.index ?? 0) + 1}`);
    st.append(dest, pans, btns, f.area, f.gain, plate);
    body.append(st);
  }
  const add = el('button', 'send-add');
  add.title = 'Add a send';
  add.append(el('div', 'plus'), el('div', 'lbl', 'Add Send'));
  add.onclick = () => {
    const buses = L.buses(session, channel).filter((b) => !b.isMaster);
    menuUnder(add, [{ header: 'Send To' },
      ...buses.map((b) => ({ label: b.name.value ?? b.id, action: () => L.addSend(channel, b.id) })),
      ...(buses.length ? ['-'] : []),
      { label: 'New Aux Bus…', action: async () => { const bus = await session.newBus({ name: 'Aux' }); await L.addSend(channel, bus.id); } },
    ]);
  };
  if (sends.length < 8) body.append(add);
  card.style.width = `${sends.length * 76 + (sends.length < 8 ? 34 : 0) + 14}px`;
  return card;
}

function outputCard() {
  const { card } = cardShell('output', 'output', { section: 'Output' });
  const body = el('div', 'card-body util');
  card.append(body);
  card.style.width = '132px';
  const isMaster = channel instanceof Luna.Bus && channel.isMaster;
  const pill = el('button', 'pill', isMaster ? 'Monitor / Hardware' : L.outputName(channel));
  if (!isMaster) {
    pill.title = 'Route the main output';
    pill.onclick = () => menuUnder(pill, [{ header: 'Output' },
      ...L.buses(session, channel).map((b) => ({ label: b.name.value ?? b.id, checked: channel.main.busUid.value === b.id, action: () => L.setOutput(channel, b.id) }))]);
  } else pill.classList.add('dim');
  body.append(pill);
  const tr = channel.main.controls.items.find((x) => x.id === 'gain_trim');
  if (tr) {
    const cell = el('div', 'knobcell');
    const v = el('div', 'pval');
    chainB.on(tr.display, () => { v.textContent = tr.display.value ?? ''; });
    v.textContent = tr.display.value ?? '';
    cell.append(el('div', 'lbl', 'Out Trim'), knobFor(tr, { bindings: chainB, label: 'Output Trim', bipolar: true }), v);
    body.append(cell);
  }
  return card;
}

function addTile(slot) {
  const card = el('div', 'card add');
  card.title = 'Add a device';
  card.append(el('div', 'plus'), el('div', 'lbl', 'Add Device'));
  card.onclick = () => openPicker(slot, 'Add Device');
  return card;
}

function gapAdd(slot) {
  const g = el('div', 'gap-add');
  g.title = `Add a device in slot ${L.slotIndex(slot) + 1}`;
  g.append(el('i'));
  g.onclick = () => openPicker(slot, 'Add Device');
  return g;
}

// Which toolbar filter shows each card.
const SECTIONS = [
  ['input', 'IN', 'Input'], ['recfx', 'REC', 'Record FX'], ['midifx', 'MIDI', 'MIDI FX'], ['instrument', 'INST', 'Instrument'],
  ['ext', 'EXT', 'Tape, console and summing'], ['fx', 'FX', 'Inserts'], ['sidechain', 'SC', 'Sidechain'], ['sends', 'SEND', 'Sends'], ['output', 'OUT', 'Output'],
];
function sectionOf(c) {
  const t = c.type === 'stub' ? c.kind : c.type;
  if (t === 'tape' || t === 'summing' || (t === 'console' && !c.console)) return 'ext';
  if (t === 'insert' || t === 'add' || t === 'console') return 'fx';
  return t;
}
const propValues = () => Object.fromEntries(PROP_NAMES.map((n) => [n, channelProps?.[n]?.value]));

// What the chain is made of: which cards, which plugins, which parameters, where the sends go,
// and how each card is shown. Only a change here re-renders, so value pushes, catalog updates
// and repeated notifications never touch the DOM under the pointer.
let chainSig = '';
function chainSignature() {
  if (!channel) return `none:${!!session}`;
  const slotSig = (s) => s ? `${s.id}=${s.pluginId.value ?? ''}!${s.pluginError.value ?? ''}[${s.params.map((c) => c.name.value).join('|')}]${s.sidechainInUse.value ? 'sc' : ''}${s.sidechainAllowed.value ? 'sa' : ''}` : '';
  return JSON.stringify([
    channel.id, $('chainWrap').clientHeight, prefs.view, prefs.mode, prefs.folded, prefs.hide,
    channel.effects.items.map(slotSig),
    channel.outputs.items.map((o) => `${o.id}>${(o.destinations.value ?? []).map((d) => d.busUid).join(',')}`),
    luna.plugins.items.length, propValues(), tapeMachines.map((m) => m.uid + m.name),
    channel.effects.items.map((s) => (s.isEmpty ? '' : String(PluginGui.known(s.pluginId.value) ? 1 : PluginGui.known(s.pluginId.value) === null ? 0 : '?'))),
  ]);
}

// Every Bindings with something on screen: the chain's own and one per kept plugin card.
const allBindings = () => [chainB, ...[...cardCache.values()].map((e) => e.B)];
function whenAllIdle(fn) {
  const busy = allBindings().find((b) => b.busy);
  return busy ? busy.whenIdle(() => whenAllIdle(fn)) : Promise.resolve().then(fn);
}

/** Re-render when the chain changed (or `force`), never mid-drag. */
function requestChain(force = false) {
  return whenAllIdle(() => {
    const sig = chainSignature();
    if (!force && sig === chainSig) return;
    renderChain();
  });
}

const PLUGIN_TYPES = new Set(['insert', 'instrument', 'console', 'recfx', 'midifx', 'tape', 'summing']);
/** Plugin cards kept across renders: `${channel}:${key}` -> { node, B, sig, h }. */
const cardCache = new Map();

/**
 * Render the chain. A plugin card whose signature is unchanged keeps its node, and a kept node
 * is never moved or re-inserted (that would reload an embedded plugin GUI): the other cards
 * are placed around it. A resize rescales kept cards in place.
 */
function renderChain() {
  chainSig = chainSignature();
  const chainEl = $('chain');
  const scroll = chainEl.scrollLeft;
  chainB.clear();
  $('empty').hidden = true;
  const used = new Set();
  const nodes = [];
  if (channel) {
    // A filtered-out card stays in place, hidden, so showing it again never reloads its GUI.
    const cards = L.chain(luna, channel, propValues());
    const slots = channel.effectSlots;
    const h = bodyHeight();
    let prevSlotIdx = -1, shown = 0;
    cards.forEach((c) => {
      const hide = !!prefs.hide?.[sectionOf(c)];
      const at = nodes.length;
      if (!hide && shown++ > 0 && c.type !== 'add') nodes.push(el('div', 'flow'));
      // An empty slot between two devices: a + there inserts in place.
      if ((c.type === 'insert' || c.type === 'console') && c.slot && slots.includes(c.slot)) {
        const idx = slots.indexOf(c.slot);
        const between = slots.slice(prevSlotIdx + 1, idx).find((s) => s.isEmpty);
        if (between && prevSlotIdx >= 0 && !hide) nodes.splice(at + (nodes.length > at ? 1 : 0), 0, gapAdd(between));
        prevSlotIdx = idx;
      }
      const hideLast = () => { nodes[nodes.length - 1].hidden = hide; };
      if (PLUGIN_TYPES.has(c.type)) {
        const key = `${channel.id}:${c.key}`;
        const sig = cardSignature(c);
        let entry = cardCache.get(key);
        if (entry && entry.sig === sig) {
          if (entry.h !== h) { entry.node._resize?.(h); entry.h = h; }
        } else {
          entry?.B.clear();
          const B = new Luna.Bindings();
          entry = { node: pluginCard(c, B), B, sig, h };
          cardCache.set(key, entry);
        }
        used.add(key);
        nodes.push(entry.node);
        hideLast();
        return;
      }
      switch (c.type) {
        case 'input': nodes.push(inputCard()); break;
        case 'add': nodes.push(addTile(c.slot)); break;
        case 'stub': nodes.push(stubCard(c)); break;
        case 'sidechain': nodes.push(sidechainCard(c)); break;
        case 'sends': nodes.push(sendsCard()); break;
        case 'output': nodes.push(outputCard()); break;
      }
      hideLast();
    });
  }
  for (const [key, entry] of cardCache) if (!used.has(key)) { entry.B.clear(); cardCache.delete(key); }

  // Place: drop what is gone, then put each node before the next kept one.
  const keep = new Set(nodes.filter((n) => n.parentNode === chainEl));
  for (const ch of [...chainEl.children]) if (!keep.has(ch)) ch.remove();
  let cursor = chainEl.firstElementChild;
  for (const n of nodes) {
    if (n === cursor) { cursor = cursor.nextElementSibling; continue; }
    chainEl.insertBefore(n, cursor);     // new nodes; a kept one only if the order changed
  }
  chainEl.scrollLeft = scroll;
  if (!channel) { $('empty').textContent = session ? 'No channel' : 'No session open in LUNA'; $('empty').hidden = false; }
  else if (!nodes.some((n) => !n.hidden)) { $('empty').textContent = 'Every section is filtered out'; $('empty').hidden = false; }
  const loaded = channel ? channel.loadedEffects.filter((s) => !L.isConsoleAlias(s)).length : 0;
  $('fxText').textContent = channel ? `${loaded} insert${loaded === 1 ? '' : 's'}` : '—';
}

// Vertical wheel scrolls the chain sideways, as Bitwig's device panel does.
// Every wheel that reaches the chain scrolls it (controls take theirs first, see wheelable) and
// starts a scroll gesture, so passing over a knob mid-scroll does not turn it.
$('chain').addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    if (e.target.closest('.params, #notes')) return;
    $('chain').scrollLeft += e.deltaY; e.preventDefault();
  }
  PluginGui.markScroll();
}, { passive: false });

// Panel resizes (dragging LUNA's editor divider) rebuild once the size settles.
let lastH = 0, resizeTimer = 0;
new ResizeObserver(() => {
  const h = $('chainWrap').clientHeight;
  if (Math.abs(h - lastH) <= 2) return;
  lastH = h;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { void requestChain(); void stripB.whenIdle(renderStrip); }, 120);
}).observe($('chainWrap'));

PluginGui.onKnown(() => void requestChain());
PluginGui.onWheel((d) => { $('chain').scrollLeft += d; });

// ======================================================================== the strip

function renderStrip() {
  const s = $('strip');
  stripB.clear();
  s.replaceChildren();
  if (!channel) return;
  const isTrack = !(channel instanceof Luna.Bus);

  const auto = el('div', 'auto');
  const ra = () => { const m = channel.automationMode.value ?? 'read'; auto.textContent = String(m).toUpperCase(); auto.className = `auto ${m}`; };
  stripB.on(channel.automationMode, ra); ra();
  if (isTrack) auto.onclick = () => menuUnder(auto, ['off', 'read', 'touch', 'latch', 'write'].map((m) => ({ label: m.toUpperCase(), checked: channel.automationMode.value === m, action: () => channel.setAutomationMode(m) })));
  s.append(auto);

  const pans = el('div', 'pans');
  const pc = channel.main.pans;
  for (const [i, p] of pc.entries()) pans.append(knobFor(p, { pan: true, bindings: stripB, label: pc.length > 1 ? (i ? 'Pan R' : 'Pan L') : 'Pan' }));
  s.append(pans);

  const btns = el('div', 'btns');
  if (isTrack) {
    const arm = el('button', 'sbtn arm', 'ARM');
    const r = () => arm.classList.toggle('on', channel.recordEnabled.value === true);
    stripB.on(channel.recordEnabled, r); r();
    arm.onclick = () => channel.recordEnabled.set(!channel.recordEnabled.value).catch(report);
    const mon = el('button', 'sbtn monitor', 'I');
    mon.title = 'Input monitor';
    const rm = () => mon.classList.toggle('on', channel.inputMonitor.value === true);
    stripB.on(channel.inputMonitor, rm); rm();
    mon.onclick = () => channel.inputMonitor.set(!channel.inputMonitor.value).catch(report);
    btns.append(arm, mon);
  }
  const solo = isTrack ? channel.solo : channel.controls.items.find((c) => c.id === 'solo');
  if (solo) {
    const b = el('button', 'sbtn solo', 'S');
    const safe = channel.controls.items.find((c) => c.id === 'solo_safe');
    const r = () => { b.classList.toggle('on', solo.on); b.classList.toggle('safe', !!safe?.on); b.title = safe?.on ? 'Solo safe (right-click to change)' : 'Solo (right-click for Solo Safe)'; };
    stripB.on(solo.real, r); if (safe) stripB.on(safe.real, r); r();
    b.onclick = () => solo.toggle().catch(report);
    if (safe) b.oncontextmenu = (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, [{ label: 'Solo Safe', checked: safe.on, action: () => safe.toggle() }]); };
    btns.append(b);
  }
  const mute = el('button', 'sbtn mute', 'M');
  const rmu = () => mute.classList.toggle('on', channel.mute.on);
  stripB.on(channel.mute.real, rmu); rmu();
  mute.onclick = () => channel.mute.toggle().catch(report);
  btns.append(mute);
  if (!solo) btns.style.gridTemplateColumns = '1fr';
  s.append(btns);

  // Fader, scale and meter.
  const f = buildFader(channel.gain, stripB, () => channel.meter, { label: 'Volume', peakText: true });
  s.append(f.area, f.gain);
  const name = el('div', 'nameplate', channel.name.value ?? '');
  s.append(name);
  stripB.on(channel.name, () => { name.textContent = channel.name.value ?? ''; });
}

// ======================================================================== header

const ICONS = {
  audio: '<svg viewBox="0 0 18 16"><rect x="1" y="6" width="2" height="4"/><rect x="5" y="3" width="2" height="10"/><rect x="9" y="1" width="2" height="14"/><rect x="13" y="4" width="2" height="8"/></svg>',
  instrument: '<svg viewBox="0 0 18 16"><rect x="1" y="2" width="16" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="4" y="2" width="2" height="7"/><rect x="8" y="2" width="2" height="7"/><rect x="12" y="2" width="2" height="7"/></svg>',
  bus: '<svg viewBox="0 0 18 16"><path d="M2 2h3v12H2zM7 5l9 3-9 3z"/></svg>',
  folder: '<svg viewBox="0 0 18 16"><path d="M1 3h6l2 2h8v9H1z"/></svg>',
  master: '<svg viewBox="0 0 18 16"><path d="M2 5h4l5-4v14l-5-4H2z"/><rect x="13" y="4" width="1.6" height="8"/><rect x="15.5" y="2" width="1.6" height="12"/></svg>',
};

function renderHeader() {
  const kind = channel ? L.kindOf(channel) : '';
  document.documentElement.style.setProperty('--track', channel ? L.cssColor(channel.color.value) : '#7d8a93');
  $('trackName').textContent = channel ? channel.name.value ?? channel.id : session ? 'No channel' : 'No session';
  $('kindIcon').innerHTML = ICONS[kind] || ICONS.audio;
  $('kindText').textContent = kind ? kind.toUpperCase() : '—';
  $('fmtText').textContent = channel ? String(channel.stemFormat.value ?? '—').toUpperCase() : '—';
  $('follow').classList.toggle('on', prefs.follow);
  $('follow').classList.add('lit-yellow');
  $('viewMode').textContent = prefs.view === 'list' ? 'LIST' : 'GUI';
  for (const b of $('filters').children) b.classList.toggle('on', !prefs.hide[b.dataset.section]);
  const folder = channel?.folderUid.value ? session?.buses.byId(channel.folderUid.value) : null;
  $('folderField').hidden = !folder;
  $('folderText').textContent = folder?.name.value ?? '';
  const isTrack = channel instanceof Luna.Track;
  $('presetField').hidden = !isTrack;
  $('presetBtn').textContent = (isTrack && channel.presetName.value) || 'None';
  $('badges').replaceChildren(
    ...(channel?.frozen.value ? [el('span', 'tag tag-frozen', 'FROZEN')] : []),
    ...(channel && channel.enabled.value === false ? [el('span', 'tag tag-off', 'INACTIVE')] : []));
  const notes = $('notes');
  notes.hidden = !channel;
  if (channel && document.activeElement !== notes) notes.value = channel.comments.value ?? '';
}

// Section filters: each button shows or hides a part of the chain.
for (const [key, text, title] of SECTIONS) {
  const b = el('button', 'lbtn lit-yellow filter', text);
  b.dataset.section = key;
  b.title = `${title} (click to show or hide; Option-click to show only this)`;
  b.onclick = (e) => {
    if (e.altKey) {
      const only = SECTIONS.every(([k]) => (k === key) !== !!prefs.hide[k]);
      for (const [k] of SECTIONS) prefs.hide[k] = only ? false : k !== key;
    } else prefs.hide[key] = !prefs.hide[key];
    savePrefs(); renderHeader(); void requestChain();
  };
  $('filters').append(b);
}

// Track presets: LUNA's own track preset browser, loaded onto the shown track.
$('presetBtn').onclick = () => { if (channel instanceof Luna.Track) openTrackPresets(channel); };

// Comments: saved when the field loses focus (one undo step), as LUNA's own comments field.
$('notes').onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.target.value = channel?.comments.value ?? ''; e.target.blur(); } };
$('notes').onchange = () => { if (channel) channel.comments.set($('notes').value).catch(report); };

$('follow').onclick = () => {
  prefs.follow = !prefs.follow; savePrefs();
  if (prefs.follow && session) void show(session.focusedTrack.value);
  renderHeader();
};
$('viewMode').onclick = () => {
  prefs.view = prefs.view === 'list' ? 'gui' : 'list';
  prefs.mode = {};      // the global switch resets each card's own choice
  savePrefs(); renderHeader(); void requestChain(true);
};
$('trackName').onclick = () => {
  if (!session) return;
  const all = L.channels(session);
  const group = (k) => all.filter((c) => (k === 'tracks' ? c.channel instanceof Luna.Track : k === 'buses' ? c.kind === 'bus' || c.kind === 'folder' : c.kind === 'master'));
  const item = (c) => ({
    label: c.name, checked: channel?.id === c.id,
    action: async () => {
      // Following, a track picked here is selected in LUNA too; a bus pins the view.
      if (prefs.follow && c.channel instanceof Luna.Track) {
        await session.context.select({ trackUids: [c.id] }).catch(() => {});
        return show(c.channel);
      }
      if (c.channel instanceof Luna.Bus) { prefs.follow = false; savePrefs(); }
      return show(c.channel);
    },
  });
  menuUnder($('trackName'), [
    { header: 'Tracks' }, ...group('tracks').map(item),
    ...(group('buses').length ? [{ header: 'Buses' }, ...group('buses').map(item)] : []),
    { header: 'Master' }, ...group('master').map(item),
  ]);
};

// ======================================================================== pickers

function openOverlay(node) {
  const o = $('overlay');
  o.replaceChildren(node);
  o.hidden = false;
  o.onpointerdown = (e) => { if (e.target === o) closeOverlay(); };
}
function closeOverlay() { const o = $('overlay'); o.hidden = true; o.replaceChildren(); thumbObserver?.disconnect(); }

let thumbObserver = null;

/** The device browser: search, categories, favorites, tiles with each UA plugin's own icon. */
async function openPicker(slot, title) {
  if (!slot) return;
  const box = el('div', 'picker');
  const head = el('div', 'picker-head');
  const search = el('input'); search.type = 'search'; search.placeholder = 'Search plugins';
  const count = el('span', 'count');
  const fav = el('button', 'chip', '★ Favorites');
  const close = el('button', 'lbtn', 'CLOSE'); close.onclick = closeOverlay;
  head.append(el('span', 'ttl', title), search, fav, el('span', 'spacer'), count, close);
  const chips = el('div', 'chips');
  const tiles = el('div', 'tiles');
  box.append(head, chips, tiles);
  openOverlay(box);
  search.focus();

  let all = [];
  try { all = await slot.validPlugins(); }
  catch (e) {
    if (!(e instanceof Luna.Unsupported)) { report(e); }
    all = luna.plugins.items.filter((p) => p.installed.value !== false && p.authorized.value !== false)
      .map((p) => ({ pluginId: p.id, name: p.name.value ?? p.id, manufacturer: p.manufacturer ?? '', categories: p.categories, favorite: p.favorite.value === true }));
  }
  const cats = [...new Set(all.flatMap((p) => p.categories || []))].filter((c) => c && c !== 'All').sort();
  let cat = '', favOnly = false;
  const chipFor = (label, value) => {
    const c = el('button', 'chip' + (cat === value ? ' on' : ''), label);
    c.onclick = () => { cat = value; for (const x of chips.children) x.classList.remove('on'); c.classList.add('on'); draw(); };
    return c;
  };
  chips.append(chipFor('All', ''), ...cats.map((c) => chipFor(c, c)));
  fav.onclick = () => { favOnly = !favOnly; fav.classList.toggle('on', favOnly); draw(); };

  thumbObserver?.disconnect();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const t = en.target; thumbObserver.unobserve(t);
      // A native UA plugin's own icon, from the user's install, when there is one.
      PluginGui.lookup(t.dataset.id).then((g) => {
        if (!g?.icon) return;
        const img = new Image();
        img.onload = () => t.replaceChildren(img);
        img.src = g.icon;
      });
    }
  }, { root: tiles, rootMargin: '200px' });

  function draw() {
    const q = search.value.trim().toLowerCase();
    const rows = all.filter((p) => (!cat || (p.categories || []).includes(cat)) && (!favOnly || p.favorite)
      && (!q || `${p.name} ${p.manufacturer ?? ''}`.toLowerCase().includes(q)));
    count.textContent = `${rows.length} plugin${rows.length === 1 ? '' : 's'}`;
    tiles.replaceChildren(...rows.slice(0, 400).map((p) => {
      const t = el('div', 'tile');
      const thumb = el('div', 'thumb');
      thumb.dataset.name = p.name;
      thumb.dataset.id = p.pluginId;
      thumb.append(el('div', 'noicon'));
      const mf = el('div', 'mf');
      if (p.favorite) mf.append(el('span', 'fav', '★'));
      mf.append(el('span', null, (p.manufacturer || (String(p.pluginId).startsWith('uaudio') ? 'Universal Audio' : '')).replace(/_/g, ' ')));
      t.append(thumb, el('div', 'nm', p.name), mf);
      t.title = p.name;
      t.onclick = async () => {
        closeOverlay();
        say(`Loading ${p.name}…`);
        try { await slot.setPlugin(p.pluginId, { timeoutMs: 20000 }); say(session?.name.value ?? ''); }
        catch (e) { report(e); setTimeout(() => say(session?.name.value ?? ''), 4000); }
      };
      if (/^uaudio_/.test(p.pluginId)) thumbObserver.observe(thumb);
      return t;
    }));
  }
  let timer;
  search.oninput = () => { clearTimeout(timer); timer = setTimeout(draw, 80); };
  search.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') closeOverlay(); if (e.key === 'Enter') tiles.querySelector('.tile')?.click(); };
  draw();
}

/** Presets for a slot: search and tags through LUNA's own preset selection. */
async function openPresets(slot, name) {
  const box = el('div', 'picker');
  const head = el('div', 'picker-head');
  const search = el('input'); search.type = 'search'; search.placeholder = 'Search presets';
  const count = el('span', 'count');
  const close = el('button', 'lbtn', 'CLOSE'); close.onclick = closeOverlay;
  head.append(el('span', 'ttl', `${name} · Presets`), search, el('span', 'spacer'), count, close);
  const list = el('div', 'list');
  box.append(head, list);
  openOverlay(box);
  search.focus();
  const sel = luna.presets.selection(slot.pluginId.value);
  const obs = new MutationObserver(() => { if ($('overlay').hidden) { sel.dispose(); obs.disconnect(); } });
  obs.observe($('overlay'), { attributes: true });
  try { await sel.ready(); } catch (e) { report(e); return; }
  const draw = () => {
    const items = sel.presets.items;
    count.textContent = `${items.length}`;
    list.replaceChildren(...items.map((p) => {
      const li = el('div', 'li' + (p.uid === slot.presetUid.value ? ' cur' : ''));
      li.append(el('span', null, p.name.value ?? p.name ?? ''));
      li.onclick = async () => { closeOverlay(); try { await slot.loadPreset(p.uid); } catch (e) { report(e); } };
      return li;
    }));
  };
  sel.presets.onChange(draw);
  draw();
  search.oninput = () => sel.search.set(search.value);
  search.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') closeOverlay(); };
}

/** Track presets, as LUNA's track preset browser lists them. */
async function openTrackPresets(track) {
  const box = el('div', 'picker');
  const head = el('div', 'picker-head');
  const search = el('input'); search.type = 'search'; search.placeholder = 'Search track presets';
  const count = el('span', 'count');
  const close = el('button', 'lbtn', 'CLOSE'); close.onclick = closeOverlay;
  head.append(el('span', 'ttl', `${track.name.value ?? ''} · Track Presets`), search, el('span', 'spacer'), count, close);
  const list = el('div', 'list');
  box.append(head, list);
  openOverlay(box);
  search.focus();
  const sel = luna.presets.trackSelection(track.trackType.value === 'instrument' ? { category: 'Instrument' } : {});
  const obs = new MutationObserver(() => { if ($('overlay').hidden) { sel.dispose(); obs.disconnect(); } });
  obs.observe($('overlay'), { attributes: true });
  try { await sel.ready(); } catch (e) { report(e); return; }
  const draw = () => {
    const items = sel.presets.items;
    count.textContent = `${items.length}`;
    list.replaceChildren(...items.map((p) => {
      const li = el('div', 'li' + (p.uid === track.presetUid.value ? ' cur' : ''));
      li.append(el('span', null, p.name.value ?? p.name ?? ''));
      li.onclick = async () => {
        closeOverlay();
        say(`Loading ${p.name.value ?? p.name ?? 'preset'}…`);
        try { await track.loadPreset(p.uid); say(session?.name.value ?? ''); } catch (e) { report(e); }
      };
      return li;
    }));
  };
  sel.presets.onChange(draw);
  draw();
  search.oninput = () => sel.search.set(search.value);
  search.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') closeOverlay(); };
}

// ======================================================================== showing a channel

let showSeq = 0;
async function show(ch) {
  const seq = ++showSeq;
  for (const off of channelOffs) off();
  channelOffs = [];
  channel = ch;
  channelProps = null;
  if (!prefs.follow && ch) { prefs.pinned = ch.id; savePrefs(); }   // a pinned channel survives a reload
  renderHeader();
  if (!ch) { chainB.clear(); renderChain(); renderStrip(); return; }
  try {
    await Promise.all([ch.loadStrip(), ch.controls.load(), ch.effects.load(), ch.outputs.load()]);
    await Promise.all(ch.effects.items.filter((s) => !s.isEmpty).map((s) => s.controls.load().catch(() => {})));
  } catch (e) { report(e); }
  if (seq !== showSeq) return;
  const rebuild = () => void requestChain();
  // Strip settings the SDK does not type yet, live (L.liveProps), and the session's tape machines.
  const props = L.liveProps(luna, ch, PROP_NAMES);
  channelOffs.push(() => props.dispose());
  await props.ready;
  L.tapeMachines(luna, session).then((m) => { tapeMachines = m; rebuild(); }).catch(() => {});
  if (seq !== showSeq) return;
  channelProps = props;
  for (const n of ['channel_strip_order', 'tape_ordering', 'sidechain_enabled', 'has_preamp']) channelOffs.push(props[n].onChange(rebuild));
  // Each slot's parameter list: rebuild when a plugin comes, goes, or its parameters arrive or
  // leave (a new plugin's controls are pushed after it loads, fact 86). The signature check in
  // requestChain makes every other notification free.
  const watched = new Map();   // control -> unsubscribe
  const watchControls = (slot) => {
    for (const c of slot.controls.items) {
      if (watched.has(c)) continue;
      watched.set(c, c.initialized.onChange(rebuild));
    }
    rebuild();
  };
  for (const slot of ch.effects.items) {
    channelOffs.push(slot.pluginId.onChange(() => { if (!slot.isEmpty) slot.controls.load().catch(() => {}); rebuild(); }));
    channelOffs.push(slot.pluginError.onChange(rebuild));
    channelOffs.push(slot.sidechainInUse.onChange(rebuild), slot.sidechainAllowed.onChange(rebuild));
    channelOffs.push(slot.controls.onChange(() => watchControls(slot)));
    watchControls(slot);
  }
  channelOffs.push(() => { for (const off of watched.values()) off(); watched.clear(); });
  channelOffs.push(ch.effects.onChange(rebuild));
  for (const o of ch.outputs.items) channelOffs.push(o.destinations.onChange(rebuild));
  channelOffs.push(ch.name.onChange(renderHeader), ch.color.onChange(renderHeader), ch.stemFormat.onChange(renderHeader),
    ch.comments.onChange(renderHeader), ch.frozen.onChange(renderHeader), ch.enabled.onChange(renderHeader), ch.folderUid.onChange(renderHeader));
  if (ch instanceof Luna.Track) channelOffs.push(ch.presetName.onChange(renderHeader));
  channelOffs.push(luna.plugins.onChange(rebuild));
  renderHeader();
  await requestChain(true);
  await stripB.whenIdle(renderStrip);
}

async function bindSession() {
  for (const off of sessionOffs) off();
  sessionOffs = [];
  session = luna.sessions.current();
  if (!session) { say('no session open'); await show(undefined); return; }
  await session.ready();
  say(session.name.value ?? '');
  sessionOffs.push(session.name.onChange(() => say(session.name.value ?? '')));
  sessionOffs.push(session.focusedTrack.onChange(() => { if (prefs.follow) void show(session.focusedTrack.value); }));
  // The shown channel deleted: fall back to the selection.
  const gone = () => {
    if (channel && !session.tracks.byId(channel.id) && !session.buses.byId(channel.id)) void show(session.focusedTrack.value);
  };
  sessionOffs.push(session.tracks.onChange(gone), session.buses.onChange(gone));
  const start = (!prefs.follow && prefs.pinned && (session.tracks.byId(prefs.pinned) || session.buses.byId(prefs.pinned))) || session.focusedTrack.value;
  await show(start);
}


async function connect() {
  for (;;) {
    try { luna = await Luna.connect(); break; }
    catch (e) {
      say(e instanceof Luna.NotRunning ? 'waiting for LUNA…' : e.message, !(e instanceof Luna.NotRunning));
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  Luna.bindShortcuts(luna);
  luna.status.onChange(() => {
    if (luna.status.value === 'disconnected') say('reconnecting…', true);
    else if (luna.status.value === 'connected' && session) say(session.name.value ?? '');
  });
  await luna.plugins.load().catch(report);
  await luna.sessions.ready();
  luna.sessions.focused.onChange(() => void bindSession());
  await bindSession();
}

renderHeader();
connect();
