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

function renderChips() {
  const options = buildChipOptions();
  const row = $("#chipRow");
  row.innerHTML = "";
  for (const opt of options) {
    const el = document.createElement("div");
    el.className = "chip" + (opt === state.activeChip ? " active" : "");
    el.textContent = opt;
    el.addEventListener("click", () => {
      state.activeChip = opt;
      localStorage.setItem("phdtracker.chip", opt);
      renderChips();
      renderList();
    });
    row.appendChild(el);
  }
}

function buildCountryOptions() {
  const set = new Set();
  for (const item of state.listings) {
    if (item.country) set.add(item.country);
  }
  return ["Tutti i paesi", ...Array.from(set).sort()];
}

function renderCountryChips() {
  const options = buildCountryOptions();
  const row = $("#countryChipRow");
  const wrap = $("#countryChipWrap");
  if (options.length <= 1) {
    wrap.style.display = "none"; // ancora nessun paese riconosciuto: non mostrare la riga
    return;
  }
  wrap.style.display = "";
  row.innerHTML = "";
  for (const opt of options) {
    const el = document.createElement("div");
    el.className = "chip" + (opt === state.activeCountry ? " active" : "");
    el.textContent = opt;
    el.addEventListener("click", () => {
      state.activeCountry = opt;
      localStorage.setItem("phdtracker.country", opt);
      renderCountryChips();
      renderList();
    });
    row.appendChild(el);
  }
}

const STATUS_OPTIONS = ["Tutte", "Da valutare", "Mi interessano", "Scartate"];

function renderStatusChips() {
  const row = $("#statusChipRow");
  if (!row) return;
  row.innerHTML = "";
  for (const opt of STATUS_OPTIONS) {
    const el = document.createElement("div");
    let count = 0;
    if (opt === "Mi interessano") count = state.listings.filter((it) => getInterest(it.id) === "yes").length;
    else if (opt === "Scartate") count = state.listings.filter((it) => getInterest(it.id) === "no").length;
    el.className = "chip" + (opt === state.activeStatus ? " active" : "");
    el.textContent = count && opt !== "Tutte" && opt !== "Da valutare" ? `${opt} (${count})` : opt;
    el.addEventListener("click", () => {
      state.activeStatus = opt;
      localStorage.setItem("phdtracker.status", opt);
      renderStatusChips();
      renderList();
    });
    row.appendChild(el);
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
  if (state.onlyNew && daysAgo(item.firstSeen) > 7) return false;
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
    renderList();
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
}

async function init() {
  await loadData();
  renderMeta();
  renderChips();
  renderCountryChips();
  renderStatusChips();
  bindControls();
  renderList();
  renderManualLinks();
}

init();
