// scripts/check.mjs
//
// Controlla le fonti configurate in config/config.json, trova nuove offerte
// di dottorato che corrispondono ai filtri, aggiorna data/listings.json e
// manda una notifica push (via ntfy.sh) se trova qualcosa di nuovo.
//
// Pensato per girare dentro GitHub Actions (Node 20+, fetch nativo).
// Nessuna dipendenza da servizi a pagamento: solo `rss-parser` e `cheerio`.

import Parser from "rss-parser";
import * as cheerio from "cheerio";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config", "config.json");
const LISTINGS_PATH = path.join(ROOT, "data", "listings.json");
const SEEN_PATH = path.join(ROOT, "data", "seen.json");
const RUNLOG_PATH = path.join(ROOT, "data", "last-run.json");

const MAX_LISTINGS = 400;
const MAX_SEEN = 4000;
const FETCH_TIMEOUT_MS = 20000;
const UA =
  "phd-tracker-bot/1.0 (+personal non-commercial PhD alert tool; contact via GitHub repo)";

const rssParser = new Parser({
  requestOptions: { headers: { "User-Agent": UA } },
  timeout: FETCH_TIMEOUT_MS,
});

function stripDiacritics(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function norm(s) {
  return stripDiacritics(String(s || "").toLowerCase());
}

async function readJson(p, fallback) {
  try {
    const raw = await readFile(p, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    console.warn(`⚠️  Impossibile leggere ${p}: ${err.message}. Uso il valore di default.`);
    return fallback;
  }
}

async function writeJson(p, data) {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: { "User-Agent": UA, ...(opts.headers || {}) },
    });
  } finally {
    clearTimeout(t);
  }
}

function makeId(link, title) {
  const base = (link || title || "").trim().toLowerCase();
  // hash semplice e stabile, senza dipendenze esterne
  let h = 0;
  for (let i = 0; i < base.length; i++) {
    h = (Math.imul(31, h) + base.charCodeAt(i)) | 0;
  }
  return "id" + (h >>> 0).toString(36) + "_" + base.length;
}

// ---------------------------------------------------------------------------
// Sorgente 1: jobs.ac.uk — feed RSS per area disciplinare
// Esempio: https://www.jobs.ac.uk/jobs/chemistry/?format=rss
// robots.txt di jobs.ac.uk non vieta questi percorsi (verificato manualmente).
// ---------------------------------------------------------------------------
async function fetchJobsAcUkSubject(subjectSlug) {
  const url = `https://www.jobs.ac.uk/jobs/${encodeURIComponent(subjectSlug)}/?format=rss`;
  const items = [];
  try {
    const feed = await rssParser.parseURL(url);
    for (const it of feed.items || []) {
      items.push({
        title: it.title || "",
        link: it.link || "",
        description: it.contentSnippet || it.content || "",
        pubDate: it.pubDate || it.isoDate || null,
        institution: "",
        location: "",
        source: `jobs.ac.uk / ${subjectSlug}`,
      });
    }
  } catch (err) {
    console.warn(`⚠️  jobs.ac.uk [${subjectSlug}]: ${err.message}`);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Sorgente 2: academicpositions.com — pagine listato per campo
// Esempio: https://academicpositions.com/jobs/field/chemistry-organic-chemistry
// robots.txt di academicpositions.com consente il crawling generico.
// Nota: qui si fa parsing HTML (nessuna API pubblica nota), quindi i
// selettori possono richiedere manutenzione se il sito cambia struttura.
// Strategia robusta: ci basiamo sul pattern stabile "/ad/" nei link agli
// annunci, non su classi CSS che cambiano spesso.
// ---------------------------------------------------------------------------
async function fetchAcademicPositionsField(fieldSlug) {
  const url = `https://academicpositions.com/jobs/field/${encodeURIComponent(fieldSlug)}`;
  const items = [];
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      console.warn(`⚠️  academicpositions.com [${fieldSlug}]: HTTP ${res.status}`);
      return items;
    }
    const html = await res.text();
    const $ = cheerio.load(html);

    $('a[href*="/ad/"]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr("href") || "";
      const title = $el.text().replace(/\s+/g, " ").trim();
      if (!title || title.length < 8) return; // scarta link "fantasma"/icone

      const link = href.startsWith("http") ? href : `https://academicpositions.com${href}`;

      // Cerca testo di contesto (istituzione, paese) nel blocco genitore più vicino
      let context = "";
      let $container = $el.closest("article, li, div");
      if ($container && $container.length) {
        context = $container.text().replace(/\s+/g, " ").trim();
      }

      items.push({
        title,
        link,
        description: context.slice(0, 400),
        pubDate: null,
        institution: "",
        location: "",
        source: `academicpositions.com / ${fieldSlug}`,
      });
    });
  } catch (err) {
    console.warn(`⚠️  academicpositions.com [${fieldSlug}]: ${err.message}`);
  }

  // Dedup interno alla pagina (a volte lo stesso annuncio compare più volte nel DOM)
  const seenLinks = new Set();
  return items.filter((it) => {
    if (seenLinks.has(it.link)) return false;
    seenLinks.add(it.link);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Filtri
// ---------------------------------------------------------------------------
function matchesPhdIndicator(item, config) {
  if (!config.requirePhdIndicator) return true;
  const hay = norm(item.title + " " + item.description);
  return (config.phdIndicatorWords || []).some((w) => hay.includes(norm(w)));
}

function matchedKeywords(item, config) {
  const hay = norm(item.title + " " + item.description + " " + item.source);
  const kws = config.keywords || [];
  if (kws.length === 0) return ["(nessun filtro: tutte le materie)"];
  return kws.filter((k) => hay.includes(norm(k)));
}

function isExcluded(item, config) {
  const hay = norm(item.title + " " + item.description);
  return (config.excludeKeywords || []).some((k) => hay.includes(norm(k)));
}

// ---------------------------------------------------------------------------
// Notifiche via ntfy.sh
// ---------------------------------------------------------------------------
async function sendNtfy(topic, { title, message, click }) {
  if (!topic) {
    console.warn("⚠️  NTFY_TOPIC non impostato: salto l'invio della notifica.");
    return;
  }
  try {
    await fetchWithTimeout(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers: {
        Title: title,
        ...(click ? { Click: click } : {}),
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: message,
    });
  } catch (err) {
    console.warn(`⚠️  Invio notifica ntfy fallito: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const config = await readJson(CONFIG_PATH, {});
  const listings = await readJson(LISTINGS_PATH, []);
  const seenRaw = await readJson(SEEN_PATH, null);
  const bootstrap = seenRaw === null; // primo avvio: niente notifiche, solo popolamento
  const seen = new Set(seenRaw || []);

  const sources = config.sources || {};
  const allRaw = [];

  for (const slug of sources.jobsAcUkSubjects || []) {
    allRaw.push(...(await fetchJobsAcUkSubject(slug)));
    await new Promise((r) => setTimeout(r, 400));
  }
  for (const slug of sources.academicPositionsFields || []) {
    allRaw.push(...(await fetchAcademicPositionsField(slug)));
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`Trovati ${allRaw.length} annunci grezzi dalle fonti configurate.`);

  const matched = [];
  for (const item of allRaw) {
    if (isExcluded(item, config)) continue;
    if (!matchesPhdIndicator(item, config)) continue;
    const kws = matchedKeywords(item, config);
    if (kws.length === 0) continue;
    const id = makeId(item.link, item.title);
    matched.push({ ...item, id, matchedKeywords: kws });
  }

  console.log(`${matched.length} annunci corrispondono ai filtri (dottorato + materie).`);

  const newItems = matched.filter((it) => !seen.has(it.id));
  console.log(`${newItems.length} sono nuovi rispetto all'ultima esecuzione.`);

  // Aggiorna listings.json: metti i nuovi in testa, tieni gli esistenti, cappa la lunghezza
  const now = new Date().toISOString();
  const withTimestamps = newItems.map((it) => ({ ...it, firstSeen: now }));
  const merged = [...withTimestamps, ...listings].slice(0, MAX_LISTINGS);

  // Aggiorna seen: aggiungi tutti gli id trovati in questa run (non solo i nuovi)
  for (const it of matched) seen.add(it.id);
  const seenArray = Array.from(seen).slice(-MAX_SEEN);

  await writeJson(LISTINGS_PATH, merged);
  await writeJson(SEEN_PATH, seenArray);
  await writeJson(RUNLOG_PATH, {
    lastRun: now,
    rawCount: allRaw.length,
    matchedCount: matched.length,
    newCount: newItems.length,
    bootstrap,
  });

  if (bootstrap) {
    console.log("🌱 Primo avvio: elenco popolato, nessuna notifica inviata (baseline).");
    return;
  }

  if (newItems.length === 0) {
    console.log("Nessuna novità: nessuna notifica da inviare.");
    return;
  }

  const topic = process.env.NTFY_TOPIC;
  const siteUrl = config.sitePublicUrl || "";

  if (newItems.length <= 3) {
    for (const it of newItems) {
      await sendNtfy(topic, {
        title: `Nuovo dottorato: ${it.title.slice(0, 120)}`,
        message: `${it.source}\n${it.link}`,
        click: it.link,
      });
    }
  } else {
    const preview = newItems
      .slice(0, 5)
      .map((it) => `• ${it.title.slice(0, 90)} (${it.source})`)
      .join("\n");
    await sendNtfy(topic, {
      title: `${newItems.length} nuove offerte di dottorato trovate`,
      message: `${preview}${newItems.length > 5 ? `\n…e altre ${newItems.length - 5}` : ""}`,
      click: siteUrl || newItems[0].link,
    });
  }

  console.log("✅ Notifiche inviate.");
}

main().catch((err) => {
  console.error("Errore fatale:", err);
  process.exit(1);
});
