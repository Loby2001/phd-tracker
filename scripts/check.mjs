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
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
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

// ---------------------------------------------------------------------------
// Città — elenco delle principali città universitarie/capitali europee, per
// riconoscere il luogo "in chiaro" anche quando il testo non segue il
// pattern rigido "Città, Paese" usato da extractCity qui sopra. Serve
// soprattutto per i dottorati condivisi tra più sedi (es. le reti MSCA
// Doctoral Networks, che spesso elencano più università in più paesi senza
// una struttura di testo fissa): qui si cercano TUTTE le città note nel
// testo, non solo la prima vicino al nome del paese.
//
// A differenza del confronto sui paesi, qui il confronto è case-sensitive
// (richiede l'iniziale maiuscola): diverse città coincidono con parole o
// nomi inglesi comuni (es. "split"/"Split", "nice"/"Nice") e richiedere la
// maiuscola riduce molto i falsi positivi. Alcune città sono comunque state
// escluse deliberatamente perché ambigue anche da maiuscole — "Nice"
// (aggettivo), "Bath", "Reading", "Hull", "Derby", "York" (sottostringa di
// "New York"), "Nancy" (nome di persona, frequente nei riferimenti ai
// ricercatori), "Tours" (plurale di "tour"): meglio ometterle che rischiare
// di mostrare un luogo sbagliato.
const CITIES = [
  // Regno Unito / Irlanda
  ["London", "United Kingdom"], ["Manchester", "United Kingdom"], ["Birmingham", "United Kingdom"],
  ["Edinburgh", "United Kingdom"], ["Glasgow", "United Kingdom"], ["Liverpool", "United Kingdom"],
  ["Leeds", "United Kingdom"], ["Sheffield", "United Kingdom"], ["Bristol", "United Kingdom"],
  ["Oxford", "United Kingdom"], ["Cambridge", "United Kingdom"], ["Nottingham", "United Kingdom"],
  ["Southampton", "United Kingdom"], ["Newcastle", "United Kingdom"], ["Cardiff", "United Kingdom"],
  ["Belfast", "United Kingdom"], ["Leicester", "United Kingdom"], ["Coventry", "United Kingdom"],
  ["Exeter", "United Kingdom"], ["Durham", "United Kingdom"], ["Warwick", "United Kingdom"],
  ["Aberdeen", "United Kingdom"], ["Dundee", "United Kingdom"], ["Loughborough", "United Kingdom"],
  ["Lancaster", "United Kingdom"], ["Swansea", "United Kingdom"], ["Bangor", "United Kingdom"],
  ["Dublin", "Ireland"], ["Cork", "Ireland"], ["Galway", "Ireland"], ["Limerick", "Ireland"],

  // Italia
  ["Roma", "Italy"], ["Rome", "Italy"], ["Milano", "Italy"], ["Milan", "Italy"],
  ["Torino", "Italy"], ["Turin", "Italy"], ["Bologna", "Italy"], ["Firenze", "Italy"],
  ["Florence", "Italy"], ["Napoli", "Italy"], ["Naples", "Italy"], ["Padova", "Italy"],
  ["Padua", "Italy"], ["Venezia", "Italy"], ["Venice", "Italy"], ["Genova", "Italy"],
  ["Genoa", "Italy"], ["Trieste", "Italy"], ["Trento", "Italy"], ["Verona", "Italy"],
  ["Brescia", "Italy"], ["Bergamo", "Italy"], ["Pavia", "Italy"], ["Parma", "Italy"],
  ["Modena", "Italy"], ["Ferrara", "Italy"], ["Perugia", "Italy"], ["Siena", "Italy"],
  ["Pisa", "Italy"], ["Cagliari", "Italy"], ["Sassari", "Italy"], ["Palermo", "Italy"],
  ["Catania", "Italy"], ["Bari", "Italy"], ["Lecce", "Italy"], ["Salerno", "Italy"],
  ["Udine", "Italy"], ["Ancona", "Italy"], ["Camerino", "Italy"], ["Urbino", "Italy"],
  ["Chieti", "Italy"], ["L'Aquila", "Italy"], ["Novara", "Italy"], ["Varese", "Italy"],
  ["Piacenza", "Italy"], ["Cremona", "Italy"],

  // Germania
  ["Berlin", "Germany"], ["Munich", "Germany"], ["München", "Germany"], ["Hamburg", "Germany"],
  ["Cologne", "Germany"], ["Köln", "Germany"], ["Frankfurt", "Germany"], ["Stuttgart", "Germany"],
  ["Düsseldorf", "Germany"], ["Dusseldorf", "Germany"], ["Leipzig", "Germany"], ["Dresden", "Germany"],
  ["Hannover", "Germany"], ["Bremen", "Germany"], ["Bonn", "Germany"], ["Heidelberg", "Germany"],
  ["Freiburg", "Germany"], ["Tübingen", "Germany"], ["Tubingen", "Germany"], ["Göttingen", "Germany"],
  ["Gottingen", "Germany"], ["Mainz", "Germany"], ["Karlsruhe", "Germany"], ["Erlangen", "Germany"],
  ["Würzburg", "Germany"], ["Wurzburg", "Germany"], ["Jena", "Germany"], ["Konstanz", "Germany"],
  ["Marburg", "Germany"], ["Aachen", "Germany"], ["Bochum", "Germany"], ["Kiel", "Germany"],
  ["Regensburg", "Germany"], ["Rostock", "Germany"], ["Potsdam", "Germany"], ["Duisburg", "Germany"],
  ["Essen", "Germany"], ["Bielefeld", "Germany"], ["Giessen", "Germany"],
  ["Magdeburg", "Germany"], ["Greifswald", "Germany"], ["Halle", "Germany"],
  ["Jülich", "Germany"], ["Julich", "Germany"], ["Darmstadt", "Germany"],
  ["Braunschweig", "Germany"], ["Bremerhaven", "Germany"], ["Geesthacht", "Germany"],

  // Francia
  ["Paris", "France"], ["Lyon", "France"], ["Marseille", "France"], ["Toulouse", "France"],
  ["Bordeaux", "France"], ["Lille", "France"], ["Strasbourg", "France"], ["Nantes", "France"],
  ["Montpellier", "France"], ["Grenoble", "France"], ["Rennes", "France"], ["Dijon", "France"],
  ["Avignon", "France"], ["Angers", "France"], ["Reims", "France"], ["Orléans", "France"],
  ["Orleans", "France"], ["Clermont-Ferrand", "France"], ["Amiens", "France"], ["Limoges", "France"],
  ["Metz", "France"], ["Besançon", "France"], ["Besancon", "France"], ["Perpignan", "France"],
  ["Caen", "France"], ["Poitiers", "France"], ["Nîmes", "France"], ["Nimes", "France"],
  ["Le Havre", "France"], ["Saclay", "France"], ["Palaiseau", "France"], ["Évry", "France"],

  // Spagna
  ["Madrid", "Spain"], ["Barcelona", "Spain"], ["Valencia", "Spain"], ["Sevilla", "Spain"],
  ["Seville", "Spain"], ["Zaragoza", "Spain"], ["Málaga", "Spain"], ["Malaga", "Spain"],
  ["Bilbao", "Spain"], ["Granada", "Spain"], ["Salamanca", "Spain"], ["Valladolid", "Spain"],
  ["Santiago de Compostela", "Spain"], ["San Sebastián", "Spain"], ["San Sebastian", "Spain"],
  ["Pamplona", "Spain"], ["Oviedo", "Spain"], ["Murcia", "Spain"], ["Alicante", "Spain"],
  ["Córdoba", "Spain"], ["Cordoba", "Spain"], ["Tarragona", "Spain"], ["Girona", "Spain"],
  ["Vigo", "Spain"], ["Cadiz", "Spain"], ["Cádiz", "Spain"],

  // Portogallo
  ["Lisboa", "Portugal"], ["Lisbon", "Portugal"], ["Porto", "Portugal"], ["Coimbra", "Portugal"],
  ["Braga", "Portugal"], ["Aveiro", "Portugal"], ["Évora", "Portugal"], ["Evora", "Portugal"],

  // Paesi Bassi
  ["Amsterdam", "Netherlands"], ["Rotterdam", "Netherlands"], ["Utrecht", "Netherlands"],
  ["Delft", "Netherlands"], ["Groningen", "Netherlands"], ["Leiden", "Netherlands"],
  ["Maastricht", "Netherlands"], ["Nijmegen", "Netherlands"], ["Eindhoven", "Netherlands"],
  ["Wageningen", "Netherlands"], ["Tilburg", "Netherlands"], ["The Hague", "Netherlands"],
  ["Den Haag", "Netherlands"],

  // Belgio / Lussemburgo
  ["Brussels", "Belgium"], ["Bruxelles", "Belgium"], ["Leuven", "Belgium"], ["Ghent", "Belgium"],
  ["Gent", "Belgium"], ["Antwerp", "Belgium"], ["Antwerpen", "Belgium"], ["Liège", "Belgium"],
  ["Liege", "Belgium"], ["Namur", "Belgium"], ["Mons", "Belgium"], ["Luxembourg", "Luxembourg"],

  // Svizzera / Austria
  ["Zurich", "Switzerland"], ["Zürich", "Switzerland"], ["Geneva", "Switzerland"],
  ["Genève", "Switzerland"], ["Lausanne", "Switzerland"], ["Basel", "Switzerland"],
  ["Bern", "Switzerland"], ["Fribourg", "Switzerland"],
  ["Vienna", "Austria"], ["Wien", "Austria"], ["Graz", "Austria"], ["Innsbruck", "Austria"],
  ["Linz", "Austria"], ["Salzburg", "Austria"], ["Klagenfurt", "Austria"],

  // Scandinavia / Nord Europa
  ["Stockholm", "Sweden"], ["Gothenburg", "Sweden"], ["Göteborg", "Sweden"], ["Uppsala", "Sweden"],
  ["Lund", "Sweden"], ["Umeå", "Sweden"], ["Umea", "Sweden"], ["Linköping", "Sweden"],
  ["Copenhagen", "Denmark"], ["København", "Denmark"], ["Aarhus", "Denmark"], ["Odense", "Denmark"],
  ["Aalborg", "Denmark"], ["Oslo", "Norway"], ["Bergen", "Norway"], ["Trondheim", "Norway"],
  ["Tromsø", "Norway"], ["Tromso", "Norway"], ["Helsinki", "Finland"], ["Espoo", "Finland"],
  ["Tampere", "Finland"], ["Turku", "Finland"], ["Oulu", "Finland"], ["Jyväskylä", "Finland"],
  ["Reykjavik", "Iceland"],

  // Europa centrale / orientale
  ["Warsaw", "Poland"], ["Warszawa", "Poland"], ["Kraków", "Poland"], ["Krakow", "Poland"],
  ["Wrocław", "Poland"], ["Wroclaw", "Poland"], ["Poznań", "Poland"], ["Poznan", "Poland"],
  ["Gdańsk", "Poland"], ["Gdansk", "Poland"], ["Łódź", "Poland"], ["Lodz", "Poland"],
  ["Prague", "Czech Republic"], ["Praha", "Czech Republic"], ["Brno", "Czech Republic"],
  ["Olomouc", "Czech Republic"], ["Bratislava", "Slovakia"], ["Košice", "Slovakia"],
  ["Kosice", "Slovakia"], ["Budapest", "Hungary"], ["Debrecen", "Hungary"], ["Szeged", "Hungary"],
  ["Ljubljana", "Slovenia"], ["Maribor", "Slovenia"], ["Zagreb", "Croatia"], ["Split", "Croatia"],
  ["Rijeka", "Croatia"], ["Bucharest", "Romania"], ["București", "Romania"], ["Cluj-Napoca", "Romania"],
  ["Timișoara", "Romania"], ["Timisoara", "Romania"], ["Iași", "Romania"], ["Iasi", "Romania"],
  ["Sofia", "Bulgaria"], ["Plovdiv", "Bulgaria"], ["Athens", "Greece"], ["Athina", "Greece"],
  ["Thessaloniki", "Greece"], ["Patras", "Greece"], ["Heraklion", "Greece"], ["Tallinn", "Estonia"],
  ["Tartu", "Estonia"], ["Riga", "Latvia"], ["Vilnius", "Lithuania"], ["Kaunas", "Lithuania"],
  ["Valletta", "Malta"], ["Nicosia", "Cyprus"], ["Belgrade", "Serbia"], ["Beograd", "Serbia"],
  ["Novi Sad", "Serbia"], ["Kyiv", "Ukraine"], ["Kiev", "Ukraine"], ["Lviv", "Ukraine"],
  ["Istanbul", "Turkey"], ["Ankara", "Turkey"], ["Izmir", "Turkey"],
];

// Città più lunghe prima (utile per nomi composti come "San Sebastián").
// Si tengono nome e paese "grezzi" e l'escape pre-calcolato: il pattern
// vero e proprio viene creato al volo in extractCities perché i flag
// (case-sensitive o no) dipendono dal testo che si sta analizzando, vedi
// isShoutyText qui sotto.
const CITY_ENTRIES = CITIES.slice()
  .sort((a, b) => b[0].length - a[0].length)
  .map(([city, country]) => ({
    city,
    country,
    escaped: city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  }));

// Alcune città esistono nell'elenco in più varianti linguistiche (es.
// "Roma"/"Rome", "Genève"/"Geneva"): quando entrambe compaiono nello stesso
// annuncio (titolo in una lingua, descrizione nell'altra) questa mappa le
// riconduce a un'unica forma da mostrare, per non ripetere due volte la
// stessa città con nomi diversi.
const CITY_CANONICAL = {
  roma: "Rome", milano: "Milan", torino: "Turin", firenze: "Florence",
  napoli: "Naples", padova: "Padua", venezia: "Venice", genova: "Genoa",
  münchen: "Munich", köln: "Cologne", wien: "Vienna", genève: "Geneva",
  zürich: "Zurich", lisboa: "Lisbon", warszawa: "Warsaw", kraków: "Krakow",
  wrocław: "Wroclaw", poznań: "Poznan", gdańsk: "Gdansk", łódź: "Lodz",
  praha: "Prague", košice: "Kosice", göteborg: "Gothenburg", umeå: "Umea",
  københavn: "Copenhagen", tromsø: "Tromso", athina: "Athens",
  beograd: "Belgrade", timișoara: "Timisoara", iași: "Iasi",
  bucurești: "Bucharest", "den haag": "The Hague", sevilla: "Seville",
  málaga: "Malaga", córdoba: "Cordoba", cádiz: "Cadiz",
};

function canonicalCityName(city) {
  return CITY_CANONICAL[city.toLowerCase()] || city;
}

// Molti annunci (soprattutto titoli, o campi tipo "Location:") sono scritti
// TUTTO MAIUSCOLO. Il confronto sulle città è case-sensitive apposta (vedi
// il commento sopra CITIES) per evitare falsi positivi su parole comuni,
// ma questo fa sì che un testo interamente maiuscolo non trovi mai nessuna
// città (perché "BOLOGNA" non è uguale a "Bologna"). Per questi casi si
// individua il testo "urlato" e si passa a un confronto case-insensitive
// solo lì: tanto in un testo tutto maiuscolo l'informazione sulle
// maiuscole/minuscole è comunque persa, quindi non protegge da nulla.
function isShoutyText(text) {
  const letters = String(text || "").replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (letters.length < 20) return false; // troppo corto per giudicare
  const upper = letters.replace(/[^A-ZÀ-Ý]/g, "").length;
  return upper / letters.length > 0.85;
}

// Cerca TUTTE le città riconosciute nel testo (non solo la prima), utile
// per i dottorati condivisi tra più sedi. Deduplica per nome canonico,
// mantiene l'ordine di comparsa nel testo, cappa a un numero ragionevole
// di risultati per non riempire la card con un elenco di partner infinito.
function extractCities(text) {
  if (!text) return [];
  const flags = isShoutyText(text) ? "i" : "";
  const found = [];
  const seenCanonical = new Set();
  for (const { city, country, escaped } of CITY_ENTRIES) {
    const canonical = canonicalCityName(city).toLowerCase();
    if (seenCanonical.has(canonical)) continue;
    const m = text.match(new RegExp(`\\b${escaped}\\b`, flags));
    if (!m) continue;
    seenCanonical.add(canonical);
    found.push({ city: canonicalCityName(city), country, index: m.index });
  }
  found.sort((a, b) => a.index - b.index);
  return found.slice(0, 6);
}

// ---------------------------------------------------------------------------
// Università / enti — molti annunci (soprattutto quelli di reti MSCA o
// consorzi) nominano l'ateneo o l'ente di ricerca ma non la città in modo
// esplicito nel testo (es. "Sapienza", "ETH Zürich", "Sorbonne"). Questo
// elenco riconduce il nome dell'istituzione alla città (o, quando l'ente non
// ha una sede unica, almeno al paese) in cui si trova, così l'etichetta del
// luogo compare comunque. Non è un elenco esaustivo di tutte le università
// europee: sono quelle più comuni nelle bacheche accademiche/scientifiche,
// ampliabile in futuro se emergono altri nomi ricorrenti.
const INSTITUTIONS = [
  ["Sapienza", "Rome", "Italy"], ["Politecnico di Milano", "Milan", "Italy"],
  ["Politecnico di Torino", "Turin", "Italy"], ["Università Bocconi", "Milan", "Italy"],
  ["Bocconi", "Milan", "Italy"], ["Scuola Normale Superiore", "Pisa", "Italy"],
  ["Sant'Anna", "Pisa", "Italy"], ["IIT Genova", "Genoa", "Italy"],
  ["Istituto Italiano di Tecnologia", "Genoa", "Italy"], ["Ca' Foscari", "Venice", "Italy"],
  ["San Raffaele", "Milan", "Italy"], ["Vita-Salute", "Milan", "Italy"],
  ["ETH Zurich", "Zurich", "Switzerland"], ["ETH Zürich", "Zurich", "Switzerland"],
  ["EPFL", "Lausanne", "Switzerland"], ["Imperial College London", "London", "United Kingdom"],
  ["Imperial College", "London", "United Kingdom"], ["University College London", "London", "United Kingdom"],
  ["King's College London", "London", "United Kingdom"], ["London School of Economics", "London", "United Kingdom"],
  ["Sorbonne", "Paris", "France"], ["École Polytechnique", "Paris", "France"],
  ["Ecole Polytechnique", "Paris", "France"], ["Sciences Po", "Paris", "France"],
  ["Institut Pasteur", "Paris", "France"], ["Ludwig-Maximilians-Universität", "Munich", "Germany"],
  ["Ludwig Maximilian University", "Munich", "Germany"], ["LMU Munich", "Munich", "Germany"],
  ["Technical University of Munich", "Munich", "Germany"],
  ["Humboldt-Universität", "Berlin", "Germany"], ["Humboldt University", "Berlin", "Germany"],
  ["Freie Universität Berlin", "Berlin", "Germany"], ["Charité", "Berlin", "Germany"],
  ["KU Leuven", "Leuven", "Belgium"], ["Vrije Universiteit Brussel", "Brussels", "Belgium"],
  ["Université Libre de Bruxelles", "Brussels", "Belgium"],
  ["Delft University of Technology", "Delft", "Netherlands"], ["TU Delft", "Delft", "Netherlands"],
  ["University of Amsterdam", "Amsterdam", "Netherlands"], ["Vrije Universiteit Amsterdam", "Amsterdam", "Netherlands"],
  ["Karolinska Institutet", "Stockholm", "Sweden"], ["KTH Royal Institute of Technology", "Stockholm", "Sweden"],
  ["Chalmers University of Technology", "Gothenburg", "Sweden"],
  ["Technical University of Denmark", "Copenhagen", "Denmark"],
  ["University of Copenhagen", "Copenhagen", "Denmark"], ["University of Oslo", "Oslo", "Norway"],
  ["Norwegian University of Science and Technology", "Trondheim", "Norway"],
  ["University of Helsinki", "Helsinki", "Finland"], ["Aalto University", "Espoo", "Finland"],
  ["University of Vienna", "Vienna", "Austria"], ["TU Wien", "Vienna", "Austria"],
  ["Charles University", "Prague", "Czech Republic"], ["Jagiellonian University", "Krakow", "Poland"],
  ["University of Warsaw", "Warsaw", "Poland"], ["Complutense", "Madrid", "Spain"],
  ["Universidad Autónoma de Madrid", "Madrid", "Spain"], ["Universitat de Barcelona", "Barcelona", "Spain"],
  ["Universitat Pompeu Fabra", "Barcelona", "Spain"], ["Universidade de Lisboa", "Lisbon", "Portugal"],
  ["Universidade do Porto", "Porto", "Portugal"], ["Trinity College Dublin", "Dublin", "Ireland"],
  ["University College Dublin", "Dublin", "Ireland"], ["CERN", "Geneva", "Switzerland"],
  ["EMBL Heidelberg", "Heidelberg", "Germany"], ["Max Planck Institute", "Munich", "Germany"],
  // I 18 centri di ricerca della Helmholtz Association hanno ciascuno una
  // sede precisa (a differenza dell'associazione in sé, vedi sotto): elencati
  // singolarmente così un annuncio che nomina il centro specifico (es.
  // "Forschungszentrum Jülich"), invece dell'associazione generica, mostra
  // comunque la città giusta.
  ["Forschungszentrum Jülich", "Jülich", "Germany"], ["FZ Jülich", "Jülich", "Germany"],
  ["Deutsches Elektronen-Synchrotron", "Hamburg", "Germany"], ["DESY", "Hamburg", "Germany"],
  ["GSI Helmholtzzentrum", "Darmstadt", "Germany"], ["GSI Darmstadt", "Darmstadt", "Germany"],
  ["Helmholtz-Zentrum Berlin", "Berlin", "Germany"], ["Helmholtz Munich", "Munich", "Germany"],
  ["Helmholtz-Zentrum München", "Munich", "Germany"],
  ["Helmholtz-Zentrum Dresden-Rossendorf", "Dresden", "Germany"],
  ["Karlsruhe Institute of Technology", "Karlsruhe", "Germany"], ["KIT Karlsruhe", "Karlsruhe", "Germany"],
  ["Helmholtz Centre for Environmental Research", "Leipzig", "Germany"], ["UFZ Leipzig", "Leipzig", "Germany"],
  ["GFZ German Research Centre for Geosciences", "Potsdam", "Germany"],
  ["Alfred Wegener Institute", "Bremerhaven", "Germany"],
  ["Helmholtz Centre for Infection Research", "Braunschweig", "Germany"],
  ["Max Delbrück Center", "Berlin", "Germany"],
  ["German Cancer Research Center", "Heidelberg", "Germany"], ["DKFZ", "Heidelberg", "Germany"],
  ["Helmholtz-Zentrum Hereon", "Geesthacht", "Germany"],
  // Reti/associazioni senza una sede unica: si riconduce solo al paese (città
  // null), meglio che indicare una città specifica sbagliata. Riserva per
  // quando l'annuncio nomina solo l'associazione generica, non un centro
  // specifico tra quelli elencati sopra.
  ["Helmholtz Association", null, "Germany"], ["Helmholtz", null, "Germany"],
];

const INSTITUTION_ENTRIES = INSTITUTIONS.slice()
  .sort((a, b) => b[0].length - a[0].length)
  .map(([name, city, country]) => ({
    name,
    city,
    country,
    escaped: name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  }));

// Stessa logica di extractCities (case-sensitive di default, insensitive su
// testo "urlato"), ma cerca nomi di istituzioni invece di città: utile come
// secondo tentativo quando nessuna città dell'elenco principale è presente
// nel testo (es. annunci che citano solo l'ateneo). Alcune istituzioni (reti
// o associazioni senza una sede unica, es. "Helmholtz Association") hanno
// `city: null`: qui vengono comunque restituite, con `city: null`, così chi
// chiama può comunque risalire almeno al paese.
function extractInstitutions(text) {
  if (!text) return [];
  const flags = isShoutyText(text) ? "i" : "";
  const found = [];
  const seenKey = new Set();
  for (const { name, city, country, escaped } of INSTITUTION_ENTRIES) {
    const key = city ? city.toLowerCase() : `country:${country.toLowerCase()}`;
    if (seenKey.has(key)) continue;
    const m = text.match(new RegExp(`\\b${escaped}\\b`, flags));
    if (!m) continue;
    seenKey.add(key);
    found.push({ city: city ? canonicalCityName(city) : null, country, index: m.index });
  }
  found.sort((a, b) => a.index - b.index);
  return found.slice(0, 6);
}

function deriveLocation(item) {
  const hay = `${item.title} ${item.description} ${item.source}`;

  let cityMatches = extractCities(hay);
  // Aggiunge anche le città dedotte dai nomi di istituzioni note (es.
  // "Sorbonne" → Parigi), utile soprattutto per i dottorati condivisi tra
  // più sedi dove magari solo una sede è nominata come città esplicita e le
  // altre solo come nome di ateneo. Non duplica una città già trovata. Le
  // istituzioni senza una sede unica (`city: null`, es. "Helmholtz
  // Association") non entrano in questo elenco di città (non c'è un punto
  // preciso da aggiungere): si tengono da parte come riserva per il solo
  // paese, usata più sotto solo se non emerge nessuna città da nessun'altra
  // fonte.
  const instMatches = extractInstitutions(hay);
  const countryOnlyInst = instMatches.find((m) => !m.city);
  const instCityMatches = instMatches.filter((m) => m.city);
  if (instCityMatches.length > 0) {
    const existingCities = new Set(cityMatches.map((m) => m.city.toLowerCase()));
    for (const im of instCityMatches) {
      const key = im.city.toLowerCase();
      if (existingCities.has(key)) continue;
      existingCities.add(key);
      cityMatches = [...cityMatches, im];
    }
    cityMatches.sort((a, b) => a.index - b.index);
  }
  if (cityMatches.length > 0) {
    const uniqueCountries = Array.from(new Set(cityMatches.map((m) => m.country)));
    const country = item.countryHint || uniqueCountries[0];
    let city;
    if (cityMatches.length === 1) {
      city = cityMatches[0].city;
    } else {
      // Dottorato con più sedi: mostra tutte le città trovate. Se sono in
      // paesi diversi, aggiunge il paese accanto a ciascuna per chiarezza
      // (es. "Bologna (Italy), Groningen (Netherlands)").
      const sameCountry = uniqueCountries.length <= 1;
      const capped = cityMatches.slice(0, 4);
      city = capped.map((m) => (sameCountry ? m.city : `${m.city} (${m.country})`)).join(", ");
      if (cityMatches.length > capped.length) {
        city += ` +${cityMatches.length - capped.length}`;
      }
    }
    return { country, city };
  }

  // Fallback: nessuna città dell'elenco riconosciuta nel testo, si ripiega
  // sul vecchio metodo (solo nome del paese + adiacenza testuale).
  if (item.countryHint) {
    return { country: item.countryHint, city: extractCity(hay, item.countryHint) };
  }
  const found = extractCountry(hay);
  if (found) return { country: found.label, city: extractCity(hay, found.raw) };
  // Ultima riserva: un'istituzione/rete senza sede unica (es. "Helmholtz
  // Association") che almeno indica il paese.
  if (countryOnlyInst) return { country: countryOnlyInst.country, city: null };
  return { country: null, city: null };
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
        // Prima era troncato a 500 caratteri: bastava per la scadenza (di
        // solito vicina all'inizio), ma spesso tagliava via il nome
        // dell'ateneo/ente prima che comparisse nel testo (specialmente su
        // jobrxiv.org, dove il titolo si ripete più volte nel blocco prima
        // del testo utile), impedendo il riconoscimento di città/istituzioni
        // che stanno più in fondo. 3000 caratteri coprono la stragrande
        // maggioranza degli annunci senza appesantire troppo i dati salvati
        // (la card in pagina mostra comunque solo un estratto più corto).
        description: context.slice(0, 3000),
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

// jobrxiv.org, come diversi altri portali che aggregano bandi, spesso mostra
// il nome dell'ente/datore di lavoro (spesso l'unico indizio di luogo, es.
// "Helmholtz Association of German Research Centers") solo nella pagina del
// singolo annuncio, non nell'estratto della pagina di ricerca — per quanto
// grande si faccia il testo estratto lì, quell'informazione semplicemente
// non è presente in quella pagina. Per questo, solo quando un annuncio
// jobrxiv.org non produce nessuna città/paese dal testo già raccolto, si
// scarica anche la sua pagina singola (stesso dominio, stesso robots.txt
// permissivo) e si riprova con quel testo in più. Fatto solo "on demand"
// (non per ogni annuncio) per non moltiplicare inutilmente le richieste.
async function fetchJobrxivDetailText(url) {
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return "";
    const html = await res.text();
    const $ = cheerio.load(html);

    // Prima si cerca il blocco dati strutturato schema.org "JobPosting"
    // (JSON-LD), quando presente: è pensato apposta per i motori di ricerca
    // e contiene di solito il nome del datore di lavoro (hiringOrganization)
    // e la sede (jobLocation) in campi puliti e separati — molto più
    // affidabile di un taglio a N caratteri sul testo visibile, che dipende
    // da quanto menu/pulsanti/form si frappongono prima del contenuto vero.
    const jsonLdBits = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      const raw = $(el).contents().text();
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        for (const entry of candidates) {
          const type = entry?.["@type"];
          const isJobPosting =
            type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
          if (!isJobPosting) continue;
          const org = entry.hiringOrganization;
          const orgName = typeof org === "string" ? org : org?.name;
          if (orgName) jsonLdBits.push(orgName);
          const locations = Array.isArray(entry.jobLocation) ? entry.jobLocation : [entry.jobLocation];
          for (const loc of locations) {
            const addr = loc?.address;
            if (!addr) continue;
            if (addr.addressLocality) jsonLdBits.push(addr.addressLocality);
            if (addr.addressRegion) jsonLdBits.push(addr.addressRegion);
            if (addr.addressCountry) {
              jsonLdBits.push(
                typeof addr.addressCountry === "string" ? addr.addressCountry : addr.addressCountry?.name || ""
              );
            }
          }
        }
      } catch {
        // JSON-LD malformato o in un formato inatteso: si ignora, si prosegue coi fallback sotto.
      }
    });

    $("script, style, nav, footer, header, noscript, form, aside").remove();
    const bodyText = $("body").text().replace(/\s+/g, " ").trim();

    // Il nome del datore di lavoro compare di solito vicino all'inizio del
    // contenuto vero dell'annuncio, ma nel testo grezzo della pagina può
    // essere preceduto da migliaia di caratteri di menu, pulsanti "Login to
    // bookmark" e simili: un taglio troppo corto (il vecchio limite di 4000
    // caratteri) rischiava di tagliarlo via. Si combinano quindi i dati
    // strutturati (se trovati) con una porzione ben più ampia del testo
    // visibile, per non perdere l'indizio in nessuno dei due casi.
    const jsonLdText = jsonLdBits.filter(Boolean).join(" ");
    return `${jsonLdText} ${bodyText.slice(0, 12000)}`.trim();
  } catch (err) {
    console.warn(`⚠️  jobrxiv.org (pagina annuncio) ${url}: ${err.message}`);
    return "";
  }
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
// Avvisi via email (EURAXESS, FindAPhD) — letti da una casella IMAP dedicata
// ---------------------------------------------------------------------------
// EURAXESS e FindAPhD vietano nel loro robots.txt di raschiare automaticamente
// le pagine di ricerca/annuncio (vedi README, sezione "Limiti noti"), quindi
// qui non si scarica nulla dal loro sito: si legge invece, via IMAP, una
// casella email dedicata su cui l'utente ha impostato i loro alert nativi.
// È il sito stesso a mandare l'email, su richiesta esplicita dell'utente —
// non è scraping, non viola le loro condizioni d'uso.
//
// Attivo solo se sources.mailAlerts.enabled è true in config.json E sono
// impostate le variabili d'ambiente IMAP_USER / IMAP_PASSWORD (come GitHub
// Secrets, mai nel repository). Vedi README per la configurazione completa.
// Nota: i template esatti delle email di alert non sono documentati
// pubblicamente, quindi l'estrazione qui sotto è volutamente generica
// (cerca link il cui URL corrisponde al pattern stabile della pagina di
// un singolo annuncio su ciascun sito) invece di basarsi su selettori
// specifici che potrebbero non esistere o cambiare. Se un'email non produce
// risultati, non è un errore bloccante: gli altri annunci continuano a
// funzionare normalmente.

const MAIL_PROFILES = [
  {
    label: "EURAXESS (avviso email)",
    hrefTest: (href) => /euraxess\.ec\.europa\.eu\/jobs\/\d+/.test(href),
  },
  {
    label: "FindAPhD (avviso email)",
    hrefTest: (href) => /findaphd\.com\/phds\/project\//.test(href),
  },
];

function looksLikeUrl(s) {
  return /^https?:\/\//i.test(String(s || "").trim());
}

// Formato osservato nelle vere email "New results for your saved search" di
// EURAXESS (verificato su un esempio reale fornito dall'utente): un elenco
// puntato dove ogni voce è "- Titolo" (spesso il titolo va a capo su più
// righe, perché il testo dell'email è formattato a larghezza fissa) seguito
// dalla URL dell'annuncio da sola sulla riga successiva. Un separatore "---"
// chiude l'elenco, dopodiché ci sono solo link di gestione/disiscrizione da
// ignorare. Questo parser associa titolo e URL senza ambiguità quando il
// formato corrisponde; se non riconosce nulla ritorna un elenco vuoto e si
// ripiega sulle altre strategie qui sotto.
function extractBulletTextItems(text) {
  const items = [];
  const lines = String(text).split(/\r?\n/);
  let pendingTitle = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^-{3,}$/.test(line)) {
      pendingTitle = null; // separatore di fine elenco
      continue;
    }
    if (/^-\s+/.test(line)) {
      pendingTitle = line.replace(/^-\s+/, "").trim();
      continue;
    }
    const urlMatch = line.match(/^(https?:\/\/\S+)/);
    if (urlMatch) {
      const href = urlMatch[1].replace(/[.,;)\]]+$/, "");
      if (pendingTitle) {
        const profile = MAIL_PROFILES.find((p) => p.hrefTest(href));
        if (profile) {
          items.push({ title: pendingTitle, link: href, description: pendingTitle, source: profile.label });
        }
      }
      pendingTitle = null;
      continue;
    }
    if (pendingTitle !== null && line) {
      // continuazione del titolo su più righe
      pendingTitle = `${pendingTitle} ${line}`.trim();
    }
  }
  return items;
}

function extractMailItems(html, text) {
  const items = [];
  const seenLinks = new Set();

  // 1) Elenco puntato in testo semplice (formato EURAXESS attuale) — il più
  // affidabile quando riconosciuto, si prova per primo.
  if (text) {
    for (const it of extractBulletTextItems(text)) {
      if (seenLinks.has(it.link)) continue;
      seenLinks.add(it.link);
      items.push(it);
    }
  }

  // 2) HTML: cerca link il cui href corrisponde a un profilo noto. Alcuni
  // template (incluso quello EURAXESS attuale) mostrano l'URL stessa come
  // testo del link invece del titolo vero, che si trova invece nel testo
  // subito prima, separato da un <br> nello stesso blocco: in quel caso si
  // prova a recuperarlo da lì invece di mostrare l'URL come titolo.
  if (html) {
    const $ = cheerio.load(html);
    $("a[href]").each((_, el) => {
      const $el = $(el);
      const href = ($el.attr("href") || "").trim();
      if (!href || seenLinks.has(href)) return;
      const profile = MAIL_PROFILES.find((p) => p.hrefTest(href));
      if (!profile) return;

      let title = $el.text().replace(/\s+/g, " ").trim();
      if (!title || title.length < 6 || looksLikeUrl(title)) {
        title = "";
        const $container = $el.closest("tr, td, div, li, p");
        if ($container.length) {
          const innerHtml = $container.html() || "";
          const segments = innerHtml.split(/<br\s*\/?>/i);
          const idx = segments.findIndex((seg) => seg.includes(href));
          if (idx > 0) {
            const prevText = cheerio
              .load(`<div>${segments[idx - 1]}</div>`)("div")
              .text()
              .replace(/\s+/g, " ")
              .trim()
              .replace(/^-+\s*/, "");
            if (prevText && !looksLikeUrl(prevText)) title = prevText.slice(0, 200);
          }
          if (!title) {
            const containerText = $container.text().replace(/\s+/g, " ").trim();
            if (containerText && containerText.length < 300 && !looksLikeUrl(containerText)) {
              title = containerText;
            }
          }
        }
      }
      if (!title) title = href;

      seenLinks.add(href);
      items.push({ title, link: href, description: title, source: profile.label });
    });
  }

  // 3) Fallback riga-per-riga generico (URL nudo su una riga di testo, con
  // eventuale titolo sulla stessa riga) — usato solo se le strategie sopra
  // non hanno trovato nulla, per email in formati diversi da quelli noti.
  if (items.length === 0 && text) {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const urlMatch = line.match(/https?:\/\/\S+/);
      if (!urlMatch) continue;
      const href = urlMatch[0].replace(/[.,;)]+$/, "");
      if (seenLinks.has(href)) continue;
      const profile = MAIL_PROFILES.find((p) => p.hrefTest(href));
      if (!profile) continue;
      seenLinks.add(href);
      const title = line.replace(href, "").replace(/\s+/g, " ").trim() || href;
      items.push({ title, link: href, description: title, source: profile.label });
    }
  }

  return items;
}

async function fetchMailAlerts(config) {
  const items = [];
  if (!config.sources?.mailAlerts?.enabled) return items;

  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASSWORD;
  if (!user || !pass) {
    console.warn(
      "⚠️  mailAlerts è attivo in config.json ma IMAP_USER/IMAP_PASSWORD non sono impostati come GitHub Secrets: salto questa fonte."
    );
    return items;
  }
  const host = process.env.IMAP_HOST || "imap.gmail.com";
  const port = Number(process.env.IMAP_PORT || 993);

  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  try {
    await withRetry(() => client.connect(), { isRetryable: is5xxOrNetworkError, retries: 1, delayMs: 3000 });
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      if (!uids || uids.length === 0) {
        console.log("📧 Nessuna nuova email di alert da leggere.");
      }
      for (const uid of uids || []) {
        try {
          const msg = await client.fetchOne(uid, { source: true }, { uid: true });
          if (!msg || !msg.source) continue;
          const parsed = await simpleParser(msg.source);
          const extracted = extractMailItems(parsed.html || null, parsed.text || null);
          for (const it of extracted) {
            items.push({
              ...it,
              pubDate: parsed.date ? parsed.date.toISOString() : null,
              deadlineText: null,
              deadlineISO: null,
            });
          }
        } catch (err) {
          console.warn(`⚠️  Email alert (uid ${uid}): impossibile leggerla/analizzarla: ${err.message}`);
        } finally {
          // Segna comunque come letta: evita di rileggerla all'infinito se
          // il contenuto non è interpretabile.
          try {
            await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
          } catch {
            // non bloccante
          }
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    console.warn(`⚠️  Lettura casella email alert fallita: ${err.message}`);
    try {
      await client.logout();
    } catch {
      // già disconnesso o mai connesso
    }
  }

  return dedupByLink(items);
}

// ---------------------------------------------------------------------------
// Filtri
// ---------------------------------------------------------------------------
function matchesPhdIndicator(item, config) {
  if (!config.requirePhdIndicator) return true;
  // Stesso ragionamento fatto per le parole chiave di materia: un annuncio
  // via alert email ha solo un titolo breve, spesso generico (es. "CALL FOR
  // EXPRESSIONS OF INTEREST", frequente per certi bandi europei) che non
  // nomina esplicitamente "PhD"/"doctoral" pur essendo effettivamente una
  // posizione di dottorato — e la ricerca salvata impostata direttamente
  // sul sito EURAXESS/FindAPhD è già scope-ata a posizioni di dottorato, non
  // serve ririchiederlo qui sul solo titolo.
  if (isMailAlertItem(item)) return true;
  const hay = norm(item.title + " " + item.description);
  return (config.phdIndicatorWords || []).some((w) => hay.includes(norm(w)));
}

// Gli annunci che arrivano via alert email (EURAXESS, FindAPhD) hanno solo
// un titolo breve, senza descrizione estesa: richiedere che una delle
// parole chiave configurate compaia lì letteralmente scarta quasi tutto,
// anche annunci in tema, perché il titolo raramente la contiene per
// esteso (es. "organic electronics" invece di "organic chemistry"). Dato
// che questi annunci sono già filtrati a monte dalla ricerca salvata che
// l'utente ha impostato direttamente sul sito (EURAXESS/FindAPhD), qui non
// si applica il filtro materia locale — resta comunque il filtro "è un
// dottorato" e le parole da escludere (es. "postdoc").
function isMailAlertItem(item) {
  return MAIL_PROFILES.some((p) => p.label === item.source);
}

function matchedKeywords(item, config) {
  if (isMailAlertItem(item)) return ["(alert email: già filtrato dalla ricerca salvata sul sito)"];
  const hay = norm(item.title + " " + item.description + " " + item.source);
  const kws = config.keywords || [];
  if (kws.length === 0) return ["(nessun filtro: tutte le materie)"];
  return kws.filter((k) => hay.includes(norm(k)));
}

function isExcluded(item, config) {
  // Su richiesta esplicita dell'utente: nessun filtro locale sugli annunci
  // via alert email, a parte avere un link — la ricerca salvata impostata
  // sul sito EURAXESS/FindAPhD è già il filtro. Chi vuole scartare un
  // annuncio via email lo fa da lì, non qui.
  if (isMailAlertItem(item)) return false;
  const hay = norm(item.title + " " + item.description);
  return (config.excludeKeywords || []).some((k) => hay.includes(norm(k)));
}

function matchesCountry(item, config) {
  if (isMailAlertItem(item)) return true;
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
// Gli header HTTP (usati qui per Title/Click/Priority) accettano solo
// caratteri "ByteString" (0-255): un'emoji o un trattino lungo "—" nel
// titolo di un annuncio li fa superare quel limite e fetch() lancia un
// errore ("Cannot convert argument to a ByteString..."), facendo fallire
// l'intera notifica in silenzio. ntfy consiglia di codificare gli header
// non-ASCII secondo RFC 2047 (vedi https://docs.ntfy.sh/publish/): se il
// titolo contiene caratteri non ASCII lo si codifica in base64, altrimenti
// lo si lascia invariato.
function encodeHeaderValue(value) {
  const s = String(value ?? "");
  if (/^[\x00-\x7F]*$/.test(s)) return s; // solo ASCII: nessuna codifica necessaria
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

// Il link (header Click) deve restare un URL valido e cliccabile, quindi non
// si può codificare come RFC 2047: nel raro caso contenga caratteri non
// ASCII (es. un URL con caratteri accentati non percent-encoded dalla
// fonte), lo si percent-encoda con encodeURI invece di lasciar fallire
// l'intera notifica.
function safeUrlHeader(url) {
  const s = String(url || "");
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  try {
    return encodeURI(s);
  } catch {
    return s.replace(/[^\x00-\x7F]/g, "");
  }
}

async function sendNtfy(topic, { title, message, click, priority }) {
  if (!topic) {
    console.warn("⚠️  NTFY_TOPIC non impostato: salto l'invio della notifica.");
    return;
  }
  try {
    await fetchWithTimeout(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers: {
        Title: encodeHeaderValue(title),
        ...(click ? { Click: safeUrlHeader(click) } : {}),
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
  if (sources.mailAlerts?.enabled) {
    allRaw.push(...(await fetchMailAlerts(config)));
  }

  console.log(`Trovati ${allRaw.length} annunci grezzi dalle fonti configurate.`);

  // jobrxiv.org spesso mostra il nome del datore di lavoro/ente (unico
  // indizio di luogo per molti annunci, es. reti/associazioni come la
  // "Helmholtz Association") solo nella pagina del singolo annuncio, non
  // nell'estratto della pagina di ricerca già raccolto: se non è emerso
  // nessun luogo dal testo già disponibile, si prova a scaricare anche
  // quella pagina e si ritenta l'estrazione con quel testo in più. Il
  // risultato (trovato o no) si segna con `locTried: true` così non si
  // ritenta all'infinito ad ogni esecuzione lo stesso annuncio senza
  // successo — e un contatore per run limita quante richieste in più si
  // fanno in una singola esecuzione, per restare garbati col sito.
  let jobrxivEnrichBudget = 20;
  async function resolveLocation(item) {
    let { country, city } = deriveLocation(item);
    let locTried = item.locTried || false;
    if (
      !country &&
      !locTried &&
      jobrxivEnrichBudget > 0 &&
      item.link &&
      /^jobrxiv\.org/.test(item.source || "")
    ) {
      jobrxivEnrichBudget--;
      locTried = true;
      const extra = await fetchJobrxivDetailText(item.link);
      if (extra) {
        const retry = deriveLocation({ ...item, description: `${item.description} ${extra}` });
        country = retry.country;
        city = retry.city;
      }
    }
    return { country, city, locTried };
  }

  const matched = [];
  for (const item of allRaw) {
    if (isExcluded(item, config)) continue;
    if (!matchesPhdIndicator(item, config)) continue;

    const { country, city, locTried } = await resolveLocation(item);
    const payText = extractPay(`${item.title} ${item.description}`);
    const withLocation = { ...item, country, city, payText, locTried };

    if (!matchesCountry(withLocation, config)) continue;
    const kws = matchedKeywords(withLocation, config);
    if (kws.length === 0) continue;
    const id = makeId(item.link, item.title);
    matched.push({ ...withLocation, id, matchedKeywords: kws });
  }

  console.log(`${matched.length} annunci corrispondono ai filtri (dottorato + materie + paese).`);

  const newItems = matched.filter((it) => !seen.has(it.id));
  console.log(`${newItems.length} sono nuovi rispetto all'ultima esecuzione.`);

  // Ricalcola paese/città/paga anche per gli annunci GIÀ salvati (non solo
  // per quelli nuovi): senza questo passaggio, un miglioramento
  // all'estrazione (come la correzione del bug sui testi TUTTO MAIUSCOLO, o
  // l'aggiunta di nuove istituzioni riconosciute) si applicherebbe solo alle
  // offerte trovate da ora in poi, lasciando per sempre "vuoti" gli annunci
  // già presenti in data/listings.json da prima. Include anche il tentativo
  // di leggere la pagina singola per jobrxiv.org (vedi sopra) quando non
  // ancora provato: è l'unico modo per cui un annuncio già salvato PRIMA che
  // questa funzionalità esistesse può ancora ottenere un luogo.
  const backfilledListings = [];
  for (const it of listings) {
    const { country, city, locTried } = await resolveLocation(it);
    const payText = extractPay(`${it.title} ${it.description}`);
    backfilledListings.push({ ...it, country, city, payText, locTried });
  }

  // Aggiorna listings.json: metti i nuovi in testa, tieni gli esistenti, cappa la lunghezza
  const now = new Date().toISOString();
  const withTimestamps = newItems.map((it) => ({ ...it, firstSeen: now }));
  const merged = [...withTimestamps, ...backfilledListings].slice(0, MAX_LISTINGS);

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
