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
}

init();
