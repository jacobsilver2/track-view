# Track View

A LUNA editor panel (under the Timeline) that shows the selected track's whole channel strip as
a device chain, the way Bitwig's device panel or Ableton's track view does.

**Left to right:** input (trim, delay, polarity, MIDI channel and transpose on instrument tracks)
· record FX · MIDI FX · instrument · tape · console · inserts · sidechain · sends · output, with
the track's fader, pan, solo, mute and meter pinned on the right. On buses the chain starts with
summing. An empty slot shows as a narrow "+" tile.

- **Real plugin GUIs.** Each native UA plugin shows its own GUI, scaled into its card, read from
  your own install at run time; nothing of UA's ships with Track View. Console and tape versions
  of the API 2500, API Vision, Studer A800 and Oxide use their insert version's GUI. Anything
  without a GUI shows as a list of knobs and switches. The header's GUI/LIST button switches
  every card, and a card's ⌄ menu switches that one.
- **Sends as strips:** destination, pan, pre/post, mute, a fader with LUNA's scale and a meter.
- **Section filters:** IN, REC, MIDI, INST, EXT, FX, SC, SEND and OUT show or hide parts of the
  chain; Option-click shows one section alone.
- **Follows LUNA:** the shown track follows LUNA's selection (FOLLOW), or click the name to pin
  any track, bus or the master. Every edit is one LUNA undo step.
- **Wheel:** scrolls the chain; at rest over a knob or fader it turns it.

## Requirements

- LUNA 3.1.2 or later.
- Plugin GUIs: macOS, with LUNA's native UA plugins installed. On Windows, and for UAD-2 and
  third-party plugins, cards show parameter lists.
- Track View must be installed as a folder (a `.lunaaddon`, the Add Ons showcase, or
  `tools/install-copy.sh`), not linked: a linked install cannot reach the plugin GUIs.

## Development

```sh
npm install
npm test                         # against Luna.MockEngine
../tools/install-copy.sh         # copy into LUNA's Add Ons folder; reopen the panel to reload
npx ua-builder pack              # track-view.lunaaddon for a release
```

In a browser, `npx ua-builder serve` serves the page; plugin GUIs need `?uaroot=<url>` pointing
at a server over `/Library/Application Support/Universal Audio`. A `manifest.json` change needs
a LUNA restart. `tools/remote/lb` installs it from this Mac onto another one over ssh.

| File | Purpose |
|---|---|
| `manifest.json` | What LUNA reads. |
| `index.html`, `styles.css` | The page and LUNA's look, drawn in CSS and inline SVG. |
| `logic.js` | Engine logic with no DOM: the chain, live properties, routing. Tested. |
| `main.js` | Cards, strips, menus, the plugin browser. |
| `plugin-gui.js` | Finds and embeds each UA plugin's own GUI. |
| `vendor/luna.global.js` | The LUNA Builder SDK. |
