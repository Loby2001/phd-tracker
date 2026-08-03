// app.js — logica della pagina PhD Tracker (nessuna dipendenza esterna)

const state = {
  listings: [],
  config: {},
  lastRun: null,
  activeChip: localStorage.getItem("phdtracker.chip") || "Tutte",
  search: localStorage.getItem("phdtracker.search") || "",
  onlyNew: localStorage.getItem("phdtracker.onlyNew") === "1",
};

const $ = (sel) => document.querySelector(sel);

function daysAgo(iso) {
  if (!iso) return Infinity;
  const diffMs = Date.now() - new Date(iso).getTime();
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

function matchesFilters(item) {
  if (state.activeChip !== "Tutte") {
    if (!(item.matchedKeywords || []).includes(state.activeChip)) return false;
  }
  if (state.onlyNew && daysAgo(item.firstSeen) > 7) return false;
  if (state.search.trim()) {
    const hay = (item.title + " " + item.description + " " + item.source).toLowerCase();
    if (!hay.includes(state.search.trim().toLowerCase())) return false;
  }
  return true;
}

function renderList() {
  const list = $("#list");
  const empty = $("#emptyState");
  const filtered = state.listings.filter(matchesFilters);

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
    card.className = "card";

    const isNew = daysAgo(item.firstSeen) <= 3;
    const tags = (item.matchedKeywords || []).filter((k) => !k.startsWith("(nessun filtro"));

    card.innerHTML = `
      <div class="row-top">
        <h2><a href="${item.link}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></h2>
        ${isNew ? '<span class="badge-new">NUOVO</span>' : ""}
      </div>
      <div class="source-line">${escapeHtml(item.source || "")}</div>
      ${
        tags.length
          ? `<div class="tag-row">${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>`
          : ""
      }
      <div class="footer-line">
        <span>Trovato il ${formatDate(item.firstSeen)}</span>
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
}

async function init() {
  await loadData();
  renderMeta();
  renderChips();
  bindControls();
  renderList();
  renderManualLinks();
}

init();
