/**
 * dial-usage-proxy
 * --------------------------------------------------------------------------
 * Kleiner HTTP-Server, der die Claude-Code-Nutzung via `ccusage` ausliest und
 * sie als kompaktes, dial-freundliches JSON ausliefert. Das M5Dial pollt nur
 * diesen Endpunkt -- kein API-Key, kein Cookie verlaesst dieses Geraet.
 *
 * Wichtiger Hinweis zur Datenquelle:
 *   Anthropic bietet KEINE offizielle API fuer die verbleibenden Claude.ai-Pro-
 *   Nachrichten. Da die Pro-Limits aber ueber alle Oberflaechen geteilt werden
 *   (claude.ai, Desktop, Claude Code zaehlen auf denselben Topf), spiegelt das
 *   aktive 5h-"block" von ccusage deinen Pro-Verbrauch realistisch wider --
 *   soweit er ueber Claude Code laeuft. Reine Chat-Nutzung auf claude.ai ist
 *   hierueber NICHT sichtbar. Die angezeigten Werte sind also eine fundierte
 *   Annaeherung, kein offizieller Kontostand.
 *
 * Endpunkte:
 *   GET /usage   -> JSON fuer das Dial (siehe buildDialPayload)
 *   GET /health  -> { ok: true }
 *   GET /raw     -> ungefiltertes ccusage-JSON (zum Debuggen)
 */

import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);

// --- .env laden ------------------------------------------------------------
// Node 22+ kann .env nativ via `node --env-file=.env` laden. Dieser Loader ist
// ein Fallback, falls der Server ohne dieses Flag gestartet wird (z. B. lokal
// per `node server.js`). Bereits gesetzte Umgebungsvariablen werden NICHT
// ueberschrieben -- echte Env-Variablen haben also Vorrang.
function loadDotEnv() {
  try {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), '.env');
    const content = readFileSync(envPath, 'utf8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      // Optionale Anfuehrungszeichen entfernen.
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch (err) {
    // Keine .env vorhanden ist voellig ok -- dann zaehlen Defaults / echte Env.
    if (err.code !== 'ENOENT') {
      console.warn('[proxy] .env konnte nicht gelesen werden:', err.message);
    }
  }
}

loadDotEnv();

// --- Konfiguration (via Umgebungsvariablen ueberschreibbar) ----------------
const PORT = Number(process.env.PORT || 8088);
// Cache-Dauer: so oft fragt der Proxy ccusage hoechstens neu ab.
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 60_000);
// Token-Budget pro 5h-Block. Anthropic nennt keine harte Tokenzahl, daher ist
// das ein konfigurierbarer Richtwert -- pass ihn an deine Erfahrung an.
const BLOCK_TOKEN_BUDGET = Number(process.env.BLOCK_TOKEN_BUDGET || 12_000_000);
// Optional: woechentliches Tokenbudget (grobe Hausnummer, anpassbar).
const WEEK_TOKEN_BUDGET = Number(process.env.WEEK_TOKEN_BUDGET || 70_000_000);
// Timezone, in der ccusage die Tage gruppiert.
const TZ = process.env.CC_TIMEZONE || 'Europe/Berlin';

// --- SSH-Konfiguration -----------------------------------------------------
// ccusage liest die Claude-Code-Logs aus ~/.claude. Diese liegen auf dem Mac,
// nicht auf dem Server -- daher fuehren wir ccusage per SSH remote auf dem Mac
// aus. Benoetigt einen passwortlosen SSH-Key (siehe README).
const SSH_HOST = process.env.SSH_HOST || '192.168.1.20'; // IP/Hostname des Macs
const SSH_USER = process.env.SSH_USER || 'sebastian';     // macOS-Benutzername
const SSH_PORT = process.env.SSH_PORT || '22';
const SSH_KEY = process.env.SSH_KEY || '/keys/id_dial';   // gemounteter Key
// Pfad zu npx/Node auf dem Mac. Eine nicht-interaktive SSH-Sitzung laedt das
// Login-Profil NICHT -- daher muss npx ueber den vollen Pfad erreichbar sein.
// Bei Homebrew (Apple Silicon): /opt/homebrew/bin, bei Intel: /usr/local/bin.
const REMOTE_PATH = process.env.REMOTE_PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';

// --- Mini-Cache ------------------------------------------------------------
let cache = { ts: 0, payload: null };

/**
 * Fuehrt `ccusage <sub> --json` per SSH auf dem Mac aus und parst das Ergebnis.
 *
 * Warum SSH: ccusage liest die Claude-Code-Logs aus ~/.claude. Diese liegen
 * auf dem Mac, wo `claude` laeuft -- nicht auf dem Homeserver. Der Proxy ruft
 * den Befehl daher remote auf dem Mac auf.
 *
 * Wichtig: Eine nicht-interaktive SSH-Sitzung laedt weder ~/.zshrc noch
 * ~/.zprofile. Deshalb setzen wir PATH explizit, damit npx/node gefunden wird.
 */
async function runCcusage(subcommand) {
  // Der Remote-Befehl. PATH wird vorangestellt, da das Login-Profil fehlt.
  const remoteCmd =
    `export PATH=${REMOTE_PATH}:$PATH; ` +
    `npx -y ccusage@latest ${subcommand} --json --timezone ${TZ}`;

  const sshArgs = [
    '-i', SSH_KEY,
    '-p', SSH_PORT,
    '-o', 'BatchMode=yes',            // niemals interaktiv nach Passwort fragen
    '-o', 'StrictHostKeyChecking=accept-new', // Host-Key beim 1. Mal akzeptieren
    '-o', 'ConnectTimeout=8',
    `${SSH_USER}@${SSH_HOST}`,
    remoteCmd,
  ];

  const { stdout } = await execFileAsync('ssh', sshArgs, {
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  // ccusage gibt sauberes JSON aus; ggf. fuehrende npx-Hinweise abschneiden.
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error('keine JSON-Ausgabe von ccusage erhalten');
  return JSON.parse(stdout.slice(start));
}

/**
 * Holt die fuer das Dial benoetigten Rohdaten: aktiver 5h-Block + Wochensumme.
 */
async function fetchUsage() {
  const [blocksJson, weeklyJson] = await Promise.all([
    runCcusage('blocks'),
    runCcusage('weekly').catch(() => null), // weekly gibt es erst in neueren Versionen
  ]);

  const blocks = Array.isArray(blocksJson?.data) ? blocksJson.data : on(blocksJson, 'blocks');
  // Ein Block gilt nur als aktiv, wenn ccusage ihn so markiert UND sein
  // Ende noch in der Zukunft liegt (schuetzt vor veralteten Logs).
  const now = Date.now();
  const activeBlock =
    blocks?.find(
      (b) => b.isActive && (!b.blockEnd || new Date(b.blockEnd).getTime() > now),
    ) || null;

  // Letzter abgeschlossener Block (fuer "vorheriger Block"-Screen).
  const finishedBlocks = (blocks || []).filter((b) => !b.isActive && !b.isGap);
  const lastBlock = finishedBlocks.length ? finishedBlocks[finishedBlocks.length - 1] : null;

  // Wochensumme: bevorzugt aus `weekly`, sonst aus den Bloecken der letzten 7 Tage.
  let weekTokens = 0;
  let weekCost = 0;
  if (weeklyJson?.data?.length) {
    const latest = weeklyJson.data[weeklyJson.data.length - 1];
    weekTokens = num(latest?.totalTokens);
    weekCost = num(latest?.totalCostUSD ?? latest?.costUSD);
  } else if (blocks?.length) {
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    for (const b of blocks) {
      if (b.isGap) continue;
      if (new Date(b.blockStart).getTime() >= weekAgo) {
        weekTokens += num(b.totalTokens);
        weekCost += num(b.costUSD);
      }
    }
  }

  return { activeBlock, lastBlock, weekTokens, weekCost };
}

// kleine Helfer
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const on = (obj, key) => (obj && Array.isArray(obj[key]) ? obj[key] : []);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Formatiert eine Tokenzahl kompakt: 1234567 -> "1.23M".
 */
function fmtTokens(t) {
  t = num(t);
  if (t >= 1_000_000) return (t / 1_000_000).toFixed(2) + 'M';
  if (t >= 1_000) return (t / 1_000).toFixed(1) + 'k';
  return String(t);
}

/**
 * Baut das kompakte JSON, das das Dial erwartet.
 * Struktur bewusst flach + kurze Strings -> wenig RAM/Parse-Aufwand auf dem ESP32.
 *
 * {
 *   "ts": 1715800000,
 *   "screens": [
 *      { "label": "5H BLOCK", "value": "34%", "sub": "4.1M / 12M tok", "pct": 34, "tone": "ok" },
 *      ...
 *   ]
 * }
 *
 * tone: "ok" | "warn" | "crit"  -> Farbcodierung auf dem Dial
 */
function buildDialPayload({ activeBlock, lastBlock, weekTokens, weekCost }) {
  const screens = [];

  // --- Screen 1: aktueller 5h-Block (Auslastung) ---------------------------
  if (activeBlock) {
    const tok = num(activeBlock.totalTokens);
    const pct = clamp(Math.round((tok / BLOCK_TOKEN_BUDGET) * 100), 0, 100);
    screens.push({
      label: '5H BLOCK',
      value: pct + '%',
      sub: `${fmtTokens(tok)} / ${fmtTokens(BLOCK_TOKEN_BUDGET)}`,
      pct,
      tone: toneFor(pct),
    });
  } else {
    screens.push({
      label: '5H BLOCK',
      value: 'IDLE',
      sub: 'kein aktiver Block',
      pct: 0,
      tone: 'ok',
    });
  }

  // --- Screen 2: verbleibende Zeit im aktiven Block ------------------------
  if (activeBlock) {
    // ccusage liefert timeRemaining teils als String ("2h 15m"), teils fehlt es.
    let remainStr = activeBlock.timeRemaining;
    if (!remainStr && activeBlock.blockEnd) {
      const msLeft = new Date(activeBlock.blockEnd).getTime() - Date.now();
      const min = clamp(Math.round(msLeft / 60000), 0, 300);
      remainStr = `${Math.floor(min / 60)}h ${min % 60}m`;
    }
    // Prozent der bereits verstrichenen Blockzeit.
    let elapsedPct = 0;
    if (activeBlock.blockStart && activeBlock.blockEnd) {
      const start = new Date(activeBlock.blockStart).getTime();
      const end = new Date(activeBlock.blockEnd).getTime();
      elapsedPct = clamp(Math.round(((Date.now() - start) / (end - start)) * 100), 0, 100);
    }
    screens.push({
      label: 'RESET IN',
      value: remainStr || '--',
      sub: `Block ${elapsedPct}% vorbei`,
      pct: elapsedPct,
      tone: 'ok',
    });
  } else {
    screens.push({ label: 'RESET IN', value: '--', sub: 'kein Block aktiv', pct: 0, tone: 'ok' });
  }

  // --- Screen 3: Burn-Rate (Tokens pro Minute) -----------------------------
  if (activeBlock && activeBlock.burnRate != null) {
    const burn = num(activeBlock.burnRate);
    screens.push({
      label: 'BURN RATE',
      value: fmtTokens(burn) + '/m',
      sub: activeBlock.projectedTotal
        ? `Prognose ${fmtTokens(activeBlock.projectedTotal)}`
        : 'tok pro Minute',
      pct: clamp(Math.round((burn / (BLOCK_TOKEN_BUDGET / 300)) * 100), 0, 100),
      tone: 'ok',
    });
  }

  // --- Screen 4: Kosten des aktiven Blocks ---------------------------------
  if (activeBlock) {
    screens.push({
      label: 'BLOCK COST',
      value: '$' + num(activeBlock.costUSD).toFixed(2),
      sub: 'aktueller 5h-Block',
      pct: 0,
      tone: 'ok',
    });
  }

  // --- Screen 5: Woche (Tokens) --------------------------------------------
  {
    const pct = clamp(Math.round((weekTokens / WEEK_TOKEN_BUDGET) * 100), 0, 100);
    screens.push({
      label: 'THIS WEEK',
      value: fmtTokens(weekTokens),
      sub: `${pct}% von ${fmtTokens(WEEK_TOKEN_BUDGET)}`,
      pct,
      tone: toneFor(pct),
    });
  }

  // --- Screen 6: Woche (Kosten) --------------------------------------------
  screens.push({
    label: 'WEEK COST',
    value: '$' + num(weekCost).toFixed(2),
    sub: 'letzte 7 Tage',
    pct: 0,
    tone: 'ok',
  });

  // --- Screen 7: vorheriger Block ------------------------------------------
  if (lastBlock) {
    screens.push({
      label: 'PREV BLOCK',
      value: fmtTokens(lastBlock.totalTokens),
      sub: '$' + num(lastBlock.costUSD).toFixed(2) + ' tokens',
      pct: 0,
      tone: 'ok',
    });
  }

  return { ts: Math.floor(Date.now() / 1000), screens };
}

/**
 * Ampel-Logik: ab 75% gelb, ab 90% rot.
 */
function toneFor(pct) {
  if (pct >= 90) return 'crit';
  if (pct >= 75) return 'warn';
  return 'ok';
}

/**
 * Liefert das Payload aus dem Cache oder erneuert es.
 */
async function getPayload() {
  const now = Date.now();
  if (cache.payload && now - cache.ts < CACHE_TTL_MS) {
    return cache.payload;
  }
  const raw = await fetchUsage();
  const payload = buildDialPayload(raw);
  cache = { ts: now, payload };
  return payload;
}

// --- HTTP-Server -----------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === '/raw') {
      const raw = await fetchUsage();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(raw, null, 2));
      return;
    }

    if (url.pathname === '/usage' || url.pathname === '/') {
      const payload = await getPayload();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (err) {
    console.error('[proxy] Fehler:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'ccusage failed', detail: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`dial-usage-proxy laeuft auf :${PORT}`);
  console.log(`  -> http://localhost:${PORT}/usage`);
  console.log(`  Block-Budget: ${fmtTokens(BLOCK_TOKEN_BUDGET)} tok, Cache: ${CACHE_TTL_MS}ms`);
});
