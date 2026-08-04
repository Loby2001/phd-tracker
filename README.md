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

Ogni annuncio, quando riconoscibile dal testo, mostra anche **luogo**
(città/paese) e **importo indicativo della borsa/stipendio**: sono
estratti automaticamente dal testo dell'annuncio (nessuna fonte li fornisce
già strutturati), quindi compaiono solo quando il formato è riconoscibile —
vedi la sezione "Limiti noti" per i dettagli. La lista si può filtrare
anche per paese, non solo per materia.

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
- **`excludeKeywords`**: parole che, se presenti, scartano l'annuncio. Di
  default include già `"postdoctoral"`, `"post-doctoral"`, `"post doctoral"`
  e `"postdoc"`, per evitare che compaiano posizioni da post-dottorato
  insieme ai dottorati veri e propri (capita perché alcuni annunci di
  post-doc citano comunque la parola "PhD" nel testo, es. "PhD required").
  Aggiungine altre allo stesso modo se noti altri annunci fuori tema.
- **`countries`**: elenco di paesi/città da richiedere (es. `["Spain",
  "Netherlands", "Italy"]`, in inglese perché quasi tutti gli annunci sono
  in inglese). Lascialo vuoto `[]` per non filtrare per paese (tutta
  Europa e oltre).
- **`requirePhdIndicator`**: se `true`, tiene solo annunci che contengono
  parole come "PhD", "doctoral", "studentship" ecc. (evita di mostrare
  post-doc o cattedre). Consigliato lasciarlo `true`.
- **`sources.jobsAcUkSubjects`**: elenco di aree disciplinari di
  [jobs.ac.uk](https://www.jobs.ac.uk/feeds) da controllare (feed RSS
  ufficiali). Usa esattamente lo slug che vedi nell'URL quando apri
  <https://www.jobs.ac.uk/feeds/subject-areas> e clicchi un'area (es.
  "Physical and Environmental Sciences" → slug
  `physical-and-environmental-sciences`, con sotto-aree come `chemistry` o
  `physics-and-astronomy` che funzionano anch'esse direttamente) — uno
  slug scritto a mano/indovinato quasi sempre dà errore 404.
- **`sources.academicPositionsFields`**: elenco di campi di
  [academicpositions.com](https://academicpositions.com/jobs) da
  controllare. Per trovare lo slug di un campo, vai sul sito, apri la
  pagina del campo che ti interessa e copia la parte finale dell'URL
  (es. `.../jobs/field/chemistry-organic-chemistry` → slug
  `chemistry-organic-chemistry`).
- **`sources.academicTransfer`**: `true`/`false`. Se attivo, controlla
  tutte le posizioni di dottorato su
  [academictransfer.com](https://www.academictransfer.com/en/job-type/phd/)
  (portale collettivo delle università olandesi — copertura forte sui
  Paesi Bassi).
- **`sources.phdPortalSubjects`**: elenco di materie di
  [phdportal.com](https://www.phdportal.com) da controllare (ambito
  "Europe"). **Disattivato di default (lista vuota `[]`)**: il sito
  blocca le richieste automatiche con un errore 403 (protezione
  anti-bot), non è un problema di configurazione — l'ho lasciato nel
  codice nel caso tu voglia sperimentare, ma per ora non aspettarti che
  funzioni. Se un giorno vuoi riprovare: trova lo slug di una materia su
  phdportal.com guardando l'URL (es. `.../search/phd/chemistry/europe` →
  slug `chemistry`).
- **`sources.bandiMur`**: `true`/`false`. Se attivo, controlla
  [bandi.mur.gov.it](https://bandi.mur.gov.it), il portale ufficiale del
  Ministero italiano con **tutti** i bandi di dottorato di **tutti** gli
  atenei italiani (Torino, Bologna, Milano compresi). Non c'è un filtro
  per parola chiave nell'URL, quindi lo script scarica l'elenco completo
  dei bandi aperti e applica i tuoi `keywords` localmente. **Nota**: i
  bandi italiani sono di solito concorsi generali per ateneo/dipartimento
  (es. "Dottorato in Chimica"), non annunci per singolo progetto — il
  tema di ricerca specifico si concorda in genere contattando prima un
  docente (come discusso in chat).
- **`sources.jobrxiv`**: `true`/`false`. Se attivo, cerca su
  [jobrxiv.org](https://jobrxiv.org) (bacheca accademica generalista) una
  query per ciascuna parola in `keywords` + "phd".

Ogni modifica al file viene applicata dal **prossimo** controllo
automatico (entro 6 ore), oppure puoi forzarlo subito (punto 12).

---

## 6. Segnare "mi interessa" / "non interessa"

Ogni annuncio in elenco ha due pulsanti, **Interessa** e **Non
interessa**:

- Toccando **Interessa** l'annuncio viene evidenziato (bordo verde) e
  salito in cima all'elenco.
- Toccando **Non interessa** l'annuncio viene contrassegnato come
  scartato: appare visivamente sbiadito e scivola in fondo all'elenco, ma
  **non viene mai nascosto o rimosso automaticamente** — resta sempre lì,
  apribile e ripristinabile in qualsiasi momento.
- Toccando di nuovo lo stesso pulsante annulli la scelta e l'annuncio
  torna "da valutare".

Aprendo il pulsante **Filtri** trovi anche un menu **Stato** —
**Tutte**, **Da valutare**, **Mi interessano**, **Scartate** — utile
per rivedere in un colpo solo tutto quello che hai scartato (per
esempio se vuoi ricontrollarlo più avanti). Il filtro di default è
"Tutte", quindi nulla sparisce mai dalla vista a meno che tu non scelga
tu stesso di filtrare.

Questa scelta è salvata solo sul tuo dispositivo (`localStorage` del
browser), non nel repository: se apri l'app da un altro telefono o
cancelli i dati del browser, le etichette Interessa/Non interessa
ripartono da zero. Non viene toccato l'elenco `data/listings.json` che
viene aggiornato dal controllo automatico.

**Non vedi i nuovi pulsanti dopo aver caricato i file aggiornati?**
L'app è una PWA con un service worker che tiene una copia offline dei
file `index.html`/`style.css`/`app.js` per farla funzionare anche senza
connessione: se avevi già aperto l'app prima di questo aggiornamento, il
telefono potrebbe continuare a mostrarti la versione salvata in cache.
Ogni volta che questi tre file cambiano, aggiorno anche il numero di
versione dentro `sw.js` (`const CACHE = "phdtracker-vN"`) proprio per
forzare il telefono a scaricare la versione nuova — se in futuro modifichi
tu stesso questi file a mano, ricordati di incrementare quel numero, o il
tuo telefono continuerà a vedere la versione vecchia. Dopo aver caricato i
file su GitHub, chiudi del tutto l'app (o Safari) e riaprila: nel giro di
pochi secondi dovrebbe aggiornarsi da sola. Se proprio non si aggiorna,
rimuovila dalla schermata Home e rifai "Aggiungi a Home" (punto 15).

---

## 7. Alert email nativi (EURAXESS, FindAPhD) senza usare la tua mail personale

EURAXESS e FindAPhD non si possono raschiare automaticamente (il loro
`robots.txt` lo vieta, vedi punto 13 "Limiti noti"), ma entrambi offrono un
loro alert nativo via email quando esce un nuovo annuncio che corrisponde
a una tua ricerca salvata. Per farli confluire nella stessa app e nella
stessa notifica ntfy di tutto il resto — invece di controllare a mano una
casella di posta — puoi collegare una **casella email dedicata** (mai la
tua personale) che lo script legge automaticamente ogni 6 ore insieme alle
altre fonti.

**Perché è permesso e non è "scraping"**: qui lo script non tocca in
nessun modo il sito di EURAXESS o FindAPhD. Legge, via IMAP, una casella
email che è tua e che controlli tu; il contenuto sono email che il sito
stesso ti manda perché gliel'hai chiesto tu iscrivendoti al loro alert.
È l'equivalente automatico di aprire la posta e cliccare i link — non
viola nessun `robots.txt` né termine di servizio.

### 7.1 Crea una casella email dedicata

Usa un indirizzo **nuovo, mai usato altrove**, così non condividi la tua
mail personale con nessuno script né con EURAXESS/FindAPhD.

**Consigliato per semplicità: [GMX](https://www.gmx.com/mail/create-email-address/)**
(o il suo gemello [mail.com](https://www.mail.com), stessa azienda). A
differenza di Gmail non richiede di attivare la verifica in due passaggi
né di generare una password separata: basta creare l'account gratuito
(un numero di telefono non è obbligatorio, si può verificare con
un'altra email di recupero) e usare **la password normale dell'account**
anche per IMAP — un solo passaggio in più rispetto alla creazione
dell'account (punto 7.2).

Se preferisci comunque Gmail va benissimo lo stesso, richiede solo un
paio di passaggi extra (verifica in due passaggi + "app password") — li
trovi in fondo a questa sezione, al punto 7.2bis.

**Da evitare: Outlook/Hotmail.** Microsoft sta eliminando l'accesso IMAP
con semplice utente/password (comprese le app password) su tutti gli
account Outlook.com nel corso del 2026, richiedendo al suo posto un
sistema di autenticazione (OAuth2) che lo script non supporta: rischi di
configurarlo e vederlo smettere di funzionare da solo poco dopo.

### 7.2 Attiva l'accesso IMAP

**Se hai scelto GMX/mail.com:**

1. Accedi alla webmail del nuovo account.
2. Vai su **Impostazioni (Settings) → POP3 & IMAP**.
3. Attiva l'opzione "Invia e ricevi email tramite programmi esterni"
   (in inglese: "Send and receive emails via external program"/"Enable
   POP3/IMAP access").
4. Da questo momento l'IMAP host è `imap.gmx.com` (o `imap.mail.com` se
   hai scelto mail.com), porta `993` — segnati quale dei due hai usato,
   ti serve al punto 7.4.

### 7.2bis Se invece usi Gmail: genera una "app password" IMAP

Gmail non permette di usare la password normale per IMAP, richiede una
password dedicata:

1. Sul nuovo account, vai su **myaccount.google.com/security** e attiva
   la **verifica in due passaggi** (obbligatoria per generare app
   password).
2. Poi vai su **myaccount.google.com/apppasswords**, crea una nuova app
   password (nome libero, es. "PhD Tracker"), e copia il codice di 16
   caratteri che ti mostra — è quella la password da usare, non quella
   del tuo account.

### 7.3 Imposta gli alert nativi su questo nuovo indirizzo

- **EURAXESS**: vai su [euraxess.ec.europa.eu/jobs/search](https://euraxess.ec.europa.eu/jobs/search),
  imposta i filtri che ti interessano (materia, paese...), cerca l'opzione
  per salvare la ricerca / ricevere un alert via email (nella loro
  interfaccia, di solito vicino ai risultati di ricerca) e usa il nuovo
  indirizzo email dedicato.
- **FindAPhD**: vai su [findaphd.com/phds](https://www.findaphd.com/phds/),
  imposta i filtri, usa la funzione **"Save search"** e attiva la
  notifica email, sempre sul nuovo indirizzo dedicato.

### 7.4 Aggiungi le credenziali come GitHub Secrets

Nel repository, **Settings → Secrets and variables → Actions → New
repository secret**, aggiungi:

- `IMAP_USER`: l'indirizzo email dedicato (es.
  `tuonome.phdalerts@gmx.com`)
- `IMAP_PASSWORD`: con GMX/mail.com la normale password dell'account; con
  Gmail l'app password di 16 caratteri del punto 7.2bis (**non** la
  password normale dell'account)
- `IMAP_HOST`: con GMX metti `imap.gmx.com`, con mail.com `imap.mail.com`.
  Con Gmail puoi ometterlo (viene usato `imap.gmail.com` automaticamente).

Queste credenziali non finiscono mai nel codice pubblico del repository:
restano solo nei Secrets, visibili solo alle Actions durante l'esecuzione.

### 7.5 Attiva la fonte in `config/config.json`

Apri `config/config.json` e cambia:

```json
"mailAlerts": {
  "enabled": false
}
```

in:

```json
"mailAlerts": {
  "enabled": true
}
```

Dal controllo automatico successivo (entro 6 ore, o forza subito col
punto 12), lo script si collega alla casella, legge le email non lette che
contengono link a un annuncio EURAXESS o FindAPhD, le fa comparire
nell'app esattamente come le altre fonti (con notifica ntfy inclusa), e le
segna come lette per non rileggerle al giro successivo.

**Formato EURAXESS confermato**: dopo aver visto un esempio reale di email
"New results for your saved search" di EURAXESS, l'estrazione ora è
specifica per il loro formato (un elenco puntato con il titolo
dell'annuncio seguito dalla URL sulla riga successiva) e riconosce
correttamente ogni annuncio con titolo e link giusti, ignorando i link di
gestione/disiscrizione in fondo all'email. Per FindAPhD il template esatto
non è ancora stato verificato: l'estrazione resta quella generica (cerca i
link il cui indirizzo corrisponde al formato stabile di un singolo annuncio,
`findaphd.com/phds/project/...`) — non estrae automaticamente scadenza o
paga da queste email (compariranno senza quei dettagli). Se dopo aver
attivato FindAPhD non vedi comparire nulla pur ricevendo le email, mandami
un esempio (anche con dati anonimizzati) così sistemo l'estrazione anche
per quel formato.

**Attenzione all'indirizzo email usato per il "save search"**: l'alert va
impostato sull'indirizzo dedicato (es. `tuonome.phdalerts@gmx.com`), **non**
sulla tua email personale — altrimenti l'email arriva dove lo script non
legge mai, e sembrerà che "non funzioni" anche se in realtà è tutto
configurato correttamente. Se hai già impostato un alert e non sei
sicuro su quale indirizzo arrivi, vai su
[euraxess.ec.europa.eu/my/saved-searches](https://euraxess.ec.europa.eu/my/saved-searches)
e controlla/correggi l'indirizzo associato alla ricerca salvata.

---

## 8. Città riconosciute automaticamente (anche per dottorati condivisi tra più sedi)

Oltre al paese, lo script confronta il testo di ogni annuncio con un elenco
di circa 200 tra le principali città universitarie/capitali europee
(`scripts/check.mjs`, costante `CITIES`) per mostrare il luogo "in chiaro"
sulla card, non solo il paese.

A differenza della versione precedente, ora vengono cercate **tutte** le
città riconosciute nel testo, non solo la prima — pensato apposta per i
dottorati condivisi tra più sedi (tipici delle reti **MSCA Doctoral
Networks** e dei dottorati in cotutela), che spesso elencano più università
in più paesi. Se ne trova più di una, le mostra tutte separate da virgola,
con il paese tra parentesi accanto a ciascuna quando sono in paesi diversi
— es. "Bologna (Italy), Groningen (Netherlands), Berlin (Germany)".

Il confronto è **case-sensitive** (richiede l'iniziale maiuscola): diverse
città coincidono con parole inglesi comuni (es. "split", "nice"), e
richiedere la maiuscola riduce molto i falsi positivi (una frase come "the
position is split between two campuses" non fa scattare nulla, ma "Split,
Croatia" sì). Per lo stesso motivo alcune città sono state escluse di
proposito dall'elenco perché ambigue anche da maiuscole — "Nice", "Bath",
"Reading", "York" (sottostringa di "New York"), "Nancy" (nome di persona),
"Tours": per queste si può ancora ottenere un risultato tramite il vecchio
metodo di riserva (ricerca "Città, Paese" nel testo), ma con affidabilità
minore.

Se una città che ti interessa non compare mai riconosciuta, puoi
aggiungerla tu stesso all'elenco `CITIES` in `scripts/check.mjs` (formato
`["NomeCittà", "NomePaese"]`, il nome del paese deve corrispondere a uno di
quelli usati altrove nel file, es. "Italy", "Netherlands").

**Università/enti noti** (`scripts/check.mjs`, costante `INSTITUTIONS`):
molti annunci — soprattutto quelli di reti MSCA/consorzi — nominano
l'ateneo o l'ente (es. "Sapienza", "ETH Zürich", "Sorbonne", "CERN", la
**Helmholtz Association**) ma non
sempre la città in modo esplicito. Un secondo elenco di circa 50 istituzioni
europee comuni riconduce questi nomi alla città (o al paese, se l'ente non
ha una sede unica) corrispondente, e si somma a quelle già trovate tramite
`CITIES` — utile in particolare per i dottorati condivisi dove magari una
sede è nominata per città e un'altra solo per nome di ateneo. Anche questo
elenco è ampliabile allo stesso modo: aggiungi una riga `["NomeIstituzione",
"Città", "Paese"]`.

---

## 9. Mappa dei dottorati che ti interessano

In fondo alla pagina, sopra "Fonti da controllare manualmente", trovi una
**mappa del mondo minimale** (in stile chiaro o scuro, con un pulsante per
alternare) con un segnaposto per ogni annuncio segnato come **"Ti
interessa"** (vedi punto 6) e per cui è stato riconosciuto un luogo — città
o, quando non c'è una città precisa, almeno il paese (es. gli annunci di
reti/associazioni senza una sede unica, come la **Helmholtz Association**,
mostrano un segnaposto al centro della Germania).

Toccando un segnaposto si apre un fumetto con titolo, luogo e un link che
apre l'annuncio originale in una nuova scheda — la mappa non serve solo per
farsi un'idea geografica dei dottorati, ma anche come scorciatoia per
tornarci sopra rapidamente. Se non hai ancora segnato nessun annuncio come
"Ti interessa" (o nessuno di quelli segnati ha un luogo riconosciuto),
compare un messaggio invece della mappa vuota.

**Come funziona tecnicamente**: la mappa usa [Leaflet](https://leafletjs.com)
(libreria open source, caricata da CDN) con le mappe di sfondo minimali di
[CARTO](https://carto.com) (varianti chiaro/scuro, gratuite e senza chiave
API per un uso personale come questo). Le coordinate di ogni luogo sono
approssimative — città/paese, non l'indirizzo esatto dell'ateneo — pensate
solo per posizionare un segnaposto su una mappa, non per navigazione di
precisione. **Richiede una connessione a Internet** per caricare la
libreria e le mappe di sfondo (come già il resto dei dati dell'app): offline
compare il messaggio informativo al posto della mappa, senza errori.

---

## 10. Esportare e importare le preferenze (interesse, filtri)

In fondo alla pagina, sezione **"Preferenze (interesse, filtri)"**, trovi
due pulsanti:

- **Esporta preferenze**: scarica un file `.json` con tutto quello che hai
  impostato su questo dispositivo — quali annunci hai segnato
  interessa/non interessa, il filtro materia/paese/stato attivo, la
  ricerca testuale, il toggle "solo novità".
- **Importa preferenze**: carica un file esportato in precedenza (da questo
  stesso dispositivo o da un altro) e lo applica subito, senza bisogno di
  ricaricare la pagina.

Serve perché queste preferenze vivono solo nella memoria del browser
(`localStorage`) di questo dispositivo, come già spiegato al punto 6: non
sono nel repository, quindi normalmente andrebbero perse se cambi telefono
o cancelli i dati del browser. Esportando puoi:

- portarle su un altro dispositivo (es. dal telefono al tablet, o su un
  telefono nuovo);
- farne un backup prima di cancellare i dati di Safari;
- tenerne più copie nel tempo, se vuoi.

Il file esportato contiene solo le tue preferenze (etichette
interessa/scartato, filtri) — non contiene l'elenco degli annunci in sé
(quello arriva sempre da `data/listings.json`, aggiornato automaticamente).
Se il file che importi non è valido o non è stato esportato da questa app,
compare un messaggio d'errore sotto ai pulsanti e non viene applicato
nulla.

---

## 11. Cambiare la frequenza di controllo

Modifica la riga `cron` in `.github/workflows/check.yml`. Esempi:

- ogni 6 ore (default): `0 */6 * * *`
- una volta al giorno alle 8:00 UTC: `0 8 * * *`
- ogni 12 ore: `0 */12 * * *`

(GitHub Actions usa sempre l'orario UTC, due ore indietro rispetto
all'ora italiana estiva.)

---

## 12. Testare subito, senza aspettare

Vai su **Actions** (in alto nel repository) → clicca sul workflow
"Controllo bandi dottorato" → **Run workflow** → **Run workflow**. Parte
subito, in genere impiega meno di un minuto.

La **primissima esecuzione** popola l'elenco ma non manda notifiche (serve
a creare una base di partenza, altrimenti riceveresti decine di notifiche
tutte insieme per annunci che magari sono lì da mesi). Da quella successiva
in poi, ricevi una notifica solo per le novità vere.

---

## 13. Limiti noti (onestamente)

- **EURAXESS** e **FindAPhD** non vengono raschiati direttamente dal sito:
  il loro `robots.txt` chiede esplicitamente ai crawler di non farlo, e ho
  preferito rispettarlo. Restano comunque linkati in fondo alla pagina per
  impostare i loro alert nativi via email — e se non vuoi controllarli a
  mano, puoi collegare quegli alert alla stessa app/notifica tramite una
  casella email dedicata (vedi punto 7).
- **jobs.ac.uk** copre in modo molto solido il Regno Unito e in modo
  discreto il resto d'Europa (molte università europee vi pubblicano
  annunci in inglese), ma non è esaustivo per bandi pubblicati solo in
  lingua locale. Il loro sistema di feed RSS ogni tanto risponde con
  errore 500 anche su indirizzi corretti (sembra un problema
  intermittente lato loro, riscontrato anche testando manualmente): lo
  script ora ritenta automaticamente una volta dopo qualche secondo, ma
  se il loro servizio è giù non c'è molto altro da fare — controlla i log
  di un'esecuzione successiva, di solito si risolve da solo.
- **phdportal.com** blocca attivamente le richieste automatiche (risposta
  403), nonostante il loro `robots.txt` non lo vietasse esplicitamente:
  è disattivato di default (`sources.phdPortalSubjects: []`).
- **academicpositions.com**, **academictransfer.com**, **phdportal.com**,
  **jobrxiv.org** e **bandi.mur.gov.it** non offrono un feed ufficiale
  strutturato per queste ricerche: lo script legge la pagina HTML
  cercando i link agli annunci con un criterio abbastanza robusto (basato
  sul pattern stabile dell'URL di ciascun annuncio, non su classi CSS che
  cambiano spesso). Se uno di questi siti cambia struttura in modo
  sostanziale, quella fonte potrebbe smettere di restituire risultati
  finché non si aggiorna il selettore corrispondente in
  `scripts/check.mjs` — **jobs.ac.uk via RSS invece è molto più stabile
  nel tempo** perché usa un feed ufficiale. Se una fonte smette di
  funzionare, i log dell'esecuzione su GitHub Actions (tab *Actions* →
  ultima esecuzione) mostrano un avviso `⚠️` con il nome della fonte.
- **Le scadenze (`deadlineISO`/badge "SCADE TRA...")** sono estratte
  automaticamente dal testo dell'annuncio quando il formato è
  riconoscibile (poche varianti coperte: inglese "Closing on:",
  "Deadline", "Closes", e italiano "scade il"). Se il sito usa un formato
  diverso, l'annuncio compare comunque ma senza scadenza evidenziata —
  meglio non mostrare una data che rischiare di mostrarne una sbagliata.
- **Il paese/città** viene riconosciuto cercando nel testo dell'annuncio le
  città dell'elenco `CITIES` e le istituzioni dell'elenco `INSTITUTIONS`
  (vedi punto 8), con il vecchio metodo "Città, Paese" come ultima riserva
  se non trova corrispondenze in nessuno dei due. Per AcademicTransfer e
  bandi.mur.gov.it il paese è comunque impostato automaticamente
  (rispettivamente Paesi Bassi e Italia, fonti mono-paese). Se un annuncio
  non nomina né una città né un'istituzione riconosciuta, il luogo resta
  vuoto invece di rischiare di mostrare qualcosa di sbagliato. Il filtro
  per paese nel menu Filtri compare solo quando l'app ha riconosciuto
  almeno due paesi diversi tra gli annunci raccolti.
- **La paga indicativa (💰)** è anch'essa estratta dal testo (simboli
  £/$/€, o "fully funded" quando non c'è una cifra) e mostrata così
  com'è, **senza conversione di valuta** — confrontare cifre in valute
  diverse va fatto a occhio. Se l'annuncio non menziona un importo da
  nessuna parte, semplicemente non compare nulla.
- **Gli alert email (punto 7)**: quelli di EURAXESS sono riconosciuti in
  modo specifico sul loro formato reale (titolo + link). Quelli di
  FindAPhD, il cui formato non è ancora stato verificato su un esempio
  reale, restano letti in modo generico (cerco solo link che puntano a un
  singolo annuncio) e non estraggono scadenza o paga — se non restituiscono
  nulla dopo averli attivati, controlla i log di GitHub Actions.

---

## 14. Struttura del progetto

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

## 15. Aggiungere l'app alla schermata Home (iPhone)

1. Apri `https://TUO-USERNAME.github.io/phd-tracker/` in **Safari** (deve
   essere Safari, non Chrome, perché su iOS solo Safari può installare
   PWA).
2. Tocca l'icona di condivisione (il quadrato con la freccia in su).
3. Scorri e tocca **Aggiungi a Home**.

Da quel momento hai un'icona come una app vera, che apre la pagina a
schermo intero.
