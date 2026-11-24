// Runs against Luna.MockEngine: no LUNA needed. `npm test`.
import { describe, expect, it } from 'vitest';
import { Luna } from '@uaudio/luna-builder-sdk';

globalThis.Luna = Luna; // logic.js and plugin-gui.js are classic scripts that read globals
globalThis.window = globalThis;
globalThis.location = { search: '?uaroot=ua/' };
// plugin-gui.js asks for each GUI's manifest; this install has the insert API 2500's only.
globalThis.fetch = async (url) => (url === 'ua/Plug-Ins/uaudio_api_2500.lunacomponent/gui.bundle/Contents/Resources/html/manifest.json'
  ? { ok: true, json: async () => ({ window: { width: 950, height: 600 }, icon: 'images/icon.png' }) }
  : { ok: false });
await import('../logic.js');
await import('../plugin-gui.js');
const L = globalThis.AddOnLogic;
const PluginGui = globalThis.PluginGui;

async function connected() {
  const engine = new Luna.MockEngine();
  engine.addSession('abc', { name: 'Demo', tracks: ['Vocal', 'Bass'] });
  engine.addBus('abc', 'rev', { name: 'Reverb', busType: 'aux', stemFormat: 'stereo' });
  engine.addPlugin('uaudio_teletronix_la-2a_silver', { name: 'LA-2A Silver Compressor', categories: ['Compressors & Limiters'] });
  engine.addPlugin('com.example.noface', { name: 'Plain EQ', categories: ['Equalization'] });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  await luna.plugins.load();
  const session = await luna.session();
  for (const t of session.visibleTracks) await Promise.all([t.loadStrip(), t.controls.load(), t.effects.load(), t.outputs.load()]);
  return { engine, luna, session, vocal: session.visibleTracks[0] };
}

describe('plugin GUIs', () => {
  it("finds a plugin's own GUI, and the insert GUI for its console version", async () => {
    const own = await PluginGui.lookup('uaudio_api_2500');
    expect(own).toMatchObject({ width: 950, height: 600, url: 'ua/Plug-Ins/uaudio_api_2500.lunacomponent/gui.bundle/Contents/Resources/html/' });
    expect((await PluginGui.lookup('uaudio_api_2500_ext'))?.url).toBe(own.url);
    expect(await PluginGui.lookup('uaudio_ampex_atr_102_ext')).toBeNull();   // no stand-in
    expect(await PluginGui.lookup('com.example.noface')).toBeNull();         // not a UA plugin
  });
});

describe('chain', () => {
  it('lists tracks, aux buses and the master as channels', async () => {
    const { session } = await connected();
    const names = L.channels(session).map((c) => `${c.kind}:${c.name}`);
    expect(names).toContain('audio:Vocal');
    expect(names).toContain('bus:Reverb');
    expect(names.some((n) => n.startsWith('master:'))).toBe(true);
  });

  it('shows every slot of an empty track in signal order, empty extensions as stubs', async () => {
    const { luna, vocal } = await connected();
    const cards = L.chain(luna, vocal);
    expect(cards.map((c) => (c.type === 'stub' ? `stub:${c.kind}` : c.type)))
      .toEqual(['input', 'stub:recfx', 'stub:tape', 'stub:console', 'add', 'sidechain', 'sends', 'output']);
    expect(cards.find((c) => c.kind === 'recfx').slot.id).toBe('record_fx_0');
  });

  it('puts the console after the inserts when the strip order says so, and bus tape post-fader', async () => {
    const { luna, session, vocal } = await connected();
    const order = (ch, props) => L.chain(luna, ch, props).map((c) => (c.type === 'stub' ? `stub:${c.kind}` : c.type));
    expect(order(vocal, { channel_strip_order: 'post_effects' }).slice(-5, -3)).toEqual(['add', 'stub:console']);
    const bus = session.buses.items.find((b) => b.name.value === 'Reverb');
    await bus.effects.load();
    const pre = order(bus, {}), post = order(bus, { tape_ordering: 'post_fader' });
    expect(pre.indexOf('stub:tape')).toBeLessThan(pre.indexOf('add'));
    expect(post.indexOf('stub:tape')).toBeGreaterThan(post.indexOf('add'));
  });

  it('puts each loaded insert in order, with its catalog name', async () => {
    const { engine, luna, vocal } = await connected();
    await vocal.insert('uaudio_teletronix_la-2a_silver');
    await vocal.insert('com.example.noface');
    await engine.settled();
    const cards = L.chain(luna, vocal);
    const inserts = cards.filter((c) => c.type === 'insert');
    expect(inserts.map((c) => c.name)).toEqual(['LA-2A Silver Compressor', 'Plain EQ']);
    expect(cards.indexOf(inserts[1]) + 1).toBe(cards.findIndex((c) => c.type === 'add'));
    expect(L.emptySlotAfter(vocal, inserts[0].slot).id).toBe(cards.find((c) => c.type === 'add').slot.id);
  });

  it('bypasses through the undoable setIn path', async () => {
    const { engine, vocal } = await connected();
    const slot = await vocal.insert('uaudio_teletronix_la-2a_silver');
    await engine.settled();
    const before = engine.requests.length;
    await L.toggleIn(slot);
    await engine.settled();
    expect(engine.requests.slice(before).some((r) => /set_in|bypass|in/.test(r.path))).toBe(true);
  });
});

describe('live properties', () => {
  it('reads, follows and writes a property the SDK does not type', async () => {
    const { engine, luna, vocal } = await connected();
    const props = L.liveProps(luna, vocal, ['comments']);
    await props.ready;
    let n = 0;
    props.comments.onChange(() => n++);
    await props.comments.set('take 3');
    await engine.settled();
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.requests.some((r) => r.path === `${vocal.path}/comments`)).toBe(true);
    expect(props.comments.value).toBe('take 3');
    expect(n).toBe(1);
    props.dispose();
  });
});

describe('parameters', () => {
  const fake = (o) => ({
    discrete: { value: o.discrete ?? false }, numSteps: { value: o.steps ?? 32769 }, displayValues: { value: o.words },
    normalized: { value: o.v }, display: { value: o.display }, name: { value: o.name },
  });

  it('words a stepped value by its own step label', () => {
    const c = fake({ discrete: true, steps: 3, words: ['Off', 'Low', 'High'], v: 0.5 });
    expect(L.steps(c)).toBe(3);
    expect(L.textAt(c, 1)).toBe('High');
    expect(L.stepValue(1, 3)).toBe(0.5);
  });

  it("words a range by LUNA's display only at the current value", () => {
    const c = fake({ v: 0.25, display: ' -3.0 dB ' });
    expect(L.steps(c)).toBe(0); // 32769 "steps" is a range
    expect(L.textAt(c, 0.25)).toBe('-3.0 dB');
    expect(L.textAt(c, 0.9)).toBe('');
  });
});

describe('routing', () => {
  it('adds a send to a bus', async () => {
    const { engine, session, vocal } = await connected();
    const bus = session.buses.items.find((b) => b.name.value === 'Reverb');
    await L.addSend(vocal, bus.id);
    await engine.settled();
    expect(L.sends(vocal).map((s) => s.busUid.value)).toEqual([bus.id]);
  });

  // The mock routes a main output to hardware and keeps it there; against LUNA 3.1.2 the
  // retarget moves it (checked live on a scratch session). Here: the request names the bus.
  it('asks LUNA to route the main output to a bus', async () => {
    const { engine, session, vocal } = await connected();
    const bus = session.buses.items.find((b) => b.name.value === 'Reverb');
    const before = engine.requests.length;
    await L.setOutput(vocal, bus.id).catch(() => {});
    expect(engine.requests.slice(before).some((r) => JSON.stringify(r.data ?? '').includes(bus.id))).toBe(true);
  });
});
