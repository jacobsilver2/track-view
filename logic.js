// Track View: logic with no DOM, so tests can exercise it against Luna.MockEngine.
//
// A channel's whole signal chain, left to right, as JSdaw's Track view and Bitwig's device
// panel show it: its input, the instrument, each insert, its sends and its output; the fader
// is pinned at the right. These functions take SDK objects and return plain data, or perform
// one engine action.

const AddOnLogic = {
  /** Every channel the view can show: the visible tracks, then aux buses, then the master. */
  channels(session) {
    const out = session.visibleTracks.map((t) => ({ id: t.id, name: t.name.value ?? t.id, kind: AddOnLogic.kindOf(t), channel: t }));
    for (const b of session.buses.items) {
      if (b.isMaster || b.busType.value !== 'aux') continue;
      out.push({ id: b.id, name: b.name.value ?? b.id, kind: b.isFolder ? 'folder' : 'bus', channel: b });
    }
    const m = session.master;
    if (m) out.push({ id: m.id, name: m.name.value ?? 'Main Output', kind: 'master', channel: m });
    return out;
  },

  /** audio | instrument | bus | folder | master | … */
  kindOf(ch) {
    if (ch instanceof Luna.Bus) return ch.isMaster ? 'master' : ch.isFolder ? 'folder' : 'bus';
    return ch.trackType?.value ?? 'audio';
  },

  /** The channel's color as CSS (engine colors are packed ARGB). */
  cssColor(argb, fallback = '#7d8a93') {
    return typeof argb === 'number' ? `#${(argb & 0xffffff).toString(16).padStart(6, '0')}` : fallback;
  },

  /** A slot's plugin name: the catalog has it when the slot's plugin_name stays null (fact 86). */
  pluginName(luna, slot) {
    if (!slot || slot.isEmpty) return '';
    const id = slot.pluginId.value;
    return luna.plugins.byId(id ?? '')?.name.value ?? slot.pluginName.value ?? id ?? '';
  },

  slotIndex(slot) {
    return Number(String(slot.id).replace(/^\D+/, '')) || 0;
  },

  /** LUNA's console emulation sits in an insert slot as an alias, not a plugin of its own. */
  isConsoleAlias(slot) {
    return /^alias\./.test(slot.pluginId.value ?? '');
  },

  /**
   * The cards of a channel's chain, in LUNA's signal order.
   *   track: input · record FX · MIDI FX · instrument · tape · console (pre) · inserts · add ·
   *          console (post) · sidechain · sends · output
   *   bus:   summing · tape (pre) · console (pre) · inserts · add · console (post) ·
   *          tape (post-fader) · sidechain · sends · output
   * A loaded extension slot is a card of its own; an empty one is a narrow `stub` that adds a
   * plugin there. LUNA marks where the console sits among the inserts with an `alias.console`
   * insert; without one it follows `channel_strip_order`. `props` holds that and the bus's
   * `tape_ordering` (from L.liveProps).
   */
  chain(luna, channel, props = {}) {
    const cards = [];
    const fx = (id) => channel.effects.byId(id);
    const isTrack = !(channel instanceof Luna.Bus);
    const kind = AddOnLogic.kindOf(channel);
    const plugin = (type, slot, extra = {}) => ({ type, key: slot.id, slot, name: AddOnLogic.pluginName(luna, slot), ...extra });
    const extension = (type, id, label) => {
      const slot = fx(id);
      if (!slot) return;
      cards.push(slot.isEmpty ? { type: 'stub', key: `stub:${id}`, slot, kind: type, label } : plugin(type, slot));
    };
    // Several slots of one kind (record FX, MIDI FX): each loaded one, then a stub for the next.
    const group = (type, prefix, label) => {
      const slots = channel.effects.items.filter((s) => s.id.startsWith(prefix));
      for (const s of slots) if (!s.isEmpty) cards.push(plugin(type, s, { index: AddOnLogic.slotIndex(s) }));
      const free = slots.find((s) => s.isEmpty);
      if (free) cards.push({ type: 'stub', key: `stub:${prefix}`, slot: free, kind: type, label });
    };

    if (isTrack) cards.push({ type: 'input', key: 'input' });
    else extension('summing', 'bus_input', 'Summing');
    if (isTrack && kind !== 'instrument') group('recfx', 'record_fx_', 'Rec FX');
    group('midifx', 'midi_', 'MIDI FX');
    const instrument = fx('instrument');
    if (kind === 'instrument' || (instrument && !instrument.isEmpty)) {
      cards.push({ type: 'instrument', key: 'instrument', slot: instrument, name: AddOnLogic.pluginName(luna, instrument) });
    }
    const tapePost = !isTrack && props.tape_ordering === 'post_fader';
    if (!tapePost) extension('tape', 'tape', 'Tape');

    const slots = channel.effectSlots;
    const console_ = fx('console');
    const aliased = slots.some((s) => AddOnLogic.isConsoleAlias(s));
    const consolePost = props.channel_strip_order === 'post_effects';
    if (console_ && !aliased && !consolePost) extension('console', 'console', 'Console');
    for (const slot of slots) {
      if (slot.isEmpty) continue;
      if (AddOnLogic.isConsoleAlias(slot)) {
        cards.push({ type: 'console', key: slot.id, slot, console: console_, name: AddOnLogic.pluginName(luna, console_) || 'Console' });
        continue;
      }
      cards.push({ type: 'insert', key: slot.id, slot, index: AddOnLogic.slotIndex(slot), name: AddOnLogic.pluginName(luna, slot) });
    }
    const free = slots.find((s) => s.isEmpty);
    if (free) cards.push({ type: 'add', key: 'add', slot: free });
    if (console_ && !aliased && consolePost) extension('console', 'console', 'Console');
    if (tapePost) extension('tape', 'tape', 'Tape');
    if (fx('sidechain_filter')) cards.push({ type: 'sidechain', key: 'sidechain', slot: fx('sidechain_filter') });
    if (!(channel instanceof Luna.Bus && channel.isMaster)) cards.push({ type: 'sends', key: 'sends' });
    cards.push({ type: 'output', key: 'output' });
    return cards;
  },

  /** The inserts that take a sidechain, and those using one now. */
  sidechainUsers(luna, channel) {
    return channel.effectSlots.filter((s) => !s.isEmpty && (s.sidechainAllowed.value || s.sidechainInUse.value))
      .map((s) => ({ slot: s, name: AddOnLogic.pluginName(luna, s), inUse: s.sidechainInUse.value === true }));
  },

  /**
   * Engine properties the SDK does not type yet, kept live: { [name]: { value, onChange, set } }
   * plus dispose(). One subscription on the node; each write is LUNA's own undo step.
   */
  liveProps(luna, node, names) {
    const props = { dispose: () => {} };
    const listeners = new Map(names.map((n) => [n, new Set()]));
    for (const n of names) {
      props[n] = {
        value: undefined,
        onChange: (fn) => { listeners.get(n).add(fn); return () => listeners.get(n).delete(fn); },
        // Applied here once LUNA accepts it: LUNA need not echo a write to its writer.
        set: (v) => luna.raw.set(`${node.path}/${n}`, v).then(() => apply(n, v)),
      };
    }
    function apply(n, v) {
      if (!listeners.has(n) || props[n].value === v) return;
      props[n].value = v;
      for (const fn of listeners.get(n)) fn();
    }
    const off = luna.raw.subscribe(node.path, (e) => {
      const n = String(e.path ?? '').slice(node.path.length + 1);
      if (!n.includes('/') && 'data' in e) apply(n, e.data);
    });
    props.dispose = off;
    props.ready = luna.raw.get(node.path, { flatvalue: true, children: false, commands: false, propfilter: names })
      .then((r) => { for (const n of names) apply(n, r?.properties?.[n] ?? null); })
      .catch(() => {});
    return props;
  },

  /** The session's tape machines that have a machine in them, for the tape card's menu. */
  async tapeMachines(luna, session) {
    const r = await luna.raw.get(`${session.path}/tape_machines`, { children: true, levels: 2, commands: false, flatvalue: true, propfilter: ['uid', 'name', 'index', 'tape_machine_type'] });
    return (r?.children ?? []).map((c) => c.properties).filter((m) => m && m.tape_machine_type)
      .sort((a, b) => a.index - b.index).map((m) => ({ uid: m.uid, name: m.name || `Machine ${m.index + 1}` }));
  },

  /** The first empty insert slot after `slot` (to insert "after this device"), else any empty one. */
  emptySlotAfter(channel, slot) {
    const slots = channel.effectSlots;
    const from = slot ? slots.indexOf(slot) + 1 : 0;
    return slots.slice(from).find((s) => s.isEmpty) ?? slots.find((s) => s.isEmpty);
  },

  // ---------- parameters ----------

  /** How many steps a parameter has: 0 for a range. */
  steps(control) {
    if (!control?.discrete.value) return 0;
    const n = control.displayValues.value?.length || control.numSteps.value || 0;
    return n > 0 && n < 1000 ? n : 0;
  },

  /** The normalized value of step `k` of `n`. */
  stepValue(k, n) {
    return n > 1 ? k / (n - 1) : 0;
  },

  /** Which step a normalized value falls on. */
  stepOf(v, n) {
    return n > 1 ? Math.round(Math.min(1, Math.max(0, v)) * (n - 1)) : 0;
  },

  /** A parameter's words for a value: a step's own label, else LUNA's display when it is the current value. */
  textAt(control, v) {
    if (!control) return '';
    const n = AddOnLogic.steps(control);
    const words = control.displayValues.value;
    if (n > 1 && words?.length) return String(words[AddOnLogic.stepOf(v, words.length)] ?? '');
    const cur = control.normalized.value;
    if (cur === undefined || Math.abs(v - cur) < 0.002) return String(control.display.value ?? '').trim();
    return '';
  },

  /** The parameters to list on a card without a GUI: the bypass and power switches left out. */
  listedParams(slot) {
    const bypass = slot.bypassControl.value;
    return slot.params.filter((c) => c.id !== bypass && c.name.value !== 'Power' && c.name.value !== 'Bypass');
  },

  /** Click on a two-state switch: flip it as one undo step. */
  async toggleParam(control) {
    const v = control.normalized.value ?? 0;
    await control.normalized.set(v >= 0.5 ? 0 : 1);
  },

  /** Pick step `k` of a stepped parameter, as one undo step. */
  async pickStep(control, k) {
    await control.normalized.set(AddOnLogic.stepValue(k, AddOnLogic.steps(control)));
  },

  /**
   * Whether a slot is IN. Read from its bypass control when it has one (a nonzero value is IN
   * when `bypassControlActiveLow` is true), since Effect.in can lag it; else Effect.in.
   */
  isIn(slot) {
    const b = slot?.bypass;
    const v = b?.normalized.value;
    if (b && v !== undefined) return slot.bypassControlActiveLow.value === false ? v < 0.5 : v >= 0.5;
    return slot?.in.value !== false;
  },

  /** Bypass on/off through LUNA's undoable path. */
  async toggleIn(slot) {
    await slot.setIn(!AddOnLogic.isIn(slot));
  },

  // ---------- input ----------

  /** The track's input section: its input's name, trim, polarity and delay controls. */
  input(track) {
    const ctrls = track.controls.items;
    const trim = ctrls.find((c) => /^input_trim_(mono|stereo|left|l)$/.test(c.id)) ?? ctrls.find((c) => /^input_trim/.test(c.id) && !/invert/.test(c.id));
    const polarity = ctrls.filter((c) => /^input_trim_invert/.test(c.id));
    const delay = ctrls.find((c) => c.id === 'latency_offset');
    const desc = track.inputDesc?.value;
    return {
      name: (desc && typeof desc === 'object' ? desc.name : null) ?? (track.trackType.value === 'instrument' ? 'MIDI' : 'No Input'),
      format: track.stemFormat.value ?? '',
      trim,
      polarity,
      delay,
      link: ctrls.find((c) => c.id === 'input_trim_link'),
    };
  },

  // ---------- routing ----------

  /** The buses a channel can be sent or routed to (never itself). */
  buses(session, channel) {
    return session.buses.items.filter((b) => b.id !== channel.id && (b.isMaster || b.busType.value === 'aux'));
  },

  /** Where the main output goes, by name. */
  outputName(channel) {
    const d = channel.main.destinations.value ?? [];
    if (!d.length) return 'No Output';
    return d.map((x) => x.name).join(', ');
  },

  /** Route the channel's main output to a bus (replacing where it went), one undo step. */
  async setOutput(channel, bus) {
    await channel.main.retarget(bus, 'Change Output');
  },

  /** The sends that go somewhere, in slot order. */
  sends(channel) {
    return channel.outputs.items.filter((o) => o.isSend && o.assigned);
  },

  /** Route the first free send to a bus; resolves to that send. */
  async addSend(channel, bus) {
    const free = channel.outputs.items.find((o) => o.isSend && !o.assigned);
    if (!free) throw new Error('All eight sends are in use');
    await free.assign(bus);
    return free;
  },

  /** Text for the transport counter. */
  locationText(transport) {
    return Luna.formatBarBeat(transport.location.value?.bar_beat);
  },
};

globalThis.AddOnLogic = AddOnLogic;
