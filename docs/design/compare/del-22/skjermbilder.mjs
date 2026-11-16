// Del 22: før/etter-bilder i hodeløs Edge via CDP (ingen avhengigheter, Node 24).
// Bruk: node shots-del22.mjs <utmappe> <før|etter>
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [outDir, tag] = process.argv.slice(2);
const BASE = 'http://127.0.0.1:41733/';
const SKINS = (process.argv[4] ?? 'kameleon,echo-groove-nights,oled-svart').split(',');
const PORT = 9333;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
mkdirSync(outDir, { recursive: true });

// Varm opp media-hurtigbufferen: første lesing fra disken kan ta sekunder per fil, og da rekker ikke katalogen å laste.
{
  const idx = await (await fetch(`${BASE}media/index.json`)).json();
  const urls = idx.assets.flatMap((a) => [`${BASE}media/${a.manifest}`, `${BASE}media/${a.manifest.replace(/manifest\.json$/, 'analysis.json')}`]);
  for (let i = 0; i < urls.length; i += 8) await Promise.all(urls.slice(i, i + 8).map((u) => fetch(u, { signal: AbortSignal.timeout(20000) }).then((r) => r.arrayBuffer()).catch(() => null)));
  console.log(`(varmet opp ${urls.length} mediefiler)`);
}

const profile = mkdtempSync(join(tmpdir(), 'gv-edge-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
for (let i = 0; i < 50 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch { await sleep(200); }
}
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: BASE });
await sleep(1500);

async function shoot(name) {
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  writeFileSync(join(outDir, `${name}.jpg`), Buffer.from(r.result.data, 'base64'));
  console.log('✓', name);
}
// Klikk første synlige element som matcher en av tekstene/aria-labelene
const clickJs = (labels) => `(() => { const ls = ${JSON.stringify(labels)};
  const els = [...document.querySelectorAll('button,[role=button],a')].filter(e => e.offsetParent);
  for (const l of ls) { const e = els.find(x => (x.getAttribute('aria-label')||'').toLowerCase() === l.toLowerCase() || (x.title||'').toLowerCase() === l.toLowerCase());
    if (e) { e.click(); return l; } } return null; })()`;

for (const skin of SKINS) {
  for (const [form, w, h, mobile] of [['desktop', 1536, 1024, false], ['mobil', 390, 844, true]].filter(f => !process.argv[5] || f[0] === process.argv[5])) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
    await send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
    await evalJs(`localStorage.setItem('gv:skin', JSON.stringify({ id: '${skin}', followShared: false, cache: [] }))`);
    await send('Page.navigate', { url: BASE });
    await sleep(1500); let ok = false; for (let i = 0; i < 360; i++) { await sleep(500); if (await evalJs(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Fortsett her' || (b.getAttribute('aria-label')||'').startsWith('Åpne spilleren') || (b.getAttribute('aria-label')||'').startsWith('Valg for '))`)) { ok = true; break; } }
    if (!ok) console.log('  (katalogen lastet ikke på 180 s)');
    await evalJs(`(() => { const e = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Fortsett her'); e?.click(); return !!e; })()`);
    await sleep(2000);
    // Start avspilling (første låt), slik at spillehode og avspillingstilstand vises
    const played = await evalJs(clickJs(['Spill', 'Play', 'Spill av', 'Spill alle']));
    await sleep(2500);
    if (mobile) {
      // Åpne fullskjermspilleren fra minispilleren
      let open = await evalJs(`(() => { const e = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||'').startsWith('Åpne spilleren')); if (e) { e.click(); return true; } return false; })()`);
      if (!open) {
        // Ingen låt lastet: start første låt i lista, så minispilleren dukker opp
        await evalJs(`(() => { const e = [...document.querySelectorAll('main li button, main [role=row]')].find(b => b.offsetParent); e?.click(); })()`);
        await sleep(2500);
        open = await evalJs(`(() => { const e = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||'').startsWith('Åpne spilleren')); if (e) { e.click(); return true; } return false; })()`);
      }
      if (!open) console.log('  (fant ikke minispilleren)');
      await sleep(1500);
    }
    {
      await sleep(1000);
      await evalJs(`(() => { const el = [...document.querySelectorAll('input.seek-overlay')].find(e => e.getBoundingClientRect().width > 100); if (!el) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '450'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await sleep(2500);
    }
    // Vent på to frames, så lerretene (bølgeform) er tegnet før bildet tas
    await evalJs('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
    await sleep(300);
    await shoot(`${tag}-${skin}-${form}`);
    if (!played) console.log('  (fant ingen play-knapp)');
  }
}
if (errors.length) console.log('Konsollfeil:', errors.slice(0, 5));
ws.close();
edge.kill();
process.exit(0);
