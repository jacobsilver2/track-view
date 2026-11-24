// Track View: a native UA plugin's own GUI, embedded in its card.
//
// LUNA's own UA plugins (uaudio_*) ship their editor as an HTML page inside the plugin:
//   /Library/Application Support/Universal Audio/Plug-Ins/<id>.lunacomponent/gui.bundle/Contents/Resources/html/
// That page talks to the engine itself over the same WebSocket as this Add On, given
// ?host=&port=&path=<the insert's engine path>. Nothing of it ships with Track View: the page
// is read from the user's own install at run time. Installed as LUNA installs Add Ons (a folder
// in .../Universal Audio/LUNA/Add Ons/), the manifest's local_content_offset "../../.." makes
// .../Universal Audio/ this page's root, so the plugins sit at ../../../Plug-Ins/. For
// development, ?uaroot=<url> points at a server over that folder instead.
//
// Anything else (UAD-2 plugins, an older or missing install, Windows) shows a parameter list.

(function () {
  const params = new URLSearchParams(location.search);
  const ROOT = params.get('uaroot') || '../../../';
  const PORT = params.get('port') || '4718';
  const info = new Map();      // pluginId -> Promise<{ url, width, height, icon } | null>

  // Console and tape extensions are plugins of their own with no web GUI. Where the insert
  // version's GUI drives the extension (checked against LUNA 3.1.2: its controls bind and a move
  // in it changes the extension), that GUI stands in.
  //   API 2500: identical parameters.
  //   API Vision: all but the 215/EQ dynamics sidechain switches and the EQ type (not in the
  //     extension), which stay inert.
  //   Studer A800, Oxide: the front panel binds; the insert's per-side alignment controls are
  //     behind its OPEN panel.
  // Ampex ATR-102's GUI is all per-side controls the extension lacks, so it is left out.
  const GUI_ALIAS = {
    uaudio_api_2500_ext: 'uaudio_api_2500',
    uaudio_api_vision_ext: 'uaudio_api_vision_channel_strip',
    uaudio_studer_a800_console: 'uaudio_studer_a800',
    uaudio_oxide_tape_console: 'uaudio_oxide_tape',
  };
  const base = (pluginId) => `${ROOT}Plug-Ins/${encodeURIComponent(pluginId)}.lunacomponent/gui.bundle/Contents/Resources/html/`;

  /** The plugin's own GUI, if this install has one: its folder and window size. */
  function lookup(pluginId) {
    if (!pluginId || !/^uaudio_[a-z0-9_.-]+$/i.test(pluginId)) return Promise.resolve(null);
    if (!info.has(pluginId)) {
      const read = (id) => {
        const url = base(id);
        return fetch(url + 'manifest.json')
          .then((r) => (r.ok ? r.json() : null))
          .then((m) => {
            const w = Number(m?.window?.width), h = Number(m?.window?.height);
            return w > 0 && h > 0 ? { url, width: w, height: h, icon: m.icon ? url + m.icon : null } : null;
          })
          .catch(() => null);
      };
      info.set(pluginId, read(pluginId).then((g) => g ?? (GUI_ALIAS[pluginId] ? read(GUI_ALIAS[pluginId]) : null)));
    }
    return info.get(pluginId);
  }

  /** What lookup() found, without waiting: undefined while asking. */
  const settled = new Map();
  function known(pluginId) {
    if (!settled.has(pluginId)) {
      settled.set(pluginId, undefined);
      lookup(pluginId).then((v) => { settled.set(pluginId, v); for (const fn of listeners) fn(pluginId, v); });
    }
    return settled.get(pluginId);
  }
  const listeners = new Set();

  /**
   * An iframe showing the plugin's GUI for one insert, scaled to `height`. The GUI keeps its own
   * connection to LUNA and does its own touches, so edits in it are LUNA's own undo steps.
   */
  function frame(gui, slotPath, height) {
    const wrap = document.createElement('div');
    wrap.className = 'plugin-gui';
    const f = document.createElement('iframe');
    f.src = `${gui.url}index.html?host=127.0.0.1&port=${PORT}&path=${encodeURIComponent(slotPath)}`;
    f.width = gui.width; f.height = gui.height;
    f.setAttribute('scrolling', 'no');
    f.title = 'Plugin';
    wrap.append(f);
    guardWheel(wrap, f);
    // Rescale in place: a new iframe would reload the GUI (and play its loading blur).
    const out = { el: wrap, width: 0 };
    out.resize = (h) => {
      const s = Math.min(1, h / gui.height);   // never past the plugin's own size
      wrap.style.width = Math.round(gui.width * s) + 'px';
      wrap.style.height = Math.round(gui.height * s) + 'px';
      f.style.transform = `scale(${s})`;
      return (out.width = Math.round(gui.width * s));
    };
    out.resize(height);
    return out;
  }

  // The wheel over a plugin GUI scrolls the chain; it never turns the plugin's knobs, so
  // scrolling past a card cannot change a setting. Clicks and drags still reach the GUI.
  // Installed in LUNA the GUI is same-origin: catch the wheel inside it, before its knobs see
  // it. Cross-origin (a dev server), a shield over the GUI takes the wheel and steps aside
  // once the pointer rests, so the GUI can still be clicked.
  // A scroll gesture: a sideways wheel, or any wheel within a moment of the last one that
  // scrolled the chain. During one, the wheel scrolls; otherwise it turns what is under it.
  let lastScroll = 0;
  const scrolling = (e) => performance.now() - lastScroll < 350 || Math.abs(e.deltaX) > Math.abs(e.deltaY);
  const markScroll = () => { lastScroll = performance.now(); };
  let wheelTo = null;
  const forward = (e) => {
    markScroll();
    e.preventDefault(); e.stopImmediatePropagation();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    wheelTo?.(d * k);
  };
  function guardWheel(wrap, f) {
    const shield = document.createElement('div');
    shield.className = 'gui-shield';
    wrap.append(shield);
    let lastWheel = 0;
    shield.addEventListener('wheel', (e) => { lastWheel = performance.now(); forward(e); }, { passive: false });
    shield.addEventListener('pointermove', () => { if (performance.now() - lastWheel > 350) shield.hidden = true; });
    wrap.addEventListener('pointerleave', () => { shield.hidden = false; });
    f.addEventListener('load', () => {
      let w;
      try { w = f.contentWindow; void w.document; } catch { return; }   // cross-origin: the shield does it
      // Inside the GUI: a scroll gesture scrolls the chain; a wheel at rest turns its knobs.
      w.addEventListener('wheel', (e) => { if (scrolling(e)) forward(e); }, { capture: true, passive: false });
      shield.remove();
    });
  }

  globalThis.PluginGui = { lookup, known, frame, onKnown: (fn) => listeners.add(fn), onWheel: (fn) => { wheelTo = fn; }, scrolling, markScroll, root: ROOT };
})();
