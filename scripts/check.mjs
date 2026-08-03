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

const MAX_LISTINGS = 500;
const MAX_SEEN = 5000;
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

// Ritenta una volta, dopo una pausa, solo per errori transitori (5xx, timeout,
// errori di rete) — non ha senso ritentare un 404/403, che non cambierà.
async function withRetry(fn, { retries = 1, delayMs = 2500, isRetryable } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = isRetryable ? isRetryable(err) : true;
      if (attempt >= retries || !retryable) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

function is5xxOrNetworkError(err) {
  const msg = String(err && err.message).toLowerCase();
  return /50\d|timeout|network|econn|abort/.test(msg);
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

function dedupByLink(items) {
  const seenLinks = new Set();
  return items.filter((it) => {
    if (!it.link || seenLinks.has(it.link)) return false;
    seenLinks.add(it.link);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Estrazione scadenza (best-effort, formati diversi da sito a sito)
// Ritorna { deadlineText, deadlineISO } — deadlineISO è null se non si riesce
// a interpretare la data in modo affidabile (meglio mostrare solo il testo
// grezzo che sbagliare una scadenza).
// ---------------------------------------------------------------------------
const MONTHS_EN = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function tryParseDate(y, mIdx, d) {
  if (mIdx == null || Number.isNaN(mIdx)) return null;
  const dt = new Date(Date.UTC(y, mIdx, d));
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function extractDeadline(text) {
  if (!text) return { deadlineText: null, deadlineISO: null };
  const hay = text;

  // "Closing on: 2026-08-17"
  let m = hay.match(/Closing on:?\s*(\d{4})-(\d{2})-(\d{2})/i);
  if (m) {
    const iso = tryParseDate(+m[1], +m[2] - 1, +m[3]);
    return { deadlineText: m[0], deadlineISO: iso };
  }

  // "Deadline 24 Aug '26" o "Deadline: 24 August 2026"
  m = hay.match(/Deadline:?\s*(\d{1,2})\s+([A-Za-z]{3,9})[a-z]*\.?\s*'?(\d{2,4})/i);
  if (m) {
    const monIdx = MONTHS_EN[m[2].slice(0, 3).toLowerCase()];
    let year = +m[3];
    if (year < 100) year += 2000;
    const iso = tryParseDate(year, monIdx, +m[1]);
    return { deadlineText: m[0], deadlineISO: iso };
  }

  // "Closes 17 Aug" (jobs.ac.uk, spesso senza anno esplicito: assumiamo l'anno corrente o il prossimo)
  m = hay.match(/Closes:?\s*(\d{1,2})\s+([A-Za-z]{3,9})/i);
  if (m) {
    const monIdx = MONTHS_EN[m[2].slice(0, 3).toLowerCase()];
    const now = new Date();
    let year = now.getUTCFullYear();
    let iso = tryParseDate(year, monIdx, +m[1]);
    if (iso && new Date(iso).getTime() < Date.now() - 3 * 24 * 3600 * 1000) {
      iso = tryParseDate(year + 1, monIdx, +m[1]); // probabilmente l'anno prossimo
    }
    return { deadlineText: m[0], deadlineISO: iso };
  }

  // Italiano: "scade il 01/09/2026"
  m = hay.match(/scade\s+il\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (m) {
    const iso = tryParseDate(+m[3], +m[2] - 1, +m[1]);
    return { deadlineText: m[0], deadlineISO: iso };
  }

  return { deadlineText: null, deadlineISO: null };
}

// ---------------------------------------------------------------------------
// Estrazione luogo (best-effort): cerca il nome di un paese nel testo.
// Elenco volutamente europeo + pochi altri paesi comuni; esclude nomi
// ambigui che generano falsi positivi in bacheche accademiche (es.
// "Georgia" quasi sempre è lo stato USA, non il paese; "Jordan" è quasi
// sempre un nome di persona).
// ---------------------------------------------------------------------------
const COUNTRIES = [
  "United Kingdom", "UK", "Ireland", "Italy", "Italia", "Spain", "Portugal",
  "France", "Germany", "Netherlands", "Belgium", "Luxembourg", "Switzerland",
  "Austria", "Sweden", "Norway", "Denmark", "Finland", "Iceland", "Poland",
  "Czech Republic", "Czechia", "Slovakia", "Hungary", "Slovenia", "Croatia",
  "Romania", "Bulgaria", "Greece", "Estonia", "Latvia", "Lithuania", "Malta",
  "Cyprus", "Serbia", "Ukraine", "Turkey", "Morocco",
  "United States", "USA", "Canada", "Australia", "New Zealand", "Japan",
  "China", "Singapore", "South Korea",
];

// Ordina le stringhe più lunghe prima, così "United Kingdom" batte "UK" ecc.
const COUNTRY_PATTERNS = COUNTRIES
  .sort((a, b) => b.length - a.length)
  .map((name) => ({ name, re: new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") }));

function normalizeCountryLabel(name) {
  if (name === "UK") return "United Kingdom";
  if (name === "USA") return "United States";
  if (name === "Italia") return "Italy";
  if (name === "Czechia") return "Czech Republic";
  return name;
}

// Ritorna sia l'etichetta normalizzata (per il filtro/visualizzazione) sia il
// testo grezzo effettivamente trovato (serve per cercare la città accanto,
// visto che nel testo originale può comparire come "UK" e non "United Kingdom").
function extractCountry(text) {
  if (!text) return null;
  for (const { name, re } of COUNTRY_PATTERNS) {
    const m = text.match(re);
    if (m) return { label: normalizeCountryLabel(name), raw: m[0] };
  }
  return null;
}

// Euristica leggera per la città: cerca "Parola/e, <Paese>" con la prima
// lettera maiuscola. Bassa affidabilità intenzionale: se il pattern non è
// chiaro si preferisce non mostrare nulla piuttosto che sbagliare.
function extractCity(text, countryRaw) {
  if (!text || !countryRaw) return null;
  const escaped = countryRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`([A-ZÀ-Ý][A-Za-zÀ-ÿ'\\-]+(?:\\s[A-ZÀ-Ý][A-Za-zÀ-ÿ'\\-]+){0,2}),\\s*${escaped}\\b`);
  const m = text.match(re);
  if (m && m[1] && m[1].length <= 28 && !/\d/.test(m[1])) return m[1].trim();
  return null;
}

function deriveLocation(item) {
  const hay = `${item.title} ${item.description} ${item.source}`;
  if (item.countryHint) {
    return { country: item.countryHint, city: extractCity(hay, item.countryHint) };
  }
  const found = extractCountry(hay);
  if (!found) return { country: null, city: null };
  return { country: found.label, city: extractCity(hay, found.raw) };
}

// ---------------------------------------------------------------------------
// Estrazione stipendio/borsa (best-effort, mostrato così com'è: nessuna
// conversione di valuta, nessuna normalizzazione — meglio un testo grezzo
// onesto che un numero "pulito" ma sbagliato).
// ---------------------------------------------------------------------------
function extractPay(text) {
  if (!text) return null;

  // "£33,002 to £46,049 per annum" / "£33,002 - £46,049"
  let m = text.match(/£\s?[\d,]+(?:\.\d+)?\s?(?:to|-|–)\s?£\s?[\d,]+(?:\.\d+)?(?:\s?per\s?\w+)?/i);
  if (m) return m[0].trim();

  // "$37,093/yr" / "$3,500 per month"
  m = text.match(/\$\s?[\d,]+(?:\.\d+)?\s?(?:\/\s?\w+|per\s?\w+)?/i);
  if (m) return m[0].trim();

  // "€3,833.56" / "€ 2.200 al mese" / "EUR 2000"
  m = text.match(/€\s?[\d.,]+\s?(?:\/\s?\w+|per\s?\w+|al mese|mensili)?/i);
  if (m) return m[0].trim();
  m = text.match(/EUR\s?[\d.,]+/i);
  if (m) return m[0].trim();

  // Italiano: "borsa di €X" / "importo della borsa: X euro" / "stipendio di X euro"
  m = text.match(/(?:borsa(?:\s+di\s+studio)?|stipendio)[^.\n]{0,25}?(\d[\d.,]{2,})\s?(?:€|euro)/i);
  if (m) return m[0].trim();

  // Generico: "stipend of £X" / "salary of $X" già coperti sopra dai simboli;
  // aggiungiamo "fully funded" come segnale debole (non è una cifra, ma è
  // un'informazione utile e spesso è tutto ciò che l'annuncio dice).
  if (/fully[\s-]funded/i.test(text)) return "Fully funded (importo non specificato)";

  return null;
}

// ---------------------------------------------------------------------------
// Sorgente: jobs.ac.uk — feed RSS per area disciplinare
// Esempio: https://www.jobs.ac.uk/jobs/chemistry/?format=rss
// robots.txt di jobs.ac.uk non vieta questi percorsi (verificato manualmente).
// ---------------------------------------------------------------------------
async function fetchJobsAcUkSubject(subjectSlug) {
  const url = `https://www.jobs.ac.uk/jobs/${encodeURIComponent(subjectSlug)}/?format=rss`;
  const items = [];
  try {
    const feed = await withRetry(() => rssParser.parseURL(url), { isRetryable: is5xxOrNetworkError });
    for (const it of feed.items || []) {
      const description = it.contentSnippet || it.content || "";
      const { deadlineText, deadlineISO } = extractDeadline(description);
      items.push({
        title: it.title || "",
        link: it.link || "",
        description,
        pubDate: it.pubDate || it.isoDate || null,
        deadlineText,
        deadlineISO,
        source: `jobs.ac.uk / ${subjectSlug}`,
      });
    }
  } catch (err) {
    console.warn(`⚠️  jobs.ac.uk [${subjectSlug}]: ${err.message}`);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Sorgente generica per pagine HTML: cerca link il cui href soddisfa
// `hrefTest`, usa il testo del link come titolo e il testo del blocco
// genitore più vicino come descrizione/contesto (da cui si prova anche a
// estrarre la scadenza). Usata per academicpositions.com, AcademicTransfer,
// PhDportal, jobRxiv, bandi.mur.gov.it: siti senza API pubblica ma che il
// loro robots.txt permette di consultare in modo automatico.
// ---------------------------------------------------------------------------
async function fetchHtmlListing(url, { hrefTest, baseUrl, minTitleLen = 8, sourceLabel, countryHint = null }) {
  const items = [];
  try {
    const res = await withRetry(
      async () => {
        const r = await fetchWithTimeout(url);
        if (!r.ok && r.status >= 500) {
          throw new Error(`HTTP ${r.status}`); // 5xx: vale la pena ritentare
        }
        return r;
      },
      { isRetryable: is5xxOrNetworkError }
    );
    if (!res.ok) {
      console.warn(`⚠️  ${sourceLabel}: HTTP ${res.status} su ${url}`);
      return items;
    }
    const html = await res.text();
    const $ = cheerio.load(html);

    $("a[href]").each((_, el) => {
      const $el = $(el);
      const href = $el.attr("href") || "";
      if (!hrefTest(href)) return;
      const title = $el.text().replace(/\s+/g, " ").trim();
      if (!title || title.length < minTitleLen) return;

      const link = href.startsWith("http") ? href : `${baseUrl}${href.startsWith("/") ? "" : "/"}${href}`;

      let context = "";
      const $container = $el.closest("article, li, div");
      if ($container && $container.length) {
        context = $container.text().replace(/\s+/g, " ").trim();
      }

      const { deadlineText, deadlineISO } = extractDeadline(context);

      items.push({
        title,
        link,
        description: context.slice(0, 500),
        pubDate: null,
        deadlineText,
        deadlineISO,
        source: sourceLabel,
        countryHint,
      });
    });
  } catch (err) {
    console.warn(`⚠️  ${sourceLabel}: ${err.message}`);
  }
  return dedupByLink(items);
}

// academicpositions.com — pagine listato per campo. Link stabili: "/ad/".
async function fetchAcademicPositionsField(fieldSlug) {
  const url = `https://academicpositions.com/jobs/field/${encodeURIComponent(fieldSlug)}`;
  return fetchHtmlListing(url, {
    hrefTest: (href) => href.includes("/ad/"),
    baseUrl: "https://academicpositions.com",
    sourceLabel: `academicpositions.com / ${fieldSlug}`,
  });
}

// AcademicTransfer (Paesi Bassi) — elenco generale posizioni di dottorato.
// robots.txt: Allow generico, solo /account/ e /apply/ vietati. Link stabili:
// "/en/jobs/<id>/...".
async function fetchAcademicTransferPhd() {
  const url = "https://www.academictransfer.com/en/job-type/phd/";
  return fetchHtmlListing(url, {
    hrefTest: (href) => /\/en\/jobs\/\d+\//.test(href),
    baseUrl: "https://www.academictransfer.com",
    sourceLabel: "academictransfer.com",
    countryHint: "Netherlands", // fonte specifica per i Paesi Bassi
  });
}

// PhDportal — cataloghi di programmi di dottorato per materia, filtrati su
// "europe". robots.txt vieta solo le ricerche con "?kw=" in query string:
// questi percorsi (/search/phd/<materia>/europe) non usano query string.
// Nota: qui sono più "programmi" che "bandi con scadenza", cambiano meno
// spesso — utile ma con un ritmo di novità diverso dalle altre fonti.
async function fetchPhdPortalSubjectEurope(subjectSlug) {
  const url = `https://www.phdportal.com/search/phd/${encodeURIComponent(subjectSlug)}/europe`;
  return fetchHtmlListing(url, {
    hrefTest: (href) => /\/studies\/\d+\//.test(href),
    baseUrl: "https://www.phdportal.com",
    sourceLabel: `phdportal.com / ${subjectSlug}`,
  });
}

// jobRxiv — bacheca annunci accademici generalista, ricerca per parola
// chiave (?s=). robots.txt: nessun divieto sulle pagine di ricerca/annuncio.
async function fetchJobrxivKeyword(keyword) {
  const url = `https://jobrxiv.org/?s=${encodeURIComponent(keyword + " phd")}`;
  return fetchHtmlListing(url, {
    hrefTest: (href) => href.includes("/job/") || href.includes("post_type=job_listing"),
    baseUrl: "https://jobrxiv.org",
    sourceLabel: `jobrxiv.org [${keyword}]`,
  });
}

// bandi.mur.gov.it — portale ufficiale del Ministero italiano, elenco di
// TUTTI i bandi di dottorato attivi (ogni ateneo, ogni area). robots.txt
// completamente aperto. Non esiste un filtro per parola chiave nell'URL:
// si scarica l'elenco (filtrato per "aperti") e si applicano i filtri
// materia/keyword localmente, come per le altre fonti.
// Nota: i bandi italiani sono tipicamente concorsi generali per ateneo
// (es. "Dottorato in Chimica"), non annunci per singolo progetto: il tema
// di ricerca specifico si concorda di solito contattando prima un docente.
async function fetchBandiMur() {
  const url =
    "https://bandi.mur.gov.it/doctorate.php/public/cercaFellowship?jf_comp_status_id=2&bb_type_code=%25&idarea=%25&azione=cerca";
  return fetchHtmlListing(url, {
    hrefTest: (href) => href.includes("id_fellow"),
    baseUrl: "https://bandi.mur.gov.it",
    minTitleLen: 4,
    sourceLabel: "bandi.mur.gov.it",
    countryHint: "Italy",
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

function matchesCountry(item, config) {
  const countries = config.countries || [];
  if (countries.length === 0) return true; // nessun filtro paese impostato
  // Preferisci il campo paese già estratto (più preciso); se assente, ripiega
  // sulla ricerca testuale grezza (com'era prima) per non perdere risultati.
  if (item.country) {
    return countries.some((c) => norm(item.country).includes(norm(c)));
  }
  const hay = norm(item.title + " " + item.description + " " + item.source);
  return countries.some((c) => hay.includes(norm(c)));
}

// ---------------------------------------------------------------------------
// Notifiche via ntfy.sh
// ---------------------------------------------------------------------------
async function sendNtfy(topic, { title, message, click, priority }) {
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
        ...(priority ? { Priority: priority } : {}),
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: message,
    });
  } catch (err) {
    console.warn(`⚠️  Invio notifica ntfy fallito: ${err.message}`);
  }
}

function formatDeadlineShort(it) {
  if (it.deadlineISO) {
    return new Date(it.deadlineISO).toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" });
  }
  if (it.deadlineText) return it.deadlineText;
  return null;
}

function formatLocation(it) {
  if (it.city && it.country) return `${it.city}, ${it.country}`;
  if (it.country) return it.country;
  return null;
}

// Messaggio ricco per una singola offerta (usato quando le novità sono poche)
function buildItemMessage(it) {
  const lines = [it.source];
  const loc = formatLocation(it);
  if (loc) lines.push(`📍 ${loc}`);
  const dl = formatDeadlineShort(it);
  if (dl) lines.push(`Scadenza: ${dl}`);
  if (it.payText) lines.push(`💰 ${it.payText}`);
  const snippet = (it.description || "").replace(/\s+/g, " ").trim();
  if (snippet) lines.push(snippet.slice(0, 220) + (snippet.length > 220 ? "…" : ""));
  lines.push(it.link);
  return lines.join("\n");
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
  const pause = () => new Promise((r) => setTimeout(r, 400));

  for (const slug of sources.jobsAcUkSubjects || []) {
    allRaw.push(...(await fetchJobsAcUkSubject(slug)));
    await pause();
  }
  for (const slug of sources.academicPositionsFields || []) {
    allRaw.push(...(await fetchAcademicPositionsField(slug)));
    await pause();
  }
  if (sources.academicTransfer) {
    allRaw.push(...(await fetchAcademicTransferPhd()));
    await pause();
  }
  for (const slug of sources.phdPortalSubjects || []) {
    allRaw.push(...(await fetchPhdPortalSubjectEurope(slug)));
    await pause();
  }
  if (sources.bandiMur) {
    allRaw.push(...(await fetchBandiMur()));
    await pause();
  }
  if (sources.jobrxiv) {
    for (const kw of config.keywords || []) {
      allRaw.push(...(await fetchJobrxivKeyword(kw)));
      await pause();
    }
  }

  console.log(`Trovati ${allRaw.length} annunci grezzi dalle fonti configurate.`);

  const matched = [];
  for (const item of allRaw) {
    if (isExcluded(item, config)) continue;
    if (!matchesPhdIndicator(item, config)) continue;

    const { country, city } = deriveLocation(item);
    const payText = extractPay(`${item.title} ${item.description}`);
    const withLocation = { ...item, country, city, payText };

    if (!matchesCountry(withLocation, config)) continue;
    const kws = matchedKeywords(withLocation, config);
    if (kws.length === 0) continue;
    const id = makeId(item.link, item.title);
    matched.push({ ...withLocation, id, matchedKeywords: kws });
  }

  console.log(`${matched.length} annunci corrispondono ai filtri (dottorato + materie + paese).`);

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
        title: `🎓 Nuovo dottorato: ${it.title.slice(0, 100)}`,
        message: buildItemMessage(it),
        click: it.link,
      });
    }
  } else {
    const preview = newItems
      .slice(0, 6)
      .map((it) => {
        const dl = formatDeadlineShort(it);
        const loc = formatLocation(it);
        return `• ${it.title.slice(0, 70)}${loc ? ` (${loc})` : ""}${dl ? ` — scad. ${dl}` : ""}`;
      })
      .join("\n");
    await sendNtfy(topic, {
      title: `🎓 ${newItems.length} nuove offerte di dottorato trovate`,
      message: `${preview}${newItems.length > 6 ? `\n…e altre ${newItems.length - 6}` : ""}`,
      click: siteUrl || newItems[0].link,
    });
  }

  console.log("✅ Notifiche inviate.");
}

main().catch((err) => {
  console.error("Errore fatale:", err);
  process.exit(1);
});
