// app.js — logica della pagina PhD Tracker (nessuna dipendenza esterna)

const state = {
  listings: [],
  config: {},
  lastRun: null,
  activeChip: localStorage.getItem("phdtracker.chip") || "Tutte",
  activeCountry: localStorage.getItem("phdtracker.country") || "Tutti i paesi",
  activeStatus: localStorage.getItem("phdtracker.status") || "Tutte",
  search: localStorage.getItem("phdtracker.search") || "",
  onlyNew: localStorage.getItem("phdtracker.onlyNew") === "1",
  interest: loadInterest(),
  mapTheme: localStorage.getItem("phdtracker.mapTheme") || "dark",
};

// Stato interesse per annuncio: { [id]: "yes" | "no" }, salvato in localStorage.
// Non viene mai rimosso automaticamente un annuncio scartato: resta sempre
// consultabile tramite il filtro "Scartate".
function loadInterest() {
  try {
    const raw = localStorage.getItem("phdtracker.interest");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveInterest() {
  localStorage.setItem("phdtracker.interest", JSON.stringify(state.interest));
}

function getInterest(id) {
  return state.interest[id] || null; // null = "da valutare"
}

function setInterest(id, value) {
  // Cliccare di nuovo la stessa azione la annulla (torna a "da valutare").
  if (state.interest[id] === value) {
    delete state.interest[id];
  } else {
    state.interest[id] = value;
  }
  saveInterest();
  renderStatusChips();
  renderList();
  renderInterestMap();
}

const $ = (sel) => document.querySelector(sel);

// Icone lineari minimali (nessuna emoji, per un aspetto più sobrio e coerente
// su tutte le piattaforme).
const ICON_PIN =
  '<svg class="icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 14.2S12.8 9.7 12.8 6.4A4.8 4.8 0 1 0 3.2 6.4C3.2 9.7 8 14.2 8 14.2Z"/><circle cx="8" cy="6.4" r="1.6"/></svg>';
const ICON_COIN =
  '<svg class="icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="5.8"/><path d="M8 4.8v6.4M6.1 6.3c0-.9.85-1.5 1.9-1.5s1.9.6 1.9 1.4-.75 1.1-1.9 1.4c-1.15.3-1.9.6-1.9 1.5s.85 1.5 1.9 1.5 1.9-.6 1.9-1.5"/></svg>';
const ICON_CHECK =
  '<svg class="icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>';
const ICON_CROSS =
  '<svg class="icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

// ---------------------------------------------------------------------------
// Mappa dei dottorati "Interessa" — coordinate approssimative (utili solo per
// posizionare un segnaposto su una mappa, non per navigazione di precisione)
// per le città riconosciute da scripts/check.mjs (costante CITIES) e per i
// centroidi dei paesi, usati come riserva quando l'annuncio ha solo il paese
// (es. istituzioni senza una sede unica come "Helmholtz Association").
// ---------------------------------------------------------------------------
const CITY_COORDS = {
  london: [51.5074, -0.1278], manchester: [53.4808, -2.2426], birmingham: [52.4862, -1.8904],
  edinburgh: [55.9533, -3.1883], glasgow: [55.8642, -4.2518], liverpool: [53.4084, -2.9916],
  leeds: [53.8008, -1.5491], sheffield: [53.3811, -1.4701], bristol: [51.4545, -2.5879],
  oxford: [51.7520, -1.2577], cambridge: [52.2053, 0.1218], nottingham: [52.9548, -1.1581],
  southampton: [50.9097, -1.4044], newcastle: [54.9783, -1.6178], cardiff: [51.4816, -3.1791],
  belfast: [54.5973, -5.9301], leicester: [52.6369, -1.1398], coventry: [52.4068, -1.5197],
  exeter: [50.7184, -3.5339], durham: [54.7761, -1.5733], warwick: [52.2823, -1.5849],
  aberdeen: [57.1497, -2.0943], dundee: [56.4620, -2.9707], loughborough: [52.7723, -1.2062],
  lancaster: [54.0466, -2.8007], swansea: [51.6214, -3.9436], bangor: [53.2280, -4.1285],
  dublin: [53.3498, -6.2603], cork: [51.8985, -8.4756], galway: [53.2707, -9.0568], limerick: [52.6638, -8.6267],
  rome: [41.9028, 12.4964], milan: [45.4642, 9.1900], turin: [45.0703, 7.6869], bologna: [44.4949, 11.3426],
  florence: [43.7696, 11.2558], naples: [40.8518, 14.2681], padua: [45.4064, 11.8768], venice: [45.4408, 12.3155],
  genoa: [44.4056, 8.9463], trieste: [45.6495, 13.7768], trento: [46.0679, 11.1211], verona: [45.4384, 10.9916],
  brescia: [45.5416, 10.2118], bergamo: [45.6983, 9.6773], pavia: [45.1847, 9.1582], parma: [44.8015, 10.3279],
  modena: [44.6471, 10.9252], ferrara: [44.8381, 11.6198], perugia: [43.1122, 12.3888], siena: [43.3188, 11.3308],
  pisa: [43.7228, 10.4017], cagliari: [39.2238, 9.1217], sassari: [40.7259, 8.5557], palermo: [38.1157, 13.3615],
  catania: [37.5079, 15.0830], bari: [41.1171, 16.8719], lecce: [40.3519, 18.1720], salerno: [40.6824, 14.7681],
  udine: [46.0693, 13.2372], ancona: [43.6158, 13.5189], camerino: [43.1358, 13.0679], urbino: [43.7259, 12.6363],
  chieti: [42.3510, 14.1678], "l'aquila": [42.3498, 13.3995], novara: [45.4469, 8.6220], varese: [45.8206, 8.8250],
  piacenza: [45.0526, 9.6929], cremona: [45.1335, 10.0422],
  berlin: [52.5200, 13.4050], munich: [48.1351, 11.5820], hamburg: [53.5511, 9.9937], cologne: [50.9375, 6.9603],
  frankfurt: [50.1109, 8.6821], stuttgart: [48.7758, 9.1829], düsseldorf: [51.2277, 6.7735],
  dusseldorf: [51.2277, 6.7735], leipzig: [51.3397, 12.3731], dresden: [51.0504, 13.7373],
  hannover: [52.3759, 9.7320], bremen: [53.0793, 8.8017], bonn: [50.7374, 7.0982], heidelberg: [49.3988, 8.6724],
  freiburg: [47.9990, 7.8421], tübingen: [48.5216, 9.0576], tubingen: [48.5216, 9.0576],
  göttingen: [51.5413, 9.9158], gottingen: [51.5413, 9.9158], mainz: [49.9929, 8.2473],
  karlsruhe: [49.0069, 8.4037], erlangen: [49.5897, 11.0119], würzburg: [49.7913, 9.9534],
  wurzburg: [49.7913, 9.9534], jena: [50.9271, 11.5892], konstanz: [47.6779, 9.1732], marburg: [50.8021, 8.7669],
  aachen: [50.7753, 6.0839], bochum: [51.4818, 7.2162], kiel: [54.3233, 10.1228], regensburg: [49.0134, 12.1016],
  rostock: [54.0924, 12.0991], potsdam: [52.3906, 13.0645], duisburg: [51.4344, 6.7623], essen: [51.4556, 7.0116],
  bielefeld: [52.0302, 8.5325], giessen: [50.5841, 8.6785], magdeburg: [52.1205, 11.6276],
  greifswald: [54.0865, 13.3923], halle: [51.4969, 11.9688],
  paris: [48.8566, 2.3522], lyon: [45.7640, 4.8357], marseille: [43.2965, 5.3698], toulouse: [43.6047, 1.4442],
  bordeaux: [44.8378, -0.5792], lille: [50.6292, 3.0573], strasbourg: [48.5734, 7.7521], nantes: [47.2184, -1.5536],
  montpellier: [43.6108, 3.8767], grenoble: [45.1885, 5.7245], rennes: [48.1173, -1.6778], dijon: [47.3220, 5.0415],
  avignon: [43.9493, 4.8055], angers: [47.4784, -0.5632], reims: [49.2583, 4.0317], orléans: [47.9029, 1.9093],
  orleans: [47.9029, 1.9093], "clermont-ferrand": [45.7772, 3.0870], amiens: [49.8941, 2.2958],
  limoges: [45.8336, 1.2611], metz: [49.1193, 6.1757], besançon: [47.2378, 6.0241], besancon: [47.2378, 6.0241],
  perpignan: [42.6887, 2.8948], caen: [49.1829, -0.3707], poitiers: [46.5802, 0.3404], nîmes: [43.8367, 4.3601],
  nimes: [43.8367, 4.3601], "le havre": [49.4944, 0.1079], saclay: [48.7167, 2.1667], palaiseau: [48.7139, 2.2452],
  évry: [48.6297, 2.4297],
  madrid: [40.4168, -3.7038], barcelona: [41.3874, 2.1686], valencia: [39.4699, -0.3763], seville: [37.3891, -5.9845],
  zaragoza: [41.6488, -0.8891], málaga: [36.7213, -4.4214], malaga: [36.7213, -4.4214], bilbao: [43.2630, -2.9350],
  granada: [37.1773, -3.5986], salamanca: [40.9701, -5.6635], valladolid: [41.6523, -4.7245],
  "santiago de compostela": [42.8782, -8.5448], "san sebastián": [43.3183, -1.9812],
  "san sebastian": [43.3183, -1.9812], pamplona: [42.8125, -1.6458], oviedo: [43.3603, -5.8448],
  murcia: [37.9922, -1.1307], alicante: [38.3452, -0.4810], córdoba: [37.8882, -4.7794],
  cordoba: [37.8882, -4.7794], tarragona: [41.1189, 1.2445], girona: [41.9794, 2.8214], vigo: [42.2406, -8.7207],
  cadiz: [36.5271, -6.2886],
  lisbon: [38.7223, -9.1393], porto: [41.1579, -8.6291], coimbra: [40.2033, -8.4103], braga: [41.5454, -8.4265],
  aveiro: [40.6443, -8.6455], evora: [38.5667, -7.9000],
  amsterdam: [52.3676, 4.9041], rotterdam: [51.9244, 4.4777], utrecht: [52.0907, 5.1214], delft: [52.0116, 4.3571],
  groningen: [53.2194, 6.5665], leiden: [52.1601, 4.4970], maastricht: [50.8514, 5.6910],
  nijmegen: [51.8126, 5.8372], eindhoven: [51.4416, 5.4697], wageningen: [51.9692, 5.6660],
  tilburg: [51.5555, 5.0913], "the hague": [52.0705, 4.3007],
  brussels: [50.8503, 4.3517], leuven: [50.8798, 4.7005], ghent: [51.0543, 3.7174], antwerp: [51.2194, 4.4025],
  liège: [50.6326, 5.5797], liege: [50.6326, 5.5797], namur: [50.4669, 4.8675], mons: [50.4542, 3.9523],
  luxembourg: [49.6116, 6.1319],
  zurich: [47.3769, 8.5417], geneva: [46.2044, 6.1432], lausanne: [46.5197, 6.6323], basel: [47.5596, 7.5886],
  bern: [46.9480, 7.4474], fribourg: [46.8065, 7.1619],
  vienna: [48.2082, 16.3738], graz: [47.0707, 15.4395], innsbruck: [47.2692, 11.4041], linz: [48.3069, 14.2858],
  salzburg: [47.8095, 13.0550], klagenfurt: [46.6247, 14.3055],
  stockholm: [59.3293, 18.0686], gothenburg: [57.7089, 11.9746], uppsala: [59.8586, 17.6389],
  lund: [55.7047, 13.1910], umea: [63.8258, 20.2630], linköping: [58.4108, 15.6214],
  copenhagen: [55.6761, 12.5683], aarhus: [56.1629, 10.2039], odense: [55.4038, 10.4024],
  aalborg: [57.0488, 9.9217], oslo: [59.9139, 10.7522], bergen: [60.3913, 5.3221], trondheim: [63.4305, 10.3951],
  tromso: [69.6492, 18.9553], helsinki: [60.1699, 24.9384], espoo: [60.2055, 24.6559], tampere: [61.4978, 23.7610],
  turku: [60.4518, 22.2666], oulu: [65.0121, 25.4651], jyväskylä: [62.2426, 25.7473], reykjavik: [64.1466, -21.9426],
  warsaw: [52.2297, 21.0122], krakow: [50.0647, 19.9450], wroclaw: [51.1079, 17.0385], poznan: [52.4064, 16.9252],
  gdansk: [54.3520, 18.6466], lodz: [51.7592, 19.4560], prague: [50.0755, 14.4378], brno: [49.1951, 16.6068],
  olomouc: [49.5938, 17.2509], bratislava: [48.1486, 17.1077], kosice: [48.7164, 21.2611],
  budapest: [47.4979, 19.0402], debrecen: [47.5316, 21.6273], szeged: [46.2530, 20.1414],
  ljubljana: [46.0569, 14.5058], maribor: [46.5547, 15.6459], zagreb: [45.8150, 15.9819], split: [43.5081, 16.4402],
  rijeka: [45.3271, 14.4422], bucharest: [44.4268, 26.1025], "cluj-napoca": [46.7712, 23.6236],
  timisoara: [45.7489, 21.2087], iasi: [47.1585, 27.6014], sofia: [42.6977, 23.3219], plovdiv: [42.1354, 24.7453],
  athens: [37.9838, 23.7275], thessaloniki: [40.6401, 22.9444], patras: [38.2466, 21.7346],
  heraklion: [35.3387, 25.1442], tallinn: [59.4370, 24.7536], tartu: [58.3780, 26.7290], riga: [56.9496, 24.1052],
  vilnius: [54.6872, 25.2797], kaunas: [54.8985, 23.9036], valletta: [35.8989, 14.5146], nicosia: [35.1856, 33.3823],
  belgrade: [44.7866, 20.4489], "novi sad": [45.2671, 19.8335], kyiv: [50.4501, 30.5234], lviv: [49.8397, 24.0297],
  istanbul: [41.0082, 28.9784], ankara: [39.9334, 32.8597], izmir: [38.4237, 27.1428],
};

const COUNTRY_COORDS = {
  "United Kingdom": [54.0, -2.0], Ireland: [53.4, -8.0], Italy: [42.8, 12.8], Spain: [40.2, -3.7],
  Portugal: [39.6, -8.0], France: [46.6, 2.5], Germany: [51.2, 10.4], Netherlands: [52.2, 5.3],
  Belgium: [50.6, 4.6], Luxembourg: [49.8, 6.1], Switzerland: [46.8, 8.2], Austria: [47.6, 14.1],
  Sweden: [62.0, 15.0], Norway: [64.6, 11.0], Denmark: [56.0, 9.5], Finland: [63.0, 26.0], Iceland: [65.0, -18.0],
  Poland: [52.0, 19.0], "Czech Republic": [49.8, 15.5], Slovakia: [48.7, 19.5], Hungary: [47.2, 19.5],
  Slovenia: [46.1, 14.8], Croatia: [45.3, 16.4], Romania: [45.9, 25.0], Bulgaria: [42.7, 25.5],
  Greece: [39.0, 22.0], Estonia: [58.6, 25.0], Latvia: [56.9, 24.6], Lithuania: [55.3, 23.9], Malta: [35.9, 14.5],
  Cyprus: [35.1, 33.4], Serbia: [44.0, 21.0], Ukraine: [49.0, 31.0], Turkey: [39.0, 35.0], Morocco: [31.8, -7.1],
  "United States": [39.8, -98.6], Canada: [56.1, -106.3], Australia: [-25.3, 133.8], "New Zealand": [-41.0, 174.9],
  Japan: [36.2, 138.3], China: [35.9, 104.2], Singapore: [1.35, 103.8], "South Korea": [36.5, 127.8],
};

const MAP_TILES = {
  dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
};
const MAP_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>';

// Prende solo la prima sede per gli annunci con più città (es. "Bologna
// (Italy), Groningen (Netherlands)"): un segnaposto solo, non ha senso
// provare a mostrarle tutte per un singolo annuncio sulla mappa.
function firstPlaceName(city) {
  if (!city) return null;
  return city
    .split(",")[0]
    .replace(/\s*\(.*?\)\s*/g, "")
    .trim();
}

function locationCoords(item) {
  const cityName = firstPlaceName(item.city);
  if (cityName && CITY_COORDS[cityName.toLowerCase()]) return CITY_COORDS[cityName.toLowerCase()];
  if (item.country && COUNTRY_COORDS[item.country]) return COUNTRY_COORDS[item.country];
  return null;
}

let interestMap = null;
let interestMapLayer = null;
let interestMapMarkers = [];

function ensureInterestMap() {
  if (interestMap || typeof L === "undefined") return interestMap;
  const el = $("#interestMap");
  if (!el) return null;
  interestMap = L.map(el, { worldCopyJump: true, minZoom: 2 }).setView([25, 15], 2);
  applyMapTheme(state.mapTheme);
  return interestMap;
}

function applyMapTheme(theme) {
  state.mapTheme = theme;
  localStorage.setItem("phdtracker.mapTheme", theme);
  const btn = $("#mapThemeToggle");
  if (btn) btn.textContent = theme === "dark" ? "Tema chiaro" : "Tema scuro";
  if (!interestMap) return;
  if (interestMapLayer) interestMap.removeLayer(interestMapLayer);
  interestMapLayer = L.tileLayer(MAP_TILES[theme], { attribution: MAP_ATTRIBUTION, maxZoom: 19 }).addTo(interestMap);
}

function renderInterestMap() {
  const section = $("#interestMapSection");
  const mapEl = $("#interestMap");
  const emptyEl = $("#interestMapEmpty");
  if (!section || !mapEl || !emptyEl) return;

  const withCoords = state.listings
    .filter((it) => getInterest(it.id) === "yes")
    .map((it) => ({ item: it, coords: locationCoords(it) }))
    .filter((x) => x.coords);

  if (typeof L === "undefined") {
    // Leaflet non è (ancora) caricato, es. offline al primo avvio: nessun
    // errore bloccante, si mostra solo il messaggio informativo.
    mapEl.style.display = "none";
    emptyEl.style.display = "block";
    emptyEl.textContent =
      "La mappa richiede una connessione a Internet per caricarsi (usa OpenStreetMap/CARTO).";
    return;
  }

  if (withCoords.length === 0) {
    mapEl.style.display = "none";
    emptyEl.style.display = "block";
    emptyEl.textContent =
      'Segna come "Interessa" almeno un annuncio con un luogo riconosciuto per vederlo qui sulla mappa.';
    return;
  }

  mapEl.style.display = "";
  emptyEl.style.display = "none";

  const map = ensureInterestMap();
  if (!map) return;

  for (const m of interestMapMarkers) map.removeLayer(m);
  interestMapMarkers = [];

  const bounds = [];
  for (const { item, coords } of withCoords) {
    const marker = L.circleMarker(coords, {
      radius: 7,
      color: "#4f8ef7",
      weight: 2,
      fillColor: "#4f8ef7",
      fillOpacity: 0.85,
    }).addTo(map);
    const loc = locationText(item) || "";
    marker.bindPopup(
      `<strong>${escapeHtml(item.title)}</strong><br>${escapeHtml(loc)}<br><a href="${item.link}" target="_blank" rel="noopener">Apri annuncio →</a>`
    );
    marker.on("click", () => marker.openPopup());
    interestMapMarkers.push(marker);
    bounds.push(coords);
  }

  if (bounds.length === 1) {
    map.setView(bounds[0], 5);
  } else if (bounds.length > 1) {
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 6 });
  }

  // Leaflet calcola le dimensioni al momento dell'init: se la sezione era
  // nascosta/appena resa visibile le misure possono essere sbagliate finché
  // non si forza un ricalcolo.
  setTimeout(() => map.invalidateSize(), 50);
}

function daysAgo(iso) {
  if (!iso) return Infinity;
  const diffMs = Date.now() - new Date(iso).getTime();
  return diffMs / (1000 * 60 * 60 * 24);
}

function daysUntil(iso) {
  if (!iso) return Infinity;
  const diffMs = new Date(iso).getTime() - Date.now();
  return diffMs / (1000 * 60 * 60 * 24);
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("it-IT", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

async function loadData() {
  const [listingsRes, configRes, runRes] = await Promise.allSettled([
    fetch("data/listings.json", { cache: "no-store" }).then((r) => r.json()),
    fetch("config/config.json", { cache: "no-store" }).then((r) => r.json()),
    fetch("data/last-run.json", { cache: "no-store" }).then((r) => r.json()),
  ]);

  state.listings = listingsRes.status === "fulfilled" ? listingsRes.value : [];
  state.config = configRes.status === "fulfilled" ? configRes.value : {};
  state.lastRun = runRes.status === "fulfilled" ? runRes.value : null;
}

function buildChipOptions() {
  const set = new Set();
  for (const item of state.listings) {
    for (const k of item.matchedKeywords || []) {
      if (k.startsWith("(nessun filtro")) continue;
      set.add(k);
    }
  }
  return ["Tutte", ...Array.from(set).sort()];
}

// ---------------------------------------------------------------------------
// Filtri — un unico pulsante "Filtri" apre un pannello con tre menu a
// tendina (Materia, Paese, Stato) più il toggle "solo novità", al posto
// delle tre righe di chip precedenti: più compatto, soprattutto quando le
// materie riconosciute sono tante.
// ---------------------------------------------------------------------------
function buildCountryOptions() {
  const set = new Set();
  for (const item of state.listings) {
    if (item.country) set.add(item.country);
  }
  return ["Tutti i paesi", ...Array.from(set).sort()];
}

const STATUS_OPTIONS = ["Tutte", "Da valutare", "Mi interessano", "Scartate"];

function fillSelect(select, options, activeValue, labelFor) {
  select.innerHTML = "";
  for (const opt of options) {
    const el = document.createElement("option");
    el.value = opt;
    el.textContent = labelFor ? labelFor(opt) : opt;
    if (opt === activeValue) el.selected = true;
    select.appendChild(el);
  }
}

function renderChips() {
  fillSelect($("#chipSelect"), buildChipOptions(), state.activeChip);
}

function renderCountryChips() {
  const options = buildCountryOptions();
  const field = $("#countryFilterField");
  if (options.length <= 1) {
    field.style.display = "none"; // ancora nessun paese riconosciuto: non mostrare il campo
    return;
  }
  field.style.display = "";
  fillSelect($("#countrySelect"), options, state.activeCountry);
}

function renderStatusChips() {
  const select = $("#statusSelect");
  if (!select) return;
  fillSelect(select, STATUS_OPTIONS, state.activeStatus, (opt) => {
    let count = 0;
    if (opt === "Mi interessano") count = state.listings.filter((it) => getInterest(it.id) === "yes").length;
    else if (opt === "Scartate") count = state.listings.filter((it) => getInterest(it.id) === "no").length;
    return count && opt !== "Tutte" && opt !== "Da valutare" ? `${opt} (${count})` : opt;
  });
}

function countActiveFilters() {
  let n = 0;
  if (state.activeChip !== "Tutte") n++;
  if (state.activeCountry !== "Tutti i paesi") n++;
  if (state.activeStatus !== "Tutte") n++;
  if (state.onlyNew) n++;
  return n;
}

function renderFiltersBadge() {
  const badge = $("#filtersBadge");
  if (!badge) return;
  const n = countActiveFilters();
  if (n > 0) {
    badge.textContent = String(n);
    badge.style.display = "";
  } else {
    badge.style.display = "none";
  }
}

function matchesFilters(item) {
  if (state.activeChip !== "Tutte") {
    if (!(item.matchedKeywords || []).includes(state.activeChip)) return false;
  }
  if (state.activeCountry !== "Tutti i paesi") {
    if (item.country !== state.activeCountry) return false;
  }
  if (state.activeStatus !== "Tutte") {
    const interest = getInterest(item.id);
    if (state.activeStatus === "Da valutare" && interest !== null) return false;
    if (state.activeStatus === "Mi interessano" && interest !== "yes") return false;
    if (state.activeStatus === "Scartate" && interest !== "no") return false;
  }
  if (state.onlyNew && daysAgo(item.firstSeen) > 1) return false;
  if (state.search.trim()) {
    const hay = (item.title + " " + item.description + " " + item.source).toLowerCase();
    if (!hay.includes(state.search.trim().toLowerCase())) return false;
  }
  return true;
}

function interestRank(item) {
  // Le offerte "mi interessa" salgono in cima, quelle scartate scendono in
  // fondo (ma restano presenti in elenco, mai rimosse), quelle da valutare
  // restano nell'ordine naturale.
  const v = getInterest(item.id);
  if (v === "yes") return 0;
  if (v === "no") return 2;
  return 1;
}

function sortListings(items) {
  return [...items].sort((a, b) => {
    const ir = interestRank(a) - interestRank(b);
    if (ir !== 0) return ir;
    const ad = a.deadlineISO ? new Date(a.deadlineISO).getTime() : Infinity;
    const bd = b.deadlineISO ? new Date(b.deadlineISO).getTime() : Infinity;
    if (ad !== bd) return ad - bd; // scadenze più vicine prima
    const af = a.firstSeen ? new Date(a.firstSeen).getTime() : 0;
    const bf = b.firstSeen ? new Date(b.firstSeen).getTime() : 0;
    return bf - af; // poi le più recenti
  });
}

function deadlineBadgeHtml(item) {
  const du = daysUntil(item.deadlineISO);
  if (item.deadlineISO && du >= 0 && du <= 14) {
    const days = Math.ceil(du);
    return `<span class="badge-deadline">${days <= 0 ? "SCADE OGGI" : `SCADE TRA ${days} G.`}</span>`;
  }
  return "";
}

function deadlineLineText(item) {
  if (item.deadlineISO) {
    return `Scadenza: ${formatDate(item.deadlineISO)}`;
  }
  if (item.deadlineText) {
    return `Scadenza (indicativa): ${item.deadlineText}`;
  }
  return null;
}

function locationText(item) {
  if (item.city && item.city.includes(",")) {
    // Dottorato con più sedi (es. reti MSCA): lo script mette già il nome
    // di ciascuna città nel campo "city", con il paese tra parentesi
    // accanto quando le sedi sono in paesi diversi — non serve ripetere
    // ancora il paese principale in coda.
    return item.city;
  }
  if (item.city && item.country) return `${item.city}, ${item.country}`;
  if (item.country) return item.country;
  return null;
}

function renderList() {
  const list = $("#list");
  const empty = $("#emptyState");
  const filtered = sortListings(state.listings.filter(matchesFilters));

  $("#totalCount").textContent = `${filtered.length} offerte${
    filtered.length !== state.listings.length ? ` (di ${state.listings.length})` : ""
  }`;

  list.innerHTML = "";
  if (filtered.length === 0) {
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  for (const item of filtered) {
    const card = document.createElement("div");
    const interest = getInterest(item.id);
    card.className = "card" + (interest === "no" ? " card-dismissed" : interest === "yes" ? " card-interested" : "");
    card.dataset.id = item.id;

    const isNew = daysAgo(item.firstSeen) <= 3;
    const tags = (item.matchedKeywords || []).filter((k) => !k.startsWith("(nessun filtro"));
    const deadlineLine = deadlineLineText(item);
    const snippet = (item.description || "").trim();
    const loc = locationText(item);

    card.innerHTML = `
      <div class="row-top">
        <h2><a href="${item.link}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></h2>
        <div class="badge-col">
          ${isNew ? '<span class="badge-new">NUOVO</span>' : ""}
          ${deadlineBadgeHtml(item)}
        </div>
      </div>
      <div class="source-line">${escapeHtml(item.source || "")}</div>
      ${
        loc || item.payText
          ? `<div class="meta-row">
              ${loc ? `<span class="meta-pill">${ICON_PIN}${escapeHtml(loc)}</span>` : ""}
              ${item.payText ? `<span class="meta-pill">${ICON_COIN}${escapeHtml(item.payText)}</span>` : ""}
            </div>`
          : ""
      }
      ${
        tags.length
          ? `<div class="tag-row">${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>`
          : ""
      }
      ${snippet ? `<p class="snippet">${escapeHtml(snippet.slice(0, 200))}${snippet.length > 200 ? "…" : ""}</p>` : ""}
      ${interest === "no" ? '<div class="dismissed-note">Segnato come "non interessa" — resta comunque disponibile qui.</div>' : ""}
      <div class="interest-row">
        <button type="button" class="interest-btn interest-yes${interest === "yes" ? " active" : ""}" data-action="yes">
          ${ICON_CHECK}${interest === "yes" ? "Ti interessa" : "Interessa"}
        </button>
        <button type="button" class="interest-btn interest-no${interest === "no" ? " active" : ""}" data-action="no">
          ${ICON_CROSS}${interest === "no" ? "Scartata" : "Non interessa"}
        </button>
      </div>
      <div class="footer-line">
        <span>${deadlineLine ? escapeHtml(deadlineLine) : `Trovato il ${formatDate(item.firstSeen)}`}</span>
        <a href="${item.link}" target="_blank" rel="noopener">Apri annuncio →</a>
      </div>
    `;
    list.appendChild(card);
  }
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderMeta() {
  const el = $("#lastCheck");
  if (state.lastRun && state.lastRun.lastRun) {
    const d = new Date(state.lastRun.lastRun);
    el.textContent = `Ultimo controllo: ${d.toLocaleString("it-IT")}`;
  } else {
    el.textContent = "Ultimo controllo: non ancora eseguito";
  }
}

function renderManualLinks() {
  const wrap = $("#manualLinks");
  const links = state.config.manualCheckLinks || [];
  if (!links.length) {
    $("#manualSection").style.display = "none";
    return;
  }
  wrap.innerHTML = links
    .map(
      (l) => `
      <a class="manual-link" href="${l.url}" target="_blank" rel="noopener">
        <span class="name">${escapeHtml(l.name)}</span>
        <span class="note">${escapeHtml(l.note || "")}</span>
      </a>`
    )
    .join("");
}

// ---------------------------------------------------------------------------
// Esporta/importa preferenze — permette di portare interesse/scartati e
// filtri su un altro dispositivo, o di farne un backup prima di cancellare
// i dati del browser (le preferenze vivono solo in localStorage, quindi
// altrimenti andrebbero perse).
// ---------------------------------------------------------------------------
const PREF_KEYS = {
  chip: "phdtracker.chip",
  country: "phdtracker.country",
  status: "phdtracker.status",
  search: "phdtracker.search",
  onlyNew: "phdtracker.onlyNew",
  interest: "phdtracker.interest",
};

function setPrefsStatus(message, isError) {
  const el = $("#prefsStatus");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("prefs-status-error", !!isError);
}

function exportPreferences() {
  const data = {
    app: "phd-tracker",
    version: 1,
    exportedAt: new Date().toISOString(),
    chip: localStorage.getItem(PREF_KEYS.chip),
    country: localStorage.getItem(PREF_KEYS.country),
    status: localStorage.getItem(PREF_KEYS.status),
    search: localStorage.getItem(PREF_KEYS.search),
    onlyNew: localStorage.getItem(PREF_KEYS.onlyNew),
    interest: loadInterest(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `phd-tracker-preferenze-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setPrefsStatus("Preferenze esportate.", false);
}

function applyImportedPreferences(data) {
  if (typeof data.chip === "string") {
    localStorage.setItem(PREF_KEYS.chip, data.chip);
    state.activeChip = data.chip;
  }
  if (typeof data.country === "string") {
    localStorage.setItem(PREF_KEYS.country, data.country);
    state.activeCountry = data.country;
  }
  if (typeof data.status === "string") {
    localStorage.setItem(PREF_KEYS.status, data.status);
    state.activeStatus = data.status;
  }
  if (typeof data.search === "string") {
    localStorage.setItem(PREF_KEYS.search, data.search);
    state.search = data.search;
  }
  if (typeof data.onlyNew === "string") {
    localStorage.setItem(PREF_KEYS.onlyNew, data.onlyNew);
    state.onlyNew = data.onlyNew === "1";
  }
  if (data.interest && typeof data.interest === "object" && !Array.isArray(data.interest)) {
    localStorage.setItem(PREF_KEYS.interest, JSON.stringify(data.interest));
    state.interest = data.interest;
  }

  // Riallinea i controlli visibili senza ricaricare la pagina.
  const searchBox = $("#searchBox");
  if (searchBox) searchBox.value = state.search;
  const onlyNewToggle = $("#onlyNewToggle");
  if (onlyNewToggle) onlyNewToggle.checked = state.onlyNew;
  renderChips();
  renderCountryChips();
  renderStatusChips();
  renderFiltersBadge();
  renderList();
  renderInterestMap();
}

function importPreferencesFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result || ""));
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("il file non contiene un oggetto JSON valido");
      }
      applyImportedPreferences(data);
      setPrefsStatus("Preferenze importate correttamente.", false);
    } catch (err) {
      setPrefsStatus(
        `Impossibile importare il file: ${err.message}. Assicurati sia un file esportato da questa app.`,
        true
      );
    }
  };
  reader.onerror = () => setPrefsStatus("Impossibile leggere il file selezionato.", true);
  reader.readAsText(file);
}

function bindControls() {
  const searchBox = $("#searchBox");
  searchBox.value = state.search;
  let t = null;
  searchBox.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.search = searchBox.value;
      localStorage.setItem("phdtracker.search", state.search);
      renderList();
    }, 150);
  });

  const onlyNew = $("#onlyNewToggle");
  onlyNew.checked = state.onlyNew;
  onlyNew.addEventListener("change", () => {
    state.onlyNew = onlyNew.checked;
    localStorage.setItem("phdtracker.onlyNew", state.onlyNew ? "1" : "0");
    renderFiltersBadge();
    renderList();
  });

  const chipSelect = $("#chipSelect");
  chipSelect.addEventListener("change", () => {
    state.activeChip = chipSelect.value;
    localStorage.setItem("phdtracker.chip", state.activeChip);
    renderFiltersBadge();
    renderList();
  });

  const countrySelect = $("#countrySelect");
  countrySelect.addEventListener("change", () => {
    state.activeCountry = countrySelect.value;
    localStorage.setItem("phdtracker.country", state.activeCountry);
    renderFiltersBadge();
    renderList();
  });

  const statusSelect = $("#statusSelect");
  statusSelect.addEventListener("change", () => {
    state.activeStatus = statusSelect.value;
    localStorage.setItem("phdtracker.status", state.activeStatus);
    renderFiltersBadge();
    renderList();
  });

  // Pulsante unico "Filtri": apre/chiude il pannello con i tre menu a
  // tendina. Si chiude anche toccando fuori dal pannello.
  const filtersToggleBtn = $("#filtersToggleBtn");
  const filtersPanel = $("#filtersPanel");
  const filtersWrap = $("#filtersWrap");
  const setFiltersOpen = (open) => {
    filtersPanel.style.display = open ? "" : "none";
    filtersToggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
    filtersToggleBtn.classList.toggle("active", open);
  };
  filtersToggleBtn.addEventListener("click", () => {
    setFiltersOpen(filtersPanel.style.display === "none");
  });
  document.addEventListener("click", (ev) => {
    if (filtersPanel.style.display === "none") return;
    if (filtersWrap.contains(ev.target)) return;
    setFiltersOpen(false);
  });

  // Delega degli eventi sui pulsanti "Interessa"/"Non interessa": le card vengono ricreate ad ogni
  // renderList(), quindi il listener va agganciato al contenitore #list.
  $("#list").addEventListener("click", (ev) => {
    const btn = ev.target.closest(".interest-btn");
    if (!btn) return;
    const card = ev.target.closest(".card");
    if (!card) return;
    setInterest(card.dataset.id, btn.dataset.action);
  });

  const exportBtn = $("#exportPrefsBtn");
  if (exportBtn) exportBtn.addEventListener("click", exportPreferences);

  const importBtn = $("#importPrefsBtn");
  const importInput = $("#importPrefsInput");
  if (importBtn && importInput) {
    importBtn.addEventListener("click", () => importInput.click());
    importInput.addEventListener("change", () => {
      const file = importInput.files && importInput.files[0];
      if (file) importPreferencesFromFile(file);
      importInput.value = ""; // permette di reimportare lo stesso file una seconda volta
    });
  }

  const mapThemeToggle = $("#mapThemeToggle");
  if (mapThemeToggle) {
    mapThemeToggle.textContent = state.mapTheme === "dark" ? "Tema chiaro" : "Tema scuro";
    mapThemeToggle.addEventListener("click", () => {
      applyMapTheme(state.mapTheme === "dark" ? "light" : "dark");
    });
  }
}

async function init() {
  await loadData();
  renderMeta();
  renderChips();
  renderCountryChips();
  renderStatusChips();
  bindControls();
  renderFiltersBadge();
  renderList();
  renderManualLinks();
  renderInterestMap();
}

init();
