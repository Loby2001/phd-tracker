# PhD Tracker

Una piccola app web che raccoglie automaticamente nuove offerte di dottorato,
le filtra per materia/parole chiave a tua scelta, e ti manda una notifica
push sul telefono quando ne trova una nuova. Gira gratis su GitHub (Pages +
Actions), nessun server da gestire.

- **Frontend**: pagina web installabile sulla schermata Home dell'iPhone
  (`index.html` + `app.js` + `style.css`), mostra l'elenco aggiornato.
- **Motore**: uno script Node (`scripts/check.mjs`) eseguito ogni 6 ore da
  GitHub Actions, che controlla le fonti configurate, trova le novità e
  aggiorna `data/listings.json`.
- **Notifiche**: quando trova qualcosa di nuovo, manda un messaggio push
  tramite [ntfy.sh](https://ntfy.sh) (servizio gratuito, open source) al tuo
  iPhone, dove avrai installato la app gratuita **ntfy** da App Store.

Non serve account Apple Developer, non serve un server sempre acceso: tutto
gira sull'infrastruttura gratuita di GitHub.

---

## 1. Pubblicare il repository su GitHub

1. Vai su [github.com/new](https://github.com/new) e crea un repository
   **pubblico** (deve essere pubblico per usare GitHub Pages gratis), es.
   `phd-tracker`. Non aggiungere README/licenza automatici (li hai già qui).
2. Apri la pagina del repository appena creato, clicca **Add file → Upload
   files**, poi trascina dentro **tutto il contenuto di questa cartella**
   (compresi i file nascosti come `.github/` e `.gitignore` — se il tuo
   browser non li mostra nel drag&drop, vedi la nota sotto).
3. Scrivi un messaggio di commit (es. "Prima versione") e conferma.

> **Nota sui file nascosti (`.github/workflows/check.yml`)**: alcuni
> gestori file nascondono le cartelle che iniziano con il punto e il
> drag&drop dal browser potrebbe non includerle. Se dopo l'upload non vedi
> la cartella `.github` nel repository, il modo più affidabile è usare Git
> da terminale:
> ```bash
> cd phd-tracker
> git init
> git add -A
> git commit -m "Prima versione"
> git branch -M main
> git remote add origin https://github.com/TUO-USERNAME/phd-tracker.git
> git push -u origin main
> ```

---

## 2. Attivare GitHub Pages

1. Nel repository, vai su **Settings → Pages**.
2. In "Build and deployment" → "Source" scegli **Deploy from a branch**.
3. Branch: **main**, cartella: **/ (root)**. Salva.
4. Dopo un minuto la pagina sarà online su:
   `https://TUO-USERNAME.github.io/phd-tracker/`

Aggiorna il campo `sitePublicUrl` in `config/config.json` con questo
indirizzo (viene usato nel link delle notifiche riassuntive).

---

## 3. Permettere alle Actions di scrivere nel repository

1. Vai su **Settings → Actions → General**.
2. Scorri fino a "Workflow permissions" e seleziona **Read and write
   permissions**. Salva.

   (Serve perché lo script, dopo ogni controllo, salva i nuovi annunci
   trovati facendo un commit automatico in `data/`.)

---

## 4. Impostare le notifiche push (ntfy)

1. Scarica l'app gratuita **ntfy** dall'App Store sul tuo iPhone.
2. Scegli un **nome di topic segreto e difficile da indovinare**, ad esempio
   `lorenzo-phd-a8f3k2` (chiunque conosca il nome del topic può leggere le
   tue notifiche, quindi non usare qualcosa di ovvio).
3. Nel repository GitHub, vai su **Settings → Secrets and variables →
   Actions → New repository secret**:
   - Nome: `NTFY_TOPIC`
   - Valore: il topic scelto (es. `lorenzo-phd-a8f3k2`)
4. Apri l'app ntfy sul telefono, tocca **+ (Subscribe to topic)** e incolla
   lo stesso nome. Da questo momento ricevi una notifica ogni volta che lo
   script trova un'offerta nuova che corrisponde ai tuoi filtri.

---

## 5. Personalizzare materie e filtri

Modifica `config/config.json` direttamente su GitHub (icona matita in alto
a destra quando apri il file) — non serve programmare:

- **`keywords`**: elenco di parole/frasi da cercare (case-insensitive).
  Lascialo vuoto `[]` per non filtrare per materia (prendi tutti i
  dottorati, di ogni campo).
- **`excludeKeywords`**: parole che, se presenti, scartano l'annuncio.
- **`requirePhdIndicator`**: se `true`, tiene solo annunci che contengono
  parole come "PhD", "doctoral", "studentship" ecc. (evita di mostrare
  post-doc o cattedre). Consigliato lasciarlo `true`.
- **`sources.jobsAcUkSubjects`**: elenco di aree disciplinari di
  [jobs.ac.uk](https://www.jobs.ac.uk/feeds) da controllare (feed RSS
  ufficiali). Elenco completo delle aree disponibili:
  <https://www.jobs.ac.uk/feeds/subject-areas>
- **`sources.academicPositionsFields`**: elenco di campi di
  [academicpositions.com](https://academicpositions.com/jobs) da
  controllare. Per trovare lo slug di un campo, vai sul sito, apri la
  pagina del campo che ti interessa e copia la parte finale dell'URL
  (es. `.../jobs/field/chemistry-organic-chemistry` → slug
  `chemistry-organic-chemistry`).

Ogni modifica al file viene applicata dal **prossimo** controllo
automatico (entro 6 ore), oppure puoi forzarlo subito (punto 7).

---

## 6. Cambiare la frequenza di controllo

Modifica la riga `cron` in `.github/workflows/check.yml`. Esempi:

- ogni 6 ore (default): `0 */6 * * *`
- una volta al giorno alle 8:00 UTC: `0 8 * * *`
- ogni 12 ore: `0 */12 * * *`

(GitHub Actions usa sempre l'orario UTC, due ore indietro rispetto
all'ora italiana estiva.)

---

## 7. Testare subito, senza aspettare

Vai su **Actions** (in alto nel repository) → clicca sul workflow
"Controllo bandi dottorato" → **Run workflow** → **Run workflow**. Parte
subito, in genere impiega meno di un minuto.

La **primissima esecuzione** popola l'elenco ma non manda notifiche (serve
a creare una base di partenza, altrimenti riceveresti decine di notifiche
tutte insieme per annunci che magari sono lì da mesi). Da quella successiva
in poi, ricevi una notifica solo per le novità vere.

---

## 8. Limiti noti (onestamente)

- **EURAXESS** e **FindAPhD** non vengono controllati automaticamente: il
  loro `robots.txt` chiede esplicitamente ai crawler di non raschiare le
  pagine di ricerca/annuncio, e ho preferito rispettarlo. Restano comunque
  linkati in fondo alla pagina: ti conviene impostare i loro alert nativi
  via email (vedi sezione "Fonti da controllare manualmente" nell'app).
- **jobs.ac.uk** copre in modo molto solido il Regno Unito e in modo
  discreto il resto d'Europa (molte università europee vi pubblicano
  annunci in inglese), ma non è esaustivo per bandi pubblicati solo in
  lingua locale (es. concorsi italiani su bandi.mur.gov.it).
- **academicpositions.com** non offre un feed ufficiale: lo script legge
  la pagina HTML cercando i link agli annunci. Se il sito cambia
  struttura, questa fonte potrebbe smettere di restituire risultati finché
  non si aggiorna il selettore in `scripts/check.mjs` (funzione
  `fetchAcademicPositionsField`) — jobs.ac.uk via RSS invece è molto più
  stabile nel tempo.
- Per bandi italiani (dottorato XLII ciclo ecc.) conviene comunque
  continuare a controllare `bandi.mur.gov.it` e i siti dei singoli atenei:
  non sono coperti da questa app.

---

## 9. Struttura del progetto

```
phd-tracker/
├── index.html              pagina principale (PWA)
├── app.js                   logica di filtro/visualizzazione
├── style.css
├── manifest.webmanifest     per "Aggiungi a Home" su iPhone
├── sw.js                    service worker (funziona offline)
├── icons/                   icone dell'app
├── config/
│   └── config.json          ← qui personalizzi materie, fonti, filtri
├── data/
│   ├── listings.json        elenco corrente (generato automaticamente)
│   ├── seen.json            id già notificati (generato automaticamente)
│   └── last-run.json        timestamp ultimo controllo (generato)
├── scripts/
│   └── check.mjs             lo script che fa il lavoro
└── .github/workflows/
    └── check.yml              il "cron job" gratuito di GitHub Actions
```

---

## 10. Aggiungere l'app alla schermata Home (iPhone)

1. Apri `https://TUO-USERNAME.github.io/phd-tracker/` in **Safari** (deve
   essere Safari, non Chrome, perché su iOS solo Safari può installare
   PWA).
2. Tocca l'icona di condivisione (il quadrato con la freccia in su).
3. Scorri e tocca **Aggiungi a Home**.

Da quel momento hai un'icona come una app vera, che apre la pagina a
schermo intero.
