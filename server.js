const express = require('express');
const https = require('https');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));   // i lotti dei perimetri OMI possono essere pesanti

const mongoURI = process.env.MONGO_URI;
if (!mongoURI) {
  console.error('ERRORE CRITICO: La variabile MONGO_URI non è configurata su Render!');
}
if (!process.env.GEMINI_API_KEY) {
  console.error('ATTENZIONE: La variabile GEMINI_API_KEY non è configurata su Render — l\'Assistente CRM non funzionerà.');
}
if (!process.env.GOOGLE_MAPS_API_KEY_SERVER) {
  console.error('ATTENZIONE: La variabile GOOGLE_MAPS_API_KEY_SERVER non è configurata su Render — la geocodifica indirizzi non funzionerà.');
}

mongoose.connect(mongoURI)
  .then(() => {
    console.log('Database MongoDB Cloud Connesso con Successo!');
    impostaBrokerPredefinito();
  })
  .catch((err) => console.error('Errore critico di connessione DB:', err));

/* Al primo avvio dopo l'introduzione dei ruoli, Alessandro Forte diventa il Broker
   dell'agenzia: e' l'unico ruolo che puo' governare le autorizzazioni degli altri.
   Se un Broker esiste gia' non tocca niente. */
async function impostaBrokerPredefinito() {
  try {
    const brokerEsistente = await Consulente.findOne({ ruolo: 'Broker' });
    if (brokerEsistente) return;
    const forte = await Consulente.findOne({ nomeCognome: /alessandro\s*forte/i });
    if (!forte) {
      console.log('Nessun Broker impostato: scheda di Alessandro Forte non trovata.');
      return;
    }
    forte.ruolo = 'Broker';
    if (!forte.percentualeProvvigione) forte.percentualeProvvigione = '100';
    await forte.save();
    console.log(`Ruolo Broker assegnato a ${forte.nomeCognome} (${forte.utente}).`);
  } catch (err) {
    console.error('Impossibile impostare il Broker predefinito:', err.message);
  }
}

/* ==========================================
   1. MODELLI DATABASE CORE (CONSULENTI & TASK)
========================================== */
const ConsulenteSchema = new mongoose.Schema({
  nomeCognome: { type: String, required: true },
  telefono: { type: String, default: '' },
  mail: { type: String, default: '' },
  idTelegram: { type: String, default: '' },
  idWhatsapp: { type: String, default: '' },
  fotoProfilo: { type: String, default: '' },
  utente: { type: String, unique: true, required: true, trim: true },
  pass: { type: String, default: '' },
  ruolo: { type: String, default: 'Junior Assistant' },
  percentualeProvvigione: { type: String, default: '' },  // se vuoto vale quella del ruolo
  areeVisibili: { type: [String], default: [] },
  consulentiVisibili: { type: [String], default: [] }
}, { timestamps: true });
const Consulente = mongoose.model('Consulente', ConsulenteSchema);

const TodoSchema = new mongoose.Schema({
  data: { type: String, required: true, default: '20/07/2026' },
  task: { type: String, required: true },
  consulente: { type: String, default: '' },
  stato: { type: String, default: 'Attivo' },
  note: { type: String, default: '' },
  /* Campi delle attivita' generate dal CRM: origine identifica la riga che l'ha creata,
     cosi' non si duplica e si chiude da sola quando il motivo viene meno. */
  origine: { type: String, default: '' },
  automatica: { type: Boolean, default: false },
  priorita: { type: String, default: 'Normale' },
  scadenza: { type: String, default: '' },   // formato aaaa-mm-gg, per ordinare
  collegamento: { type: String, default: '' }
}, { timestamps: true });
const Todo = mongoose.model('Todo', TodoSchema);

/* ==========================================
   MODELLI DI ATTIVITA'
   Regole del tipo "quando succede X, crea l'attivita' Y e assegnala a Z".
   Stanno sul database e si modificano dal CRM: cambiando processo non si tocca il codice.
========================================== */
const ModelloTaskSchema = new mongoose.Schema({
  evento: { type: String, default: 'incarico' },   // incarico | preliminare | rogito | provvigione
  testo: { type: String, default: '' },
  assegnatario: { type: String, default: '' },     // username del consulente
  giorni: { type: Number, default: 0 },            // giorni dall'evento (negativi = in anticipo)
  priorita: { type: String, default: 'Normale' },
  attivo: { type: Boolean, default: true },
  ordine: { type: Number, default: 0 }
}, { timestamps: true });
const ModelloTask = mongoose.model('ModelloTask', ModelloTaskSchema);

/* Regole di partenza: si scrivono una volta sola, poi comandano quelle salvate */
const MODELLI_TASK_STANDARD = [
  { evento: 'incarico',    testo: 'Fare il servizio fotografico',                              nomeAssegnatario: 'Alessandro Forte', giorni: 3, priorita: 'Alta' },
  { evento: 'incarico',    testo: 'Editing e post-produzione delle foto',                      nomeAssegnatario: 'Giuseppe Mazzeo',  giorni: 5, priorita: 'Normale' },
  { evento: 'incarico',    testo: 'Antiriciclaggio: adeguata verifica del venditore',          nomeAssegnatario: 'Arianna Mazzeo',   giorni: 2, priorita: 'Alta' },
  { evento: 'preliminare', testo: 'Antiriciclaggio: adeguata verifica per il preliminare',     nomeAssegnatario: 'Arianna Mazzeo',   giorni: 0, priorita: 'Alta' },
  { evento: 'rogito',      testo: 'Antiriciclaggio: verifica finale al rogito',                nomeAssegnatario: 'Arianna Mazzeo',   giorni: 0, priorita: 'Alta' },
  { evento: 'provvigione', testo: 'Preparare la fattura della provvigione',                    nomeAssegnatario: 'Arianna Mazzeo',   giorni: -3, priorita: 'Alta' }
];

async function seminaModelliTask() {
  try {
    if (await ModelloTask.countDocuments() > 0) return;
    const consulenti = await Consulente.find({});
    const trovaUtente = (nome) => {
      const c = consulenti.find(x => (x.nomeCognome || '').trim().toLowerCase() === nome.trim().toLowerCase());
      return c ? c.utente : '';
    };
    await ModelloTask.insertMany(MODELLI_TASK_STANDARD.map((m, i) => ({
      evento: m.evento, testo: m.testo, giorni: m.giorni, priorita: m.priorita,
      assegnatario: trovaUtente(m.nomeAssegnatario), attivo: true, ordine: i
    })));
    console.log('Modelli di attivita inizializzati.');
  } catch (err) { console.error('Modelli attivita non inizializzati:', err.message); }
}

app.get('/api/modelli-task', async (req, res) => {
  try {
    await seminaModelliTask();
    res.status(200).json(await ModelloTask.find({}).sort({ evento: 1, ordine: 1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/modelli-task', async (req, res) => {
  try { res.status(201).json({ status: 'success', data: await new ModelloTask(req.body).save() }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/modelli-task/:id', async (req, res) => {
  try {
    const payload = (req.body && req.body.campo !== undefined) ? { [req.body.campo]: req.body.valore } : req.body;
    const aggiornato = await ModelloTask.findByIdAndUpdate(req.params.id, { $set: payload }, { new: true });
    if (!aggiornato) return res.status(404).json({ error: 'Modello non trovato' });
    res.status(200).json({ status: 'success', data: aggiornato });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/modelli-task/:id', async (req, res) => {
  try { await ModelloTask.findByIdAndDelete(req.params.id); res.status(200).json({ status: 'success' }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

/* ==========================================
   2. MODELLO TARGET & BUDGET (OBY)
========================================== */
const ObyBudgetSchema = new mongoose.Schema({
  consulente: { type: String, required: true, unique: true },
  percentualeProvvigione: { type: Number, default: 40 },
  guadagnoNettoDesiderato: { type: Number, default: 30000 },
  lordoFatturareAgenzia: { type: Number, default: 75000 },
  immobiliDaVendere: { type: Number, default: 0 },
  immobiliDaAcquisire: { type: Number, default: 0 },
  cdv2Necessarie: { type: Number, default: 0 },
  cdv1Necessarie: { type: Number, default: 0 },
  notizieNecessarie: { type: Number, default: 0 },
  kpi: { type: mongoose.Schema.Types.Mixed, default: {} },  // parametri del funnel, modificabili dal consulente
  kpiPartenza: { type: mongoose.Schema.Types.Mixed, default: {} }, // fotografia dei KPI all'avvio del monitoraggio
  dataInizioMonitoraggio: { type: String, default: '' },
  dataFineMonitoraggio: { type: String, default: '' }
}, { timestamps: true });
const ObyBudget = mongoose.model('ObyBudget', ObyBudgetSchema);

/* ==========================================
   3. MODELLO STRADARIO LIVE CLOUD E COPERTURA
========================================== */
const StradarioSchema = new mongoose.Schema({
  comune: { type: String, required: true, unique: true },
  ultimoCensimento: { type: String, default: '' },   // aaaa-mm-gg dell'ultima ricognizione dichiarata
  censitoDa: { type: String, default: '' },
  provincia: { type: String, default: 'MI' },
  abitanti: { type: String, default: 'N.D.' },
  subalterniTotali: { type: Number, default: 5000 },
  vie: [
    {
      nome: { type: String, required: true },
      zone: { type: String, default: 'CENTRO' },
      /* quando si e' ripassata questa via: si ricensisce la via, non il
         comune intero, e la data sul comune non diceva niente di utile */
      ultimoPassaggio: { type: String, default: '' },
      passatoDa: { type: String, default: '' },
      civici: [
        {
          numero: { type: String, required: true },
          note: { type: String, default: '' },
          contestoCivico: { type: String, default: 'Palazzina' },
          /* i dati dello stabile: raccolti stando davanti al portone */
          annoCostruzione: { type: String, default: '' },   // fascia di dieci anni
          statoStabile: { type: Number, default: 0 },       // da zero a tre stelle
          amministratore: { type: String, default: '' },
          foglio: { type: String, default: '' },
          particella: { type: String, default: '' },
          citofoni: [
            {
              nome: { type: String, default: '' },
              /* a quale unita' da visura corrisponde, e cosa e' successo
                 quando si e' provato a contattarlo */
              unitaVisura: { type: String, default: '' },   // il sub collegato
              attivita: { type: Array, default: [] },       // [{tipo, quando, nota}]
              statoProprietario: { type: String, default: '' },
              piano: { type: String, default: '' },
              vani: { type: String, default: '' },
              sub: { type: String, default: '' },
              mq: { type: String, default: '' },
              nomeCognomeCf: { type: String, default: '' },
              nomeCognomeAnno: { type: String, default: '' },
              gruppiCollegatiIds: { type: [String], default: [] }
            }
          ],
          proprietariNonResidenti: [
            {
              _id: { type: mongoose.Schema.Types.ObjectId, default: () => new mongoose.Types.ObjectId() },
              piano: { type: String, default: '' },
              vani: { type: String, default: '' },
              sub: { type: String, default: '' },
              mq: { type: String, default: '' },
              proprietari: [
                {
                  _id: { type: mongoose.Schema.Types.ObjectId, default: () => new mongoose.Types.ObjectId() },
                  nomeCognome: { type: String, default: '' },
                  cf: { type: String, default: '' },
                  annoNascita: { type: String, default: '' },
                  /* data e luogo per esteso: dalla visura si leggono, e servono
                     per il preliminare senza doverli ricercare */
                  dataNascita: { type: String, default: '' },
                  luogoNascita: { type: String, default: '' }
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}, { timestamps: true });
const Stradario = mongoose.model('Stradario', StradarioSchema);

/* ==========================================
   4. MODELLO CONCORRENZA MANUALE ED EXCEL
========================================== */
const ConcorrenzaSchema = new mongoose.Schema({
  consulente: { type: String, default: '' },   // username del consulente a cui e' assegnata la riga
  titolo: { type: String, required: true },
  comune: { type: String, default: '' }, // per filtrare la Concorrenza per comune/zona
  via: { type: String, default: '' }, // collegata (con suggerimenti) allo Stradario
  paeseVia: { type: String, required: true },
  civico: { type: String, default: 'N.D.' },
  contesto: { type: String, default: 'Residenziale' },
  unita: { type: String, default: 'Appartamento' },
  piano: { type: String, default: 'Intermedio' },
  bagni: { type: String, default: '1' },
  prezzo: { type: String, required: true },
  agenzia: { type: String, default: 'Concorrente' },
  agenziaId: { type: String, default: '' },
  privato: { type: String, default: '' }, // '' (agenzia) | 'VDP' | 'VDP NO NUMERO'
  statoSviluppo: { type: String, default: 'Informazione' }, // Informazione | Individuato proprietario | Opportunity
  dataAnnuncio: { type: String, default: '20/07/2026' },
  link: { type: String, default: '' },
  idImmobiliare: { type: String, default: '' }, // id numerico dell'annuncio su immobiliare.it: chiave stabile per riconoscere i doppioni
  mq: { type: Number, default: null },          // superficie in mq, presa dallo scraping (prima l'archivio non la registrava)
  dataUltimoMonitoraggio: { type: String, default: '' }, // gg/mm/aaaa dell'ultima scansione automatica che ha rivisto l'annuncio
  statoAnnuncio: { type: String, default: 'Attivo' }, // 'Attivo' | 'Ritirato' | 'Venduto' (modificabile a mano dalla tabella)
  lat: { type: Number, default: null },  // coordinate calcolate una volta sola e riusate dalla mappa
  lng: { type: Number, default: null }
}, { timestamps: true });
const Concorrenza = mongoose.model('Concorrenza', ConcorrenzaSchema);

/* ==========================================
   SCHEMI: AGENZIE E AGENTI IMMOBILIARI (Capitale Sociale)
   Un'agenzia ha molti agenti collegati tramite agenziaId.
========================================== */
const AgenziaImmobiliareSchema = new mongoose.Schema({
  nomeAgenzia: { type: String, required: true },
  sede: { type: String, default: '' },
  mail: { type: String, default: '' },
  telefono: { type: String, default: '' }
}, { timestamps: true });
const AgenziaImmobiliare = mongoose.model('AgenziaImmobiliare', AgenziaImmobiliareSchema);

const AgenteImmobiliareSchema = new mongoose.Schema({
  nomeCognome: { type: String, required: true },
  telefono: { type: String, default: '' },
  mail: { type: String, default: '' },
  agenziaId: { type: String, default: '' }
}, { timestamps: true });
const AgenteImmobiliare = mongoose.model('AgenteImmobiliare', AgenteImmobiliareSchema);

app.get('/api/agenzie-immobiliari', async (req, res) => {
  try { res.status(200).json(await AgenziaImmobiliare.find({}).sort({ nomeAgenzia: 1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/agenzie-immobiliari', async (req, res) => {
  try { res.status(201).json(await new AgenziaImmobiliare(req.body).save()); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/agenzie-immobiliari/:id', async (req, res) => {
  try {
    const aggiornato = await AgenziaImmobiliare.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    if (!aggiornato) return res.status(404).json({ error: 'Agenzia non trovata' });
    res.status(200).json(aggiornato);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/agenzie-immobiliari/:id', async (req, res) => {
  try {
    await AgenziaImmobiliare.findByIdAndDelete(req.params.id);
    res.status(200).json({ status: 'success' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/agenti-immobiliari', async (req, res) => {
  try { res.status(200).json(await AgenteImmobiliare.find({}).sort({ nomeCognome: 1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/agenti-immobiliari', async (req, res) => {
  try { res.status(201).json(await new AgenteImmobiliare(req.body).save()); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/agenti-immobiliari/:id', async (req, res) => {
  try {
    const aggiornato = await AgenteImmobiliare.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    if (!aggiornato) return res.status(404).json({ error: 'Agente non trovato' });
    res.status(200).json(aggiornato);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/agenti-immobiliari/:id', async (req, res) => {
  try {
    await AgenteImmobiliare.findByIdAndDelete(req.params.id);
    res.status(200).json({ status: 'success' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================
   4b. MODELLO CENTRALINO (REGISTRO CHIAMATE) MANUALE ED EXCEL
========================================== */
const CentralinoSchema = new mongoose.Schema({
  consulente: { type: String, default: '' },   // username del consulente a cui e' assegnata la riga
  nome: { type: String, required: true },
  tipoRichiesta: { type: String, default: 'Mail Richiesta Specifica' },
  stato: { type: String, default: 'Da Fare' },
  telefonoCliente: { type: String, default: '' },
  emailCliente: { type: String, default: '' },
  whatsappInviato: { type: String, default: '' },
  messaggioCliente: { type: String, default: '' },
  incaricoCollegatoId: { type: String, default: '' },
  /* da quale mail nasce questa riga: serve a non crearla due volte quando
     la stessa mail arriva dalla notifica e dal controllo di riserva */
  idMailOrigine: { type: String, default: '', index: true },
  portaleOrigine: { type: String, default: '' },
  riferimentoImmobile: { type: String, default: '' },
  indirizzoImmobile: { type: String, default: '' },
  descrizioneImmobile: { type: String, default: '' },
  consulenteRiferimento: { type: String, default: '' },
  cellConsulente: { type: String, default: '' },
  linkCalendar: { type: String, default: '' },
  linkImmobile: { type: String, default: '' },
  linkWhatsapp: { type: String, default: '' },
  portale: { type: String, default: '' },
  dataRichiesta: { type: String, default: '' },
  tgConsInviato: { type: String, default: '' },
  /* quando e' partito davvero. Serve a non rimandarlo ogni volta che la riga
     viene risalvata: la colonna dice "Inviato" anche dopo, e senza questo
     ogni modifica farebbe partire un altro messaggio. */
  tgInviatoIl: { type: Date, default: null },
  mexInviatoIl: { type: Date, default: null },
  mexClienteInviato: { type: String, default: '' }
}, { timestamps: true });
/* L'automazione parte quando la riga nasce, da qualunque parte arrivi: dal
   modulo del telefono, da una mail, o scritta a mano. I ganci vanno messi
   prima che il modello nasca, altrimenti mongoose non li vede. Le funzioni
   che servono sono definite piu' avanti nel file: vengono chiamate dentro
   setImmediate, quindi a quel punto ci sono gia'. */
CentralinoSchema.pre('save', function (next) {
  this.eraNuova = this.isNew;
  next();
});

/* Per ora l'invio non parte alla creazione: lo comanda chi mette la colonna
   "Tg Cons Inviato" su Inviato, come faceva lo scenario su Make. Cosi' si
   sceglie riga per riga finche' non ci si fida dell'automatismo. */

const Centralino = mongoose.model('Centralino', CentralinoSchema);

/* ==========================================
   4d. MODELLO BANCA DATI (RICHIESTE CLIENTI ACQUIRENTI)
   Creato automaticamente quando un item del Centralino diventa "Completo",
   e gestibile anche manualmente.
========================================== */
const BancaDatiSchema = new mongoose.Schema({
  consulente: { type: String, default: '' },   // username del consulente a cui e' assegnata la riga
  nomeCognome: { type: String, required: true },
  mail: { type: String, default: '' },
  telefono: { type: String, default: '' },
  immobileFonteRichiesta: { type: String, default: '' }, // idElemento dell'incarico collegato
  comuniRicerca: { type: [String], default: [] },
  tipologiaContesto: { type: [String], default: [] },
  tipologiaUnita: { type: [String], default: [] },
  budgetAcquisto: { type: String, default: '' },
  mutuo: { type: String, default: '' },
  importoMutuo: { type: String, default: '' },
  deveVendere: { type: String, default: '' },
  scadenzaAcquistoIdeale: { type: String, default: '' },
  statoAdvFix: { type: String, default: 'Da Fix' },
  centralinoOrigineId: { type: String, default: '' } // evita duplicati quando un item torna "Completo"
}, { timestamps: true });
const BancaDati = mongoose.model('BancaDati', BancaDatiSchema);

/* ==========================================
   4e. MODELLO VISIONI (FEEDBACK VISITE IMMOBILE)
   Creato automaticamente quando un item di Banca Dati passa a Stato ADV FIX = "Fissato".
========================================== */
const VisioniSchema = new mongoose.Schema({
  consulente: { type: String, default: '' },   // username del consulente a cui e' assegnata la riga
  nomeCognome: { type: String, required: true },
  telefono: { type: String, default: '' },
  mail: { type: String, default: '' },
  incaricoUfficio: { type: String, default: '' }, // idElemento dell'incarico collegato
  feedbackAdv: { type: String, default: '' }, // Interessa | Valuta | Non Interessa
  testoFeedback: { type: String, default: '' },
  valorePercepito: { type: String, default: '' },
  dataVisione: { type: String, default: '' },   // giorno dell'appuntamento, spostabile dal calendario
  oraVisione: { type: String, default: '' },
  bancaDatiOrigineId: { type: String, default: '' }, // evita duplicati quando l'item torna "Fissato"
  /* Lo stato dell'appuntamento: fissato non vuol dire fatto, e sapere quanti
     ne saltano e' un dato che serve. */
  statoAdv: { type: String, default: 'Fissato' },     // Fissato | Fatto | Saltato
  statoProposta: { type: String, default: 'No' },     // Fatta Proposta | No
  propostaCreata: { type: Boolean, default: false }
}, { timestamps: true });
const Visioni = mongoose.model('Visioni', VisioniSchema);

const PropostaSchema = new mongoose.Schema({
  consulente: { type: String, default: '' },   // username del consulente a cui e' assegnata la riga
  nomeCognome: { type: String, default: '' },
  telefono: { type: String, default: '' },
  mail: { type: String, default: '' },
  incaricoUfficio: { type: String, default: '' }, // idElemento dell'incarico collegato
  visioneOrigineId: { type: String, default: '' }, // la Visione da cui è stata creata
  dataPresaProposta: { type: String, default: '' },
  dataScadenza: { type: String, default: '' },
  vincolo: { type: String, default: 'no' }, // 'si' | 'no'
  vincoloSpecifica: { type: String, default: '' },
  vincoloDataFine: { type: String, default: '' },
  prezzoIncarico: { type: String, default: '' },
  prezzoProposta: { type: String, default: '' },
  percentualeSconto: { type: Number, default: 0 },
  percentualeChiusura: { type: Number, default: 100 },
  provvigioneAcquirente: { type: String, default: '' },
  percentualeProvvigione: { type: Number, default: 0 },
  caparra: { type: String, default: '' },                  // assegno alla sottoscrizione
  accontoPreliminare: { type: String, default: '' },       // bonifico al preliminare
  dataPreliminare: { type: String, default: '' },
  composizioneImmobile: { type: String, default: '' },     // es. "APPARTAMENTO + CANTINA"
  statoImmobileProposta: { type: String, default: '' },    // occupato | libero al rogito | locato
  statoProposta: { type: String, default: 'In Corso' },     // In Corso | Accettata (Vincolata) | Accettata (No Vincolo) | Rifiutata | Scaduta
  esitoVincolo: { type: String, default: '' },              // svincolata | buon-fine | decaduta
  statoAttuale: { type: String, default: 'Preliminare da fare' }, // avanzamento post-accettazione
  provvVenditoreStato: { type: String, default: 'Da incassare' },
  provvVenditoreScadenza: { type: String, default: '' },
  provvAcquirenteStato: { type: String, default: 'Da incassare' },
  provvAcquirenteScadenza: { type: String, default: '' },
  /* Mongoose scarta in silenzio i campi non dichiarati: se un dato non e' qui,
     al salvataggio sparisce senza dire niente. Servono anche i dati di nascita,
     che finiscono nel preliminare. */
  acquirenti: { type: [{ nome: String, codiceFiscale: String, allegatoDocumento: String,
                         dataNascita: String, luogoNascita: String, sesso: String,
                         residenza: String }], default: [] },
  dataRogito: { type: String, default: '' },
  dataConsegnaImmobile: { type: String, default: '' },
  noteVarie: { type: String, default: '' }
}, { timestamps: true });
const Proposta = mongoose.model('Proposta', PropostaSchema);

/* ==========================================
   4f. MODELLO TRANSAZIONI
   Creato in automatico quando una Proposta passa a stato "Accettata".
========================================== */
const TransazioneSchema = new mongoose.Schema({
  consulente: { type: String, default: '' },   // username del consulente a cui e' assegnata la riga
  propostaOrigineId: { type: String, default: '' },   // evita doppioni sulla stessa proposta
  incaricoUfficio: { type: String, default: '' },
  statoTransazione: { type: String, default: 'Da Fare Preliminare' }, // Vincolata | Da Fare Preliminare | Fare Preliminare | Da Rogitare | Rogitate
  vincolo: { type: String, default: 'no' },
  vincoloSpecifica: { type: String, default: '' },
  dataScadenzaVincolo: { type: String, default: '' },
  acquirenti: { type: [{ nome: String, codiceFiscale: String,
                         dataNascita: String, luogoNascita: String, sesso: String }], default: [] },
  venditori: { type: [{ nome: String, codiceFiscale: String,
                        dataNascita: String, luogoNascita: String, sesso: String,
                        residenza: String, codiceFiscaleTesto: String }], default: [] },
  immobile: { type: String, default: '' },
  prezzoVendita: { type: String, default: '' },
  dataPrimoAcconto: { type: String, default: '' },
  dataRogito: { type: String, default: '' },          // tempistiche rogito
  preliminareFatto: { type: String, default: 'No' },  // Si | No
  dataPreliminare: { type: String, default: '' },
  nomeNotaio: { type: String, default: '' },
  provvigioneAcquirente: { type: String, default: '' },
  provvigioneVenditore: { type: String, default: '' },
  note: { type: String, default: '' }
}, { timestamps: true });
const Transazione = mongoose.model('Transazione', TransazioneSchema);

/* ==========================================
   4g. MODELLO PROFESSIONISTI (Capitale Sociale)
   Rubrica della rete: BNI, professionisti, clienti rogitati.
========================================== */
const ProfessionistaSchema = new mongoose.Schema({
  consulente: { type: String, default: '' },   // username del consulente a cui e' assegnata la riga
  nome: { type: String, required: true },
  gruppo: { type: String, default: '' },              // BNI, Acquirenti Rogitati, ...
  ultimoContatto: { type: String, default: '' },
  tipologia: { type: String, default: '' },           // Notaio, Commercialista, ...
  noteLastContact: { type: String, default: '' },
  dataLast1to1: { type: String, default: '' },
  residenza: { type: String, default: '' },
  attivitaLavorativa: { type: String, default: '' },
  dataCompleanno: { type: String, default: '' },
  compleannoRogito: { type: String, default: '' },
  gac: { type: String, default: '' },                 // Gac in euro
  storniDati: { type: String, default: '' },          // Storni dati in euro
  referenzeRicevute: { type: String, default: '' },
  giriCompletati: { type: String, default: '' },
  incaricoCollegato: { type: String, default: '' },   // idElemento dell'incarico
  telefono: { type: String, default: '' },
  mail: { type: String, default: '' },
  inseritoDa: { type: String, default: '' }
}, { timestamps: true });
const Professionista = mongoose.model('Professionista', ProfessionistaSchema);

/* ==========================================
   4h. MODELLO OPPORTUNITY (Acquisizione > Notizie)
========================================== */
const OpportunitySchema = new mongoose.Schema({
  consulente: { type: String, default: '' },   // username del consulente a cui e' assegnata la riga
  nome: { type: String, default: '' },
  persone: { type: String, default: '' },              // consulente assegnato
  posizione: { type: String, default: '' },
  telefono: { type: String, default: '' },
  cdvFatto: { type: String, default: 'No' },
  dataPotCdv: { type: String, default: '' },
  comune: { type: String, default: '' },
  via: { type: String, default: '' },
  civico: { type: String, default: '' },
  tipologiaContesto: { type: String, default: '' },
  noteContesto: { type: String, default: '' },
  locali: { type: String, default: '' },
  mq: { type: String, default: '' },
  piano: { type: String, default: '' },
  piuLivelli: { type: String, default: 'No' },
  bagni: { type: String, default: '' },
  pertinenze: { type: String, default: '' },
  giaVendita: { type: String, default: 'No' },
  richiesta: { type: String, default: '' },
  linkAnnuncio: { type: String, default: '' },
  semaforoConcorrenza: { type: String, default: 'Da Scoprire' },
  dataScadenzaIncarico: { type: String, default: '' },
  dataProssimaAttivita: { type: String, default: '' },
  dataUltimaAttivita: { type: String, default: '' },
  esitoUltimaAttivita: { type: String, default: 'Da Editare' },
  giriAttivita: { type: String, default: '' },
  fonte: { type: String, default: '' },
  fonteBancaDati: { type: String, default: '' },
  inseritoDa: { type: String, default: '' }
}, { timestamps: true });
const Opportunity = mongoose.model('Opportunity', OpportunitySchema);

/* ==========================================
   4i. MODELLO CDV (Comparativa di Vendita)
========================================== */
const CdvSchema = new mongoose.Schema({
  consulente: { type: String, default: '' },   // username del consulente a cui e' assegnata la riga
  nome: { type: String, default: '' },
  livello: { type: String, default: 'Info' },          // Info | Opportunity
  posizione: { type: String, default: '' },
  tipologiaAnnuncio: { type: String, default: '' },
  fonte: { type: String, default: '' },
  comune: { type: String, default: '' },
  via: { type: String, default: '' },
  civico: { type: String, default: '' },
  contesto: { type: String, default: '' },
  unita: { type: String, default: '' },
  accessori: { type: String, default: '' },
  venditaAffitto: { type: String, default: '' },
  anagraficaProprietario: { type: String, default: '' }, // nome in Capitale Sociale
  cdv1: { type: String, default: 'No' },
  dataCdv1: { type: String, default: '' },
  cdv2: { type: String, default: 'No' },
  dataCdv2: { type: String, default: '' },
  valutazione: { type: String, default: '' },
  allegatoCdv: { type: String, default: '' },
  incaricoFatto: { type: String, default: 'No' },
  cdvFatto: { type: String, default: 'No' },
  dataPotIncarico: { type: String, default: '' },
  dataPotCdv: { type: String, default: '' },
  statoProprietario: { type: String, default: 'Da Editare' },
  dataProssimaAttivita: { type: String, default: '' },
  statoZona: { type: String, default: '' },
  statoVdp: { type: String, default: '' },
  attivitaVdp: { type: String, default: '' },
  attivitaConcorrenza: { type: String, default: '' },
  statoNecrologio: { type: String, default: '' },
  attivitaNecrologio: { type: String, default: '' },
  dataUltimaAttivita: { type: String, default: '' },
  esitoUltimaAttivita: { type: String, default: 'Da Editare' },
  piano: { type: String, default: '' },
  giaVendita: { type: String, default: 'No' },
  piuLivelli: { type: String, default: 'No' },
  richiesta: { type: String, default: '' },
  zonaImmobiliare: { type: String, default: '' },
  bagni: { type: String, default: '' },
  locali: { type: String, default: '' },
  mq: { type: String, default: '' },
  giriAttivita: { type: String, default: '' },
  linkAnnuncio: { type: String, default: '' },
  visuraggio: { type: String, default: 'No' },
  nomeProprieta: { type: String, default: '' },
  testoUltimoFeedback: { type: String, default: '' },
  dataNascita: { type: String, default: '' },
  dataMorte: { type: String, default: '' },
  semaforoConcorrenza: { type: String, default: 'Da Scoprire' },
  dataScadenzaIncarico: { type: String, default: '' },
  nomeIntestatariCf: { type: String, default: '' },
  noteCdv1: { type: String, default: '' },
  piuSpazio: { type: String, default: 'No' },
  noteCdv2: { type: String, default: '' },
  speseCondominiali: { type: String, default: '' },
  costoAcquisto: { type: String, default: '' },
  ristrutturazione: { type: String, default: '' },
  euroRistrutturazione: { type: String, default: '' },
  budgetRiacquisto: { type: String, default: '' },
  mutuoRiacquisto: { type: String, default: '' },
  mutuoResiduo: { type: String, default: '' },
  noteSpeseCondominiali: { type: String, default: '' },
  noteRistrutturazione: { type: String, default: '' },
  riacquisto: { type: String, default: '' },
  dataAcquisto: { type: String, default: '' },
  documentiRaccolti: { type: String, default: '' },   // Plan + Visure + Atto + Spese Condominiali
  inseritoDa: { type: String, default: '' }
}, { timestamps: true });
const Cdv = mongoose.model('Cdv', CdvSchema);

/* ==========================================
   4l. MODELLO VALUTAZIONI IMMOBILIARI
   Scheda compilata dal consulente, da cui nasce il fascicolo di stima.
========================================== */
const ValutazioneSchema = new mongoose.Schema({
  consulente: { type: String, default: '' },
  nomeCliente: { type: String, default: '' },
  emailCliente: { type: String, default: '' },
  telefonoCliente: { type: String, default: '' },
  comune: { type: String, default: '' },
  zona: { type: String, default: '' },
  via: { type: String, default: '' },
  civico: { type: String, default: '' },
  motivo: { type: String, default: '' },
  occupazione: { type: String, default: '' },
  titolarita: { type: String, default: '' },
  visura: { type: String, default: '' },
  ape: { type: String, default: '' },
  planimetria: { type: String, default: '' },
  pratiche: { type: String, default: '' },
  identificativi: { type: String, default: '' },
  rendita: { type: String, default: '' },
  mq: { type: String, default: '' },
  tipologia: { type: String, default: '' },
  locali: { type: String, default: '' },
  bagni: { type: String, default: '' },
  piano: { type: String, default: '' },
  ascensore: { type: String, default: '' },
  esposizione: { type: String, default: '' },
  stato: { type: String, default: '' },
  annoRistrutturazione: { type: String, default: '' },
  riscaldamento: { type: String, default: '' },
  infissi: { type: String, default: '' },
  accessori: { type: String, default: '' },
  epoca: { type: String, default: '' },
  annoCostruzione: { type: String, default: '' },
  speseCondominiali: { type: String, default: '' },
  partiComuni: { type: String, default: '' },
  serviziComuni: { type: String, default: '' },
  rumore: { type: String, default: '' },
  prezzoBaseMq: { type: String, default: '' },
  notaZona: { type: String, default: '' },
  zonaOmi: { type: String, default: '' },
  quotazioneOmiMin: { type: String, default: '' },
  quotazioneOmiMax: { type: String, default: '' },
  comparabili: { type: Array, default: [] },
  origine: { type: String, default: '' },   // "Landing pubblica" per le richieste dal sito
  valoreConsigliato: { type: String, default: '' },
  valoreMinimo: { type: String, default: '' },
  valoreMassimo: { type: String, default: '' },
  valoreAlMq: { type: String, default: '' }
}, { timestamps: true });
const Valutazione = mongoose.model('Valutazione', ValutazioneSchema);

/* ==========================================
   4n. COEFFICIENTI DI VALUTAZIONE
   I moltiplicatori che correggono il prezzo base della zona: piano, ascensore,
   esposizione, stato... Stanno sul database e si modificano dal CRM.
========================================== */
const CoefficienteSchema = new mongoose.Schema({
  famiglia: { type: String, default: '' },   // es. 'piano', 'ascensore', 'stato'
  voce: { type: String, default: '' },       // es. 'Ultimo piano con ascensore'
  valore: { type: Number, default: 1 },
  ordine: { type: Number, default: 0 }
}, { timestamps: true });
CoefficienteSchema.index({ famiglia: 1, voce: 1 }, { unique: true });
const Coefficiente = mongoose.model('Coefficiente', CoefficienteSchema);

/* Valori di partenza, scritti solo se la collezione e' vuota: da li' in poi comandano
   quelli salvati dall'agenzia. */
const COEFFICIENTI_STANDARD = [
  ['tipologia', 'Appartamento standard', 1.00], ['tipologia', 'Appartamento signorile / Attico', 1.15],
  ['tipologia', 'Villa Singola', 1.25], ['tipologia', 'Villa a Schiera', 1.10],
  ['stato', 'Ristrutturato a nuovo', 1.20], ['stato', 'Buono / Abitabile subito', 1.00],
  ['stato', 'Completamente da ristrutturare', 0.75],
  ['piano', 'Seminterrato', 0.75], ['piano', 'Piano terra', 0.85], ['piano', 'Primo piano', 0.95],
  ['piano', 'Piano intermedio', 1.00], ['piano', 'Ultimo piano con ascensore', 1.05],
  ['piano', 'Ultimo piano senza ascensore', 0.90], ['piano', 'Attico', 1.15],
  ['ascensore', 'S\u00ec, presente', 1.00], ['ascensore', 'No, assente', 0.95],
  ['esposizione', 'Doppia / passante', 1.05], ['esposizione', 'Singola luminosa', 1.00],
  ['esposizione', 'Interna / poca luce', 0.93],
  /* Vetusta': curva del Borsino Immobiliare FIMAA (-1% l'anno per i primi 15 anni,
     poi -0,5% fino al 45esimo, minimo 0,70), normalizzata sull'eta' tipica della zona. */
  ['vetusta', 'Calo annuo primi 15 anni (%)', 1.0],
  ['vetusta', 'Calo annuo dal 16\u00b0 anno (%)', 0.5],
  ['vetusta', 'Coefficiente minimo', 0.70],
  ['vetusta', 'Vetust\u00e0 di riferimento (anni)', 30],
  ['rumore', 'Via silenziosa e interna', 1.02], ['rumore', 'Zona trafficata / commerciale', 0.96],
  ['partiComuni', 'In buono stato', 1.00], ['partiComuni', 'Interventi da fare', 0.95]
];

async function seminaCoefficienti() {
  try {
    /* Inserisce solo le voci mancanti: i valori gia' modificati dall'agenzia
       restano come sono, anche quando aggiungiamo una famiglia nuova. */
    await Coefficiente.bulkWrite(COEFFICIENTI_STANDARD.map((c, i) => ({
      updateOne: {
        filter: { famiglia: c[0], voce: c[1] },
        update: { $setOnInsert: { famiglia: c[0], voce: c[1], valore: c[2], ordine: i } },
        upsert: true
      }
    })));
  } catch (err) { console.error('Coefficienti non inizializzati:', err.message); }
}

app.get('/api/coefficienti', async (req, res) => {
  try {
    await seminaCoefficienti();
    res.status(200).json(await Coefficiente.find({}).sort({ famiglia: 1, ordine: 1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/coefficienti/:id', async (req, res) => {
  try {
    const payload = (req.body && req.body.campo !== undefined) ? { [req.body.campo]: req.body.valore } : req.body;
    const aggiornato = await Coefficiente.findByIdAndUpdate(req.params.id, { $set: payload }, { new: true });
    if (!aggiornato) return res.status(404).json({ error: 'Coefficiente non trovato' });
    res.status(200).json({ status: 'success', data: aggiornato });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* Torna ai valori standard */
app.post('/api/coefficienti/ripristina', async (req, res) => {
  try {
    await Coefficiente.deleteMany({});
    await seminaCoefficienti();
    res.status(200).json({ status: 'success', coefficienti: await Coefficiente.find({}).sort({ famiglia: 1, ordine: 1 }) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});


/* ==========================================
   4m. ZONE OMI (Agenzia delle Entrate)
   I perimetri si caricano dall'interfaccia del CRM, non dal codice:
   ogni semestre si riscarica il pacchetto da Geopoi e si reimporta.
   Le quotazioni si compilano a mano leggendole dalla mappa pubblica.
========================================== */
const ZonaOmiSchema = new mongoose.Schema({
  comune: { type: String, default: '' },
  codiceComune: { type: String, default: '' },
  zona: { type: String, default: '' },
  semestre: { type: String, default: '' },          // es. "2025-2"
  poligoni: { type: Array, default: [] },           // [[[lng,lat], ...], ...]
  // quotazioni lette da Geopoi, in euro al metro quadro
  quotazioneMin: { type: String, default: '' },
  quotazioneMax: { type: String, default: '' },
  quotazioneTipologia: { type: String, default: 'Abitazioni civili' },
  quotazioneStato: { type: String, default: 'Normale' },
  aggiornataIl: { type: String, default: '' }
}, { timestamps: true });
ZonaOmiSchema.index({ comune: 1, zona: 1, semestre: 1 }, { unique: true });
const ZonaOmi = mongoose.model('ZonaOmi', ZonaOmiSchema);

/* Il punto e' dentro il poligono? Algoritmo del raggio: conto quante volte
   una semiretta uscente dal punto attraversa i lati. Dispari = dentro. */
function puntoDentroPoligono(lng, lat, anello) {
  let dentro = false;
  for (let i = 0, j = anello.length - 1; i < anello.length; j = i++) {
    const xi = anello[i][0], yi = anello[i][1];
    const xj = anello[j][0], yj = anello[j][1];
    const attraversa = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
    if (attraversa) dentro = !dentro;
  }
  return dentro;
}

/* ==========================================
   4c. MODELLO INCARICHI GESTIONE MANUALE ED EXCEL
========================================== */
const IncaricoSchema = new mongoose.Schema({
  consulente: { type: String, default: '' },   // username del consulente a cui e' assegnata la riga
  nome: { type: String, required: true },
  idElemento: { type: String, default: '' },
  statoImmobile: { type: String, default: '' },
  statoSecondario: { type: String, default: '' },
  teamLeader: { type: String, default: '' },
  listing: { type: String, default: '' },
  buyer: { type: String, default: '' },
  nomeVenditore: { type: String, default: '' },
  residenzaVenditore: { type: String, default: '' },
  telefonoVenditore: { type: String, default: '' },
  posizione: { type: String, default: '' },
  comune: { type: String, default: '' },
  via: { type: String, default: '' },
  civico: { type: String, default: '' },
  nextOpenHouse: { type: String, default: '' },
  prezzoIncarico: { type: String, default: '' },
  tipologiaContratto: { type: String, default: '' },
  prezzoValutazione: { type: String, default: '' },
  provvigioneVenditore: { type: String, default: '' },
  dataIncarico: { type: String, default: '' },
  dataScadenza: { type: String, default: '' },
  contesto: { type: String, default: '' },
  tipologiaUnita: { type: String, default: '' },
  ascensore: { type: String, default: '' },
  locali: { type: String, default: '' },
  piano: { type: String, default: '' },
  mq: { type: String, default: '' },
  bagni: { type: String, default: '' },
  box: { type: String, default: '' },
  mqBox: { type: String, default: '' },
  classeApe: { type: String, default: '' },
  ipeApe: { type: String, default: '' },
  speseCondominiali: { type: String, default: '' },
  testoAnnuncio: { type: String, default: '' },
  linkVideo: { type: String, default: '' },
  linkVirtualTour: { type: String, default: '' },
  linkDocumenti: { type: String, default: '' },
  foto: { type: String, default: '' },
  fotoAllegati: { type: [String], default: [] },
  reportUsername: { type: String, default: '' },
  reportPassword: { type: String, default: '' },
  /* le tappe della gestione: quando ogni cosa e' stata fatta.
     Servono al report per raccontare il lavoro svolto, non solo il risultato. */
  /* I dati catastali dell'immobile, scritti una volta e riusati ovunque:
     preliminare, valutazione, fascicolo. Sono piu' unita' perche' un immobile
     ne ha spesso due o tre — abitazione, box, cantina. */
  datiCatastali: { type: Array, default: [] },
  provenienza: { type: String, default: '' },        // da chi e come e' arrivato al venditore
  confini: { type: String, default: '' },
  conformitaNote: { type: String, default: '' },
  dataDocumenti: { type: String, default: '' },      // documenti recuperati dal proprietario
  dataAccessoAtti: { type: String, default: '' },    // accesso agli atti in Comune
  dataPubblicazione: { type: String, default: '' },  // messa online sui portali
  visualizzazioni: { type: String, default: '' },    // quante volte l'annuncio e' stato visto
  contattiRicevuti: { type: String, default: '' },   // richieste arrivate dai portali
  dataAggiornamentoViste: { type: String, default: '' },
  gestioneDocumenti: { type: mongoose.Schema.Types.Mixed, default: {} } // venditori, provenienza, mutuo, accesso atti, foto, pubblicazione
}, { timestamps: true });
const Incarico = mongoose.model('Incarico', IncaricoSchema);

/* ==========================================
   5. MODELLO AGGIORNATO: CAPITALE SOCIALE (CON STRUTTURA IMMOBILE NESTED)
========================================== */
const ProprietaCollegataSchema = new mongoose.Schema({
  paese: String,
  via: String,
  civico: String,
  contesto: String,
  foglio: String,
  mappale: String,
  sub: String,
  piano: String,
  vani: String,
  mq: String,
  statoImmobile: { type: String, default: 'Residente' } // Residente | Vuoto | Locato | Abitato da Familiare
});

const CapitaleSocialeSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  cf: { type: String, default: '' },
  dataNascita: { type: String, default: '' },
  /* il luogo di nascita arriva dalle visure del censimento: serve al
     preliminare, e riscriverlo a mano significa sbagliarlo */
  luogoNascita: { type: String, default: '' },
  tel: { type: String, default: '' },
  mail: { type: String, default: '' },
  social: {
    facebook: { type: String, default: '' },
    instagram: { type: String, default: '' },
    linkedin: { type: String, default: '' },
    x: { type: String, default: '' }
  },
  inseritoDa: { type: String, default: '' },
  residenzaId: { type: String, default: '' }, // _id dell'elemento in 'proprieta' scelto come residenza
  proprieta: [ProprietaCollegataSchema] // Subitems dedicati a contenere tutti i dati della casa
}, { timestamps: true });
const CapitaleSociale = mongoose.model('CapitaleSociale', CapitaleSocialeSchema);

/* ==========================================
   6. MODELLO ARCHIVIO UNITÀ RIMOSSE (SOLO SE CAMBIO NOMINATIVO)
========================================== */
const UnitaRimossaSchema = new mongoose.Schema({
  nomePrecedente: { type: String, required: true },
  paese: String, via: String, civico: String, contesto: String,
  foglio: String, mappale: String, sub: String, piano: String, vani: String, mq: String,
  motivazione: { type: String, default: 'Cambio Nominativo' },
  rimossoDa: { type: String, default: '' }
}, { timestamps: true });
const UnitaRimossa = mongoose.model('UnitaRimossa', UnitaRimossaSchema);

/* ==========================================
   ROTTE API INTERNE CORE & AUTENTICAZIONE
========================================== */
app.get('/', (req, res) => res.json({ status: 'success', message: 'Forte CRM Backend attivo e integro al 100%' }));

app.post('/api/login', async (req, res) => {
  try {
    const { utente, pass } = req.body;
    if (utente.trim().toLowerCase() === "admin" && pass === "Forte2026") {
      return res.status(200).json({ status: 'success', data: { nomeCognome: "Alessandro Forte (Master)", ruolo: "AMMINISTRATORE", utente: "admin", areeVisibili: [], consulentiVisibili: [] } });
    }
    const consulente = await Consulente.findOne({ utente: utente.trim() });
    if (!consulente || consulente.pass !== pass) return res.status(401).json({ error: 'Username o password errati' });
    const datiSenzaPassword = consulente.toObject();
    delete datiSenzaPassword.pass;
    res.status(200).json({ status: 'success', data: datiSenzaPassword });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================
   ROTTE API: CONSULENTI
========================================== */
app.get('/api/consulenti', async (req, res) => {
  try { res.status(200).json(await Consulente.find({}).sort({ nomeCognome: 1 })); } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ricerca un consulente per nome esatto (Nome e Cognome). Pensata per automazioni esterne
// (es. Make.com) che devono trovare l'ID Telegram/WhatsApp di un consulente dato il suo nome.
app.get('/api/consulenti/cerca', async (req, res) => {
  try {
    const { nome } = req.query;
    if (!nome) return res.status(200).json({ trovato: false });
    const trovato = await Consulente.findOne({ nomeCognome: nome.trim() });
    if (!trovato) return res.status(200).json({ trovato: false });
    res.status(200).json({ trovato: true, consulente: trovato });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/consulenti', async (req, res) => {
  try {
    const nuevo = new Consulente({ ...req.body, utente: req.body.utente.trim() });
    res.status(201).json({ status: 'success', data: await nuevo.save() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/consulenti/:id', async (req, res) => {
  try {
    const eliminato = await Consulente.findByIdAndDelete(req.params.id);
    if (!eliminato) return res.status(404).json({ error: 'Consulente non trovato' });
    res.status(200).json({ status: 'success', message: 'Consulente eliminato con successo' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/consulenti/:id/permessi', async (req, res) => {
  try {
    const { areeVisibili, consulentiVisibili } = req.body;
    const aggiornato = await Consulente.findByIdAndUpdate(
      req.params.id,
      { $set: { areeVisibili: areeVisibili || [], consulentiVisibili: consulentiVisibili || [] } },
      { new: true }
    );
    if (!aggiornato) return res.status(404).json({ error: 'Consulente non trovato' });
    res.status(200).json({ status: 'success', data: aggiornato });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Modifica generica dei dati anagrafici di un consulente (nome, username, password, mail, telefono, telegram, whatsapp, foto, ruolo)
app.put('/api/consulenti/:id', async (req, res) => {
  try {
    const campiConsentiti = ['nomeCognome', 'utente', 'pass', 'mail', 'telefono', 'idTelegram', 'idWhatsapp', 'fotoProfilo', 'ruolo'];
    const aggiornamento = {};
    for (const campo of campiConsentiti) {
      if (req.body[campo] !== undefined) aggiornamento[campo] = req.body[campo];
    }
    const aggiornato = await Consulente.findByIdAndUpdate(req.params.id, { $set: aggiornamento }, { new: true });
    if (!aggiornato) return res.status(404).json({ error: 'Consulente non trovato' });
    res.status(200).json({ status: 'success', data: aggiornato });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* ==========================================
   ROTTE API: TODO
========================================== */
app.get('/api/todo', async (req, res) => {
  try { res.status(200).json(await Todo.find({}).sort({ createdAt: -1 })); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/todo', async (req, res) => {
  try { const nuovo = new Todo(req.body); res.status(201).json({ status: 'success', data: await nuovo.save() }); } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/todo/:id', async (req, res) => {
  try { res.status(200).json({ status: 'success', data: await Todo.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true }) }); } catch (err) { res.status(400).json({ error: err.message }); }
});

/* Allinea le attivita' automatiche: crea quelle nuove, chiude quelle che non servono piu'.
   Le attivita' scritte a mano dai consulenti non vengono mai toccate. */
app.post('/api/todo/sincronizza', async (req, res) => {
  try {
    const attese = Array.isArray(req.body) ? req.body : (req.body.attivita || []);
    const chiaviAttese = attese.map(a => a.origine).filter(Boolean);

    const esistenti = await Todo.find({ automatica: true });
    const perOrigine = {};
    esistenti.forEach(e => { perOrigine[e.origine] = e; });

    let create = 0, aggiornate = 0, chiuse = 0;
    for (const a of attese) {
      if (!a.origine || !a.task) continue;
      const gia = perOrigine[a.origine];
      if (gia) {
        /* Se il consulente l'ha gia' spuntata non la resuscito: una lista di controllo
           spuntata deve restare spuntata, altrimenti riappare all'infinito. */
        if (gia.stato === 'Completato') continue;
        gia.task = a.task; gia.data = a.data; gia.scadenza = a.scadenza || '';
        gia.priorita = a.priorita || 'Normale'; gia.consulente = a.consulente || gia.consulente;
        gia.collegamento = a.collegamento || '';
        await gia.save(); aggiornate++;
      } else {
        await new Todo(Object.assign({ automatica: true, stato: 'Attivo' }, a)).save();
        create++;
      }
    }

    // quello che non e' piu' nell'elenco atteso ha esaurito il suo motivo di esistere,
    // ma le attivita' gia' completate restano come storico
    const daChiudere = esistenti.filter(e => chiaviAttese.indexOf(e.origine) === -1 && e.stato !== 'Completato');
    for (const e of daChiudere) { await Todo.findByIdAndDelete(e._id); chiuse++; }

    res.status(200).json({ status: 'success', create, aggiornate, chiuse });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/todo/:id', async (req, res) => {
  try {
    const eliminato = await Todo.findByIdAndDelete(req.params.id);
    if (!eliminato) return res.status(404).json({ error: 'Task non trovato' });
    res.status(200).json({ status: 'success', message: 'Task eliminato con successo' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Tutti gli Oby: serve alla scheda di monitoraggio per confrontare i consulenti */
app.get('/api/oby-budget', async (req, res) => {
  try { res.status(200).json(await ObyBudget.find({})); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/oby-budget/:consulente', async (req, res) => {
  try {
    let b = await ObyBudget.findOne({ consulente: req.params.consulente });
    if (!b) b = { consulente: req.params.consulente, percentualeProvvigione: 40, guadagnoNettoDesiderato: 30000, lordoFatturareAgenzia: 75000, immobiliDaVendere: 9, immobiliDaAcquisire: 13, cdv2Necessarie: 44, cdv1Necessarie: 63, notizieNecessarie: 210 };
    res.status(200).json(b);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/oby-budget', async (req, res) => {
  try { res.status(200).json({ status: 'success', data: await ObyBudget.findOneAndUpdate({ consulente: req.body.consulente }, { $set: req.body }, { new: true, upsert: true }) }); } catch (err) { res.status(400).json({ error: err.message }); }
});

/* ==========================================
   ROTTE API: STRADARIO CLOUD COMPLETO
========================================== */
app.get('/api/stradario', async (req, res) => {
  try {
    let elenco = await Stradario.find({}).sort({ comune: 1 });
    if (elenco.length === 0) {
      const initComuni = [
        { comune: "Legnano", provincia: "MI", abitanti: "61.271", subalterniTotali: 32500, vie: [] },
        { comune: "Canegrate", provincia: "MI", abitanti: "12.500", subalterniTotali: 6100, vie: [] },
        { comune: "San Giorgio su Legnano", provincia: "MI", abitanti: "6.700", subalterniTotali: 3100, vie: [] },
        { comune: "San Vittore Olona", provincia: "MI", abitanti: "8.300", subalterniTotali: 4100, vie: [] },
        { comune: "Cerro Maggiore", provincia: "MI", abitanti: "15.200", subalterniTotali: 7400, vie: [] },
        { comune: "Rescaldina", provincia: "MI", abitanti: "14.100", subalterniTotali: 6800, vie: [] },
        { comune: "Saronno", provincia: "VA", abitanti: "38.600", subalterniTotali: 19800, vie: [] }
      ];
      await Stradario.insertMany(initComuni);
      elenco = await Stradario.find({}).sort({ comune: 1 });
    }
    res.status(200).json(elenco);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/stradario/:comuneId', async (req, res) => {
  try {
    const updateFields = { vie: req.body.vie };
    if (req.body.abitanti) updateFields.abitanti = req.body.abitanti;
    if (req.body.subalterniTotali) updateFields.subalterniTotali = Number(req.body.subalterniTotali);

    const aggiornato = await Stradario.findByIdAndUpdate(req.params.comuneId, { $set: updateFields }, { new: true });
    res.status(200).json({ status: 'success', data: aggiornato });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/stradario/nuovo-comune', async (req, res) => {
  try {
    const esiste = await Stradario.findOne({ comune: req.body.comune });
    if(esiste) return res.status(400).json({ error: "Questo comune è già presente!" });
    const nuovo = new Stradario(req.body);
    res.status(201).json({ status: 'success', data: await nuovo.save() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/stradario/:comuneId', async (req, res) => {
  try {
    const eliminato = await Stradario.findByIdAndDelete(req.params.comuneId);
    if (!eliminato) return res.status(404).json({ error: 'Comune non trovato' });
    res.status(200).json({ status: 'success', message: 'Comune eliminato con successo' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================
   ROTTE API: CONCORRENZA MANUALE ED EXCEL
========================================== */
app.get('/api/concorrenza', async (req, res) => {
  try {
    const elenco = await Concorrenza.find({}).sort({ createdAt: -1 });
    res.status(200).json(elenco);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/concorrenza', async (req, res) => {
  try {
    const nuovo = new Concorrenza(req.body);
    res.status(201).json(await nuovo.save());
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/concorrenza/massivo', async (req, res) => {
  try {
    const righeRicevute = req.body;

    // Raccolgo, per ogni agenzia citata nel file, i contatti trovati dallo scraping
    // (sede/telefono/mail): servono a riempire la scheda in Capitale Sociale. Tengo il
    // primo valore non vuoto che incontro per ciascun campo.
    const contattiPerAgenzia = new Map(); // nomeLower -> { sede, telefono, mail }
    righeRicevute.forEach(r => {
      const nome = (r.agenzia || '').trim();
      if (!nome || nome.toLowerCase() === 'n.d.' || nome.toLowerCase() === 'concorrente') return;
      const chiave = nome.toLowerCase();
      const attuale = contattiPerAgenzia.get(chiave) || { sede: '', telefono: '', mail: '' };
      if (!attuale.sede && r.agenziaSede) attuale.sede = String(r.agenziaSede).trim();
      if (!attuale.telefono && r.agenziaTelefono) attuale.telefono = String(r.agenziaTelefono).trim();
      if (!attuale.mail && r.agenziaMail) attuale.mail = String(r.agenziaMail).trim();
      contattiPerAgenzia.set(chiave, attuale);
    });

    // Per ogni nome di agenzia presente nel file, cerca l'Agenzia Immobiliare già censita (per nome,
    // senza distinguere maiuscole/minuscole). Se non esiste, la crea al volo con i contatti trovati.
    // Se esiste ma le manca sede/telefono/mail, li riempie SENZA sovrascrivere quello che c'è già
    // (così non calpesta un dato inserito a mano).
    const agenzieEsistenti = await AgenziaImmobiliare.find({});
    const mappaNomeAgenziaId = new Map(agenzieEsistenti.map(a => [a.nomeAgenzia.trim().toLowerCase(), a._id.toString()]));

    const nomiAgenziaNelFile = [...new Set(
      righeRicevute.map(r => (r.agenzia || '').trim()).filter(nome => nome && nome.toLowerCase() !== 'n.d.' && nome.toLowerCase() !== 'concorrente')
    )];
    let agenzieNuoveCreate = 0;
    let agenzieArricchite = 0;
    for (const nomeAgenzia of nomiAgenziaNelFile) {
      const chiave = nomeAgenzia.toLowerCase();
      const contatti = contattiPerAgenzia.get(chiave) || { sede: '', telefono: '', mail: '' };
      const idEsistente = mappaNomeAgenziaId.get(chiave);
      if (!idEsistente) {
        const nuovaAgenzia = await new AgenziaImmobiliare({
          nomeAgenzia,
          sede: contatti.sede || '',
          telefono: contatti.telefono || '',
          mail: contatti.mail || ''
        }).save();
        mappaNomeAgenziaId.set(chiave, nuovaAgenzia._id.toString());
        agenzieNuoveCreate++;
      } else {
        const esistente = agenzieEsistenti.find(a => a._id.toString() === idEsistente);
        const daAggiornare = {};
        if (esistente && !esistente.sede && contatti.sede) daAggiornare.sede = contatti.sede;
        if (esistente && !esistente.telefono && contatti.telefono) daAggiornare.telefono = contatti.telefono;
        if (esistente && !esistente.mail && contatti.mail) daAggiornare.mail = contatti.mail;
        if (Object.keys(daAggiornare).length > 0) {
          await AgenziaImmobiliare.findByIdAndUpdate(idEsistente, { $set: daAggiornare });
          agenzieArricchite++;
        }
      }
    }

    // Riconoscimento dei doppioni: uso l'id immobiliare quando c'è (è stabile anche se il link cambia),
    // altrimenti ripiego sul link come prima.
    const annunciEsistenti = await Concorrenza.find({}, 'link idImmobiliare');
    const idGiaPresenti = new Set(annunciEsistenti.map(r => (r.idImmobiliare || '').trim()).filter(x => x));
    const linkGiaPresenti = new Set(annunciEsistenti.map(r => (r.link || '').trim().toLowerCase()).filter(l => l));

    const daInserire = [];
    let saltatiPerDoppione = 0;
    const idVistiInQuestoImport = new Set();
    const linkVistiInQuestoImport = new Set();

    righeRicevute.forEach(riga => {
      const idNorm = (riga.idImmobiliare || '').trim();
      const linkNorm = (riga.link || '').trim().toLowerCase();
      const eGiaPresente =
        (idNorm && (idGiaPresenti.has(idNorm) || idVistiInQuestoImport.has(idNorm))) ||
        (linkNorm && (linkGiaPresenti.has(linkNorm) || linkVistiInQuestoImport.has(linkNorm)));
      if (eGiaPresente) {
        saltatiPerDoppione++;
      } else {
        if (idNorm) idVistiInQuestoImport.add(idNorm);
        if (linkNorm) linkVistiInQuestoImport.add(linkNorm);
        const nomeAgenziaRiga = (riga.agenzia || '').trim().toLowerCase();
        riga.agenziaId = mappaNomeAgenziaId.get(nomeAgenziaRiga) || '';
        daInserire.push(riga);
      }
    });

    const inseriti = daInserire.length > 0 ? await Concorrenza.insertMany(daInserire) : [];
    res.status(201).json({ status: 'success', count: inseriti.length, saltatiPerDoppione, agenzieNuoveCreate, agenzieArricchite });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/concorrenza/svuota', async (req, res) => {
  try {
    await Concorrenza.deleteMany({});
    res.status(200).json({ status: 'success', message: 'Tabella Concorrenza azzerata' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/concorrenza/:id', async (req, res) => {
  try {
    const eliminato = await Concorrenza.findByIdAndDelete(req.params.id);
    if (!eliminato) return res.status(404).json({ error: 'Annuncio non trovato' });
    res.status(200).json({ status: 'success', message: 'Annuncio eliminato con successo' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/concorrenza/:id', async (req, res) => {
  try {
    const aggiornato = await Concorrenza.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    if (!aggiornato) return res.status(404).json({ error: 'Annuncio non trovato' });
    res.status(200).json(aggiornato);
  } catch (err) { res.status(400).json({ error: err.message }); }
});


/* Aggiornamento in blocco dello stato degli annunci dopo una verifica automatica.
   Lo scanner riapre i link già salvati e manda qui l'esito di ognuno: statoAnnuncio
   ('Attivo' | 'Ritirato' | 'Venduto') e, se le ha lette, la data dell'annuncio e la
   data dell'ultimo monitoraggio. Riconosce la riga per idImmobiliare, altrimenti per link.
   Non crea niente di nuovo: aggiorna solo quello che esiste già. */
app.post('/api/concorrenza/verifica-stato', async (req, res) => {
  try {
    const esiti = Array.isArray(req.body) ? req.body : [];
    let aggiornati = 0, nonTrovati = 0, senzaDati = 0;
    for (const e of esiti) {
      const filtro = (e.idImmobiliare && String(e.idImmobiliare).trim())
        ? { idImmobiliare: String(e.idImmobiliare).trim() }
        : (e.link ? { link: e.link } : null);
      if (!filtro) { nonTrovati++; continue; }
      const set = {};
      if (e.statoAnnuncio) set.statoAnnuncio = e.statoAnnuncio;
      if (e.dataAnnuncio) set.dataAnnuncio = e.dataAnnuncio;
      if (e.dataUltimoMonitoraggio) set.dataUltimoMonitoraggio = e.dataUltimoMonitoraggio;
      if (Object.keys(set).length === 0) { senzaDati++; continue; }
      const r = await Concorrenza.updateOne(filtro, { $set: set });
      const haTrovato = (r.matchedCount || r.n || 0) > 0;
      if (haTrovato) aggiornati++; else nonTrovati++;
    }
    res.status(200).json({ status: 'success', aggiornati, nonTrovati, senzaDati });
  } catch (err) { res.status(400).json({ error: err.message }); }
});


/* ==========================================
   ROTTE API: CENTRALINO (REGISTRO CHIAMATE) MANUALE ED EXCEL
========================================== */
app.get('/api/centralino', async (req, res) => {
  try {
    const elenco = await Centralino.find({}).sort({ createdAt: -1 });
    res.status(200).json(elenco);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/centralino', async (req, res) => {
  try {
    const nuovo = new Centralino(req.body);
    res.status(201).json(await nuovo.save());
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/centralino/massivo', async (req, res) => {
  try {
    const inseriti = await Centralino.insertMany(req.body);
    res.status(201).json({ status: 'success', count: inseriti.length });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/centralino/:id', async (req, res) => {
  try {
    const aggiornato = await Centralino.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    if (!aggiornato) return res.status(404).json({ error: 'Chiamata non trovata' });

    /* Mettendo la colonna su Inviato il messaggio parte davvero.
       Aspetto l'esito invece di rispondere subito: prima il server diceva
       "fatto" e mandava dopo, quindi se l'invio falliva l'errore spariva e a
       schermo non succedeva niente. Meglio un secondo di attesa che un
       guasto invisibile. */
    let esitoInvio = null;

    /* Nel CRM la colonna vale "✅ Inviato", con l'emoji davanti. Confrontarla
       con "Inviato" secco non tornava mai, e non partiva niente senza che
       comparisse un errore: guardo solo la parola, ignorando simboli e
       maiuscole. */
    const dice = (v) => /invia|inviato/i.test(String(v || '').replace(/[^\p{L}\s]/gu, '').trim());

    if (dice(req.body.tgConsInviato) && !aggiornato.tgInviatoIl) {
      esitoInvio = await mandaAvvisoTelegram(aggiornato);
    } else if (dice(req.body.mexClienteInviato) && !aggiornato.mexInviatoIl) {
      esitoInvio = await mandaMessaggioAlCliente(aggiornato);
    }

    res.status(200).json({ status: 'success', data: aggiornato, invio: esitoInvio });
  } catch (err) {
    console.error('Centralino, aggiornamento fallito:', err);
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/centralino/svuota', async (req, res) => {
  try {
    await Centralino.deleteMany({});
    res.status(200).json({ status: 'success', message: 'Registro Chiamate azzerato' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/centralino/:id', async (req, res) => {
  try {
    const eliminato = await Centralino.findByIdAndDelete(req.params.id);
    if (!eliminato) return res.status(404).json({ error: 'Chiamata non trovata' });
    res.status(200).json({ status: 'success', message: 'Chiamata eliminata con successo' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================
   ROTTE API: BANCA DATI (RICHIESTE CLIENTI ACQUIRENTI)
========================================== */
app.get('/api/banca-dati', async (req, res) => {
  try {
    const elenco = await BancaDati.find({}).sort({ createdAt: -1 });
    res.status(200).json(elenco);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/banca-dati', async (req, res) => {
  try {
    // Se arriva un centralinoOrigineId, evitiamo di creare un doppione per lo stesso item Centralino
    if (req.body.centralinoOrigineId) {
      const esistente = await BancaDati.findOne({ centralinoOrigineId: req.body.centralinoOrigineId });
      if (esistente) return res.status(200).json({ status: 'success', data: esistente, duplicato: true });
    }
    const nuovo = new BancaDati(req.body);
    res.status(201).json({ status: 'success', data: await nuovo.save() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/banca-dati/:id', async (req, res) => {
  try {
    const { campo, valore } = req.body;
    const aggiornamento = campo ? { [campo]: valore } : req.body;
    const aggiornato = await BancaDati.findByIdAndUpdate(req.params.id, { $set: aggiornamento }, { new: true });
    if (!aggiornato) return res.status(404).json({ error: 'Voce non trovata' });
    res.status(200).json({ status: 'success', data: aggiornato });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/banca-dati/:id', async (req, res) => {
  try {
    const eliminato = await BancaDati.findByIdAndDelete(req.params.id);
    if (!eliminato) return res.status(404).json({ error: 'Voce non trovata' });
    res.status(200).json({ status: 'success', message: 'Voce eliminata con successo' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================
   ROTTA: ASSISTENTE CRM (CHAT INTERNA COLLEGATA A GOOGLE GEMINI)
   Risponde alle domande dei consulenti su come funziona il CRM, usando come
   conoscenza di base una guida scritta a mano di tutte le funzionalità.
========================================== */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-3.6-flash';

const GUIDA_CRM_FORTE = `
Sei l'assistente interno del CRM di Forte Immobiliare. Rispondi in italiano, in modo chiaro, breve e pratico,
spiegando SEMPRE dove cliccare passo passo. Se non sai una risposta con certezza, dillo onestamente invece di inventare.

STRUTTURA GENERALE: il CRM è diviso in schede nel menu laterale, raggruppate per area (Capitale Sociale, Centralino,
Incarichi Gestione, Consulenti, Acquisizione, ecc). Ogni scheda è una tabella modificabile direttamente cliccando sulle celle.

--- INCARICHI (menu Incarichi Gestione ➔ Incarichi) ---
Contiene tutti gli immobili in gestione. Colonne principali: Nome, ID (es. IF-120), Stato, Posizione, Contesto,
Tipologia, Locali, Mq, Prezzo, Contratto (Vendita/Affitto), Team Leader/Listing/Buyer (tendine collegate ai Consulenti).
- Icona graffetta 📎 accanto al nome: apre il popup Allegati, con foto (anche da Google Drive), video, virtual tour,
  documenti, descrizione testuale, i due pulsanti per generare la Brochure PDF (Stampabile e Web), e la sezione
  "Report Proprietario" dove si imposta username/password da dare al proprietario per vedere le statistiche del suo immobile.
- Icona persone 👥 accanto al nome: apre/chiude un sottopannello con le Richieste (da Banca Dati) e le Visioni collegate
  a quell'immobile.
- Le viste si possono raggruppare, filtrare, ordinare tramite i controlli sopra la tabella.

--- CENTRALINO (Registro Chiamate) ---
Registra ogni richiesta arrivata (telefono, mail, portali). Ha una colonna "Smistamento Completo" calcolata
automaticamente da "Tg Cons Inviato" e "Mex Cliente Inviato": Da Fare, Solo Consulente, Solo Cliente, Completo.
La tabella è raggruppata di default in queste 4 sezioni apri/chiudi. Quando un item diventa "Completo",
si crea IN AUTOMATICO una voce in Banca Dati Richieste (senza bisogno di fare nulla).

--- BANCA DATI RICHIESTE (menu sotto Centralino) ---
Elenco dei potenziali acquirenti/richieste. Colonne: Nome & Cognome, Mail, Telefono, Immobile Fonte Richiesta
(collegato agli Incarichi), Comuni Ricerca (popup con tutti i comuni di Milano/Varese/Como/Monza-Brianza/Novara),
Tipologia Contesto e Tipologia Unità (popup a selezione multipla), Budget Acquisto, Mutuo (Sì/No), Importo Mutuo,
% Ltv (calcolato automaticamente da Importo Mutuo / Budget), Deve Vendere, Scadenza Acquisto Ideale,
e Stato ADV FIX (Da Fix, In Attesa, Fissato, Non Interessa, Venduto/Non Disponibile).
Quando si imposta Stato ADV FIX = "Fissato", si crea IN AUTOMATICO una voce nella scheda Visioni.
C'è anche un pulsante "Trasporta Completo in Banca Dati" nel Centralino, per recuperare i vecchi item "Completo"
creati prima di questa funzione.

--- VISIONI (Feedback ADV) (menu sotto Centralino) ---
Elenco delle visite effettuate. Colonne: Nome & Cognome, Telefono, Mail, Incarico Ufficio, Feedback ADV
(Interessa/Valuta/Non Interessa), Testo Feedback, Valore Percepito, e un pulsante "Copia link" che genera un
link unico da mandare al cliente (via WhatsApp/mail) per fargli compilare da solo il proprio feedback dopo la visita,
senza bisogno di accedere al CRM.

--- CONSULENTI ---
Anagrafica di tutti i consulenti: nome, username/password di accesso, mail, telefono, ID Telegram/WhatsApp,
foto profilo (caricabile anche dal computer), ruolo, permessi di visibilità su aree e altri consulenti.

--- CAPITALE SOCIALE ---
Anagrafica Proprietari: tutte le persone censite con le case collegate. Unità Rimosse: archivio storico di
unità che hanno cambiato nominativo.

--- ESPLORATORE TERRITORIO (Stradario) ---
Censimento strutturato per Comune ➔ Via ➔ Civico ➔ Citofono, con proprietario collegato e stato (Residente,
Vuoto, Locato, Abitato da Familiare).

--- ALTRE SCHEDE ---
Concorrenza (annunci di altre agenzie), To Do List (task dei consulenti), Oby (calcolo budget/target individuale
in base a provvigione desiderata).

--- BROCHURE PDF ---
Dall'incarico (popup Allegati): "Genera Brochure Stampabile" crea 4 pagine A4 verticali in ordine di stampa a
libretto (foglio1: pag4+pag1, foglio2: pag2+pag3); "Genera Brochure Web" crea le stesse 4 pagine in ordine
normale di lettura. In entrambi i casi si apre la finestra di stampa del browser: bisogna scegliere
"Salva come PDF" come destinazione.

--- PAGINE PUBBLICHE (fuori dal CRM, per clienti esterni) ---
"Report Proprietario": pagina dove un proprietario, con username/password dedicati (impostati nel popup Allegati
del suo incarico), vede solo conteggi aggregati (mai nomi) di richieste e visioni sul suo immobile.
"Feedback Visita": pagina dove un cliente, tramite link unico generato da una riga di Visioni, compila da solo
il proprio giudizio sulla visita appena fatta.
`.trim();

/* Dice se la lettura delle foto puo' funzionare: quale modello, se la chiave
   c'e', e cosa risponde Google. Serve quando qualcosa non va e non si vuole
   tirare a indovinare. */
app.get('/api/pubblico/prova-visione', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(200).json({ funziona: false, motivo: 'GEMINI_API_KEY non configurata su Render' });
  }
  try {
    const elenco = await new Promise((risolvi, rifiuta) => {
      https.get({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models?key=${GEMINI_API_KEY}`
      }, (r) => { let d = ''; r.on('data', p => d += p); r.on('end', () => risolvi(d)); })
      .on('error', rifiuta);
    });
    const dati = JSON.parse(elenco);
    if (dati.error) {
      return res.status(200).json({ funziona: false, modello: GEMINI_MODEL, motivo: dati.error.message });
    }
    const nomi = (dati.models || []).map(m => String(m.name || '').replace('models/', ''));
    const cercato = GEMINI_MODEL;
    return res.status(200).json({
      funziona: nomi.indexOf(cercato) >= 0,
      modelloImpostato: cercato,
      esiste: nomi.indexOf(cercato) >= 0,
      motivo: nomi.indexOf(cercato) >= 0 ? 'tutto a posto' : 'il modello impostato non è fra quelli disponibili',
      /* quali modelli vedono le immagini: serve a scegliere il sostituto */
      disponibili: nomi.filter(n => /flash|pro/.test(n)).slice(0, 12)
    });
  } catch (err) {
    res.status(200).json({ funziona: false, motivo: err.message });
  }
});

app.post('/api/analizza-citofono', async (req, res) => {
  try {
    const { immagineBase64, tipoMime, messaggio, soloNomi } = req.body;
    if (!immagineBase64) return res.status(400).json({ error: 'Immagine mancante' });

    /* Chiamata dal civico l'indirizzo lo sappiamo gia': chiedere al modello
       di indovinarlo e' lavoro sprecato, e un indirizzo inventato confonde
       chi legge la risposta. In quel caso si chiedono solo i nomi. */
    if (soloNomi) {
      const soloElenco = `Guarda questa foto di una pulsantiera citofonica.
Estrai TUTTI i nomi scritti sulle targhette, uno per pulsante, nell'ordine in cui
compaiono dall'alto verso il basso. Riportali esattamente come sono scritti, anche
se poco chiari: fai la tua migliore lettura e non inventare nomi che non vedi.
Se una targhetta è vuota o illeggibile, saltala.
Rispondi SOLO con un oggetto JSON valido: {"nomi": ["nome1", "nome2"]}`;

      const corpo = JSON.stringify({
        contents: [{ role: 'user', parts: [
          { text: soloElenco },
          { inline_data: { mime_type: tipoMime || 'image/jpeg', data: immagineBase64 } }
        ] }],
        generationConfig: { responseMimeType: 'application/json' }
      });

      const risposta = await new Promise((risolvi, rifiuta) => {
        const r = https.request({
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) }
        }, (x) => { let d = ''; x.on('data', p => d += p); x.on('end', () => risolvi(d)); });
        r.on('error', rifiuta); r.write(corpo); r.end();
      });

      let dati;
      try { dati = JSON.parse(risposta); }
      catch (e) {
        console.error('Risposta illeggibile:', String(risposta).slice(0, 300));
        return res.status(502).json({ error: 'Risposta illeggibile dal modello' });
      }

      /* Google spiega sempre perche' rifiuta: chiave assente, modello che non
         esiste piu', quota finita. Riportarlo evita di tirare a indovinare. */
      if (dati.error) {
        console.error('Lettura rifiutata:', JSON.stringify(dati.error).slice(0, 400));
        await segnaNelDiario('gemini', 'errore', 'lettura pulsantiera',
          dati.error.message, messaggio || '');
        return res.status(502).json({
          error: dati.error.message || 'Il modello ha rifiutato la richiesta',
          modello: GEMINI_MODEL,
          chiaveConfigurata: !!GEMINI_API_KEY
        });
      }

      const testo = dati && dati.candidates && dati.candidates[0] &&
                    dati.candidates[0].content && dati.candidates[0].content.parts &&
                    dati.candidates[0].content.parts[0] && dati.candidates[0].content.parts[0].text;
      if (!testo) {
        console.error('Risposta inattesa dalla lettura:', JSON.stringify(dati).slice(0, 400));
        return res.status(502).json({
          error: 'Il modello non ha restituito nomi',
          modello: GEMINI_MODEL,
          chiaveConfigurata: !!GEMINI_API_KEY,
          dettaglio: JSON.stringify(dati).slice(0, 200)
        });
      }

      let estratto;
      try { estratto = JSON.parse(testo); }
      catch (e) {
        await segnaNelDiario('gemini', 'errore', 'lettura pulsantiera',
          'risposta in formato inatteso', messaggio || '');
        return res.status(502).json({ error: 'Il modello ha risposto in un formato inatteso' });
      }
      const nomiLetti = (estratto.nomi || []).filter(n => String(n).trim());
      await segnaNelDiario('gemini', nomiLetti.length ? 'ok' : 'scartato', 'lettura pulsantiera',
        nomiLetti.length ? nomiLetti.length + ' nomi letti' : 'nessun nome riconosciuto',
        messaggio || '');
      return res.status(200).json({ nomi: nomiLetti });
    }

    const promptEstrazione = `Guarda questa foto di una targa/bussola citofonica di un condominio. Estrai TUTTI i nomi
scritti su ciascun pulsante/etichetta, uno per uno, esattamente come sono scritti (anche se poco chiari, fai la tua
migliore lettura). L'utente ha scritto questo messaggio insieme alla foto, che potrebbe contenere l'indirizzo
(comune, via, civico) a cui questi nomi vanno associati: "${messaggio || ''}".

Rispondi SOLO con un oggetto JSON valido, senza testo aggiuntivo, in questo formato esatto:
{"comune": "nome comune o stringa vuota se non capito", "via": "nome via o stringa vuota se non capito", "civico": "numero civico o stringa vuota se non capito", "nomi": ["nome1", "nome2", "..."]}`;

    const corpoRichiesta = JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { text: promptEstrazione },
          { inline_data: { mime_type: tipoMime || 'image/jpeg', data: immagineBase64 } }
        ]
      }],
      generationConfig: { responseMimeType: 'application/json' }
    });

    const rispostaGemini = await new Promise((risolvi, rifiuta) => {
      const opzioni = {
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpoRichiesta) }
      };
      const richiesta = https.request(opzioni, (r) => {
        let dati = '';
        r.on('data', (pezzo) => dati += pezzo);
        r.on('end', () => risolvi(dati));
      });
      richiesta.on('error', rifiuta);
      richiesta.write(corpoRichiesta);
      richiesta.end();
    });

    const dati = JSON.parse(rispostaGemini);
    const testoRisposta = dati?.candidates?.[0]?.content?.parts?.[0]?.text || null;
    if (!testoRisposta) {
      console.error('Risposta Gemini inattesa (citofono):', JSON.stringify(dati));
      return res.status(500).json({ error: 'Risposta non valida da Gemini', dettaglio: dati });
    }
    const estrazione = JSON.parse(testoRisposta);
    res.status(200).json(estrazione);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/assistente-crm', async (req, res) => {
  try {
    const { messaggio, storico } = req.body;
    if (!messaggio) return res.status(400).json({ error: 'Messaggio mancante' });

    const contenutiChat = [
      ...(Array.isArray(storico) ? storico : []).map(m => ({ role: m.ruolo === 'assistente' ? 'model' : 'user', parts: [{ text: m.testo }] })),
      { role: 'user', parts: [{ text: messaggio }] }
    ];

    const corpoRichiesta = JSON.stringify({
      contents: contenutiChat,
      systemInstruction: { parts: [{ text: GUIDA_CRM_FORTE }] }
    });

    const rispostaGemini = await new Promise((risolvi, rifiuta) => {
      const opzioni = {
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpoRichiesta) }
      };
      const richiesta = https.request(opzioni, (r) => {
        let dati = '';
        r.on('data', (pezzo) => dati += pezzo);
        r.on('end', () => risolvi(dati));
      });
      richiesta.on('error', rifiuta);
      richiesta.write(corpoRichiesta);
      richiesta.end();
    });

    const dati = JSON.parse(rispostaGemini);
    const testoRisposta = dati?.candidates?.[0]?.content?.parts?.[0]?.text || null;
    if (!testoRisposta) {
      console.error('Risposta Gemini inattesa:', JSON.stringify(dati));
      return res.status(500).json({ error: 'Risposta non valida da Gemini', dettaglio: dati });
    }
    res.status(200).json({ risposta: testoRisposta });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================
   ROTTA PUBBLICA: REPORT PROPRIETARIO (SOLO DATI AGGREGATI, NESSUN NOME)
   Pensata per essere condivisa con il proprietario di un immobile: mostra solo conteggi
   (Richieste per Stato ADV FIX, Visioni per Feedback ADV), mai nomi o contatti dei clienti.
   Protetta da una password semplice condivisa (cambiala qui sotto quando vuoi).
========================================== */
const PASSWORD_REPORT_PROPRIETARIO = 'Forte2026'; // non più usata per il controllo, lasciata solo come riferimento storico
app.get('/api/report-proprietario/:idElemento', async (req, res) => {
  try {
    const idElemento = req.params.idElemento;
    const incarico = await Incarico.findOne({ idElemento });
    if (!incarico) return res.status(404).json({ error: 'Immobile non trovato' });

    if (!incarico.reportUsername || !incarico.reportPassword) {
      return res.status(403).json({ error: 'Report non ancora attivato per questo immobile' });
    }
    if (req.query.username !== incarico.reportUsername || req.query.password !== incarico.reportPassword) {
      return res.status(401).json({ error: 'Username o password errati' });
    }

    const richieste = await BancaDati.find({ immobileFonteRichiesta: idElemento });
    const visioni = await Visioni.find({ incaricoUfficio: idElemento });

    const contaPerCampo = (elenco, campo) => {
      const conteggio = {};
      elenco.forEach(item => {
        const valore = item[campo] || 'Non specificato';
        conteggio[valore] = (conteggio[valore] || 0) + 1;
      });
      return conteggio;
    };

    const gd = incarico.gestioneDocumenti || {};
    const venditori = gd.venditori || [];

    res.status(200).json({
      indirizzo: incarico.posizione || incarico.nome || '',
      richieste: { totale: richieste.length, perStato: contaPerCampo(richieste, 'statoAdvFix') },
      visioni: { totale: visioni.length, perFeedback: contaPerCampo(visioni, 'feedbackAdv') },
      gestioneProcesso: {
        dataInizio: incarico.dataIncarico || '',
        dataFine: incarico.dataScadenza || '',
        dataPrimoOH: incarico.nextOpenHouse || gd.dataPrimoOH || '',
        fotoFatte: gd.fotoFatte === 'si',
        dataPubblicazionePrevista: gd.dataPubblicazione || '',
        pubblicato: {
          immobiliareIt: !!gd.linkImmobiliareIt,
          idealista: !!gd.linkIdealista,
          wikicasa: !!gd.linkWikicasa,
          immobiliareForte: !!gd.linkImmobiliareForte
        },
        documentiVenditori: { totale: venditori.length, completi: venditori.filter(v => v.cartaIdentita && v.codiceFiscale).length },
        documentiImmobile: {
          provenienzaFatta: !!gd.allegatoProvenienza,
          mutuoGestito: gd.mutuoPresente !== 'si' || !!gd.allegatoAttoMutuo,
          accessoAttiGestito: gd.accessoAttiFatto !== 'si' || !!gd.allegatoUrbanistica
        }
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================
   ROTTE API: VISIONI (FEEDBACK VISITE IMMOBILE)
========================================== */
app.get('/api/visioni', async (req, res) => {
  try {
    const elenco = await Visioni.find({}).sort({ createdAt: -1 });
    res.status(200).json(elenco);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/visioni', async (req, res) => {
  try {
    if (req.body.bancaDatiOrigineId) {
      const esistente = await Visioni.findOne({ bancaDatiOrigineId: req.body.bancaDatiOrigineId });
      if (esistente) return res.status(200).json({ status: 'success', data: esistente, duplicato: true });
    }
    const nuovo = new Visioni(req.body);
    res.status(201).json({ status: 'success', data: await nuovo.save() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/visioni/:id', async (req, res) => {
  try {
    const { campo, valore } = req.body;
    const aggiornamento = campo ? { [campo]: valore } : req.body;
    const aggiornato = await Visioni.findByIdAndUpdate(req.params.id, { $set: aggiornamento }, { new: true });
    if (!aggiornato) return res.status(404).json({ error: 'Voce non trovata' });
    res.status(200).json({ status: 'success', data: aggiornato });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/visioni/:id', async (req, res) => {
  try {
    const eliminato = await Visioni.findByIdAndDelete(req.params.id);
    if (!eliminato) return res.status(404).json({ error: 'Voce non trovata' });
    res.status(200).json({ status: 'success', message: 'Voce eliminata con successo' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================
   ROTTE API: PROPOSTE (create dalla scheda Visioni)
========================================== */
app.get('/api/proposte', async (req, res) => {
  try { res.status(200).json(await Proposta.find({}).sort({ createdAt: -1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/proposte', async (req, res) => {
  try {
    // Evita doppioni: se esiste già una proposta per quella Visione, la aggiorna invece di crearne un'altra
    const esistente = req.body.visioneOrigineId ? await Proposta.findOne({ visioneOrigineId: req.body.visioneOrigineId }) : null;
    if (esistente) {
      const aggiornata = await Proposta.findByIdAndUpdate(esistente._id, { $set: req.body }, { new: true });
      return res.status(200).json({ status: 'success', data: aggiornata });
    }
    const nuova = await new Proposta(req.body).save();
    res.status(201).json({ status: 'success', data: nuova });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/proposte/:id', async (req, res) => {
  try {
    const aggiornata = await Proposta.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    if (!aggiornata) return res.status(404).json({ error: 'Proposta non trovata' });
    res.status(200).json({ status: 'success', data: aggiornata });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
/* ==========================================
   ROTTE API: TRANSAZIONI (create dalle Proposte accettate)
========================================== */
/* ==========================================
   ROTTE API: PROFESSIONISTI (Capitale Sociale)
========================================== */
/* ==========================================
   ROTTE API: OPPORTUNITY e CDV
========================================== */
function registraRotteScheda(percorso, Modello, nomeUmano) {
  app.get(`/api/${percorso}`, async (req, res) => {
    try { res.status(200).json(await Modello.find({}).sort({ createdAt: -1 })); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post(`/api/${percorso}`, async (req, res) => {
    try { res.status(201).json({ status: 'success', data: await new Modello(req.body).save() }); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.put(`/api/${percorso}/:id`, async (req, res) => {
    try {
      const payload = (req.body && req.body.campo !== undefined)
        ? { [req.body.campo]: req.body.valore }
        : req.body;
      const aggiornato = await Modello.findByIdAndUpdate(req.params.id, { $set: payload }, { new: true });
      if (!aggiornato) return res.status(404).json({ error: `${nomeUmano} non trovato` });
      res.status(200).json({ status: 'success', data: aggiornato });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.delete(`/api/${percorso}/:id`, async (req, res) => {
    try {
      await Modello.findByIdAndDelete(req.params.id);
      res.status(200).json({ status: 'success' });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });
}

registraRotteScheda('opportunity', Opportunity, 'Opportunity');
registraRotteScheda('valutazioni', Valutazione, 'Valutazione');

/* ==========================================
   ROTTE API: ZONE OMI
========================================== */
/* Elenco: di default senza i perimetri, che sono pesanti e servono solo al server */
app.get('/api/zone-omi', async (req, res) => {
  try {
    const filtro = {};
    if (req.query.comune) filtro.comune = new RegExp('^' + req.query.comune.trim() + '$', 'i');
    if (req.query.semestre) filtro.semestre = req.query.semestre;
    const proiezione = req.query.conPerimetri === 'si' ? {} : { poligoni: 0 };
    res.status(200).json(await ZonaOmi.find(filtro, proiezione).sort({ comune: 1, zona: 1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Quali semestri sono caricati e con quante zone */
app.get('/api/zone-omi/semestri', async (req, res) => {
  try {
    const dati = await ZonaOmi.aggregate([
      { $group: { _id: '$semestre', zone: { $sum: 1 }, comuni: { $addToSet: '$comune' },
                  conQuotazione: { $sum: { $cond: [{ $gt: ['$quotazioneMin', ''] }, 1, 0] } } } },
      { $project: { semestre: '$_id', zone: 1, conQuotazione: 1, comuni: { $size: '$comuni' }, _id: 0 } },
      { $sort: { semestre: -1 } }
    ]);
    res.status(200).json(dati);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* In quale zona OMI cade un punto: il calcolo pesante resta sul server */
app.get('/api/zone-omi/cerca', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
    if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'Servono lat e lng' });

    const filtro = {};
    if (req.query.comune) filtro.comune = new RegExp('^' + req.query.comune.trim() + '$', 'i');
    if (req.query.semestre) filtro.semestre = req.query.semestre;
    const candidate = await ZonaOmi.find(filtro);

    for (const z of candidate) {
      for (const anello of (z.poligoni || [])) {
        if (puntoDentroPoligono(lng, lat, anello)) {
          const { poligoni, ...senzaGeometria } = z.toObject();
          return res.status(200).json({ trovata: true, zona: senzaGeometria });
        }
      }
    }
    res.status(200).json({ trovata: false, zoneEsaminate: candidate.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Import massivo dei perimetri: arriva a lotti dal CRM */
app.post('/api/zone-omi/massivo', async (req, res) => {
  try {
    const zone = Array.isArray(req.body) ? req.body : (req.body.zone || []);
    if (!zone.length) return res.status(400).json({ error: 'Nessuna zona ricevuta' });

    let inserite = 0, aggiornate = 0;
    for (const z of zone) {
      if (!z.comune || !z.zona || !z.semestre) continue;
      const esistente = await ZonaOmi.findOne({ comune: z.comune, zona: z.zona, semestre: z.semestre });
      if (esistente) {
        // i perimetri si aggiornano, le quotazioni gia' inserite non si toccano
        esistente.poligoni = z.poligoni || esistente.poligoni;
        esistente.codiceComune = z.codiceComune || esistente.codiceComune;
        await esistente.save();
        aggiornate++;
      } else {
        await new ZonaOmi(z).save();
        inserite++;
      }
    }
    res.status(200).json({ status: 'success', inserite, aggiornate });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* Import massivo delle quotazioni: arrivano dal CSV ufficiale dell'Agenzia.
   Si abbinano alle zone gia' caricate per comune + sigla zona. */
app.post('/api/zone-omi/quotazioni', async (req, res) => {
  try {
    const righe = Array.isArray(req.body) ? req.body : (req.body.righe || []);
    if (!righe.length) return res.status(400).json({ error: 'Nessuna quotazione ricevuta' });

    let aggiornate = 0, nonAbbinate = 0;
    for (const r of righe) {
      if (!r.comune || !r.zona) continue;
      const filtro = {
        comune: new RegExp('^' + String(r.comune).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'),
        zona: new RegExp('^' + String(r.zona).trim() + '$', 'i')
      };
      if (r.semestre) filtro.semestre = r.semestre;

      const payload = {};
      if (r.quotazioneMin !== undefined) payload.quotazioneMin = String(r.quotazioneMin);
      if (r.quotazioneMax !== undefined) payload.quotazioneMax = String(r.quotazioneMax);
      if (r.quotazioneTipologia) payload.quotazioneTipologia = r.quotazioneTipologia;
      if (r.quotazioneStato) payload.quotazioneStato = r.quotazioneStato;

      const esito = await ZonaOmi.updateMany(filtro, { $set: payload });
      if (esito.matchedCount > 0) aggiornate += esito.matchedCount; else nonAbbinate++;
    }
    res.status(200).json({ status: 'success', aggiornate, nonAbbinate });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* Aggiornamento di una singola zona (tipicamente le quotazioni) */
app.put('/api/zone-omi/:id', async (req, res) => {
  try {
    const payload = (req.body && req.body.campo !== undefined) ? { [req.body.campo]: req.body.valore } : req.body;
    const aggiornata = await ZonaOmi.findByIdAndUpdate(req.params.id, { $set: payload }, { new: true, projection: { poligoni: 0 } });
    if (!aggiornata) return res.status(404).json({ error: 'Zona non trovata' });
    res.status(200).json({ status: 'success', data: aggiornata });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* ==========================================
   MERCATO DEL COMUNE — volumi di compravendita OMI
   Il NTN (numero transazioni normalizzate) e' annuale e per comune.
   Caricando piu' annualita' si ottiene l'andamento nel tempo.
========================================== */
const MercatoComuneSchema = new mongoose.Schema({
  comune: { type: String, default: '' },
  codiceComune: { type: String, default: '' },   // codice catastale, es. E514
  provincia: { type: String, default: '' },
  anno: { type: String, default: '' },
  ntn: { type: Number, default: 0 },             // transazioni residenziali dell'anno
  fasce: { type: Object, default: {} },          // ripartizione per superficie
  tagliaMercato: { type: String, default: '' }   // S, M, L come classificata dall'Agenzia
}, { timestamps: true });
MercatoComuneSchema.index({ codiceComune: 1, anno: 1 }, { unique: true });
const MercatoComune = mongoose.model('MercatoComune', MercatoComuneSchema);

app.get('/api/mercato', async (req, res) => {
  try {
    const filtro = {};
    if (req.query.comune) filtro.comune = new RegExp('^' + String(req.query.comune).trim() + '$', 'i');
    res.status(200).json(await MercatoComune.find(filtro).sort({ comune: 1, anno: 1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/mercato/massivo', async (req, res) => {
  try {
    const righe = Array.isArray(req.body) ? req.body : [];
    if (!righe.length) return res.status(400).json({ error: 'Nessun dato ricevuto' });

    let inserite = 0, aggiornate = 0;
    for (const r of righe) {
      if (!r.codiceComune || !r.anno) continue;
      const esistente = await MercatoComune.findOne({ codiceComune: r.codiceComune, anno: String(r.anno) });
      if (esistente) {
        Object.assign(esistente, r, { anno: String(r.anno) });
        await esistente.save(); aggiornate++;
      } else {
        await new MercatoComune(Object.assign({}, r, { anno: String(r.anno) })).save(); inserite++;
      }
    }
    res.status(200).json({ status: 'success', inserite, aggiornate });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/mercato/anno/:anno', async (req, res) => {
  try {
    const esito = await MercatoComune.deleteMany({ anno: req.params.anno });
    res.status(200).json({ status: 'success', eliminate: esito.deletedCount });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* ==========================================
   ROTTE PUBBLICHE PER LA LANDING DI VALUTAZIONE
   Espongono il minimo indispensabile: zone con quotazioni e coefficienti.
   Nessun dato di clienti, incarichi o consulenti passa di qui.
========================================== */
app.get('/api/pubblico/valutazione-dati', async (req, res) => {
  try {
    const zone = await ZonaOmi.find({ quotazioneMin: { $nin: ['', null] } },
      { comune: 1, zona: 1, descrizioneZona: 1, quotazioneMin: 1, quotazioneMax: 1, semestre: 1, _id: 0 })
      .sort({ comune: 1, zona: 1 });

    await seminaCoefficienti();
    const coefficienti = await Coefficiente.find({}, { famiglia: 1, voce: 1, valore: 1, _id: 0 }).sort({ famiglia: 1, ordine: 1 });

    const mercato = await MercatoComune.find({}, { comune: 1, anno: 1, ntn: 1, fasce: 1, tagliaMercato: 1, _id: 0 })
      .sort({ comune: 1, anno: 1 });

    res.set('Cache-Control', 'public, max-age=3600');   // cambia due volte l'anno: inutile richiederlo ogni volta
    res.status(200).json({ zone, coefficienti, mercato });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Servizi vicini all'indirizzo, per la pagina "dove si trova" del documento.
   La chiave Google resta sul server: la pagina pubblica non la vede mai. */
const CHIAVE_GOOGLE = process.env.GOOGLE_MAPS_KEY || '';

app.get('/api/pubblico/dintorni', async (req, res) => {
  try {
    if (!CHIAVE_GOOGLE) return res.status(200).json({ attivo: false, punti: [] });
    const indirizzo = String(req.query.indirizzo || '').trim();
    if (!indirizzo) return res.status(400).json({ error: 'Indirizzo mancante' });

    const chiedi = (url) => new Promise((risolvi, rifiuta) => {
      https.get(url, r => {
        let corpo = '';
        r.on('data', c => corpo += c);
        r.on('end', () => { try { risolvi(JSON.parse(corpo)); } catch (e) { rifiuta(e); } });
      }).on('error', rifiuta);
    });

    const geo = await chiedi('https://maps.googleapis.com/maps/api/geocode/json?address=' +
      encodeURIComponent(indirizzo) + '&region=it&components=country:IT&key=' + CHIAVE_GOOGLE);
    if (!geo.results || !geo.results[0]) return res.status(200).json({ attivo: true, punti: [] });
    const punto = geo.results[0].geometry.location;

    /* Una categoria per volta, tenendo il piu' vicino: e' quello che interessa a chi compra */
    const categorie = [
      { tipo: 'transit_station', etichetta: 'Trasporto pubblico' },
      { tipo: 'supermarket', etichetta: 'Supermercato' },
      { tipo: 'school', etichetta: 'Scuola' },
      { tipo: 'pharmacy', etichetta: 'Farmacia' },
      { tipo: 'park', etichetta: 'Verde pubblico' }
    ];

    const distanza = (a, b) => {
      const R = 6371000, rad = g => g * Math.PI / 180;
      const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
      const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
      return Math.round(R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)));
    };

    const punti = [];
    for (const c of categorie) {
      try {
        const r = await chiedi('https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=' +
          punto.lat + ',' + punto.lng + '&rankby=distance&type=' + c.tipo + '&key=' + CHIAVE_GOOGLE);
        const primo = (r.results || [])[0];
        if (primo) punti.push({
          categoria: c.etichetta, nome: primo.name,
          metri: distanza(punto, primo.geometry.location)
        });
      } catch (e) { /* una categoria che manca non ferma le altre */ }
    }

    res.set('Cache-Control', 'public, max-age=86400');
    res.status(200).json({ attivo: true, lat: punto.lat, lng: punto.lng, punti });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* La mappa statica passa dal server per non esporre la chiave */
app.get('/api/pubblico/mappa', async (req, res) => {
  try {
    if (!CHIAVE_GOOGLE) return res.status(404).send('mappa non configurata');
    const indirizzo = encodeURIComponent(String(req.query.indirizzo || '').trim());
    if (!indirizzo) return res.status(400).send('indirizzo mancante');
    const url = 'https://maps.googleapis.com/maps/api/staticmap?center=' + indirizzo +
      '&zoom=15&size=640x320&scale=2&language=it&maptype=roadmap' +
      '&markers=color:0x0B3B4A%7Clabel:%7C' + indirizzo + '&key=' + CHIAVE_GOOGLE;
    https.get(url, r => {
      res.set('Content-Type', r.headers['content-type'] || 'image/png');
      res.set('Cache-Control', 'public, max-age=86400');
      r.pipe(res);
    }).on('error', () => res.status(502).send('mappa non disponibile'));
  } catch (err) { res.status(500).send(err.message); }
});

/* Gli annunci attualmente in pubblicita' nel comune, per la pagina comparabili.
   Vengono dall'archivio Concorrenza: sono annunci pubblici, ma esco solo con
   indirizzo, superficie e prezzo, senza il nome dell'agenzia che li pubblica. */
app.get('/api/pubblico/comparabili', async (req, res) => {
  try {
    const comune = String(req.query.comune || '').trim();
    if (!comune) return res.status(400).json({ error: 'Comune mancante' });

    /* Il comune puo' stare nel campo suo oppure, sui record piu' vecchi, dentro
       l'indirizzo completo: cerco in tutti e due, altrimenti l'archivio sembra vuoto. */
    const pulito = comune.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const righe = await Concorrenza.find({
      $or: [
        { comune: new RegExp('^' + pulito + '$', 'i') },
        { paeseVia: new RegExp(pulito, 'i') }
      ],
      statoAnnuncio: { $nin: ['Venduto', 'Ritirato'] },
      /* niente "Prezzo su richiesta": senza una cifra non si confronta nulla.
         Il filtro sta nella domanda al database, non dopo: cosi' non rischio di
         pescare sessanta annunci senza prezzo e restituire una lista vuota. */
      prezzo: { $regex: '[0-9]' }
    }, { via: 1, civico: 1, comune: 1, paeseVia: 1, prezzo: 1, unita: 1, piano: 1, bagni: 1, contesto: 1,
         link: 1, agenzia: 1, privato: 1, dataAnnuncio: 1, _id: 0 })
      .sort({ updatedAt: -1 }).limit(300);

    const numero = (v) => Number(String(v == null ? '' : v).replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.')) || 0;
    /* L'archivio Concorrenza non registra la superficie: restituisco quello che c'e'
       e lascia che sia il consulente a scrivere i metri per gli annunci che sceglie.
       Prima filtravo su un prezzo al metro che non poteva mai esistere, e il risultato
       era sempre vuoto. */
    const utili = righe
      .map(r => {
        const prezzo = numero(r.prezzo);
        /* se via e civico non sono compilati uso l'indirizzo completo del vecchio formato */
        const indirizzo = [r.via, r.civico].filter(x => x && x !== 'N.D.').join(' ').trim();
        return { via: indirizzo || (r.paeseVia || ''), civico: '', comune: r.comune || '',
                 prezzo: prezzo, mq: 0, tipo: r.unita || '', piano: r.piano || '',
                 bagni: r.bagni || '', contesto: r.contesto || '', link: r.link || '',
                 fonte: (r.privato ? 'Privato' : (r.agenzia || 'Agenzia')),
                 data: r.dataAnnuncio || '', alMq: 0 };
      })
      .filter(r => r.prezzo > 0)
      .sort((a, b) => a.prezzo - b.prezzo)
      .slice(0, 12);

    res.set('Cache-Control', 'public, max-age=900');
    res.status(200).json(utili);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Un solo documento, per chi apre il link o inquadra il codice.
   Restituisce quella valutazione e il contorno che serve a comporre il fascicolo:
   nient'altro. Le altre valutazioni non escono da qui. */
app.get('/api/pubblico/documento/:riferimento', async (req, res) => {
  try {
    const riferimento = String(req.params.riferimento || '').trim();
    let valutazione = null;

    if (/^[0-9a-fA-F]{24}$/.test(riferimento)) {
      valutazione = await Valutazione.findById(riferimento);
    }
    /* si puo' arrivare anche col numero di pratica, che finisce con le ultime sei cifre */
    if (!valutazione) {
      const coda = riferimento.split('-').pop().toLowerCase();
      if (coda.length >= 4) {
        const candidate = await Valutazione.find({}, { _id: 1 }).sort({ createdAt: -1 }).limit(500);
        const trovata = candidate.find(v => String(v._id).slice(-coda.length).toLowerCase() === coda);
        if (trovata) valutazione = await Valutazione.findById(trovata._id);
      }
    }
    if (!valutazione) return res.status(404).json({ error: 'Documento non trovato' });

    const v = valutazione.toObject();
    delete v.__v;

    await seminaCoefficienti();
    const coefficienti = await Coefficiente.find({}, { famiglia: 1, voce: 1, valore: 1, _id: 0 }).sort({ famiglia: 1, ordine: 1 });

    /* solo la zona di questo immobile, non tutte */
    const zona = v.comune && v.zonaOmi
      ? await ZonaOmi.findOne({
          comune: new RegExp('^' + String(v.comune).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'),
          zona: new RegExp('^' + String(v.zonaOmi) + '$', 'i')
        }, { comune: 1, zona: 1, descrizioneZona: 1, quotazioneMin: 1, quotazioneMax: 1, semestre: 1, _id: 0 })
      : null;

    const mercato = v.comune
      ? await MercatoComune.find({ comune: new RegExp('^' + String(v.comune) + '$', 'i') },
          { comune: 1, anno: 1, ntn: 1, fasce: 1, tagliaMercato: 1, _id: 0 }).sort({ anno: 1 })
      : [];

    const consulente = v.consulente
      ? await Consulente.findOne({ utente: v.consulente },
          { nomeCognome: 1, ruolo: 1, telefono: 1, mail: 1, fotoProfilo: 1, utente: 1, _id: 0 })
      : null;

    res.set('Cache-Control', 'public, max-age=300');
    res.status(200).json({ valutazione: v, zona, coefficienti, mercato, consulente });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================
   RITOCCO DELLE FOTO — piu' fornitori, uno solo attivo
   Il modello che modifica le immagini si sceglie con una variabile d'ambiente:
   se domani ne esce uno migliore o piu' economico si cambia su Render senza
   toccare il codice. Le chiavi restano tutte qui: la pagina non ne vede nessuna.
========================================== */
const FORNITORE_IMMAGINI = process.env.FORNITORE_IMMAGINI || 'gemini';

const GEMINI_MODELLI_IMMAGINI = (process.env.GEMINI_MODELLO_IMMAGINI
  ? [process.env.GEMINI_MODELLO_IMMAGINI]
  : ['gemini-2.5-flash-image', 'gemini-2.0-flash-preview-image-generation', 'gemini-3.1-flash-image']);

const FAL_API_KEY = process.env.FAL_API_KEY || '';
const FAL_MODELLO = process.env.FAL_MODELLO || 'fal-ai/flux-pro/kontext';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODELLO_IMMAGINI = process.env.OPENAI_MODELLO_IMMAGINI || 'gpt-image-1';

/* Una richiesta HTTP che restituisce testo, con i reindirizzamenti seguiti */
function chiediHttp(opzioni, corpo) {
  return new Promise((risolvi, rifiuta) => {
    const richiesta = https.request(opzioni, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        return chiediHttp(r.headers.location, null).then(risolvi, rifiuta);
      }
      let pezzi = [];
      r.on('data', c => pezzi.push(c));
      r.on('end', () => risolvi({ stato: r.statusCode, corpo: Buffer.concat(pezzi) }));
    });
    richiesta.on('error', rifiuta);
    if (corpo) richiesta.write(corpo);
    richiesta.end();
  });
}

/* --- Gemini: stesso servizio dell'assistente, con un modello che sa disegnare --- */
async function ritoccaConGemini(immagine, tipoMime, istruzioni) {
  if (!GEMINI_API_KEY) throw new Error('Chiave Gemini non configurata sul server');

  const corpo = JSON.stringify({
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: tipoMime || 'image/jpeg', data: immagine } },
      { text: istruzioni }
    ] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
  });

  const tentativi = [];
  for (const modello of GEMINI_MODELLI_IMMAGINI) {
    let risposta;
    try {
      risposta = await chiediHttp({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${modello}:generateContent?key=${GEMINI_API_KEY}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) }
      }, corpo);
    } catch (e) { tentativi.push(`${modello}: ${e.message}`); continue; }

    let dati;
    try { dati = JSON.parse(risposta.corpo.toString()); }
    catch (e) { tentativi.push(`${modello}: risposta illeggibile`); continue; }

    if (dati.error) { tentativi.push(`${modello}: ${dati.error.message || 'rifiutata'}`); continue; }

    const parti = ((dati.candidates || [])[0] || {}).content ? dati.candidates[0].content.parts || [] : [];
    const tornata = parti.filter(p => p.inlineData || p.inline_data)[0];
    if (!tornata) { tentativi.push(`${modello}: nessuna immagine restituita`); continue; }

    const dato = tornata.inlineData || tornata.inline_data;
    return {
      immagine: dato.data,
      tipoMime: dato.mimeType || dato.mime_type || 'image/png',
      commento: parti.filter(p => p.text).map(p => p.text).join(' ').trim(),
      modello: modello
    };
  }

  const quotaZero = tentativi.some(x => /quota|limit: 0|billing/i.test(x));
  const errore = new Error(quotaZero
    ? 'Nessun modello Gemini disponibile con questa chiave nel piano gratuito: serve attivare la fatturazione, oppure passare a un altro fornitore.'
    : 'Nessun modello Gemini ha prodotto l\'immagine.');
  errore.dettaglio = tentativi;
  throw errore;
}

/* --- fal.ai: ospita FLUX Kontext, pensato apposta per modificare immagini --- */
async function ritoccaConFal(immagine, tipoMime, istruzioni) {
  if (!FAL_API_KEY) throw new Error('Chiave fal.ai non configurata sul server');

  const corpo = JSON.stringify({
    prompt: istruzioni,
    image_url: `data:${tipoMime || 'image/jpeg'};base64,${immagine}`,
    num_images: 1,
    output_format: 'jpeg',
    safety_tolerance: '2'
  });

  const risposta = await chiediHttp({
    hostname: 'fal.run',
    path: '/' + FAL_MODELLO,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Key ' + FAL_API_KEY,
      'Content-Length': Buffer.byteLength(corpo)
    }
  }, corpo);

  const dati = JSON.parse(risposta.corpo.toString());
  if (risposta.stato !== 200) throw new Error(dati.detail || dati.error || 'fal.ai ha risposto ' + risposta.stato);

  const prima = (dati.images || [])[0];
  if (!prima || !prima.url) throw new Error('fal.ai non ha restituito nessuna immagine');

  /* torna un indirizzo: lo scarico io e lo passo come dato, cosi' il CRM
     non deve parlare con un dominio in piu' */
  const scaricata = await chiediHttp(prima.url, null);
  return {
    immagine: scaricata.corpo.toString('base64'),
    tipoMime: prima.content_type || 'image/jpeg',
    commento: '',
    modello: FAL_MODELLO
  };
}

/* --- OpenAI: gpt-image accetta istruzioni a parole su un'immagine caricata --- */
async function ritoccaConOpenAi(immagine, tipoMime, istruzioni) {
  if (!OPENAI_API_KEY) throw new Error('Chiave OpenAI non configurata sul server');

  /* il formato richiede un invio a pezzi: lo compongo a mano per non
     aggiungere librerie al progetto */
  const confine = '----forte' + Date.now();
  const pezzo = (nome, valore) =>
    Buffer.from(`--${confine}\r\nContent-Disposition: form-data; name="${nome}"\r\n\r\n${valore}\r\n`);

  const corpo = Buffer.concat([
    pezzo('model', OPENAI_MODELLO_IMMAGINI),
    pezzo('prompt', istruzioni),
    pezzo('n', '1'),
    pezzo('size', 'auto'),
    Buffer.from(`--${confine}\r\nContent-Disposition: form-data; name="image"; filename="foto.jpg"\r\n` +
                `Content-Type: ${tipoMime || 'image/jpeg'}\r\n\r\n`),
    Buffer.from(immagine, 'base64'),
    Buffer.from(`\r\n--${confine}--\r\n`)
  ]);

  const risposta = await chiediHttp({
    hostname: 'api.openai.com',
    path: '/v1/images/edits',
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + OPENAI_API_KEY,
      'Content-Type': 'multipart/form-data; boundary=' + confine,
      'Content-Length': corpo.length
    }
  }, corpo);

  const dati = JSON.parse(risposta.corpo.toString());
  if (risposta.stato !== 200) throw new Error((dati.error && dati.error.message) || 'OpenAI ha risposto ' + risposta.stato);

  const prima = (dati.data || [])[0];
  if (!prima || !prima.b64_json) throw new Error('OpenAI non ha restituito nessuna immagine');
  return { immagine: prima.b64_json, tipoMime: 'image/png', commento: '', modello: OPENAI_MODELLO_IMMAGINI };
}

const FORNITORI_IMMAGINI = {
  gemini: ritoccaConGemini,
  fal: ritoccaConFal,
  openai: ritoccaConOpenAi
};

app.post('/api/foto-ritocco', async (req, res) => {
  try {
    const { immagine, tipoMime, richiesta } = req.body || {};
    if (!immagine) return res.status(400).json({ error: 'Immagine mancante' });
    if (!richiesta || !String(richiesta).trim()) return res.status(400).json({ error: 'Manca la descrizione della modifica' });

    /* I vincoli di contorno valgono per qualunque fornitore: senza, il modello
       reinventa la stanza, e una foto che non corrisponde all'immobile non si
       puo' pubblicare. */
    const istruzioni = [
      String(richiesta).trim(),
      '',
      'Vincoli da rispettare in ogni caso:',
      '- non modificare la struttura della stanza: pareti, finestre, porte, altezza dei soffitti e prospettiva restano identiche',
      '- non cambiare la vista dalle finestre',
      "- mantieni la stessa luce e le stesse ombre dell'originale",
      '- il risultato deve sembrare una fotografia reale della stessa stanza, non un rendering',
      '- non aggiungere testo, filigrane o loghi'
    ].join('\n');

    const ritocca = FORNITORI_IMMAGINI[FORNITORE_IMMAGINI];
    if (!ritocca) return res.status(500).json({ error: 'Fornitore immagini sconosciuto: ' + FORNITORE_IMMAGINI });

    const esito = await ritocca(immagine, tipoMime, istruzioni);
    res.status(200).json(Object.assign({ fornitore: FORNITORE_IMMAGINI }, esito));
  } catch (err) {
    console.error('Ritocco foto non riuscito:', err);
    res.status(502).json({ error: err.message, dettaglio: err.dettaglio || [], fornitore: FORNITORE_IMMAGINI });
  }
});

/* Dice quale fornitore e' attivo e quali chiavi risultano configurate */
app.get('/api/foto-ritocco/stato', (req, res) => {
  res.status(200).json({
    attivo: FORNITORE_IMMAGINI,
    disponibili: {
      gemini: !!GEMINI_API_KEY,
      fal: !!FAL_API_KEY,
      openai: !!OPENAI_API_KEY
    },
    modelli: { gemini: GEMINI_MODELLI_IMMAGINI, fal: FAL_MODELLO, openai: OPENAI_MODELLO_IMMAGINI }
  });
});

/* La libreria che converte le foto HEIC dell'iPhone./* La libreria che converte le foto HEIC dell'iPhone.
   Squarespace blocca gli script presi dai CDN pubblici, ma il CRM parla gia'
   con questo server: gliela serviamo da qui. La scarichiamo una volta sola
   e la teniamo in memoria. */
let LIBRERIA_HEIC = null;

/* La libreria dei codici da inquadrare, servita da qui: i CDN pubblici su
   Squarespace sono bloccati, questo dominio no. */
let LIBRERIA_QR = null;

app.get('/api/pubblico/qrcode.js', async (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=604800');
  res.set('Access-Control-Allow-Origin', '*');
  if (LIBRERIA_QR) return res.status(200).send(LIBRERIA_QR);

  const fonti = [
    'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js',
    'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js'
  ];
  const scarica = (url) => new Promise((risolvi, rifiuta) => {
    https.get(url, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        return scarica(r.headers.location).then(risolvi, rifiuta);
      }
      if (r.statusCode !== 200) { rifiuta(new Error('risposta ' + r.statusCode)); return; }
      let corpo = ''; r.setEncoding('utf8');
      r.on('data', c => corpo += c);
      r.on('end', () => risolvi(corpo));
    }).on('error', rifiuta);
  });

  for (const fonte of fonti) {
    try {
      const codice = await scarica(fonte);
      if (codice && codice.length > 3000) { LIBRERIA_QR = codice; return res.status(200).send(codice); }
    } catch (e) { console.error('Libreria QR non scaricata da', fonte, e.message); }
  }
  res.status(502).send('// libreria non disponibile');
});

app.get('/api/pubblico/heic2any.js', async (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=604800');
  res.set('Access-Control-Allow-Origin', '*');

  if (LIBRERIA_HEIC) return res.status(200).send(LIBRERIA_HEIC);

  const fonti = [
    'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js',
    'https://unpkg.com/heic2any@0.0.4/dist/heic2any.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/heic2any/0.0.1/index.min.js'
  ];

  const scarica = (url) => new Promise((risolvi, rifiuta) => {
    https.get(url, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        return scarica(r.headers.location).then(risolvi, rifiuta);
      }
      if (r.statusCode !== 200) { rifiuta(new Error('risposta ' + r.statusCode)); return; }
      let corpo = '';
      r.setEncoding('utf8');
      r.on('data', c => corpo += c);
      r.on('end', () => risolvi(corpo));
    }).on('error', rifiuta);
  });

  for (const fonte of fonti) {
    try {
      const codice = await scarica(fonte);
      if (codice && codice.length > 10000) {
        LIBRERIA_HEIC = codice;
        return res.status(200).send(codice);
      }
    } catch (e) { console.error('Libreria HEIC non scaricata da', fonte, e.message); }
  }
  res.status(502).send('// libreria non disponibile');
});

/* Diagnosi rapida dell'archivio Concorrenza per un comune: serve a capire
   se il problema e' che non ci sono annunci o che i campi sono compilati altrove. */
app.get('/api/pubblico/comparabili-diagnosi', async (req, res) => {
  try {
    const comune = String(req.query.comune || '').trim();
    const pulito = comune.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tutti = await Concorrenza.countDocuments();
    const conComune = comune ? await Concorrenza.countDocuments({ comune: new RegExp('^' + pulito + '$', 'i') }) : 0;
    const nellIndirizzo = comune ? await Concorrenza.countDocuments({ paeseVia: new RegExp(pulito, 'i') }) : 0;
    const attivi = comune ? await Concorrenza.countDocuments({
      $or: [{ comune: new RegExp('^' + pulito + '$', 'i') }, { paeseVia: new RegExp(pulito, 'i') }],
      statoAnnuncio: { $nin: ['Venduto', 'Ritirato'] }
    }) : 0;
    const esempio = await Concorrenza.findOne({}, { comune: 1, via: 1, civico: 1, paeseVia: 1, prezzo: 1, statoAnnuncio: 1, _id: 0 });

    const conPrezzo = comune ? await Concorrenza.countDocuments({
      $or: [{ comune: new RegExp('^' + pulito + '$', 'i') }, { paeseVia: new RegExp(pulito, 'i') }],
      statoAnnuncio: { $nin: ['Venduto', 'Ritirato'] },
      prezzo: { $regex: '[0-9]' }
    }) : 0;

    res.status(200).json({
      comuneCercato: comune,
      annunciTotali: tutti,
      conQuelComune: conComune,
      colComuneNellIndirizzo: nellIndirizzo,
      attiviTrovati: attivi,
      conPrezzoNumerico: conPrezzo,
      senzaPrezzo: attivi - conPrezzo,
      esempioDiRecord: esempio
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* La richiesta compilata dal visitatore diventa una valutazione nel CRM,
   senza consulente assegnato: la prende chi la lavora. */
app.post('/api/pubblico/valutazione', async (req, res) => {
  try {
    const b = req.body || {};
    /* Basta il nome: la pagina la usano i consulenti, e in sopralluogo il telefono
       del proprietario puo' non essere ancora stato chiesto. */
    if (!b.nomeCliente) {
      return res.status(400).json({ error: 'Serve almeno il nome degli intestatari' });
    }

    const consentiti = ['nomeCliente', 'emailCliente', 'telefonoCliente', 'comune', 'zona', 'zonaOmi', 'via', 'civico',
      'motivo', 'mq', 'tipologia', 'locali', 'bagni', 'piano', 'ascensore', 'esposizione', 'stato',
      'annoCostruzione', 'rumore', 'partiComuni', 'prezzoBaseMq', 'notaZona',
      'quotazioneOmiMin', 'quotazioneOmiMax', 'valoreConsigliato', 'valoreMinimo', 'valoreMassimo', 'valoreAlMq',
      /* mancavano: senza questi la valutazione arrivava senza consulente, senza dati
         catastali e senza i confronti scelti */
      'consulente', 'identificativi', 'rendita', 'speseCondominiali', 'epoca', 'esposizione'];
    const dati = { origine: 'Pagina valutazione' };
    consentiti.forEach(c => { if (b[c] !== undefined) dati[c] = String(b[c]); });
    if (Array.isArray(b.comparabili)) dati.comparabili = b.comparabili;

    /* Aggiornamento di una valutazione gia' esistente, quando si riapre un report */
    if (b.id) {
      const aggiornata = await Valutazione.findByIdAndUpdate(b.id, { $set: dati }, { new: true });
      if (aggiornata) return res.status(200).json({ status: 'success', id: aggiornata._id, aggiornata: true });
    }

    const salvata = await new Valutazione(dati).save();
    res.status(201).json({ status: 'success', id: salvata._id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* Quanto spazio occupa ogni collezione: serve a capire cosa sta riempiendo il piano gratuito */
app.get('/api/spazio', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const generale = await db.stats();
    const collezioni = await db.listCollections().toArray();

    const dettaglio = [];
    for (const c of collezioni) {
      try {
        const s = await db.command({ collStats: c.name });
        dettaglio.push({
          nome: c.name,
          documenti: s.count || 0,
          dati: s.size || 0,
          indici: s.totalIndexSize || 0,
          totale: (s.storageSize || 0) + (s.totalIndexSize || 0)
        });
      } catch (e) { /* collezione di sistema: la salto */ }
    }
    dettaglio.sort((a, b) => b.totale - a.totale);

    res.status(200).json({
      limite: 512 * 1024 * 1024,
      dati: generale.dataSize || 0,
      archiviato: generale.storageSize || 0,
      indici: generale.indexSize || 0,
      occupato: (generale.storageSize || 0) + (generale.indexSize || 0),
      collezioni: dettaglio
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Alleggerimento: butta via i perimetri tenendo zone e quotazioni.
   I poligoni sono il grosso dell'ingombro e non servono alle valutazioni. */
app.delete('/api/zone-omi/perimetri', async (req, res) => {
  try {
    const esito = await ZonaOmi.updateMany({ 'poligoni.0': { $exists: true } }, { $set: { poligoni: [] } });
    res.status(200).json({ status: 'success', alleggerite: esito.modifiedCount });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* Cancella tutte le zone OMI: la via piu' rapida per liberare spazio */
app.delete('/api/zone-omi', async (req, res) => {
  try {
    const esito = await ZonaOmi.deleteMany({});
    res.status(200).json({ status: 'success', eliminate: esito.deletedCount });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* Ripulire un semestre intero, se un import va storto */
app.delete('/api/zone-omi/semestre/:semestre', async (req, res) => {
  try {
    const esito = await ZonaOmi.deleteMany({ semestre: req.params.semestre });
    res.status(200).json({ status: 'success', eliminate: esito.deletedCount });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
registraRotteScheda('cdv', Cdv, 'Cdv');

/* ==========================================
   OPEN HOUSE
   Una giornata di porte aperte su un immobile in incarico. Ogni riga e'
   una giornata: quando si tiene, su quale immobile, e le attivita' di
   promozione che vanno fatte prima perche' ci venga gente.
========================================== */
const OpenHouseSchema = new mongoose.Schema({
  consulente: { type: String, default: '' },
  data: { type: String, default: '' },              // aaaa-mm-gg
  orario: { type: String, default: '' },            // es. "15:00 - 18:00"
  incaricoUfficio: { type: String, default: '' },   // idElemento dell'incarico
  immobile: { type: String, default: '' },          // descrizione leggibile, per l'elenco
  stato: { type: String, default: 'Da programmare' },
  visitatori: { type: String, default: '' },
  proposteRaccolte: { type: String, default: '' },
  note: { type: String, default: '' },
  attivita: { type: Object, default: {} }           // quali promozioni sono state fatte
}, { timestamps: true });
const OpenHouse = mongoose.model('OpenHouse', OpenHouseSchema);
registraRotteScheda('open-house', OpenHouse, 'Open House');

/* ==========================================
   GESTIONE IMMOBILI
   Ogni volta che si genera il report di un incarico resta una riga qui:
   quando e' stato fatto, con che numeri, da chi. E' il registro di quello
   che il proprietario ha ricevuto, e serve a non doverselo ricordare.
========================================== */
const GestioneImmobileSchema = new mongoose.Schema({
  consulente: { type: String, default: '' },
  data: { type: String, default: '' },
  incaricoUfficio: { type: String, default: '' },
  immobile: { type: String, default: '' },
  tipo: { type: String, default: 'Report' },
  destinatario: { type: String, default: '' },
  note: { type: String, default: '' },
  /* i numeri com'erano quel giorno: il report si rigenera aggiornato,
     ma qui resta la fotografia di allora */
  numeri: { type: Object, default: {} }
}, { timestamps: true });
const GestioneImmobile = mongoose.model('GestioneImmobile', GestioneImmobileSchema);
registraRotteScheda('gestione-immobili', GestioneImmobile, 'Gestione Immobili');

/* ==========================================
   CROSS POSTING
   Un contenuto scritto una volta e pubblicato su piu' canali. Qui vive il
   contenuto e lo stato su ciascun canale: cosa e' stato pubblicato, quando,
   e cosa e' ancora da fare.
========================================== */
const PostSchema = new mongoose.Schema({
  consulente: { type: String, default: '' },
  titolo: { type: String, default: '' },
  tipo: { type: String, default: 'Post' },          // Post | Reel | Storia
  testo: { type: String, default: '' },
  hashtag: { type: String, default: '' },
  link: { type: String, default: '' },              // annuncio o pagina a cui rimanda
  media: { type: Array, default: [] },              // indirizzi delle immagini o del video
  incaricoUfficio: { type: String, default: '' },
  dataProgrammata: { type: String, default: '' },
  stato: { type: String, default: 'Bozza' },        // Bozza | Programmato | Pubblicato
  /* per ogni canale: se e' previsto, se e' stato fatto, quando, e il testo
     adattato a quel canale se e' stato modificato a mano */
  canali: { type: Object, default: {} },
  note: { type: String, default: '' }
}, { timestamps: true });
const Post = mongoose.model('Post', PostSchema);
registraRotteScheda('cross-posting', Post, 'Cross Posting');

/* ==========================================
   LETTERE
   Il testo si scrive una volta con i segnaposto, e viene stampato tante volte
   quanti sono i destinatari, ognuna con i suoi dati.
========================================== */
const LetteraSchema = new mongoose.Schema({
  consulente: { type: String, default: '' },
  titolo: { type: String, default: '' },
  oggetto: { type: String, default: '' },
  testo: { type: String, default: '' },
  fonte: { type: String, default: 'proprietari' },   // da quale archivio prendere i destinatari
  conCarta: { type: Boolean, default: true },        // carta intestata dell'agenzia
  conFirma: { type: Boolean, default: true },
  ultimaStampa: { type: String, default: '' },
  quanteStampate: { type: String, default: '' }
}, { timestamps: true });
const Lettera = mongoose.model('Lettera', LetteraSchema);
registraRotteScheda('lettere', Lettera, 'Lettere');

/* ==========================================
   VOLANTINI
   Un A5 per l'acquisizione, con il codice da inquadrare che porta al
   consulente giusto. Il volantino e' lo stesso, la firma cambia.
========================================== */
const VolantinoSchema = new mongoose.Schema({
  consulente: { type: String, default: '' },
  titolo: { type: String, default: '' },
  layout: { type: String, default: 'classico' },
  occhiello: { type: String, default: '' },
  testata: { type: String, default: '' },
  testo: { type: String, default: '' },
  richiamo: { type: String, default: '' },        // la frase che invita ad agire
  tipoCodice: { type: String, default: 'whatsapp' },
  /* il retro: si stampa fronte-retro, e quasi sempre e' li' che si mettono
     le ragioni per chiamare */
  conRetro: { type: Boolean, default: false },
  retroTestata: { type: String, default: '' },
  retroTesto: { type: String, default: '' },
  retroPunti: { type: Array, default: [] },
  modello: { type: String, default: '' },
  linkCodice: { type: String, default: '' },
  immagine: { type: String, default: '' },
  zona: { type: String, default: '' },
  quantiStampati: { type: String, default: '' }
}, { timestamps: true });
const Volantino = mongoose.model('Volantino', VolantinoSchema);
registraRotteScheda('volantini', Volantino, 'Volantini');

/* ==========================================
   PLANIMETRIE
   La pianta disegnata a mano libera sulla griglia: muri come linee, stanze
   come aree chiuse, porte e finestre appoggiate ai muri. Le misure sono in
   centimetri, cosi' non ci sono decimali che si perdono per strada.
========================================== */
const PlanimetriaSchema = new mongoose.Schema({
  consulente: { type: String, default: '' },
  titolo: { type: String, default: '' },
  incaricoUfficio: { type: String, default: '' },
  muri: { type: Array, default: [] },        // [{x1,y1,x2,y2}] in centimetri
  stanze: { type: Array, default: [] },      // [{nome, punti:[[x,y],...]}]
  aperture: { type: Array, default: [] },    // [{tipo,muro,posizione,larghezza}]
  conQuote: { type: Boolean, default: true },
  note: { type: String, default: '' }
}, { timestamps: true });
const Planimetria = mongoose.model('Planimetria', PlanimetriaSchema);
registraRotteScheda('planimetrie', Planimetria, 'Planimetrie');

/* ==========================================
   AGENDA DA TELEFONO
   Gli appuntamenti del consulente, letti da tutte le schede e restituiti
   gia' pronti. Serve alla pagina che si mette sulla schermata iniziale:
   il telefono non deve scaricarsi tutto il CRM per far vedere tre visite.
========================================== */
/* ==========================================
   I KPI PER IL TELEFONO
   Il conto lo fa il server: al telefono non si scaricano cinque archivi
   interi per far vedere due percentuali.
========================================== */
app.get('/api/pubblico/kpi/:utente', async (req, res) => {
  try {
    const utente = String(req.params.utente || '');
    const oby = await ObyBudget.findOne({ consulente: utente });

    if (!oby || !oby.guadagnoNettoDesiderato) {
      return res.status(200).json({ utente, configurato: false });
    }

    const da = oby.dataInizioMonitoraggio || '';
    const a = oby.dataFineMonitoraggio || '';
    const nelPeriodo = (d) => {
      if (!d) return false;
      const s = String(d).slice(0, 10);
      return (!da || s >= da) && (!a || s <= a);
    };
    const suo = (r) => r.consulente === utente;

    /* i conteggi reali, presi dagli archivi */
    const [proposte, incarichi, visioni, cdv, opportunity, concorrenza] = await Promise.all([
      Proposta.find({}).limit(900), Incarico.find({}).limit(900),
      Visioni.find({}).limit(900), Cdv.find({}).limit(900),
      Opportunity.find({}).limit(900), Concorrenza.find({}).limit(900)
    ]);

    const mie = (elenco, campo) => elenco.filter(r => suo(r) && nelPeriodo(r[campo] || r.createdAt));

    const k = oby.kpi || {};
    const provv = oby.percentualeProvvigione || 40;
    const lordo = Math.round((oby.guadagnoNettoDesiderato / provv) * 100);

    /* il funnel a ritroso, come nel CRM */
    const vendite = Math.ceil(lordo / (k.provvigioneMediaVendita || 6000));
    const immobili = Math.ceil(vendite / (k.transazioniPerImmobile || 1.2));
    const proposteAttese = Math.ceil(vendite / ((k.chiusuraProposte || 60) / 100));
    const visioniAttese = Math.ceil(proposteAttese * (k.visioniPerProposta || 8));
    const incarichiAttesi = Math.ceil(immobili / ((k.venditaSuAcquisito || 70) / 100));
    const cdv2Attese = Math.ceil(incarichiAttesi / ((k.cdv2SuIncarico || 50) / 100));
    const cdv1Attese = Math.ceil(cdv2Attese / ((k.cdv1SuCdv2 || 60) / 100));
    const opportunityAttese = Math.ceil(cdv1Attese * (k.opportunityPerCdv || 30));

    const mieProposte = mie(proposte, 'dataPresaProposta');
    const mieCdv = mie(cdv, 'createdAt');

    const funnel = [
      { titolo: 'Opportunity', obiettivo: opportunityAttese, attuale: mie(opportunity, 'createdAt').length },
      { titolo: 'Cdv 1', obiettivo: cdv1Attese, attuale: mieCdv.filter(c => c.cdv1 === 'Sì').length },
      { titolo: 'Cdv 2', obiettivo: cdv2Attese, attuale: mieCdv.filter(c => c.cdv2 === 'Sì').length },
      { titolo: 'Incarichi', obiettivo: incarichiAttesi, attuale: mie(incarichi, 'dataIncarico').length },
      { titolo: 'Visite', obiettivo: visioniAttese, attuale: mie(visioni, 'dataVisione').length },
      { titolo: 'Proposte', obiettivo: proposteAttese, attuale: mieProposte.length },
      { titolo: 'Vendite', obiettivo: vendite,
        attuale: mieProposte.filter(p => String(p.statoAvanzamento || '').indexOf('Rogito') >= 0).length }
    ];

    /* i canali di acquisizione, con le quote fisse */
    const quote = { concorrenza: 10, vdp: 20, vdpNoNum: 20, necrologio: 20, zona: 20, leadUfficio: 10 };
    const canaleDi = (fonte) => {
      const f = String(fonte || '').toLowerCase();
      if (f.indexOf('concorrenza') !== -1) return 'concorrenza';
      if (f.indexOf('privatello') !== -1 || f.indexOf('vdp') !== -1) return 'vdp';
      if (f.indexOf('necrolog') !== -1) return 'necrologio';
      if (f.indexOf('zona') !== -1 || f.indexOf('fresca') !== -1) return 'zona';
      if (f.indexOf('ufficio') !== -1 || f.indexOf('lead') !== -1) return 'leadUfficio';
      return '';
    };

    const raccolte = {};
    Object.keys(quote).forEach(c => { raccolte[c] = 0; });
    mie(opportunity, 'createdAt').forEach(o => {
      const c = canaleDi(o.fonte);
      if (c) raccolte[c]++;
    });
    mie(concorrenza, 'createdAt').forEach(r => {
      if (r.statoSviluppo !== 'Opportunity') return;
      if (r.agenzia) raccolte.concorrenza++;
      else if (/no.*num/i.test(String(r.privato))) raccolte.vdpNoNum++;
      else if (r.privato) raccolte.vdp++;
    });

    const canali = Object.keys(quote).map(c => ({
      chiave: c, quota: quote[c],
      obiettivo: Math.round(opportunityAttese * quote[c] / 100),
      raccolte: raccolte[c]
    }));

    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      utente, configurato: true, da, a,
      netto: oby.guadagnoNettoDesiderato, lordo, provvigione: provv,
      funnel, canali, opportunityAttese
    });
  } catch (err) {
    console.error('KPI non calcolati:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ==========================================
   AMMINISTRATORI DI CONDOMINIO
   Chi amministra gli stabili censiti. E' capitale sociale: un amministratore
   che si fida porta incarichi senza che tu li cerchi.
========================================== */
const AmministratoreSchema = new mongoose.Schema({
  consulente: { type: String, default: '' },
  nomeStudio: { type: String, default: '' },
  referente: { type: String, default: '' },
  telefono: { type: String, default: '' },
  mail: { type: String, default: '' },
  indirizzo: { type: String, default: '' },
  comune: { type: String, default: '' },
  quantiStabili: { type: String, default: '' },
  rapporto: { type: String, default: 'Da conoscere' },  // Da conoscere | Contattato | In rapporto | Collabora
  ultimoContatto: { type: String, default: '' },
  note: { type: String, default: '' }
}, { timestamps: true });
const Amministratore = mongoose.model('Amministratore', AmministratoreSchema);
registraRotteScheda('amministratori', Amministratore, 'Amministratori');

/* ==========================================
   CENSIMENTO DA TELEFONO
   Sul campo si citofona e si annota. La pagina scarica una via per volta:
   caricare un comune intero su una connessione mobile non ha senso.
========================================== */
/* I comuni sono salvati come li scrive chi li crea — "Legnano", non
   "LEGNANO". Cercare in maiuscolo non trovava niente: qui si cerca senza
   badare a maiuscole ne' a spazi in piu'. */
function trovaComune(nome) {
  const pulito = String(nome || '').trim();
  if (!pulito) return Promise.resolve(null);
  const sicuro = pulito.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Stradario.findOne({ comune: new RegExp('^\\s*' + sicuro + '\\s*$', 'i') });
}

app.get('/api/pubblico/censimento/comuni', async (req, res) => {
  try {
    const comuni = await Stradario.find({}, { comune: 1, provincia: 1, ultimoCensimento: 1, vie: 1 });
    res.set('Cache-Control', 'no-store');
    res.status(200).json(comuni.map(c => ({
      comune: c.comune, provincia: c.provincia || '',
      ultimoCensimento: c.ultimoCensimento || '',
      quanteVie: (c.vie || []).length,
      quantiCivici: (c.vie || []).reduce((s, v) => s + (v.civici || []).length, 0)
    })).sort((a, b) => a.comune.localeCompare(b.comune)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Dice cosa c'e' davvero nello stradario: serve quando qualcosa non torna
   e non si vuole tirare a indovinare. */
app.get('/api/pubblico/censimento/diagnosi', async (req, res) => {
  try {
    const tutti = await Stradario.find({}, { comune: 1, vie: 1 }).limit(50);
    res.status(200).json({
      quantiComuni: tutti.length,
      comuni: tutti.map(c => ({
        comune: c.comune,
        vie: (c.vie || []).length,
        primeVie: (c.vie || []).slice(0, 3).map(v => ({
          nome: v.nome,
          civici: (v.civici || []).length,
          primoCivico: (v.civici || [])[0]
            ? { numero: (v.civici || [])[0].numero,
                citofoni: ((v.civici || [])[0].citofoni || []).length }
            : null
        }))
      }))
    });
  } catch (err) {
    console.error('Diagnosi non riuscita:', err);
    res.status(500).json({ error: err.message, dove: 'lettura dello stradario' });
  }
});

/* L'elenco delle vie di un comune, senza i civici: serve solo a scegliere */
app.get('/api/pubblico/censimento/:comune/vie', async (req, res) => {
  try {
    const cercato = String(req.params.comune || '').trim();
    const s = await trovaComune(cercato);
    if (!s) {
      const esistenti = await Stradario.find({}, { comune: 1 }).limit(30);
      return res.status(404).json({
        error: 'Comune non trovato', cercato,
        disponibili: esistenti.map(x => x.comune)
      });
    }
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      comune: s.comune,
      vie: (s.vie || []).map(v => ({
        nome: v.nome, zona: v.zone || '',
        civici: (v.civici || []).length,
        citofoni: (v.civici || []).reduce((n, c) => n + (c.citofoni || []).length, 0),
        censiti: (v.civici || []).reduce((n, c) =>
          n + (c.citofoni || []).filter(x => x.nome).length, 0)
      })).sort((a, b) => a.nome.localeCompare(b.nome))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Una via con tutti i suoi civici e citofoni: e' quello che si ha in mano
   mentre si sta davanti al portone */
app.get('/api/pubblico/censimento/:comune/via', async (req, res) => {
  try {
    /* il nome della via arriva come parametro di ricerca, non dentro il
       percorso: nomi come "VIA A/B" spezzerebbero la rotta in due */
    const cercata = String(req.query.nome || '');
    const s = await trovaComune(req.params.comune);
    if (!s) return res.status(404).json({ error: 'Comune non trovato', cercato: req.params.comune });
    /* anche il nome della via si confronta senza badare a maiuscole e spazi:
       nel database sta come l'ha scritto chi l'ha creata */
    const uguale = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    const via = (s.vie || []).find(v => uguale(v.nome, cercata));
    if (!via) {
      return res.status(404).json({
        error: 'Via non trovata', cercata,
        primeVie: (s.vie || []).slice(0, 5).map(v => v.nome)
      });
    }

    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      comune: s.comune, via: via.nome, zona: via.zone || '',
      civici: (via.civici || []).map(c => ({
        numero: c.numero, contesto: c.contestoCivico || '', note: c.note || '',
        anno: c.annoCostruzione || '', stato: c.statoStabile || 0,
        amministratore: c.amministratore || '',
        foglio: c.foglio || '', particella: c.particella || '',
        /* le unita' risultanti da visura: chi possiede cosa, anche se non
           ci abita — e' il grosso di quello che serve in acquisizione */
        unita: (c.proprietariNonResidenti || []).map((u, k) => ({
          indice: k, sub: u.sub || '', piano: u.piano || '',
          vani: u.vani || '', mq: u.mq || '',
          proprietari: (u.proprietari || []).map(p => ({
            nome: p.nomeCognome || '', cf: p.cf || '', anno: p.annoNascita || '',
            dataNascita: p.dataNascita || '', luogoNascita: p.luogoNascita || ''
          }))
        })),
        citofoni: (c.citofoni || []).map((x, k) => ({
          indice: k, nome: x.nome || '', piano: x.piano || '',
          stato: x.statoProprietario || '', vani: x.vani || '', mq: x.mq || '',
          unitaVisura: x.unitaVisura || '',
          attivita: (x.attivita || []).slice().sort((a, b) =>
            String(b.quando || '').localeCompare(String(a.quando || '')))
        }))
      })).sort((a, b) => String(a.numero).localeCompare(String(b.numero), 'it', { numeric: true }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* I dati dello stabile: contesto, anni, stato e amministratore */
app.put('/api/pubblico/censimento/:comune/contesto', async (req, res) => {
  try {
    const b = req.body || {};
    const s = await trovaComune(req.params.comune);
    if (!s) return res.status(404).json({ error: 'Comune non trovato' });

    const uguale = (x, y) => String(x || '').trim().toLowerCase() === String(y || '').trim().toLowerCase();
    const via = (s.vie || []).find(v => uguale(v.nome, b.via));
    if (!via) return res.status(404).json({ error: 'Via non trovata' });

    const civico = (via.civici || []).find(c => String(c.numero) === String(b.civico));
    if (!civico) return res.status(404).json({ error: 'Civico non trovato' });

    if (b.contesto !== undefined) civico.contestoCivico = b.contesto;
    if (b.anno !== undefined) civico.annoCostruzione = b.anno;
    if (b.stato !== undefined) civico.statoStabile = Number(b.stato) || 0;
    if (b.amministratore !== undefined) civico.amministratore = b.amministratore;
    if (b.note !== undefined) civico.note = b.note;
    if (b.foglio !== undefined) civico.foglio = b.foglio;
    if (b.particella !== undefined) civico.particella = b.particella;

    s.markModified('vie');
    await s.save();
    res.status(200).json({ status: 'success' });
  } catch (err) {
    console.error('Contesto non salvato:', err);
    res.status(500).json({ error: err.message });
  }
});

/* Cosa e' successo su un citofono: chi ha aperto, chi non ha risposto, a chi
   si e' scritto. E' la memoria del lavoro fatto: senza, si ricitofona a chi
   ha gia' detto di no. */
app.post('/api/pubblico/censimento/:comune/attivita', async (req, res) => {
  try {
    const b = req.body || {};
    const s = await trovaComune(req.params.comune);
    if (!s) return res.status(404).json({ error: 'Comune non trovato' });

    const uguale = (x, y) => String(x || '').trim().toLowerCase() === String(y || '').trim().toLowerCase();
    const via = (s.vie || []).find(v => uguale(v.nome, b.via));
    const civico = via && (via.civici || []).find(c => String(c.numero) === String(b.civico));
    const citofono = civico && (civico.citofoni || [])[b.indice];
    if (!citofono) return res.status(404).json({ error: 'Citofono non trovato' });

    if (!citofono.attivita) citofono.attivita = [];
    citofono.attivita.push({
      tipo: b.tipo || '',
      quando: b.quando || new Date().toISOString(),
      nota: b.nota || '',
      consulente: b.consulente || ''
    });

    s.markModified('vie');
    await s.save();
    res.status(200).json({ status: 'success', quante: citofono.attivita.length });
  } catch (err) {
    console.error('Attività non salvata:', err);
    res.status(500).json({ error: err.message });
  }
});

/* La nota su un'attivita' gia' segnata: si scrive dopo, con calma */
app.put('/api/pubblico/censimento/:comune/nota', async (req, res) => {
  try {
    const b = req.body || {};
    const s = await trovaComune(req.params.comune);
    if (!s) return res.status(404).json({ error: 'Comune non trovato' });

    const uguale = (x, y) => String(x || '').trim().toLowerCase() === String(y || '').trim().toLowerCase();
    const via = (s.vie || []).find(v => uguale(v.nome, b.via));
    const civico = via && (via.civici || []).find(c => String(c.numero) === String(b.civico));
    const citofono = civico && (civico.citofoni || [])[b.indice];
    if (!citofono) return res.status(404).json({ error: 'Citofono non trovato' });

    const attivita = (citofono.attivita || []).find(a => String(a.quando) === String(b.quando));
    if (!attivita) return res.status(404).json({ error: 'Attività non trovata' });

    attivita.nota = String(b.nota || '');
    s.markModified('vie');
    await s.save();
    res.status(200).json({ status: 'success' });
  } catch (err) {
    console.error('Nota non salvata:', err);
    res.status(500).json({ error: err.message });
  }
});

/* Togliere un'attivita' segnata per sbaglio */
app.delete('/api/pubblico/censimento/:comune/attivita', async (req, res) => {
  try {
    const b = req.body || {};
    const s = await trovaComune(req.params.comune);
    if (!s) return res.status(404).json({ error: 'Comune non trovato' });

    const uguale = (x, y) => String(x || '').trim().toLowerCase() === String(y || '').trim().toLowerCase();
    const via = (s.vie || []).find(v => uguale(v.nome, b.via));
    const civico = via && (via.civici || []).find(c => String(c.numero) === String(b.civico));
    const citofono = civico && (civico.citofoni || [])[b.indice];
    if (!citofono) return res.status(404).json({ error: 'Citofono non trovato' });

    /* le attivita' si tolgono per quando sono state segnate: l'ordine a
       schermo e' per data, quindi la posizione non coincide */
    citofono.attivita = (citofono.attivita || []).filter(a => String(a.quando) !== String(b.quando));
    s.markModified('vie');
    await s.save();
    res.status(200).json({ status: 'success' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Le unita' da visura: sub, piano, e chi le possiede. Si scrivono dal campo
   perche' la visura si legge spesso sul telefono, davanti al portone. */
app.put('/api/pubblico/censimento/:comune/unita', async (req, res) => {
  try {
    const b = req.body || {};
    const s = await trovaComune(req.params.comune);
    if (!s) return res.status(404).json({ error: 'Comune non trovato' });

    const uguale = (x, y) => String(x || '').trim().toLowerCase() === String(y || '').trim().toLowerCase();
    const via = (s.vie || []).find(v => uguale(v.nome, b.via));
    if (!via) return res.status(404).json({ error: 'Via non trovata' });

    const civico = (via.civici || []).find(c => String(c.numero) === String(b.civico));
    if (!civico) return res.status(404).json({ error: 'Civico non trovato' });

    if (!civico.proprietariNonResidenti) civico.proprietariNonResidenti = [];

    /* se arriva un indice modifico quella, altrimenti ne aggiungo una */
    let unita;
    if (b.indice !== undefined && b.indice !== null && civico.proprietariNonResidenti[b.indice]) {
      unita = civico.proprietariNonResidenti[b.indice];
    } else {
      civico.proprietariNonResidenti.push({ sub: '', piano: '', vani: '', mq: '', proprietari: [] });
      unita = civico.proprietariNonResidenti[civico.proprietariNonResidenti.length - 1];
    }

    if (b.sub !== undefined) unita.sub = b.sub;
    if (b.piano !== undefined) unita.piano = b.piano;
    if (b.vani !== undefined) unita.vani = b.vani;
    if (b.mq !== undefined) unita.mq = b.mq;
    if (Array.isArray(b.proprietari)) {
      unita.proprietari = b.proprietari.map(p => ({
        nomeCognome: p.nome || '', cf: p.cf || '', annoNascita: p.anno || '',
        dataNascita: p.dataNascita || '', luogoNascita: p.luogoNascita || ''
      }));
    }

    s.markModified('vie');
    await s.save();
    res.status(200).json({ status: 'success', quante: civico.proprietariNonResidenti.length });
  } catch (err) {
    console.error('Unità non salvata:', err);
    res.status(500).json({ error: err.message });
  }
});

/* Togliere un'unita' inserita per sbaglio */
app.delete('/api/pubblico/censimento/:comune/unita', async (req, res) => {
  try {
    const b = req.body || {};
    const s = await trovaComune(req.params.comune);
    if (!s) return res.status(404).json({ error: 'Comune non trovato' });

    const uguale = (x, y) => String(x || '').trim().toLowerCase() === String(y || '').trim().toLowerCase();
    const via = (s.vie || []).find(v => uguale(v.nome, b.via));
    const civico = via && (via.civici || []).find(c => String(c.numero) === String(b.civico));
    if (!civico) return res.status(404).json({ error: 'Civico non trovato' });

    (civico.proprietariNonResidenti || []).splice(b.indice, 1);
    s.markModified('vie');
    await s.save();
    res.status(200).json({ status: 'success' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Creare un amministratore dal campo: nasce con il solo nome, il resto si
   completa in ufficio */
app.post('/api/pubblico/amministratori', async (req, res) => {
  try {
    const nome = String((req.body || {}).nome || '').trim();
    if (!nome) return res.status(400).json({ error: 'Serve il nome' });

    const gia = await Amministratore.findOne({ nomeStudio: new RegExp('^\\s*' + nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i') });
    if (gia) return res.status(200).json({ status: 'esisteva', id: String(gia._id), nome: gia.nomeStudio });

    const creato = await Amministratore.create({
      nomeStudio: nome, consulente: String((req.body || {}).consulente || ''),
      rapporto: 'Da conoscere'
    });
    res.status(201).json({ status: 'success', id: String(creato._id), nome });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Gli appuntamenti che non nascono da una scheda: riunioni, giri di zona,
   ferie, tutto quello che sta in agenda senza essere una visione o un rogito. */
const AppuntamentoSchema = new mongoose.Schema({
  consulente: { type: String, default: '' },
  titolo: { type: String, default: '' },
  tipo: { type: String, default: 'appuntamento' },
  data: { type: String, default: '' },        // aaaa-mm-gg
  ora: { type: String, default: '' },         // hh:mm, vuoto = tutto il giorno
  durata: { type: Number, default: 60 },      // minuti
  luogo: { type: String, default: '' },
  note: { type: String, default: '' },
  conChi: { type: String, default: '' },
  creatoDa: { type: String, default: '' }
}, { timestamps: true });

const Appuntamento = mongoose.model('Appuntamento', AppuntamentoSchema);
registraRotteScheda('appuntamenti', Appuntamento);

/* ==========================================================================
   IL DIARIO DELLE CONNESSIONI
   Un'automazione che gira sul server e' invisibile finche' non si rompe, e
   quando si rompe non lo scopri con un errore: lo scopri fra tre settimane
   accorgendoti che non arrivano piu' lead. Ogni cosa che il server fa da solo
   lascia una riga qui.
========================================================================== */
const DiarioSchema = new mongoose.Schema({
  servizio: { type: String, default: '' },    // gmail, meta, gemini, immagini
  esito: { type: String, default: 'ok' },     // ok | scartato | errore
  cosa: { type: String, default: '' },        // che operazione era
  dettaglio: { type: String, default: '' },   // il messaggio di errore, o cosa e' stato creato
  origine: { type: String, default: '' },     // il mittente, il portale
  quando: { type: Date, default: Date.now }
}, { timestamps: true });

DiarioSchema.index({ quando: -1 });
const Diario = mongoose.model('Diario', DiarioSchema);

/* Scrive nel diario senza far fallire l'operazione se il diario stesso ha un
   problema: e' un registro, non un pezzo del lavoro */
async function segnaNelDiario(servizio, esito, cosa, dettaglio, origine) {
  try {
    await Diario.create({
      servizio, esito, cosa,
      dettaglio: String(dettaglio || '').slice(0, 500),
      origine: origine || ''
    });
  } catch (e) { console.error('Diario non scritto:', e.message); }
}

/* Lo stato di tutto: cosa e' configurato, e soprattutto quando ha funzionato
   l'ultima volta. Un pallino verde dice poco; "ultima mail letta 12 minuti fa"
   dice tutto. */
app.get('/api/connessioni/stato', async (req, res) => {
  try {
    const servizi = [
      { chiave: 'gemini',   nome: 'Gemini (testi e foto)', chiave_env: !!GEMINI_API_KEY,
        variabile: 'GEMINI_API_KEY' },
      { chiave: 'meta',     nome: 'Meta (Facebook e Instagram)',
        chiave_env: !!(process.env.META_APP_ID && process.env.META_APP_SECRET),
        variabile: 'META_APP_ID e META_APP_SECRET' },
      { chiave: 'immagini', nome: 'Ritocco immagini',
        chiave_env: !!(process.env.FAL_API_KEY || process.env.OPENAI_API_KEY),
        variabile: 'FAL_API_KEY oppure OPENAI_API_KEY' },
      { chiave: 'gmail',    nome: 'Lettura mail (lead)',
        chiave_env: !!process.env.GMAIL_REFRESH_TOKEN,
        variabile: 'GMAIL_REFRESH_TOKEN' }
    ];

    const risultato = [];
    for (const s of servizi) {
      const ultimo = await Diario.findOne({ servizio: s.chiave }).sort({ quando: -1 });
      const ultimoOk = await Diario.findOne({ servizio: s.chiave, esito: 'ok' }).sort({ quando: -1 });
      const erroriRecenti = await Diario.countDocuments({
        servizio: s.chiave, esito: 'errore',
        quando: { $gte: new Date(Date.now() - 24 * 3600 * 1000) }
      });

      risultato.push({
        chiave: s.chiave, nome: s.nome,
        configurato: s.chiave_env, variabile: s.variabile,
        ultimoUso: ultimo ? ultimo.quando : null,
        ultimoBuono: ultimoOk ? ultimoOk.quando : null,
        ultimoErrore: ultimo && ultimo.esito === 'errore' ? ultimo.dettaglio : '',
        erroriOggi: erroriRecenti
      });
    }
    res.status(200).json(risultato);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Le ultime righe del diario: e' qui che si vede se un portale ha cambiato
   formato — cominciano a comparire "non riconosciuta" tutte insieme. */
app.get('/api/connessioni/diario', async (req, res) => {
  try {
    const quante = Math.min(Number(req.query.quante) || 60, 200);
    const filtro = {};
    if (req.query.servizio) filtro.servizio = req.query.servizio;
    if (req.query.esito) filtro.esito = req.query.esito;
    const righe = await Diario.find(filtro).sort({ quando: -1 }).limit(quante);
    res.status(200).json(righe);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Una prova a comando: invece di aspettare che qualcosa si rompa da solo */
app.post('/api/connessioni/prova/:servizio', async (req, res) => {
  const servizio = req.params.servizio;
  try {
    if (servizio === 'gemini') {
      if (!GEMINI_API_KEY) {
        await segnaNelDiario('gemini', 'errore', 'prova', 'chiave non configurata');
        return res.status(200).json({ funziona: false, motivo: 'GEMINI_API_KEY non configurata su Render' });
      }
      const elenco = await new Promise((risolvi, rifiuta) => {
        https.get({
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models?key=${GEMINI_API_KEY}`
        }, (r) => { let d = ''; r.on('data', p => d += p); r.on('end', () => risolvi(d)); }).on('error', rifiuta);
      });
      const dati = JSON.parse(elenco);
      if (dati.error) {
        await segnaNelDiario('gemini', 'errore', 'prova', dati.error.message);
        return res.status(200).json({ funziona: false, motivo: dati.error.message });
      }
      const nomi = (dati.models || []).map(m => String(m.name || '').replace('models/', ''));
      const esiste = nomi.indexOf(GEMINI_MODEL) >= 0;
      await segnaNelDiario('gemini', esiste ? 'ok' : 'errore', 'prova',
        esiste ? 'modello ' + GEMINI_MODEL + ' disponibile' : 'il modello ' + GEMINI_MODEL + ' non esiste piu');
      return res.status(200).json({
        funziona: esiste, modello: GEMINI_MODEL,
        motivo: esiste ? 'tutto a posto' : 'il modello impostato non è fra quelli disponibili',
        disponibili: nomi.filter(n => /flash|pro/.test(n)).slice(0, 10)
      });
    }

    if (servizio === 'meta') {
      const c = await ConnessioneSocial.findOne({ canale: 'facebook' });
      const configurato = !!(process.env.META_APP_ID && process.env.META_APP_SECRET);
      const collegato = !!(c && c.tokenAccesso);
      await segnaNelDiario('meta', collegato ? 'ok' : 'errore', 'prova',
        collegato ? 'pagina collegata' : (configurato ? 'app configurata ma nessuna pagina collegata' : 'chiavi mancanti'));
      return res.status(200).json({
        funziona: collegato, configurato,
        motivo: collegato ? 'collegato' : (configurato ? 'manca il collegamento alla pagina' : 'META_APP_ID e META_APP_SECRET non configurate')
      });
    }

    await segnaNelDiario(servizio, 'errore', 'prova', 'servizio sconosciuto');
    res.status(200).json({ funziona: false, motivo: 'Non so ancora provare questo servizio' });
  } catch (err) {
    await segnaNelDiario(servizio, 'errore', 'prova', err.message);
    res.status(200).json({ funziona: false, motivo: err.message });
  }
});

/* Le chiamate annotate dal telefono, mentre si e' ancora in linea. La rotta
   e' pubblica come le altre del campo: serve poterla aprire senza accedere,
   perche' con un cliente all'orecchio nessuno fa il login. */
app.post('/api/pubblico/chiamata', async (req, res) => {
  try {
    const b = req.body || {};
    const nome = String(b.nome || '').trim();
    if (!nome) return res.status(400).json({ error: 'Serve almeno il nome' });

    const creata = await Centralino.create({
      nome,
      telefonoCliente: String(b.telefono || '').trim(),
      emailCliente: String(b.email || '').trim(),
      messaggioCliente: String(b.note || b.cosaVoleva || '').trim(),
      tipoRichiesta: b.tipo || 'Richiesta Generica',
      consulente: String(b.consulente || '').trim(),
      stato: 'Da Fare',
      riferimentoImmobile: String(b.immobile || '').trim(),
      incaricoCollegatoId: String(b.immobileId || '').trim()
    });

    await segnaNelDiario('chiamate', 'ok', 'chiamata annotata',
      nome + (b.telefono ? ' · ' + b.telefono : ''), b.consulente || '');

    res.status(201).json({ status: 'success', id: String(creata._id) });
  } catch (err) {
    await segnaNelDiario('chiamate', 'errore', 'chiamata annotata', err.message, '');
    res.status(500).json({ error: err.message });
  }
});

/* Gli immobili in vendita, per la tendina: solo quelli vivi, perche' chi
   chiama non chiede di una casa venduta l'anno scorso */
app.get('/api/pubblico/immobili-attivi', async (req, res) => {
  try {
    const righe = await Incarico.find({
      statoImmobile: { $nin: ['Archiviato', 'Venduto', 'Ritirato'] }
    }).sort({ nome: 1 }).limit(300).select('nome idElemento posizione statoImmobile');

    res.status(200).json(righe.map(r => ({
      id: String(r._id),
      nome: r.nome || r.idElemento || '',
      riferimento: r.idElemento || '',
      dove: r.posizione || ''
    })).filter(r => r.nome));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Le ultime annotate: se richiama la stessa persona la riconosci invece di
   riscriverla da capo */
app.get('/api/pubblico/chiamate-recenti', async (req, res) => {
  try {
    const righe = await Centralino.find({ tipoRichiesta: 'Chiamata' })
      .sort({ createdAt: -1 }).limit(12)
      .select('nome telefonoCliente messaggioCliente stato createdAt');
    res.status(200).json(righe);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


/* ==========================================================================
   LEAD DA MAIL
   Ogni portale scrive le sue mail a modo suo. Un lettore per ciascuno e'
   preciso e istantaneo; quando il formato cambia — e cambia — si passa a
   Gemini, che regge qualsiasi forma. Cosi' il caso normale non costa nulla
   e il caso strano non si perde.
========================================================================== */

/* Il testo pulito: le mail dei portali sono HTML pieno di stili */
function testoPulito(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|td|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&egrave;/g, 'è').replace(/&agrave;/g, 'à')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/* Cerca un valore dopo un'etichetta: "Telefono: 333 1234567" */
function dopoEtichetta(testo, etichette) {
  for (const et of etichette) {
    const r = new RegExp(et + '\\s*[:\\-]?\\s*(.+)', 'i');
    const m = testo.match(r);
    if (m && m[1]) {
      const valore = m[1].split('\n')[0].trim();
      if (valore && valore.length < 200) return valore;
    }
  }
  return '';
}

function primoTelefono(testo) {
  /* i numeri italiani: fissi e mobili, con o senza prefisso */
  const m = String(testo).match(/(?:\+39[\s.]?)?(?:3\d{2}|0\d{1,3})[\s.\-/]?\d{5,8}/);
  return m ? m[0].replace(/\s+/g, ' ').trim() : '';
}

function primaMail(testo) {
  const m = String(testo).match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  if (!m) return '';
  /* le mail dei portali stessi non sono il cliente */
  const trovata = m[0].toLowerCase();
  if (/immobiliare\.it|idealista|casa\.it|wikicasa|noreply|no-reply/.test(trovata)) {
    const tutte = String(testo).match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || [];
    const buona = tutte.find(x => !/immobiliare\.it|idealista|casa\.it|wikicasa|noreply|no-reply/i.test(x));
    return buona || '';
  }
  return m[0];
}

/* I portali che conosciamo. Ognuno ha le sue etichette, ma la struttura del
   lettore e' la stessa: cosi' aggiungerne uno e' scrivere tre righe. */
const PORTALI = [
  {
    chiave: 'immobiliare',
    nome: 'Immobiliare.it',
    riconosci: (t, m) => /immobiliare\.it/i.test(t + ' ' + m),
    etichette: {
      nome: ['Nome e cognome', 'Nome', 'Da parte di', 'Utente'],
      telefono: ['Telefono', 'Tel', 'Cellulare'],
      mail: ['Email', 'E-mail', 'Mail'],
      riferimento: ['Riferimento', 'Rif', 'Codice annuncio', 'ID annuncio'],
      messaggio: ['Messaggio', 'Richiesta', 'Testo']
    }
  },
  {
    chiave: 'idealista',
    nome: 'Idealista',
    riconosci: (t, m) => /idealista/i.test(t + ' ' + m),
    etichette: {
      nome: ['Nome', 'Contatto', 'Da'],
      telefono: ['Telefono', 'Tel'],
      mail: ['Email', 'E-mail'],
      riferimento: ['Riferimento', 'Codice', 'Rif'],
      messaggio: ['Messaggio', 'Commento']
    }
  },
  {
    chiave: 'casa',
    nome: 'Casa.it',
    riconosci: (t, m) => /casa\.it/i.test(t + ' ' + m),
    etichette: {
      nome: ['Nome', 'Nominativo', 'Cliente'],
      telefono: ['Telefono', 'Cellulare', 'Tel'],
      mail: ['Email', 'E-mail'],
      riferimento: ['Riferimento', 'Rif annuncio', 'Codice'],
      messaggio: ['Messaggio', 'Richiesta']
    }
  },
  {
    chiave: 'wikicasa',
    nome: 'Wikicasa',
    riconosci: (t, m) => /wikicasa/i.test(t + ' ' + m),
    etichette: {
      nome: ['Nome', 'Utente'],
      telefono: ['Telefono', 'Cellulare'],
      mail: ['Email', 'E-mail'],
      riferimento: ['Riferimento', 'Codice'],
      messaggio: ['Messaggio', 'Richiesta']
    }
  }
];

/* Legge la mail senza scomodare nessun modello. Torna null quando non
   riconosce abbastanza: e' il segnale per passare a Gemini invece di
   creare un lead a meta'. */
function leggiMailLead(testoGrezzo, mittente, oggetto) {
  const testo = testoPulito(testoGrezzo);
  const portale = PORTALI.find(p => p.riconosci(testo, (mittente || '') + ' ' + (oggetto || '')));
  if (!portale) return null;

  const e = portale.etichette;
  const nome = dopoEtichetta(testo, e.nome);
  const telefono = dopoEtichetta(testo, e.telefono) || primoTelefono(testo);
  const mail = dopoEtichetta(testo, e.mail) || primaMail(testo);

  /* Senza un modo per richiamarlo non e' un lead: e' meglio farlo leggere
     a Gemini che salvare una riga inutile. */
  if (!telefono && !mail) return null;
  if (!nome && !telefono) return null;

  return {
    portale: portale.chiave, nomePortale: portale.nome,
    nome: nome || '(senza nome)',
    telefono: (telefono || '').replace(/[^\d+\s]/g, '').trim(),
    mail: mail || '',
    riferimento: dopoEtichetta(testo, e.riferimento),
    messaggio: dopoEtichetta(testo, e.messaggio) || testo.slice(0, 400),
    comeLetta: 'diretta'
  };
}


/* ==========================================================================
   COME SI COMPORTA L'AUTOMAZIONE
   Il messaggio al cliente e le notifiche cambiano nel tempo: se stessero nel
   codice ogni ritocco vorrebbe dire un rilascio. Stanno qui, modificabili
   dal CRM.
========================================================================== */
const ImpostazioniLeadSchema = new mongoose.Schema({
  chiave: { type: String, default: 'automazione-lead', unique: true },

  attiva: { type: Boolean, default: false },

  /* il messaggio che parte al cliente: {nome} e {immobile} si sostituiscono */
  messaggioCliente: {
    type: String,
    default: 'Buongiorno {nome}, sono {consulente} di Forte Immobiliare. ' +
      'Ho ricevuto la sua richiesta{immobile} e la richiamo al più presto. ' +
      'Se preferisce può scrivermi qui su WhatsApp.'
  },
  mandaWhatsapp: { type: Boolean, default: true },

  /* la notifica al consulente su Telegram */
  mandaTelegram: { type: Boolean, default: true },
  testoTelegram: {
    type: String,
    default: '🔔 Nuovo lead da {portale}\n\n{nome}\n{telefono}\n{immobile}\n\n{messaggio}'
  },

  /* a chi assegnare quando non si capisce di chi e' l'immobile */
  consulenteRiserva: { type: String, default: '' },


  ultimaMailLetta: { type: String, default: '' },
  ultimaSorveglianza: { type: Date, default: null },
  storicoIdGmail: { type: String, default: '' }
}, { timestamps: true });

const ImpostazioniLead = mongoose.model('ImpostazioniLead', ImpostazioniLeadSchema);

async function impostazioniLead() {
  let i = await ImpostazioniLead.findOne({ chiave: 'automazione-lead' });
  if (!i) i = await ImpostazioniLead.create({ chiave: 'automazione-lead' });
  return i;
}

app.get('/api/lead/impostazioni', async (req, res) => {
  try { res.status(200).json(await impostazioniLead()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/lead/impostazioni', async (req, res) => {
  try {
    const i = await impostazioniLead();
    ['attiva', 'messaggioCliente', 'mandaWhatsapp', 'mandaTelegram', 'testoTelegram',
     'consulenteRiserva'].forEach(c => {
      if (req.body[c] !== undefined) i[c] = req.body[c];
    });
    await i.save();
    res.status(200).json(i);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================================================
   MANDARE I MESSAGGI
========================================================================== */

/* WhatsApp via Twilio. Il numero va scritto come lo vuole Twilio, con il
   prefisso: i clienti lo lasciano in dieci forme diverse. */
function numeroPerTwilio(grezzo) {
  let n = String(grezzo || '').replace(/[^\d+]/g, '');
  if (!n) return '';
  if (n.startsWith('00')) n = '+' + n.slice(2);
  if (!n.startsWith('+')) {
    /* un numero italiano senza prefisso: lo aggiungo */
    n = n.replace(/^0039/, '');
    n = '+39' + n;
  }
  return n;
}

async function mandaWhatsapp(numero, testo) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const mittente = process.env.TWILIO_NUMERO_WHATSAPP;   // es. whatsapp:+14155238886

  if (!sid || !token || !mittente) throw new Error('Twilio non configurato');
  const a = numeroPerTwilio(numero);
  if (!a) throw new Error('numero del cliente illeggibile');

  const corpo = new URLSearchParams({
    To: 'whatsapp:' + a,
    From: mittente.startsWith('whatsapp:') ? mittente : 'whatsapp:' + mittente,
    Body: testo
  }).toString();

  return new Promise((risolvi, rifiuta) => {
    const r = https.request({
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${sid}/Messages.json`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(corpo),
        'Authorization': 'Basic ' + Buffer.from(sid + ':' + token).toString('base64')
      }
    }, (x) => {
      let d = '';
      x.on('data', p => d += p);
      x.on('end', () => {
        try {
          const esito = JSON.parse(d);
          if (esito.error_message || esito.code) return rifiuta(new Error(esito.error_message || 'codice ' + esito.code));
          risolvi(esito);
        } catch (e) { rifiuta(new Error('risposta illeggibile da Twilio')); }
      });
    });
    r.on('error', rifiuta);
    r.write(corpo);
    r.end();
  });
}

async function mandaTelegram(chatId, testo) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Telegram non configurato');
  if (!chatId) throw new Error('manca la casella Telegram del consulente');

  const corpo = JSON.stringify({ chat_id: chatId, text: testo, parse_mode: 'HTML' });
  return new Promise((risolvi, rifiuta) => {
    const r = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) }
    }, (x) => {
      let d = '';
      x.on('data', p => d += p);
      x.on('end', () => {
        try {
          const esito = JSON.parse(d);
          if (!esito.ok) return rifiuta(new Error(esito.description || 'Telegram ha rifiutato'));
          risolvi(esito);
        } catch (e) { rifiuta(new Error('risposta illeggibile da Telegram')); }
      });
    });
    r.on('error', rifiuta);
    r.write(corpo);
    r.end();
  });
}

/* Sostituisce i segnaposto nel testo */
function riempi(modello, dati) {
  /* Riga per riga: si tiene traccia di quali segnaposto c'erano e se sono
     rimasti vuoti. Cercare "righe senza lettere" era troppo furbo e sbagliava
     — mangiava i numeri di telefono, che di lettere non ne hanno. */
  return String(modello || '').split('\n').map(riga => {
    const segnaposto = riga.match(/\{(\w+)\}/g) || [];
    const riempita = riga.replace(/\{(\w+)\}/g, (tutto, campo) => {
      const v = dati[campo];
      return v === undefined || v === null ? '' : String(v);
    });

    /* la riga aveva dei segnaposto ed erano tutti vuoti: e' una riga che non
       dice niente, tipo "✉️" da solo. Si toglie. */
    if (segnaposto.length) {
      const tuttiVuoti = segnaposto.every(s => {
        const campo = s.slice(1, -1);
        const v = dati[campo];
        return v === undefined || v === null || String(v).trim() === '';
      });
      if (tuttiVuoti) return null;
    }
    return riempita;
  })
  .filter(r => r !== null)
  .join('\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();
}


/* ==========================================================================
   DA UNA MAIL A UN LEAD
   Un solo punto: qualunque cosa porti la mail — la notifica di Gmail, il
   controllo di riserva, o una prova a mano — finisce qui. Cosi' il
   comportamento e' identico e c'e' un posto solo da correggere.
========================================================================== */

/* Quando il lettore diretto non ce la fa, la mail la legge Gemini. Regge i
   formati nuovi, ma costa e ogni tanto sbaglia: e' la rete di sicurezza,
   non la prima scelta. */
async function leggiMailConGemini(testo, mittente, oggetto) {
  if (!GEMINI_API_KEY) throw new Error('Gemini non configurato');

  const richiesta = `Questa è una mail ricevuta da un'agenzia immobiliare.
Se è la richiesta di un potenziale cliente (un lead), estrai i dati.
Se NON è un lead — è pubblicità, una fattura, una newsletter, una risposta
automatica — dillo chiaramente invece di inventare.

Mittente: ${mittente || ''}
Oggetto: ${oggetto || ''}

${String(testo).slice(0, 6000)}

Rispondi SOLO con JSON:
{"lead": true/false, "motivo": "perché non è un lead, se non lo è",
 "nome": "", "telefono": "", "mail": "", "riferimento": "codice dell'annuncio se c'è",
 "portale": "immobiliare/idealista/casa/wikicasa/sito/altro", "messaggio": "cosa chiede"}`;

  const corpo = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: richiesta }] }],
    generationConfig: { responseMimeType: 'application/json' }
  });

  const risposta = await new Promise((risolvi, rifiuta) => {
    const r = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) }
    }, (x) => { let d = ''; x.on('data', p => d += p); x.on('end', () => risolvi(d)); });
    r.on('error', rifiuta); r.write(corpo); r.end();
  });

  const dati = JSON.parse(risposta);
  if (dati.error) throw new Error(dati.error.message);
  const t = dati.candidates && dati.candidates[0] && dati.candidates[0].content &&
            dati.candidates[0].content.parts && dati.candidates[0].content.parts[0].text;
  if (!t) throw new Error('Gemini non ha risposto come previsto');

  const letto = JSON.parse(t);
  if (!letto.lead) return { nonEunLead: true, motivo: letto.motivo || 'non sembra una richiesta' };

  return {
    portale: letto.portale || 'altro', nomePortale: letto.portale || 'altro',
    nome: letto.nome || '(senza nome)',
    telefono: letto.telefono || '', mail: letto.mail || '',
    riferimento: letto.riferimento || '',
    messaggio: letto.messaggio || '',
    comeLetta: 'gemini'
  };
}

/* Di chi e' questo lead. Se la mail nomina un immobile nostro, va al
   consulente che lo segue: e' lui che sa rispondere. */
async function aChiVa(riferimento, impostazioni) {
  if (riferimento) {
    const pulito = String(riferimento).trim();
    const incarico = await Incarico.findOne({
      $or: [
        { idElemento: new RegExp('^\\s*' + pulito.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i') },
        { nome: new RegExp(pulito.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
      ]
    });
    if (incarico) {
      return {
        consulente: incarico.consulente || impostazioni.consulenteRiserva || '',
        incaricoId: String(incarico._id),
        immobile: incarico.nome || incarico.idElemento || '',
        riconosciuto: true
      };
    }
  }
  return {
    consulente: impostazioni.consulenteRiserva || '',
    incaricoId: '', immobile: '', riconosciuto: false
  };
}

/* Il giro completo. Ogni passo lascia una riga nel diario: se il messaggio
   non parte lo si scopre da li', non dal cliente che non richiama. */
async function lavoraMailLead(testo, mittente, oggetto, idGmail) {
  const impostazioni = await impostazioniLead();

  /* niente doppioni: la stessa mail puo' arrivare dalla notifica e dal
     controllo di riserva */
  if (idGmail) {
    const gia = await Centralino.findOne({ idMailOrigine: idGmail });
    if (gia) return { saltata: true, motivo: 'già lavorata', id: String(gia._id) };
  }

  /* prima il lettore diretto, poi Gemini */
  let letto = null;
  try { letto = leggiMailLead(testo, mittente, oggetto); } catch (e) { letto = null; }

  if (!letto) {
    try {
      letto = await leggiMailConGemini(testo, mittente, oggetto);
    } catch (e) {
      await segnaNelDiario('lead', 'errore', 'lettura mail', e.message, mittente || '');
      return { errore: e.message };
    }
  }

  if (letto.nonEunLead) {
    await segnaNelDiario('lead', 'scartato', 'mail scartata', letto.motivo, mittente || '');
    return { scartata: true, motivo: letto.motivo };
  }

  const destinazione = await aChiVa(letto.riferimento, impostazioni);

  const riga = await Centralino.create({
    nome: letto.nome,
    telefonoCliente: letto.telefono,
    emailCliente: letto.mail,
    messaggioCliente: letto.messaggio,
    tipoRichiesta: destinazione.riconosciuto ? 'Richiesta Specifica' : 'Richiesta Generica',
    stato: 'Da Fare',
    consulente: destinazione.consulente,
    riferimentoImmobile: letto.riferimento || '',
    incaricoCollegatoId: destinazione.incaricoId,
    idMailOrigine: idGmail || '',
    portaleOrigine: letto.nomePortale || letto.portale || ''
  });

  await segnaNelDiario('lead', 'ok', 'lead creato',
    `${letto.nome} · ${letto.telefono || letto.mail}` +
    (destinazione.immobile ? ' · ' + destinazione.immobile : '') +
    (letto.comeLetta === 'gemini' ? ' (letta da Gemini)' : ''),
    letto.nomePortale || mittente || '');

  /* il messaggio al cliente e la notifica partono dal gancio sulla riga
     appena creata: cosi' il comportamento e' identico che la riga nasca da
     una mail, dal modulo del telefono o scritta a mano */
  return { id: String(riga._id), letto };
}



/* Per provare senza aspettare una mail vera: si incolla il testo e si vede
   cosa ne esce, senza mandare niente a nessuno. */
app.post('/api/lead/prova', async (req, res) => {
  try {
    const b = req.body || {};
    let letto = leggiMailLead(b.testo, b.mittente, b.oggetto);
    let come = 'diretta';
    if (!letto) {
      letto = await leggiMailConGemini(b.testo, b.mittente, b.oggetto);
      come = 'gemini';
    }
    if (letto.nonEunLead) return res.status(200).json({ lead: false, motivo: letto.motivo });

    const impostazioni = await impostazioniLead();
    const dove = await aChiVa(letto.riferimento, impostazioni);
    res.status(200).json({ lead: true, come, letto, destinazione: dove });
  } catch (err) { res.status(200).json({ lead: false, errore: err.message }); }
});

/* L'ingresso vero: da qui passano la notifica di Gmail e il controllo di
   riserva. Utile anche a mano, mentre si mette a punto. */
app.post('/api/lead/in-arrivo', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.testo) return res.status(400).json({ error: 'Manca il testo della mail' });
    const esito = await lavoraMailLead(b.testo, b.mittente, b.oggetto, b.idGmail);
    res.status(200).json(esito);
  } catch (err) {
    await segnaNelDiario('lead', 'errore', 'mail in arrivo', err.message, '');
    res.status(500).json({ error: err.message });
  }
});


/* ==========================================================================
   LEGGERE GMAIL
   Due strade verso lo stesso posto: la notifica di Google fa nascere il lead
   in due secondi, il controllo di riserva recupera quello che la notifica si
   perde — e ogni tanto si perde. Una mail persa costa piu' di un controllo
   in piu'.
========================================================================== */

/* Il token di accesso dura un'ora: si rinnova da solo con quello lungo */
let GMAIL_TOKEN = { valore: '', scade: 0 };

async function tokenGmail() {
  if (GMAIL_TOKEN.valore && Date.now() < GMAIL_TOKEN.scade - 60000) return GMAIL_TOKEN.valore;

  const id = process.env.GMAIL_CLIENT_ID;
  const segreto = process.env.GMAIL_CLIENT_SECRET;
  const lungo = process.env.GMAIL_REFRESH_TOKEN;
  if (!id || !segreto || !lungo) throw new Error('Gmail non configurato');

  const corpo = new URLSearchParams({
    client_id: id, client_secret: segreto,
    refresh_token: lungo, grant_type: 'refresh_token'
  }).toString();

  const risposta = await new Promise((risolvi, rifiuta) => {
    const r = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                 'Content-Length': Buffer.byteLength(corpo) }
    }, (x) => { let d = ''; x.on('data', p => d += p); x.on('end', () => risolvi(d)); });
    r.on('error', rifiuta); r.write(corpo); r.end();
  });

  const dati = JSON.parse(risposta);
  if (dati.error) throw new Error(dati.error_description || dati.error);

  GMAIL_TOKEN = { valore: dati.access_token, scade: Date.now() + (dati.expires_in || 3600) * 1000 };
  return GMAIL_TOKEN.valore;
}

function chiediAGmail(percorso) {
  return tokenGmail().then(token => new Promise((risolvi, rifiuta) => {
    https.get({
      hostname: 'gmail.googleapis.com', path: percorso,
      headers: { Authorization: 'Bearer ' + token }
    }, (x) => {
      let d = '';
      x.on('data', p => d += p);
      x.on('end', () => {
        try {
          const dati = JSON.parse(d);
          if (dati.error) return rifiuta(new Error(dati.error.message));
          risolvi(dati);
        } catch (e) { rifiuta(new Error('risposta illeggibile da Gmail')); }
      });
    }).on('error', rifiuta);
  }));
}

/* Il corpo di una mail sta annidato in parti: lo cerco ovunque sia */
function corpoDellaMail(parte) {
  if (!parte) return '';
  if (parte.body && parte.body.data) {
    return Buffer.from(parte.body.data, 'base64').toString('utf8');
  }
  if (parte.parts) {
    /* preferisco l'HTML: contiene le tabelle dove i portali mettono i dati */
    const html = parte.parts.find(p => p.mimeType === 'text/html');
    const testo = parte.parts.find(p => p.mimeType === 'text/plain');
    return corpoDellaMail(html) || corpoDellaMail(testo) ||
           parte.parts.map(p => corpoDellaMail(p)).find(Boolean) || '';
  }
  return '';
}

function intestazione(mail, nome) {
  const h = (mail.payload && mail.payload.headers) || [];
  const t = h.find(x => String(x.name).toLowerCase() === nome.toLowerCase());
  return t ? t.value : '';
}

/* Prende una mail e la manda al motore */
async function lavoraMailDiGmail(id) {
  const mail = await chiediAGmail(`/gmail/v1/users/me/messages/${id}?format=full`);
  const testo = corpoDellaMail(mail.payload);
  if (!testo) {
    await segnaNelDiario('gmail', 'scartato', 'mail vuota', 'nessun corpo leggibile', id);
    return { scartata: true };
  }
  return lavoraMailLead(testo, intestazione(mail, 'From'), intestazione(mail, 'Subject'), id);
}

/* Quali mail guardare: solo quelle non lette che sembrano dei portali.
   Senza filtro il server leggerebbe tutta la posta, comprese cose private. */
function filtroLead() {
  return process.env.GMAIL_FILTRO ||
    'is:unread (from:immobiliare.it OR from:idealista.it OR from:casa.it OR from:wikicasa.it)';
}

/* Il controllo di riserva: guarda cosa e' arrivato e non e' stato lavorato */
async function controlloDiRiserva() {
  try {
    const q = encodeURIComponent(filtroLead());
    const elenco = await chiediAGmail(`/gmail/v1/users/me/messages?q=${q}&maxResults=15`);
    const mail = elenco.messages || [];
    if (!mail.length) return { guardate: 0 };

    let nuovi = 0;
    for (const m of mail) {
      const gia = await Centralino.findOne({ idMailOrigine: m.id });
      if (gia) continue;
      const esito = await lavoraMailDiGmail(m.id);
      if (esito && esito.id) nuovi++;
    }
    if (nuovi) {
      await segnaNelDiario('gmail', 'ok', 'controllo di riserva',
        nuovi + (nuovi === 1 ? ' mail recuperata' : ' mail recuperate'), '');
    }
    return { guardate: mail.length, nuovi };
  } catch (e) {
    await segnaNelDiario('gmail', 'errore', 'controllo di riserva', e.message, '');
    return { errore: e.message };
  }
}

/* La notifica di Google: arriva qui appena entra una mail. Non dice quale,
   dice solo "e' cambiato qualcosa" — quindi si guarda cosa c'e' di nuovo. */
app.post('/api/lead/notifica-gmail', async (req, res) => {
  /* si risponde subito: Google riprova se tardiamo, e ci ritroveremmo la
     stessa notifica lavorata due volte */
  res.status(200).json({ ricevuta: true });

  try {
    const impostazioni = await impostazioniLead();
    if (!impostazioni.attiva) {
      await segnaNelDiario('gmail', 'scartato', 'notifica ignorata', 'automazione spenta', '');
      return;
    }
    const esito = await controlloDiRiserva();
    if (esito.nuovi) {
      await segnaNelDiario('gmail', 'ok', 'notifica lavorata',
        esito.nuovi + ' nuovi lead', '');
    }
  } catch (e) {
    await segnaNelDiario('gmail', 'errore', 'notifica', e.message, '');
  }
});

/* Registra la sorveglianza: va rinnovata ogni sette giorni, e il server lo
   fa da solo — ma se salta, il controllo di riserva regge lo stesso. */
async function accendiSorveglianza() {
  const argomento = process.env.GMAIL_PUBSUB_TOPIC;
  if (!argomento) throw new Error('GMAIL_PUBSUB_TOPIC non configurato');

  const token = await tokenGmail();
  const corpo = JSON.stringify({ topicName: argomento, labelIds: ['INBOX'] });

  const risposta = await new Promise((risolvi, rifiuta) => {
    const r = https.request({
      hostname: 'gmail.googleapis.com', path: '/gmail/v1/users/me/watch', method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
                 'Content-Length': Buffer.byteLength(corpo) }
    }, (x) => { let d = ''; x.on('data', p => d += p); x.on('end', () => risolvi(d)); });
    r.on('error', rifiuta); r.write(corpo); r.end();
  });

  const dati = JSON.parse(risposta);
  if (dati.error) throw new Error(dati.error.message);

  const i = await impostazioniLead();
  i.ultimaSorveglianza = new Date();
  i.storicoIdGmail = String(dati.historyId || '');
  await i.save();

  await segnaNelDiario('gmail', 'ok', 'sorveglianza accesa',
    'scade il ' + new Date(Number(dati.expiration)).toLocaleDateString('it-IT'), '');
  return dati;
}

app.post('/api/lead/accendi-sorveglianza', async (req, res) => {
  try { res.status(200).json({ fatto: true, dati: await accendiSorveglianza() }); }
  catch (err) {
    await segnaNelDiario('gmail', 'errore', 'sorveglianza', err.message, '');
    res.status(200).json({ fatto: false, motivo: err.message });
  }
});

/* Manda un messaggio di prova a un consulente: e' l'unico modo di sapere se
   la sua casella Telegram e' quella giusta senza aspettare un lead vero */
app.post('/api/lead/prova-telegram/:utente', async (req, res) => {
  try {
    const scheda = await Consulente.findOne({ utente: req.params.utente });
    if (!scheda) return res.status(200).json({ fatto: false, motivo: 'Consulente non trovato' });
    if (!scheda.idTelegram) {
      return res.status(200).json({ fatto: false,
        motivo: 'Nella sua scheda manca la casella Telegram' });
    }
    await mandaTelegram(scheda.idTelegram,
      '✅ Prova da Forte CRM\n\nSe leggi questo messaggio, le notifiche dei lead ti arriveranno qui.');
    await segnaNelDiario('telegram', 'ok', 'prova', scheda.nomeCognome || req.params.utente, '');
    res.status(200).json({ fatto: true });
  } catch (err) {
    await segnaNelDiario('telegram', 'errore', 'prova', err.message, req.params.utente);
    res.status(200).json({ fatto: false, motivo: err.message });
  }
});

/* Chi ha scritto al bot di recente, con la sua casella. Serve a riempire il
   campo senza chiedere a ognuno di cercarselo. */
app.get('/api/lead/caselle-telegram', async (req, res) => {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return res.status(200).json({ pronte: [], motivo: 'TELEGRAM_BOT_TOKEN non configurato' });

    const risposta = await new Promise((risolvi, rifiuta) => {
      https.get({ hostname: 'api.telegram.org', path: `/bot${token}/getUpdates?limit=40` },
        (x) => { let d = ''; x.on('data', p => d += p); x.on('end', () => risolvi(d)); }).on('error', rifiuta);
    });
    const dati = JSON.parse(risposta);
    if (!dati.ok) return res.status(200).json({ pronte: [], motivo: dati.description || 'Telegram ha rifiutato' });

    const viste = {};
    (dati.result || []).forEach(u => {
      const m = u.message || u.edited_message;
      if (!m || !m.from) return;
      viste[m.from.id] = {
        chatId: String(m.chat.id),
        nome: [m.from.first_name, m.from.last_name].filter(Boolean).join(' '),
        utenteTelegram: m.from.username ? '@' + m.from.username : ''
      };
    });
    res.status(200).json({ pronte: Object.values(viste) });
  } catch (err) { res.status(200).json({ pronte: [], motivo: err.message }); }
});

app.post('/api/lead/controlla-ora', async (req, res) => {
  try { res.status(200).json(await controlloDiRiserva()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

/* Ogni cinque minuti il controllo di riserva; ogni giorno il rinnovo della
   sorveglianza, che Google fa scadere dopo una settimana. */
setInterval(async () => {
  try {
    const i = await impostazioniLead();
    if (i.attiva && process.env.GMAIL_REFRESH_TOKEN) await controlloDiRiserva();
  } catch (e) {}
}, 5 * 60 * 1000);

setInterval(async () => {
  try {
    const i = await impostazioniLead();
    if (!i.attiva || !process.env.GMAIL_PUBSUB_TOPIC) return;
    const scaduta = !i.ultimaSorveglianza ||
      (Date.now() - new Date(i.ultimaSorveglianza).getTime()) > 5 * 24 * 3600 * 1000;
    if (scaduta) await accendiSorveglianza();
  } catch (e) {}
}, 6 * 3600 * 1000);


/* ==========================================================================
   L'AUTOMAZIONE SULLE RIGHE DEL CENTRALINO
   Parte quando nasce una riga, da qualunque parte arrivi: dal modulo del
   telefono, da una mail, o scritta a mano nel CRM. Un solo punto vuol dire
   un solo comportamento — e un solo posto da correggere.
========================================================================== */

async function avvisaPerRigaCentralino(riga, forzato) {
  const impostazioni = await impostazioniLead();
  if (!impostazioni.attiva && !forzato) return { spenta: true };

const scheda = await schedaDelConsulente(riga.consulente);

  const esiti = {};

  /* la notifica al consulente */
  if ((impostazioni.mandaTelegram || forzato) && !riga.tgInviatoIl) {
    const testo = riempi(impostazioni.testoTelegram, {
      portale: riga.portaleOrigine || riga.tipoRichiesta || 'Centralino',
      nome: riga.nome || '',
      telefono: riga.telefonoCliente || riga.emailCliente || 'nessun recapito',
      immobile: riga.riferimentoImmobile || '',
      messaggio: String(riga.messaggioCliente || '').slice(0, 300)
    });

    try {
      if (!scheda) throw new Error('la riga non è assegnata a nessun consulente');
      if (!scheda.idTelegram) {
        throw new Error('manca la casella Telegram di ' + (scheda.nomeCognome || riga.consulente));
      }
      await mandaTelegram(scheda.idTelegram, testo);
      riga.tgConsInviato = 'Inviato';
      riga.tgInviatoIl = new Date();
      esiti.telegram = 'inviato';
      await segnaNelDiario('telegram', 'ok', 'avviso al consulente',
        (scheda.nomeCognome || riga.consulente) + ' · ' + (riga.nome || ''), riga.portaleOrigine || '');
    } catch (e) {
      riga.tgConsInviato = 'Non inviato';
      esiti.telegram = e.message;
      await segnaNelDiario('telegram', 'errore', 'avviso al consulente', e.message, riga.nome || '');
    }
  }

  /* il messaggio al cliente */
  if ((impostazioni.mandaWhatsapp || forzato) && !riga.mexInviatoIl && riga.telefonoCliente) {
    const testo = riempi(impostazioni.messaggioCliente, {
      /* "Ferrari Marica" arriva col cognome davanti: al cliente si scrive
         col nome di battesimo, che e' l'ultima parola */
      nome: String(riga.nome || '').trim().split(/\s+/).slice(-1)[0] || '',
      consulente: (scheda && scheda.nomeCognome) || 'Forte Immobiliare',
      immobile: riga.riferimentoImmobile ? ' per ' + riga.riferimentoImmobile : ''
    });

    try {
      await mandaWhatsapp(riga.telefonoCliente, testo);
      riga.mexClienteInviato = 'Inviato';
      riga.mexInviatoIl = new Date();
      esiti.whatsapp = 'inviato';
      await segnaNelDiario('whatsapp', 'ok', 'messaggio al cliente',
        riga.nome || '', riga.telefonoCliente);
    } catch (e) {
      riga.mexClienteInviato = 'Non inviato';
      esiti.whatsapp = e.message;
      await segnaNelDiario('whatsapp', 'errore', 'messaggio al cliente', e.message, riga.telefonoCliente);
    }
  }

  /* i due campi in tabella dicono cosa e' partito e cosa no: si vede dal
     CRM senza aprire il diario */
  try { await riga.save(); } catch (e) {}
  return esiti;
}

/* A mano, per rimandare quello che non e' partito */
app.post('/api/centralino/:id/riavvisa', async (req, res) => {
  try {
    const riga = await Centralino.findById(req.params.id);
    if (!riga) return res.status(404).json({ error: 'Riga non trovata' });
    /* si azzerano gli stati, altrimenti si crederebbe gia' fatto */
    if (req.body && req.body.rifai) {
      riga.tgConsInviato = ''; riga.mexClienteInviato = '';
    }
    const esiti = await avvisaPerRigaCentralino(riga);
    res.status(200).json(esiti);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


/* ==========================================================================
   SCENARI
   Ogni automazione e' una cosa sola: un innesco, un'azione, e un testo. Prima
   erano due comportamenti dentro la stessa impostazione, e non si poteva
   tenerne acceso uno solo — ne' capire quale dei due aveva fallito.
========================================================================== */
const ScenarioSchema = new mongoose.Schema({
  nome: { type: String, default: '' },
  attivo: { type: Boolean, default: false },

  /* cosa lo fa partire */
  innesco: { type: String, default: 'colonna-tg' },
  /* colonna-tg      → la colonna Tg Cons Inviato passa su Inviato
     colonna-mex     → la colonna Mex Cliente Inviato passa su Inviato
     riga-creata     → nasce una riga nel Registro Chiamate
     mail-lead       → arriva una mail da un portale                        */

  azione: { type: String, default: 'telegram-consulente' },
  /* telegram-consulente → avvisa il consulente su Telegram
     whatsapp-cliente    → scrive al cliente su WhatsApp                    */

  testo: { type: String, default: '' },

  /* la memoria di cosa e' successo: senza, un'automazione e' una scatola
     chiusa finche' qualcuno non si lamenta */
  ultimoAvvio: { type: Date, default: null },
  ultimoEsito: { type: String, default: '' },     // ok | errore
  ultimoMotivo: { type: String, default: '' },
  quanteVolte: { type: Number, default: 0 },
  quantiErrori: { type: Number, default: 0 }
}, { timestamps: true });

const Scenario = mongoose.model('Scenario', ScenarioSchema);

/* I due scenari di partenza. Nascono spenti: accenderli e' una scelta, non
   un effetto collaterale del primo avvio. */
const SCENARI_DI_PARTENZA = [
  {
    nome: 'Avvisa il consulente su Telegram',
    innesco: 'colonna-tg', azione: 'telegram-consulente', attivo: false,
    testo: '🔔 Nuova richiesta\n\n👤 {nome}\n📞 {telefono}\n✉️ {mail}\n🏠 {immobile}\n\n{messaggio}'
  },
  {
    nome: 'Scrivi al cliente su WhatsApp',
    innesco: 'colonna-mex', azione: 'whatsapp-cliente', attivo: false,
    testo: 'Buongiorno {nome}, sono {consulente} di Forte Immobiliare. ' +
      'Ho ricevuto la sua richiesta{immobile} e la richiamo al più presto.'
  }
];

/* Due chiamate quasi simultanee trovavano entrambe zero scenari e li
   creavano tutte e due: ne uscivano quattro. Ora si crea per azione, una
   volta sola, e i doppioni gia' nati si ripuliscono. */
let CREAZIONE_SCENARI = null;

async function scenariEsistenti() {
  if (!CREAZIONE_SCENARI) {
    CREAZIONE_SCENARI = (async () => {
      for (const s of SCENARI_DI_PARTENZA) {
        const gia = await Scenario.findOne({ azione: s.azione });
        if (!gia) await Scenario.create(s);
      }
      /* i doppioni delle volte precedenti: tengo il piu' vecchio per azione */
      for (const s of SCENARI_DI_PARTENZA) {
        const tutti = await Scenario.find({ azione: s.azione }).sort({ createdAt: 1 });
        if (tutti.length > 1) {
          const daTogliere = tutti.slice(1).map(x => x._id);
          await Scenario.deleteMany({ _id: { $in: daTogliere } });
        }
      }
    })().catch(e => { CREAZIONE_SCENARI = null; throw e; });
  }
  await CREAZIONE_SCENARI;
  return Scenario.find({}).sort({ createdAt: 1 });
}

app.get('/api/scenari', async (req, res) => {
  try { res.status(200).json(await scenariEsistenti()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/scenari', async (req, res) => {
  try { res.status(201).json(await Scenario.create(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/scenari/:id', async (req, res) => {
  try {
    const s = await Scenario.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    if (!s) return res.status(404).json({ error: 'Scenario non trovato' });
    res.status(200).json(s);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/scenari/:id', async (req, res) => {
  try {
    await Scenario.findByIdAndDelete(req.params.id);
    res.status(200).json({ status: 'success' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Cosa manca perche' funzioni. Un'automazione accesa che non puo' partire e'
   peggio di una spenta: sembra a posto e non lo e'. */
app.get('/api/scenari/diagnosi', async (req, res) => {
  try {
    const scenari = await scenariEsistenti();
    const consulenti = await Consulente.find({});
    const esito = [];

    for (const s of scenari) {
      /* Due elenchi distinti. Un blocco impedisce allo scenario di partire
         per chiunque; un avviso riguarda solo alcuni casi — e trattarlo come
         blocco vuol dire segnalare rotto qualcosa che per gli altri funziona. */
      const blocchi = [];
      const avvisi = [];

      if (s.azione === 'telegram-consulente') {
        if (!process.env.TELEGRAM_BOT_TOKEN) {
          blocchi.push('Manca TELEGRAM_BOT_TOKEN fra le variabili su Render');
        }
        const senza = consulenti.filter(c => c.utente && !c.idTelegram);
        const conCasella = consulenti.filter(c => c.utente && c.idTelegram);

        if (consulenti.length && !conCasella.length) {
          /* questo si': senza nemmeno una casella non parte per nessuno */
          blocchi.push('Nessun consulente ha la casella Telegram nella sua scheda');
        } else if (senza.length) {
          avvisi.push('Non ricevono l\'avviso: ' +
            senza.map(c => c.nomeCognome || c.utente).join(', ') +
            '. Per gli altri funziona.');
        }
      }

      if (s.azione === 'whatsapp-cliente') {
        if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
          blocchi.push('Mancano le chiavi Twilio fra le variabili su Render');
        }
        if (!process.env.TWILIO_NUMERO_WHATSAPP) {
          blocchi.push('Manca TWILIO_NUMERO_WHATSAPP');
        }
        avvisi.push('Per scrivere per primo a qualcuno, WhatsApp vuole un template approvato da Meta');
      }

      if (!s.testo || !s.testo.trim()) blocchi.push('Il testo del messaggio è vuoto');

      esito.push({
        id: String(s._id), nome: s.nome, attivo: s.attivo,
        puoPartire: blocchi.length === 0,
        problemi: blocchi, avvisi
      });
    }
    res.status(200).json(esito);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Il consulente di una riga. Il CRM salva lo username, ma le righe piu'
   vecchie — e quelle arrivate da fuori — hanno il nome per esteso: cercare
   solo per username le lascia senza destinatario, e il messaggio non parte
   senza che si capisca perche'. */
async function schedaDelConsulente(valore) {
  const grezzo = String(valore || '').trim();
  if (!grezzo) return null;

  let scheda = await Consulente.findOne({ utente: grezzo });
  if (scheda) return scheda;

  /* per nome, senza badare a maiuscole e spazi doppi */
  const pulito = grezzo.replace(/\s+/g, ' ');
  const senzaCaratteriStrani = pulito.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  scheda = await Consulente.findOne({
    nomeCognome: new RegExp('^\\s*' + senzaCaratteriStrani + '\\s*$', 'i')
  });
  if (scheda) return scheda;

  /* ultimo tentativo: username scritto con altre maiuscole */
  return Consulente.findOne({ utente: new RegExp('^\\s*' + senzaCaratteriStrani + '\\s*$', 'i') });
}

/* Perche' non e' partito. Prende una riga vera e racconta ogni passaggio,
   senza mandare niente: e' l'unico modo di rispondere a "non parte" con un
   fatto invece che con un'ipotesi. */
app.get('/api/scenari/perche/:idRiga', async (req, res) => {
  const passi = [];
  const dì = (esito, cosa) => passi.push({ esito, cosa });

  try {
    const riga = await Centralino.findById(req.params.idRiga);
    if (!riga) return res.status(200).json({ passi: [{ esito: 'no', cosa: 'Riga non trovata' }] });

    dì('sì', `Riga: ${riga.nome || '(senza nome)'}`);
    dì(riga.tgConsInviato === 'Inviato' ? 'sì' : 'no',
      `La colonna "Tg Cons Inviato" vale: ${riga.tgConsInviato || '(vuota)'}`);
    dì(riga.tgInviatoIl ? 'no' : 'sì',
      riga.tgInviatoIl
        ? `Già inviato il ${new Date(riga.tgInviatoIl).toLocaleString('it-IT')} — non riparte`
        : 'Non è ancora stato inviato');

    const scenari = await Scenario.find({ innesco: 'colonna-tg' });
    dì(scenari.length ? 'sì' : 'no',
      scenari.length
        ? `${scenari.length} scenario/i sull'innesco "colonna-tg": ${scenari.map(s => s.nome).join(', ')}`
        : 'Nessuno scenario parte quando quella colonna cambia');

    for (const s of scenari) {
      dì(s.attivo ? 'sì' : 'no', `"${s.nome}" è ${s.attivo ? 'acceso' : 'spento'}`);
      if (s.azione !== 'telegram-consulente') continue;

      dì(process.env.TELEGRAM_BOT_TOKEN ? 'sì' : 'no',
        process.env.TELEGRAM_BOT_TOKEN
          ? 'TELEGRAM_BOT_TOKEN è configurato su Render'
          : 'TELEGRAM_BOT_TOKEN non è configurato su Render');

      dì(riga.consulente || riga.incaricoCollegatoId ? 'sì' : 'no',
        riga.consulente
          ? `Il campo consulente della riga vale: ${riga.consulente}`
          : (riga.incaricoCollegatoId
              ? 'La riga non ha un consulente, ma è collegata a un incarico'
              : 'La riga non ha né consulente né incarico collegato'));

      /* La stessa strada che segue l'invio: prima l'incarico collegato,
         poi il campo consulente della riga. Se la diagnosi guardasse
         altrove direbbe il falso, che e' peggio del non dire niente. */
      let destinatario = null;
      let daDove = '';

      if (riga.incaricoCollegatoId) {
        const incarico = await Incarico.findById(riga.incaricoCollegatoId).catch(() => null);
        dì(incarico ? 'sì' : 'no',
          incarico ? `Incarico collegato: ${incarico.nome || incarico.idElemento}`
                   : 'La riga punta a un incarico che non esiste più');
        if (incarico) {
          dì(incarico.listing ? 'sì' : 'no',
            incarico.listing ? `Consulente dell'incarico (listing): ${incarico.listing}`
                             : "L'incarico non ha un listing");
          if (incarico.listing) {
            destinatario = await schedaDelConsulente(incarico.listing);
            daDove = "dall'incarico";
          }
        }
      }

      if (!destinatario && riga.consulente) {
        destinatario = await schedaDelConsulente(riga.consulente);
        daDove = 'dalla riga';
      }

      dì(destinatario ? 'sì' : 'no',
        destinatario ? `Scheda trovata ${daDove}: ${destinatario.nomeCognome || destinatario.utente}`
                     : 'Nessuna scheda consulente trovata, né dall\'incarico né dalla riga');

      if (destinatario) {
        dì(destinatario.idTelegram ? 'sì' : 'no',
          destinatario.idTelegram
            ? `Casella Telegram: ${destinatario.idTelegram}`
            : `${destinatario.nomeCognome || destinatario.utente} non ha la casella Telegram nella sua scheda`);
      }
      dì(s.testo && s.testo.trim() ? 'sì' : 'no',
        s.testo && s.testo.trim() ? 'Il testo del messaggio c\'è' : 'Il testo del messaggio è vuoto');
    }

    const bloccanti = passi.filter(p => p.esito === 'no');
    res.status(200).json({
      passi,
      conclusione: bloccanti.length
        ? bloccanti[0].cosa
        : 'Tutto a posto: rimettendo la colonna su Inviato dovrebbe partire'
    });
  } catch (err) {
    res.status(200).json({ passi, conclusione: 'Errore nel controllo: ' + err.message });
  }
});

/* Le ultime righe del Registro Chiamate, per scegliere su quale indagare */
app.get('/api/scenari/righe-recenti', async (req, res) => {
  try {
    const righe = await Centralino.find({}).sort({ createdAt: -1 }).limit(10)
      .select('nome telefonoCliente consulente tgConsInviato tgInviatoIl createdAt');
    res.status(200).json(righe);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Esegue uno scenario su una riga. Un posto solo, cosi' il comportamento e'
   identico che parta da solo o a comando. */
async function eseguiScenario(scenario, riga, forzato) {
  const segna = async (esito, motivo) => {
    scenario.ultimoAvvio = new Date();
    scenario.ultimoEsito = esito;
    scenario.ultimoMotivo = String(motivo || '').slice(0, 300);
    scenario.quanteVolte = (scenario.quanteVolte || 0) + 1;
    if (esito === 'errore') scenario.quantiErrori = (scenario.quantiErrori || 0) + 1;
    try { await scenario.save(); } catch (e) {}
    await segnaNelDiario('scenari', esito, scenario.nome, motivo, riga.nome || '');
  };

  if (!scenario.attivo && !forzato) return { spento: true };

  const scheda = await schedaDelConsulente(riga.consulente);

  if (scenario.azione === 'telegram-consulente') {
    if (riga.tgInviatoIl) return { gia: true };

    /* Nel Registro Chiamate la colonna "ID Telegram" mostra la casella del
       consulente dell'incarico collegato — il suo listing — non quella del
       campo consulente della riga. Se la riga e' agganciata a un incarico
       si segue quella strada, che e' quella che si vede a schermo. */
    let destinatario = scheda;
    if (riga.incaricoCollegatoId) {
      try {
        const incarico = await Incarico.findById(riga.incaricoCollegatoId);
        if (incarico && incarico.listing) {
          const suo = await schedaDelConsulente(incarico.listing);
          if (suo) destinatario = suo;
        }
      } catch (e) {}
    }
    const testo = riempi(scenario.testo, {
      nome: riga.nome || '',
      telefono: riga.telefonoCliente || riga.emailCliente || 'nessun recapito',
      immobile: riga.riferimentoImmobile || '',
      portale: riga.portaleOrigine || riga.tipoRichiesta || '',
      messaggio: String(riga.messaggioCliente || '').slice(0, 300),
      consulente: (destinatario && destinatario.nomeCognome) || ''
    });
    try {
      if (!destinatario) {
        throw new Error(riga.incaricoCollegatoId
          ? "né la riga né l'incarico collegato hanno un consulente"
          : 'la riga non è assegnata a nessun consulente');
      }
      if (!destinatario.idTelegram) {
        throw new Error('manca la casella Telegram di ' +
          (destinatario.nomeCognome || destinatario.utente));
      }
      await mandaTelegram(destinatario.idTelegram, testo);
      riga.tgConsInviato = 'Inviato';
      riga.tgInviatoIl = new Date();
      await riga.save();
      await segna('ok', 'avvisato ' + (destinatario.nomeCognome || destinatario.utente));
      return { fatto: true };
    } catch (e) {
      riga.tgConsInviato = 'Non inviato';
      try { await riga.save(); } catch (x) {}
      await segna('errore', e.message);
      return { errore: e.message };
    }
  }

  if (scenario.azione === 'whatsapp-cliente') {
    if (riga.mexInviatoIl) return { gia: true };
    if (!riga.telefonoCliente) {
      await segna('errore', 'il cliente non ha lasciato un numero');
      return { errore: 'nessun numero' };
    }
    const testo = riempi(scenario.testo, {
      nome: String(riga.nome || '').trim().split(/\s+/).slice(-1)[0] || '',
      consulente: (scheda && scheda.nomeCognome) || 'Forte Immobiliare',
      immobile: riga.riferimentoImmobile ? ' per ' + riga.riferimentoImmobile : ''
    });
    try {
      await mandaWhatsapp(riga.telefonoCliente, testo);
      riga.mexClienteInviato = 'Inviato';
      riga.mexInviatoIl = new Date();
      await riga.save();
      await segna('ok', 'scritto a ' + riga.telefonoCliente);
      return { fatto: true };
    } catch (e) {
      riga.mexClienteInviato = 'Non inviato';
      try { await riga.save(); } catch (x) {}
      await segna('errore', e.message);
      return { errore: e.message };
    }
  }

  return { sconosciuta: true };
}

/* L'avviso al consulente. Una funzione sola, diretta, che torna sempre un
   esito leggibile: e' quello che mancava per capire cosa non andava. */
async function mandaAvvisoTelegram(riga) {
  const passi = [];
  try {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      throw new Error('TELEGRAM_BOT_TOKEN non è configurato su Render');
    }

    /* Il destinatario: prima il consulente dell'incarico collegato — che e'
       quello che si vede nella colonna ID Telegram — poi quello della riga. */
    let destinatario = null;
    let daDove = '';

    if (riga.incaricoCollegatoId) {
      const incarico = await Incarico.findById(riga.incaricoCollegatoId).catch(() => null);
      if (incarico && incarico.listing) {
        destinatario = await schedaDelConsulente(incarico.listing);
        daDove = "dall'incarico (" + incarico.listing + ')';
      }
      passi.push(incarico
        ? ('incarico: ' + (incarico.nome || incarico.idElemento) + ', listing: ' + (incarico.listing || 'nessuno'))
        : 'incarico collegato non trovato');
    }
    if (!destinatario && riga.consulente) {
      destinatario = await schedaDelConsulente(riga.consulente);
      daDove = 'dalla riga (' + riga.consulente + ')';
      passi.push('consulente della riga: ' + riga.consulente);
    }

    if (!destinatario) {
      throw new Error('Non trovo il consulente a cui mandarlo. ' +
        (riga.incaricoCollegatoId
          ? "L'incarico collegato non ha un listing, e la riga non ha un consulente."
          : 'La riga non ha un consulente né un immobile collegato.'));
    }
    if (!destinatario.idTelegram) {
      throw new Error((destinatario.nomeCognome || destinatario.utente) +
        ' non ha la casella Telegram nella sua scheda');
    }

    /* il testo: quello dello scenario se c'e', altrimenti uno di riserva.
       Senza scenari configurati l'avviso deve partire lo stesso. */
    const scenario = await Scenario.findOne({ azione: 'telegram-consulente' });
    const modello = (scenario && scenario.testo && scenario.testo.trim())
      ? scenario.testo
      : '🔔 Nuova richiesta\n\n👤 {nome}\n📞 {telefono}\n✉️ {mail}\n🏠 {immobile}\n\n{messaggio}';

    /* L'immobile: il campo sulla riga spesso e' vuoto perche' il collegamento
       e' all'incarico, non al testo. Lo prendo da li' e uso il campo della
       riga solo come ripiego — altrimenti la riga del messaggio resta vuota
       proprio quando serve di piu'. */
    let nomeImmobile = '';
    let riferimento = '';
    if (riga.incaricoCollegatoId) {
      const suo = await Incarico.findById(riga.incaricoCollegatoId).catch(() => null);
      if (suo) {
        nomeImmobile = suo.nome || '';
        riferimento = suo.idElemento || '';
      }
    }
    if (!nomeImmobile) nomeImmobile = riga.riferimentoImmobile || '';

    const descrizioneImmobile = [riferimento, nomeImmobile]
      .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · ');

    const testo = riempi(modello, {
      nome: riga.nome || '',
      telefono: riga.telefonoCliente || 'nessun numero',
      mail: riga.emailCliente || '',
      immobile: descrizioneImmobile,
      portale: riga.portaleOrigine || riga.tipoRichiesta || '',
      messaggio: String(riga.messaggioCliente || '').slice(0, 300),
      consulente: destinatario.nomeCognome || ''
    });

    await mandaTelegram(destinatario.idTelegram, testo);

    riga.tgConsInviato = '✅ Inviato';
    riga.tgInviatoIl = new Date();
    await riga.save();

    await segnaNelDiario('telegram', 'ok', 'avviso al consulente',
      'avvisato ' + (destinatario.nomeCognome || destinatario.utente) + ' ' + daDove, riga.nome || '');

    if (scenario) {
      scenario.ultimoAvvio = new Date(); scenario.ultimoEsito = 'ok';
      scenario.ultimoMotivo = 'avvisato ' + (destinatario.nomeCognome || destinatario.utente);
      scenario.quanteVolte = (scenario.quanteVolte || 0) + 1;
      await scenario.save().catch(() => {});
    }

    return { fatto: true, a: destinatario.nomeCognome || destinatario.utente, passi };
  } catch (e) {
    /* la colonna torna su "Non inviato": se resta su Inviato sembra fatto */
    riga.tgConsInviato = '❌ Fallito';
    await riga.save().catch(() => {});
    await segnaNelDiario('telegram', 'errore', 'avviso al consulente', e.message, riga.nome || '');

    const scenario = await Scenario.findOne({ azione: 'telegram-consulente' }).catch(() => null);
    if (scenario) {
      scenario.ultimoAvvio = new Date(); scenario.ultimoEsito = 'errore';
      scenario.ultimoMotivo = e.message;
      scenario.quanteVolte = (scenario.quanteVolte || 0) + 1;
      scenario.quantiErrori = (scenario.quantiErrori || 0) + 1;
      await scenario.save().catch(() => {});
    }
    return { fatto: false, motivo: e.message, passi };
  }
}

async function mandaMessaggioAlCliente(riga) {
  try {
    if (!riga.telefonoCliente) throw new Error('Il cliente non ha lasciato un numero');

    const scheda = await schedaDelConsulente(riga.consulente);
    const scenario = await Scenario.findOne({ azione: 'whatsapp-cliente' });
    const modello = (scenario && scenario.testo && scenario.testo.trim())
      ? scenario.testo
      : 'Buongiorno {nome}, sono {consulente} di Forte Immobiliare. ' +
        'Ho ricevuto la sua richiesta{immobile} e la richiamo al più presto.';

    const testo = riempi(modello, {
      nome: String(riga.nome || '').trim().split(/\s+/).slice(-1)[0] || '',
      consulente: (scheda && scheda.nomeCognome) || 'Forte Immobiliare',
      immobile: riga.riferimentoImmobile ? ' per ' + riga.riferimentoImmobile : ''
    });

    await mandaWhatsapp(riga.telefonoCliente, testo);
    riga.mexClienteInviato = '✅ Inviato';
    riga.mexInviatoIl = new Date();
    await riga.save();
    await segnaNelDiario('whatsapp', 'ok', 'messaggio al cliente', riga.nome || '', riga.telefonoCliente);
    return { fatto: true, a: riga.telefonoCliente };
  } catch (e) {
    riga.mexClienteInviato = '❌ Fallito';
    await riga.save().catch(() => {});
    await segnaNelDiario('whatsapp', 'errore', 'messaggio al cliente', e.message, riga.nome || '');
    return { fatto: false, motivo: e.message };
  }
}

/* Chi deve partire per questo innesco */
async function scenariPerInnesco(innesco) {
  return Scenario.find({ innesco });
}

/* A comando, per provare senza aspettare */
app.post('/api/scenari/:id/prova/:idRiga', async (req, res) => {
  try {
    const scenario = await Scenario.findById(req.params.id);
    const riga = await Centralino.findById(req.params.idRiga);
    if (!scenario || !riga) return res.status(404).json({ error: 'Non trovato' });
    /* si azzerano i segni, altrimenti crederebbe di averlo gia' fatto */
    riga.tgInviatoIl = null; riga.mexInviatoIl = null;
    res.status(200).json(await eseguiScenario(scenario, riga, true));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Gli amministratori gia' noti, per il menu a discesa */
app.get('/api/pubblico/amministratori', async (req, res) => {
  try {
    const elenco = await Amministratore.find({}, { nomeStudio: 1, referente: 1, telefono: 1, comune: 1 });
    res.set('Cache-Control', 'no-store');
    res.status(200).json(elenco
      .map(a => ({ id: String(a._id), nome: a.nomeStudio || a.referente || '',
                   telefono: a.telefono || '', comune: a.comune || '' }))
      .filter(a => a.nome)
      .sort((x, y) => x.nome.localeCompare(y.nome)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Scrivere un citofono dal campo. Se il civico non esiste lo creo:
   davanti al portone si scopre spesso un numero che non era in elenco. */
app.put('/api/pubblico/censimento/:comune/citofono', async (req, res) => {
  try {
    const b = req.body || {};
    const s = await trovaComune(req.params.comune);
    if (!s) return res.status(404).json({ error: 'Comune non trovato', cercato: req.params.comune });

    let via = (s.vie || []).find(v => v.nome === b.via);
    if (!via) { s.vie.push({ nome: b.via, zone: 'CENTRO', civici: [] }); via = s.vie[s.vie.length - 1]; }

    let civico = (via.civici || []).find(c => String(c.numero) === String(b.civico));
    if (!civico) {
      via.civici.push({ numero: String(b.civico), contestoCivico: b.contesto || 'Palazzina', citofoni: [] });
      civico = via.civici[via.civici.length - 1];
    }

    if (b.indice !== undefined && b.indice !== null && civico.citofoni[b.indice]) {
      const c = civico.citofoni[b.indice];
      if (b.nome !== undefined) c.nome = b.nome;
      if (b.piano !== undefined) c.piano = b.piano;
      if (b.stato !== undefined) c.statoProprietario = b.stato;
      if (b.unitaVisura !== undefined) c.unitaVisura = b.unitaVisura;
    } else {
      civico.citofoni.push({
        nome: b.nome || '', piano: b.piano || '', statoProprietario: b.stato || '',
        unitaVisura: b.unitaVisura || '', attivita: []
      });
    }

    s.censitoDa = b.consulente || s.censitoDa;
    s.ultimoCensimento = new Date().toISOString().slice(0, 10);
    s.markModified('vie');
    await s.save();

    res.status(200).json({ status: 'success', citofoni: civico.citofoni.length });
  } catch (err) {
    console.error('Citofono non salvato:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ==========================================
   ACQUIRENTI PER IL TELEFONO
   Le richieste in banca dati e le visite fatte, con quello che serve in
   giro: chi cerca cosa, e cosa ha detto chi ha visto la casa.
========================================== */
app.get('/api/pubblico/acquirenti/:utente', async (req, res) => {
  try {
    const utente = String(req.params.utente || '');
    const suo = (r) => !utente || r.consulente === utente;

    const [richieste, visite, incarichi] = await Promise.all([
      BancaDati.find({}).limit(700),
      Visioni.find({}).limit(700),
      Incarico.find({}, { idElemento: 1, nome: 1 }).limit(500)
    ]);

    const nomeImmobile = (id) => {
      const i = incarichi.find(x => x.idElemento === id);
      return i ? (i.nome || i.idElemento) : (id || '');
    };

    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      utente,
      richieste: richieste.filter(suo).map(r => ({
        id: String(r._id), nome: r.nomeCognome || '', telefono: r.telefono || '',
        mail: r.mail || '', stato: r.statoAdvFix || 'Da Fix',
        zone: r.comuniRicerca || '', tipologia: r.tipologiaUnita || '',
        contesto: r.tipologiaContesto || '', budget: r.budgetAcquisto || '',
        mutuo: r.mutuo || '', deveVendere: r.deveVendere || '',
        immobile: nomeImmobile(r.immobileFonteRichiesta),
        quando: String(r.createdAt || '').slice(0, 10)
      })).sort((a, b) => String(b.quando).localeCompare(String(a.quando))),

      visite: visite.filter(suo).map(v => ({
        id: String(v._id), nome: v.nomeCognome || '', telefono: v.telefono || '',
        data: String(v.dataVisione || '').slice(0, 10), ora: v.oraVisione || '',
        statoAdv: v.statoAdv || 'Fissato', feedback: v.feedbackAdv || '',
        testo: v.testoFeedback || '', valore: v.valorePercepito || '',
        immobile: nomeImmobile(v.incaricoUfficio),
        statoProposta: v.statoProposta || 'No'
      })).sort((a, b) => String(b.data).localeCompare(String(a.data)))
    });
  } catch (err) {
    console.error('Acquirenti non letti:', err);
    res.status(500).json({ error: err.message });
  }
});

/* Segnare com'e' andata una visita, da fuori */
app.put('/api/pubblico/visita/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const modifiche = {};
    if (b.statoAdv && ['Fissato', 'Fatto', 'Saltato'].indexOf(b.statoAdv) >= 0) modifiche.statoAdv = b.statoAdv;
    if (typeof b.feedbackAdv === 'string') modifiche.feedbackAdv = b.feedbackAdv;
    if (typeof b.testoFeedback === 'string') modifiche.testoFeedback = b.testoFeedback;
    if (typeof b.valorePercepito === 'string') modifiche.valorePercepito = b.valorePercepito;
    if (!Object.keys(modifiche).length) return res.status(400).json({ error: 'Niente da salvare' });

    await Visioni.findByIdAndUpdate(req.params.id, modifiche);
    res.status(200).json({ status: 'success' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Le attivita' del consulente per il telefono. Le date qui sono scritte
   come giorno/mese/anno, quindi vanno convertite per confrontarle. */
app.get('/api/pubblico/attivita/:utente', async (req, res) => {
  try {
    const utente = String(req.params.utente || '');
    const tutte = await Todo.find({}).limit(800);

    const inIso = (d) => {
      const s = String(d || '').trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      const p = s.split('/');
      return p.length === 3 ? `${p[2]}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}` : '';
    };

    const attivita = tutte
      .filter(x => !utente || x.consulente === utente)
      .map(x => ({
        id: String(x._id), data: inIso(x.data), testo: x.task || '',
        stato: x.stato || 'Attivo', note: x.note || '',
        origine: x.origine || '', collegamento: x.collegamento || ''
      }))
      .filter(x => x.data)
      .sort((a, b) => a.data.localeCompare(b.data));

    res.set('Cache-Control', 'no-store');
    res.status(200).json({ utente, attivita });
  } catch (err) {
    console.error('Attività non lette:', err);
    res.status(500).json({ error: err.message });
  }
});

/* Spuntare un'attivita' dal telefono */
app.put('/api/pubblico/attivita/:id', async (req, res) => {
  try {
    const stato = String((req.body || {}).stato || '');
    if (['Attivo', 'Completato'].indexOf(stato) === -1) {
      return res.status(400).json({ error: 'Stato non valido' });
    }
    await Todo.findByIdAndUpdate(req.params.id, { stato });
    res.status(200).json({ status: 'success', stato });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/pubblico/agenda/:utente', async (req, res) => {
  try {
    const utente = String(req.params.utente || '');
    const da = String(req.query.da || new Date().toISOString().slice(0, 10));
    const a = String(req.query.a || '');

    const nelPeriodo = (data) => {
      if (!data) return false;
      const d = String(data).slice(0, 10);
      return d >= da && (!a || d <= a);
    };
    const suo = (r) => !utente || r.consulente === utente;

    const eventi = [];

    const visioni = await Visioni.find({}).limit(600);
    visioni.filter(v => suo(v) && nelPeriodo(v.dataVisione)).forEach(v => {
      eventi.push({ tipo: 'visione', data: String(v.dataVisione).slice(0, 10),
        /* il campo si chiama oraVisione: leggendo "orario" l'agenda mostrava
           tutte le visite come "tutto il giorno" */
        orario: v.oraVisione || '', titolo: 'Visita ' + (v.nomeCognome || ''),
        dettaglio: v.incaricoUfficio || '', telefono: v.telefono || '' });
    });

    const openHouse = await OpenHouse.find({}).limit(200);
    openHouse.filter(o => suo(o) && nelPeriodo(o.data) && o.stato !== 'Annullato').forEach(o => {
      eventi.push({ tipo: 'openhouse', data: String(o.data).slice(0, 10),
        orario: o.orario || '', titolo: 'Open House', dettaglio: o.immobile || '' });
    });

    const cdv = await Cdv.find({}).limit(400);
    cdv.filter(c => suo(c)).forEach(c => {
      if (nelPeriodo(c.dataCdv1)) eventi.push({ tipo: 'cdv', data: String(c.dataCdv1).slice(0, 10),
        orario: c.orarioCdv1 || '', titolo: 'Cdv 1 ' + (c.nomeProprietario || c.nome || ''),
        dettaglio: c.indirizzo || c.comune || '', telefono: c.telefono || '' });
      if (nelPeriodo(c.dataCdv2)) eventi.push({ tipo: 'cdv', data: String(c.dataCdv2).slice(0, 10),
        orario: c.orarioCdv2 || '', titolo: 'Cdv 2 ' + (c.nomeProprietario || c.nome || ''),
        dettaglio: c.indirizzo || c.comune || '', telefono: c.telefono || '' });
    });

    const incarichi = await Incarico.find({}).limit(400);
    incarichi.filter(i => suo(i) && nelPeriodo(i.dataScadenza)).forEach(i => {
      eventi.push({ tipo: 'scadenza', data: String(i.dataScadenza).slice(0, 10), orario: '',
        titolo: 'Scade incarico', dettaglio: i.nome || i.idElemento || '' });
    });

    eventi.sort((x, y) => (x.data + (x.orario || '')).localeCompare(y.data + (y.orario || '')));
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ utente, da, eventi });
  } catch (err) {
    console.error('Agenda non letta:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ==========================================
   CONNESSIONI AI SOCIAL
   Il collegamento a ciascuna piattaforma: il consenso si da' una volta e
   il permesso resta qui, sul server. La pagina non vede mai i token.
========================================== */
const ConnessioneSocialSchema = new mongoose.Schema({
  canale: { type: String, required: true },        // facebook | instagram | linkedin | x | tiktok
  nomeAccount: { type: String, default: '' },      // come si chiama la pagina o il profilo collegato
  idAccount: { type: String, default: '' },        // id della pagina Facebook o dell'account Instagram
  token: { type: String, default: '' },
  scadenza: { type: String, default: '' },
  collegatoDa: { type: String, default: '' },
  attiva: { type: Boolean, default: true }
}, { timestamps: true });
const ConnessioneSocial = mongoose.model('ConnessioneSocial', ConnessioneSocialSchema);

/* Le credenziali dell'applicazione: si registrano una volta presso ogni
   piattaforma e si mettono qui come variabili d'ambiente. Senza queste,
   il collegamento non puo' nemmeno cominciare. */
const SOCIAL_CONFIG = {
  facebook: {
    nome: 'Facebook',
    id: process.env.META_APP_ID || '',
    segreto: process.env.META_APP_SECRET || '',
    autorizza: 'https://www.facebook.com/v21.0/dialog/oauth',
    permessi: 'pages_show_list,pages_manage_posts,pages_read_engagement,business_management'
  },
  instagram: {
    nome: 'Instagram',
    id: process.env.META_APP_ID || '',
    segreto: process.env.META_APP_SECRET || '',
    autorizza: 'https://www.facebook.com/v21.0/dialog/oauth',
    permessi: 'instagram_basic,instagram_content_publish,pages_show_list,business_management'
  },
  linkedin: {
    nome: 'LinkedIn',
    id: process.env.LINKEDIN_CLIENT_ID || '',
    segreto: process.env.LINKEDIN_CLIENT_SECRET || '',
    autorizza: 'https://www.linkedin.com/oauth/v2/authorization',
    permessi: 'w_member_social,r_liteprofile'
  },
  x: {
    nome: 'X',
    id: process.env.X_CLIENT_ID || '',
    segreto: process.env.X_CLIENT_SECRET || '',
    autorizza: 'https://twitter.com/i/oauth2/authorize',
    permessi: 'tweet.read tweet.write users.read offline.access'
  },
  tiktok: {
    nome: 'TikTok',
    id: process.env.TIKTOK_CLIENT_KEY || '',
    segreto: process.env.TIKTOK_CLIENT_SECRET || '',
    autorizza: 'https://www.tiktok.com/v2/auth/authorize/',
    permessi: 'video.publish,video.upload'
  }
};

const INDIRIZZO_SERVER = process.env.INDIRIZZO_SERVER || 'https://forte-crm-backend.onrender.com';

/* I collegamenti a meta' strada: quando ci sono piu' pagine fra cui scegliere,
   il permesso e' gia' stato ottenuto e va tenuto da parte per un minuto.
   Non si puo' rifare lo scambio: il codice che Meta manda vale una volta sola,
   ed e' proprio questo che rompeva la scelta della pagina. */
const COLLEGAMENTI_IN_CORSO = new Map();

/* Il codice che Meta manda vale una volta sola: se la stessa pagina di ritorno
   viene caricata due volte — succede, e non sempre per colpa di chi la usa:
   ci sono browser che precaricano gli indirizzi e servizi che li controllano —
   il secondo tentativo fallirebbe. Quindi il risultato dello scambio lo tengo
   da parte per qualche minuto: se il codice torna, riuso quello che ho gia'
   invece di richiedere a Meta. */
const CODICI_SCAMBIATI = new Map();

setInterval(() => {
  const limite = Date.now() - 10 * 60 * 1000;
  for (const [chiave, dato] of COLLEGAMENTI_IN_CORSO) {
    if (dato.quando < limite) COLLEGAMENTI_IN_CORSO.delete(chiave);
  }
  for (const [chiave, dato] of CODICI_SCAMBIATI) {
    if (dato.quando < limite) CODICI_SCAMBIATI.delete(chiave);
  }
}, 5 * 60 * 1000);

/* Dice quali canali sono collegati e quali credenziali mancano. E' la prima
   cosa che la finestra delle connessioni chiede. */
app.get('/api/social/stato', async (req, res) => {
  try {
    const collegate = await ConnessioneSocial.find({ attiva: true },
      { canale: 1, nomeAccount: 1, idAccount: 1, scadenza: 1, collegatoDa: 1, updatedAt: 1, _id: 0 });

    const canali = Object.keys(SOCIAL_CONFIG).map(chiave => {
      const c = SOCIAL_CONFIG[chiave];
      const connessione = collegate.find(x => x.canale === chiave);
      return {
        canale: chiave,
        nome: c.nome,
        configurato: !!(c.id && c.segreto),      // l'applicazione e' registrata?
        collegato: !!connessione,
        nomeAccount: connessione ? connessione.nomeAccount : '',
        idAccount: connessione ? connessione.idAccount : '',
        scadenza: connessione ? connessione.scadenza : '',
        collegatoDa: connessione ? connessione.collegatoDa : ''
      };
    });

    res.status(200).json({
      versione: 'codice-riusabile-3',    // cambia a ogni modifica: dice quale codice gira davvero
      canali,
      indirizzoRitorno: INDIRIZZO_SERVER + '/api/social/ritorno',
      collegamentiInCorso: COLLEGAMENTI_IN_CORSO.size
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Primo passo: si manda l'utente alla pagina di consenso della piattaforma */
app.get('/api/social/avvia/:canale', (req, res) => {
  const chiave = String(req.params.canale || '');
  const c = SOCIAL_CONFIG[chiave];
  if (!c) return res.status(404).send('Canale sconosciuto');
  if (!c.id || !c.segreto) {
    return res.status(503).send(
      `<p style="font-family:sans-serif;padding:30px">L'applicazione ${c.nome} non e' ancora registrata.<br><br>` +
      `Servono le credenziali nelle variabili d'ambiente del server.</p>`);
  }

  const ritorno = INDIRIZZO_SERVER + '/api/social/ritorno';
  const stato = chiave + ':' + Math.random().toString(36).slice(2);

  const parametri = new URLSearchParams({
    client_id: c.id,
    redirect_uri: ritorno,
    state: stato,
    response_type: 'code',
    scope: c.permessi
  });

  res.redirect(c.autorizza + '?' + parametri.toString());
});

/* Secondo passo: la piattaforma rimanda qui con un codice, che si scambia
   con il permesso vero e proprio. */
app.get('/api/social/ritorno', async (req, res) => {
  const chiudi = (messaggio, colore) => res.status(200).send(
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
     <body style="font-family:system-ui,sans-serif;background:#0B3B4A;color:#fff;display:flex;
                  align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">
       <div><div style="font-size:15px;font-weight:800;letter-spacing:1.4px;margin-bottom:14px">
         FORTE <span style="color:#C6A777">IMMOBILIARE</span></div>
       <div style="color:${colore};font-size:14px;line-height:1.7;max-width:44ch">${messaggio}</div>
       <div style="color:#8fb3c0;font-size:12px;margin-top:18px">Puoi chiudere questa finestra.</div></div>
       <script>setTimeout(function(){ try{ window.opener && window.opener.postMessage('social-aggiornato','*'); window.close(); }catch(e){} }, 2200);<\/script>
     </body></html>`);

  try {
    const codice = req.query.code;
    const stato = String(req.query.state || '');
    const chiave = stato.split(':')[0];
    const c = SOCIAL_CONFIG[chiave];

    if (req.query.error) return chiudi('Collegamento annullato: ' + (req.query.error_description || req.query.error), '#f8a4b0');
    if (!c) return chiudi('Risposta incompleta dalla piattaforma.', '#f8a4b0');

    /* Secondo passaggio: si sta tornando dalla scelta della pagina. Il permesso
       ce l'ho gia' da prima — il codice di Meta e' gia' stato speso e non si
       puo' riusare. */
    const inCorso = COLLEGAMENTI_IN_CORSO.get(stato);
    if (req.query.pagina && inCorso) {
      const scelta = (inCorso.pagine || []).find(p => p.id === req.query.pagina);
      if (!scelta) return chiudi('Pagina non piu\' disponibile: riprova il collegamento.', '#e2b13c');
      COLLEGAMENTI_IN_CORSO.delete(stato);

      let tokenScelto = scelta.access_token, idScelto = scelta.id, nomeScelto = scelta.name;
      if (chiave === 'instagram') {
        if (!scelta.instagram_business_account) {
          return chiudi('La pagina "' + scelta.name + '" non ha un account Instagram professionale collegato.', '#e2b13c');
        }
        idScelto = scelta.instagram_business_account.id;
        nomeScelto = scelta.name + ' (Instagram)';
      }

      await ConnessioneSocial.findOneAndUpdate({ canale: chiave },
        { canale: chiave, token: tokenScelto, idAccount: idScelto, nomeAccount: nomeScelto, attiva: true },
        { upsert: true, new: true });

      return chiudi('<strong>' + c.nome + ' collegato.</strong><br>Account: ' + nomeScelto, '#8fe5b0');
    }

    if (!codice) return chiudi('Risposta incompleta dalla piattaforma.', '#f8a4b0');

    /* lo scambio del codice con il token: per Meta e' una chiamata sola */
    let token = '', nomeAccount = '', idAccount = '', scadenza = '';

    if (chiave === 'facebook' || chiave === 'instagram') {
      const parametri = new URLSearchParams({
        client_id: c.id, client_secret: c.segreto,
        redirect_uri: INDIRIZZO_SERVER + '/api/social/ritorno', code: codice
      });
      /* gia' scambiato poco fa? riuso, invece di bruciare il codice una seconda volta */
      const gia = CODICI_SCAMBIATI.get(codice);
      let risposta;
      if (gia) {
        console.log('[social] codice gia\' scambiato: riuso il permesso');
        risposta = { access_token: gia.token };
      } else {
        console.log('[social] scambio del codice per', chiave, '- stato', stato);
        risposta = await chiamataJson('graph.facebook.com', '/v21.0/oauth/access_token?' + parametri.toString(), 'GET');
        if (risposta.access_token) CODICI_SCAMBIATI.set(codice, { token: risposta.access_token, quando: Date.now() });
      }

      if (risposta.error) {
        const messaggio = risposta.error.message || 'errore sconosciuto';
        /* questo errore ha una causa sola: la stessa pagina e' stata caricata due
           volte, di solito ricaricando la finestra del collegamento */
        const riusato = /has been used|already been used/i.test(messaggio);
        return chiudi(riusato
          ? '<strong>Questo collegamento era già stato usato.</strong><br>' +
            'Chiudi questa finestra e premi di nuovo Collega dal CRM: ' +
            'non ricaricare questa pagina, ogni tentativo vale una volta sola.'
          : 'Meta ha rifiutato: ' + messaggio, '#f8a4b0');
      }
      token = risposta.access_token;

      /* Le pagine che amministri. Se sono piu' di una NON scelgo io: mostro
         l'elenco e decidi tu. Prendere la prima e' il modo migliore per
         pubblicare sulla pagina sbagliata senza accorgersene. */
      const pagine = await chiamataJson('graph.facebook.com',
        '/v21.0/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=' + token, 'GET');
      const elenco = pagine.data || [];
      if (!elenco.length) return chiudi('Nessuna pagina Facebook trovata su questo account.', '#e2b13c');

      const sceltaId = req.query.pagina;
      let scelta = sceltaId ? elenco.find(p => p.id === sceltaId) : null;

      if (!scelta) {
        if (elenco.length === 1) {
          scelta = elenco[0];
        } else {
          /* piu' pagine: tengo da parte il permesso e chiedo quale */
          COLLEGAMENTI_IN_CORSO.set(stato, { pagine: elenco, quando: Date.now() });

          const bottoni = elenco.map(p => {
            const adatta = (chiave === 'instagram') ? !!p.instagram_business_account : true;
            const indirizzo = INDIRIZZO_SERVER + '/api/social/ritorno?state=' + encodeURIComponent(stato) +
                              '&pagina=' + encodeURIComponent(p.id);
            return `<a href="${adatta ? indirizzo : '#'}" ${adatta ? '' : 'onclick="return false"'}
              style="display:flex;align-items:center;gap:12px;background:${adatta ? '#12323f' : '#0e2029'};
                     border:1px solid ${adatta ? '#C6A777' : '#1d3b47'};border-radius:9px;padding:14px 16px;
                     margin-bottom:9px;text-decoration:none;color:#fff;${adatta ? '' : 'opacity:.5;cursor:not-allowed;'}">
              <div style="flex:1;text-align:left">
                <div style="font-weight:700;font-size:14px">${p.name}</div>
                <div style="color:#8fb3c0;font-size:11.5px;margin-top:3px">
                  ${chiave === 'instagram'
                    ? (p.instagram_business_account ? 'ha un account Instagram professionale collegato'
                                                    : 'nessun Instagram professionale collegato')
                    : 'pagina Facebook'}</div>
              </div>
              ${adatta ? '<span style="color:#C6A777;font-size:18px">&rsaquo;</span>' : ''}
            </a>`;
          }).join('');

          return res.status(200).send(
            `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
             <body style="font-family:system-ui,sans-serif;background:#0B3B4A;color:#fff;margin:0;padding:34px 26px">
               <div style="max-width:460px;margin:0 auto">
                 <div style="font-size:15px;font-weight:800;letter-spacing:1.4px;margin-bottom:6px;text-align:center">
                   FORTE <span style="color:#C6A777">IMMOBILIARE</span></div>
                 <div style="color:#8fb3c0;font-size:13.5px;line-height:1.6;text-align:center;margin-bottom:22px">
                   Amministri più di una pagina.<br>Su quale vuoi pubblicare?</div>
                 ${bottoni}
               </div></body></html>`);
        }
      }

      if (chiave === 'facebook') {
        token = scelta.access_token; idAccount = scelta.id; nomeAccount = scelta.name;
      } else {
        if (!scelta.instagram_business_account) {
          return chiudi('La pagina "' + scelta.name + '" non ha un account Instagram professionale collegato.', '#e2b13c');
        }
        token = scelta.access_token;
        idAccount = scelta.instagram_business_account.id;
        nomeAccount = scelta.name + ' (Instagram)';
      }
    } else {
      return chiudi('Il collegamento a ' + c.nome + ' non e\' ancora attivo su questo server.', '#e2b13c');
    }

    await ConnessioneSocial.findOneAndUpdate({ canale: chiave },
      { canale: chiave, token, idAccount, nomeAccount, scadenza, attiva: true },
      { upsert: true, new: true });

    chiudi('<strong>' + c.nome + ' collegato.</strong><br>Account: ' + nomeAccount, '#8fe5b0');
  } catch (err) {
    console.error('Collegamento social non riuscito:', err);
    chiudi('Qualcosa e\' andato storto: ' + err.message, '#f8a4b0');
  }
});

app.delete('/api/social/:canale', async (req, res) => {
  try {
    await ConnessioneSocial.deleteOne({ canale: String(req.params.canale || '') });
    res.status(200).json({ status: 'success' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================
   PUBBLICAZIONE
   Su Facebook si pubblica in una chiamata. Su Instagram in due: prima si
   prepara il contenitore con l'immagine, poi lo si pubblica. E' il modo in
   cui funziona la loro interfaccia, non una complicazione nostra.
========================================== */
async function pubblicaSuCanale(canale, testo, immagine) {
  const connessione = await ConnessioneSocial.findOne({ canale, attiva: true });
  if (!connessione || !connessione.token) throw new Error(SOCIAL_CONFIG[canale].nome + ' non e\' collegato');

  if (canale === 'facebook') {
    const parametri = new URLSearchParams({ access_token: connessione.token });
    if (immagine) { parametri.set('url', immagine); parametri.set('caption', testo); }
    else { parametri.set('message', testo); }
    const percorso = `/v21.0/${connessione.idAccount}/${immagine ? 'photos' : 'feed'}?` + parametri.toString();
    const esito = await chiamataJson('graph.facebook.com', percorso, 'POST');
    if (esito.error) throw new Error(esito.error.message);
    return { id: esito.id || esito.post_id };
  }

  if (canale === 'instagram') {
    if (!immagine) throw new Error('Instagram vuole un\'immagine: senza, non si pubblica');
    const creazione = await chiamataJson('graph.facebook.com',
      `/v21.0/${connessione.idAccount}/media?` + new URLSearchParams({
        image_url: immagine, caption: testo, access_token: connessione.token
      }).toString(), 'POST');
    if (creazione.error) throw new Error(creazione.error.message);

    const pubblicazione = await chiamataJson('graph.facebook.com',
      `/v21.0/${connessione.idAccount}/media_publish?` + new URLSearchParams({
        creation_id: creazione.id, access_token: connessione.token
      }).toString(), 'POST');
    if (pubblicazione.error) throw new Error(pubblicazione.error.message);
    return { id: pubblicazione.id };
  }

  throw new Error('La pubblicazione su ' + SOCIAL_CONFIG[canale].nome + ' non e\' ancora attiva');
}

app.post('/api/social/pubblica', async (req, res) => {
  /* ogni pubblicazione lascia una riga: e' l'unico modo per accorgersi che
     un canale ha smesso di funzionare senza controllarlo a mano */
  try {
    const { idPost, canale, testo, immagine } = req.body || {};
    if (!canale) return res.status(400).json({ error: 'Manca il canale' });
    if (!testo && !immagine) return res.status(400).json({ error: 'Non c\'e\' niente da pubblicare' });

    const esito = await pubblicaSuCanale(canale, testo || '', immagine || '');

    /* segno il risultato sul contenuto, cosi' l'elenco lo sa */
    if (idPost) {
      const post = await Post.findById(idPost);
      if (post) {
        const canali = post.canali || {};
        canali[canale] = Object.assign({}, canali[canale], {
          previsto: true, pubblicato: true,
          quando: new Date().toISOString().slice(0, 10), idPubblicazione: esito.id
        });
        post.canali = canali;
        post.markModified('canali');
        await post.save();
      }
    }
    res.status(200).json({ status: 'success', id: esito.id });
  } catch (err) {
    console.error('Pubblicazione non riuscita:', err);
    res.status(502).json({ error: err.message });
  }
});

/* ==========================================
   PROGRAMMAZIONE
   Ogni cinque minuti guarda se c'e' qualcosa da pubblicare. Su Render il
   servizio gratuito si addormenta quando nessuno lo usa: la programmazione
   funziona solo se il piano lo tiene sveglio.
========================================== */
async function eseguiProgrammazioni() {
  try {
    const adesso = new Date().toISOString().slice(0, 16);       // aaaa-mm-ggThh:mm
    const daFare = await Post.find({
      stato: 'Programmato',
      dataProgrammata: { $ne: '', $lte: adesso }
    }).limit(20);

    for (const post of daFare) {
      const canali = post.canali || {};
      let tuttiFatti = true;

      for (const canale of Object.keys(canali)) {
        const suo = canali[canale] || {};
        if (!suo.previsto || suo.pubblicato) continue;
        try {
          const esito = await pubblicaSuCanale(canale, suo.testo || post.testo, (post.media || [])[0] || '');
          canali[canale] = Object.assign({}, suo, {
            pubblicato: true, quando: new Date().toISOString().slice(0, 10), idPubblicazione: esito.id
          });
        } catch (e) {
          console.error('Programmazione fallita su', canale, e.message);
          canali[canale] = Object.assign({}, suo, { errore: e.message });
          tuttiFatti = false;
        }
      }

      post.canali = canali;
      post.markModified('canali');
      if (tuttiFatti) post.stato = 'Pubblicato';
      await post.save();
    }
  } catch (err) { console.error('Giro delle programmazioni non riuscito:', err); }
}

setInterval(eseguiProgrammazioni, 5 * 60 * 1000);

/* Una chiamata che restituisce JSON, per non ripetere le stesse dieci righe */
function chiamataJson(dominio, percorso, metodo, corpo) {
  return new Promise((risolvi, rifiuta) => {
    const opzioni = { hostname: dominio, path: percorso, method: metodo || 'GET', headers: {} };
    if (corpo) {
      opzioni.headers['Content-Type'] = 'application/json';
      opzioni.headers['Content-Length'] = Buffer.byteLength(corpo);
    }
    const r = https.request(opzioni, (risposta) => {
      let pezzi = '';
      risposta.on('data', c => pezzi += c);
      risposta.on('end', () => { try { risolvi(JSON.parse(pezzi || '{}')); } catch (e) { rifiuta(new Error('risposta illeggibile')); } });
    });
    r.on('error', rifiuta);
    if (corpo) r.write(corpo);
    r.end();
  });
}

app.get('/api/professionisti', async (req, res) => {
  try { res.status(200).json(await Professionista.find({}).sort({ createdAt: -1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/professionisti', async (req, res) => {
  try { res.status(201).json({ status: 'success', data: await new Professionista(req.body).save() }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/professionisti/:id', async (req, res) => {
  try {
    const payload = (req.body && req.body.campo !== undefined)
      ? { [req.body.campo]: req.body.valore }
      : req.body;
    const aggiornato = await Professionista.findByIdAndUpdate(req.params.id, { $set: payload }, { new: true });
    if (!aggiornato) return res.status(404).json({ error: 'Professionista non trovato' });
    res.status(200).json({ status: 'success', data: aggiornato });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/professionisti/:id', async (req, res) => {
  try {
    await Professionista.findByIdAndDelete(req.params.id);
    res.status(200).json({ status: 'success' });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/transazioni', async (req, res) => {
  try { res.status(200).json(await Transazione.find({}).sort({ createdAt: -1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/transazioni', async (req, res) => {
  try {
    // Una sola transazione per proposta: se esiste gia' la aggiorna invece di duplicarla
    const esistente = req.body.propostaOrigineId
      ? await Transazione.findOne({ propostaOrigineId: req.body.propostaOrigineId })
      : null;
    if (esistente) {
      const aggiornata = await Transazione.findByIdAndUpdate(esistente._id, { $set: req.body }, { new: true });
      return res.status(200).json({ status: 'success', message: 'Transazione gia presente, aggiornata.', data: aggiornata });
    }
    const nuova = await new Transazione(req.body).save();
    res.status(201).json({ status: 'success', data: nuova });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/transazioni/:id', async (req, res) => {
  try {
    const payload = (req.body && req.body.campo !== undefined)
      ? { [req.body.campo]: req.body.valore }   // aggiornamento di una singola cella
      : req.body;
    const aggiornata = await Transazione.findByIdAndUpdate(req.params.id, { $set: payload }, { new: true });
    if (!aggiornata) return res.status(404).json({ error: 'Transazione non trovata' });
    res.status(200).json({ status: 'success', data: aggiornata });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/transazioni/:id', async (req, res) => {
  try {
    await Transazione.findByIdAndDelete(req.params.id);
    res.status(200).json({ status: 'success' });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/proposte/:id', async (req, res) => {
  try {
    await Proposta.findByIdAndDelete(req.params.id);
    res.status(200).json({ status: 'success' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================
   ROTTE API: INCARICHI GESTIONE MANUALE ED EXCEL
========================================== */
app.get('/api/incarichi', async (req, res) => {
  try {
    const elenco = await Incarico.find({}).sort({ createdAt: -1 });
    res.status(200).json(elenco);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Geocodifica un indirizzo tramite Google Maps, chiamata dal server (non dal browser) per evitare
// i blocchi CORS che Google a volte applica alle chiamate dirette dai siti.
const GOOGLE_MAPS_API_KEY_SERVER = process.env.GOOGLE_MAPS_API_KEY_SERVER;
app.get('/api/geocodifica', async (req, res) => {
  try {
    const { indirizzo } = req.query;
    if (!indirizzo) return res.status(200).json({ trovato: false });
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(indirizzo)}&key=${GOOGLE_MAPS_API_KEY_SERVER}`;
    const rispostaGoogle = await new Promise((risolvi, rifiuta) => {
      https.get(url, (r) => {
        let dati = '';
        r.on('data', (pezzo) => dati += pezzo);
        r.on('end', () => risolvi(dati));
      }).on('error', rifiuta);
    });
    const dati = JSON.parse(rispostaGoogle);
    if (dati.status !== 'OK' || !dati.results || dati.results.length === 0) return res.status(200).json({ trovato: false });
    const componenti = dati.results[0].address_components;
    const trovaComponente = (tipo) => {
      const c = componenti.find(x => x.types.includes(tipo));
      return c ? c.long_name : '';
    };
    const comune = trovaComponente('locality') || trovaComponente('administrative_area_level_3') || '';
    const via = [trovaComponente('route'), trovaComponente('street_number')].filter(x => x).join(' ');
    res.status(200).json({ trovato: true, comune, via });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ricerca un incarico per ID Elemento (es. "IF-14") o, in mancanza, per corrispondenza parziale
// nella posizione. Pensata per essere chiamata da automazioni esterne (es. Make.com) per collegare
// automaticamente una nuova chiamata del Centralino all'incarico giusto.
app.get('/api/incarichi/cerca', async (req, res) => {
  try {
    const { idElemento, posizione } = req.query;
    let trovato = null;
    if (idElemento) {
      trovato = await Incarico.findOne({ idElemento: idElemento.trim() });
    }
    if (!trovato && posizione) {
      trovato = await Incarico.findOne({ posizione: { $regex: posizione.trim(), $options: 'i' } });
    }
    if (!trovato) return res.status(200).json({ trovato: false });
    res.status(200).json({ trovato: true, incarico: trovato });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/incarichi', async (req, res) => {
  try {
    let payload = { ...req.body };
    // Codice automatico IF-N, che continua la numerazione reale (se l'ultimo importato è IF-119,
    // il prossimo generato in automatico sarà IF-120). Scatta solo se non è stato specificato un ID
    // (l'import Excel porta già i suoi codici IF-XX).
    if (!payload.idElemento || !payload.idElemento.toString().trim()) {
      const esistenti = await Incarico.find({ idElemento: /^IF-\d+$/ });
      let maxN = 0;
      esistenti.forEach(e => {
        const m = e.idElemento.match(/^IF-(\d+)$/);
        if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
      });
      payload.idElemento = `IF-${maxN + 1}`;
    }
    const nuovo = new Incarico(payload);
    res.status(201).json(await nuovo.save());
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/incarichi/massivo', async (req, res) => {
  try {
    const inseriti = await Incarico.insertMany(req.body);
    res.status(201).json({ status: 'success', count: inseriti.length });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Modifica generica di un campo (usata per l'editing inline nella tabella)
app.put('/api/incarichi/:id', async (req, res) => {
  try {
    // Due formati possibili: quello vecchio { campo, valore } (usato dalla modifica di singole celle
    // in tabella), oppure un oggetto con più campi insieme (usato dal popup Gestione Documenti).
    const datiDaAggiornare = (req.body.campo !== undefined) ? { [req.body.campo]: req.body.valore } : req.body;
    const aggiornato = await Incarico.findByIdAndUpdate(req.params.id, { $set: datiDaAggiornare }, { new: true });
    if (!aggiornato) return res.status(404).json({ error: 'Incarico non trovato' });
    res.status(200).json({ status: 'success', data: aggiornato });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/incarichi/svuota', async (req, res) => {
  try {
    await Incarico.deleteMany({});
    res.status(200).json({ status: 'success', message: 'Incarichi azzerati' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/incarichi/:id', async (req, res) => {
  try {
    const eliminato = await Incarico.findByIdAndDelete(req.params.id);
    if (!eliminato) return res.status(404).json({ error: 'Incarico non trovato' });
    res.status(200).json({ status: 'success', message: 'Incarico eliminato con successo' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================
   ROTTE API: CAPITALE SOCIALE CON INTEGRAZIONE INTELLIGENTE (UPSERT LOGIC)
========================================== */
app.get('/api/capitale-sociale', async (req, res) => {
  try {
    const elenco = await CapitaleSociale.find({}).sort({ nome: 1 });
    res.status(200).json(elenco);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/capitale-sociale', async (req, res) => {
  try {
    const { nome, cf, tel, mail, inseritoDa, casaCensita, dataNascita, luogoNascita } = req.body;

    // Se la chiamata proviene dall'automazione del citofono, verifichiamo la presenza duplicati
    if (casaCensita) {
      let proprietarioEsistente = await CapitaleSociale.findOne({ nome: nome });

      if (proprietarioEsistente) {
        // Controlliamo se l'immobile è già salvato nella lista delle proprietà di questo utente
        const indiceEsistente = proprietarioEsistente.proprieta.findIndex(p =>
          p.paese === casaCensita.paese &&
          p.via === casaCensita.via &&
          p.civico === casaCensita.civico &&
          p.sub === casaCensita.sub
        );

        if (indiceEsistente === -1) {
          // Immobile nuovo per questo proprietario: lo aggiungiamo
          proprietarioEsistente.proprieta.push(casaCensita);
        } else {
          // Immobile già collegato: aggiorniamo sempre i suoi dettagli con quelli più recenti
          proprietarioEsistente.proprieta[indiceEsistente].set(casaCensita);
        }
        /* Completo cio' che manca senza sovrascrivere quello che c'e' gia':
           l'automazione porta i dati della visura, ma un codice fiscale
           corretto a mano non va buttato via. */
        if (cf && !proprietarioEsistente.cf) proprietarioEsistente.cf = cf;
        if (dataNascita && !proprietarioEsistente.dataNascita) proprietarioEsistente.dataNascita = dataNascita;
        if (luogoNascita && !proprietarioEsistente.luogoNascita) proprietarioEsistente.luogoNascita = luogoNascita;

        await proprietarioEsistente.save();
        return res.status(200).json({ status: 'success', message: 'Anagrafica aggiornata.', data: proprietarioEsistente });
      } else {
        // Nuovo proprietario assoluto, creiamo il record con la prima casa dentro l'array
        const nuovoRecord = new CapitaleSociale({
          nome, cf, tel, mail, inseritoDa,
          dataNascita: dataNascita || '', luogoNascita: luogoNascita || '',
          proprieta: [casaCensita]
        });
        await nuovoRecord.save();
        return res.status(201).json({ status: 'success', message: 'Nuovo proprietario creato con immobile.', data: nuovoRecord });
      }
    }

    // Inserimento manuale standard da bottone "+ Nuovo Inserimento"
    const nuovoManuale = new CapitaleSociale(req.body);
    res.status(201).json({ status: 'success', data: await nuovoManuale.save() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Rimuove un immobile specifico dalla scheda di un proprietario (usato quando si rinomina
// un nominativo o si toglie un collegamento citofono-proprietari, per non lasciare schede "orfane").
// Se la motivazione è "Cambio Nominativo", l'unità rimossa viene archiviata in Unità Rimosse
// (utile per capire quali immobili sono stati venduti/passati ad altro proprietario).
// Se dopo la rimozione il proprietario non ha più nessun immobile collegato, la scheda viene eliminata.
/* Riporta nel censimento i dati corretti in anagrafica. Cerca la persona
   nelle unita' da visura degli immobili che le sono attribuiti: e' un giro
   corto, perche' gli immobili li conosciamo gia' dal suo elenco. */
async function allineaCensimentoDaAnagrafica(proprietario) {
  try {
    const nome = String(proprietario.nome || '').trim().toLowerCase();
    if (!nome) return;

    const comuni = Array.from(new Set(
      (proprietario.proprieta || []).map(p => p.paese).filter(Boolean)));
    if (!comuni.length) return;

    for (const nomeComune of comuni) {
      const s = await trovaComune(nomeComune);
      if (!s) continue;
      let toccato = false;

      (s.vie || []).forEach(via => {
        (via.civici || []).forEach(civ => {
          (civ.proprietariNonResidenti || []).forEach(unita => {
            (unita.proprietari || []).forEach(p => {
              if (String(p.nomeCognome || '').trim().toLowerCase() !== nome) return;
              if (proprietario.cf !== undefined && p.cf !== proprietario.cf) {
                p.cf = proprietario.cf; toccato = true;
              }
              if (proprietario.dataNascita !== undefined && p.dataNascita !== proprietario.dataNascita) {
                p.dataNascita = proprietario.dataNascita; toccato = true;
              }
              if (proprietario.luogoNascita !== undefined && p.luogoNascita !== proprietario.luogoNascita) {
                p.luogoNascita = proprietario.luogoNascita; toccato = true;
              }
            });
          });
        });
      });

      if (toccato) { s.markModified('vie'); await s.save(); }
    }
  } catch (err) {
    console.error('Allineamento del censimento non riuscito:', err);
  }
}

app.put('/api/capitale-sociale/rimuovi-immobile', async (req, res) => {
  try {
    const { nome, paese, via, civico, sub, motivazione, rimossoDa } = req.body;
    const proprietario = await CapitaleSociale.findOne({ nome });
    if (!proprietario) return res.status(200).json({ status: 'success', message: 'Proprietario non trovato, nulla da rimuovere.' });

    const immobileRimosso = proprietario.proprieta.find(p =>
      p.paese === paese && p.via === via && p.civico === civico && p.sub === sub
    );

    proprietario.proprieta = proprietario.proprieta.filter(p =>
      !(p.paese === paese && p.via === via && p.civico === civico && p.sub === sub)
    );

    if (motivazione === 'Cambio Nominativo' && immobileRimosso) {
      await UnitaRimossa.create({
        nomePrecedente: nome,
        paese: immobileRimosso.paese, via: immobileRimosso.via, civico: immobileRimosso.civico,
        contesto: immobileRimosso.contesto, foglio: immobileRimosso.foglio, mappale: immobileRimosso.mappale,
        sub: immobileRimosso.sub, piano: immobileRimosso.piano, vani: immobileRimosso.vani, mq: immobileRimosso.mq,
        motivazione, rimossoDa: rimossoDa || ''
      });
    }

    if (proprietario.proprieta.length === 0) {
      await CapitaleSociale.findByIdAndDelete(proprietario._id);
      return res.status(200).json({ status: 'success', message: 'Immobile rimosso e scheda eliminata (nessun altro immobile collegato).' });
    }

    await proprietario.save();
    res.status(200).json({ status: 'success', message: 'Immobile rimosso dal proprietario.', data: proprietario });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Modifica i dettagli anagrafici di un proprietario già censito (data nascita, telefono, mail, social)
app.put('/api/capitale-sociale/:id/dettagli', async (req, res) => {
  try {
    const campiConsentiti = ['dataNascita', 'luogoNascita', 'tel', 'mail', 'social', 'cf', 'residenzaId'];
    const aggiornamento = {};
    for (const campo of campiConsentiti) {
      if (req.body[campo] !== undefined) aggiornamento[campo] = req.body[campo];
    }
    const aggiornato = await CapitaleSociale.findByIdAndUpdate(req.params.id, { $set: aggiornamento }, { new: true });
    if (!aggiornato) return res.status(404).json({ error: 'Proprietario non trovato' });

    /* Il dato torna anche nel censimento: senza questo, correggendo un codice
       fiscale in anagrafica restava quello sbagliato nelle visure, e le due
       copie divergevano senza che nessuno se ne accorgesse. */
    await allineaCensimentoDaAnagrafica(aggiornato);

    res.status(200).json({ status: 'success', data: aggiornato });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Modifica lo Stato Immobile (Residente / Vuoto / Locato / Abitato da Familiare) di una specifica unità
app.put('/api/capitale-sociale/:id/proprieta/:proprietaId', async (req, res) => {
  try {
    const proprietario = await CapitaleSociale.findById(req.params.id);
    if (!proprietario) return res.status(404).json({ error: 'Proprietario non trovato' });
    const unita = proprietario.proprieta.id(req.params.proprietaId);
    if (!unita) return res.status(404).json({ error: 'Unità non trovata' });
    if (req.body.statoImmobile !== undefined) unita.statoImmobile = req.body.statoImmobile;
    await proprietario.save();
    res.status(200).json({ status: 'success', data: proprietario });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* ==========================================
   ROTTE API: ARCHIVIO UNITÀ RIMOSSE
========================================== */
/* Aggiornamento generico di una scheda dell'anagrafica (usato per assegnare il consulente) */
app.put('/api/capitale-sociale/:id', async (req, res) => {
  try {
    const payload = (req.body && req.body.campo !== undefined) ? { [req.body.campo]: req.body.valore } : req.body;
    const aggiornato = await CapitaleSociale.findByIdAndUpdate(req.params.id, { $set: payload }, { new: true });
    if (!aggiornato) return res.status(404).json({ error: 'Proprietario non trovato' });
    res.status(200).json({ status: 'success', data: aggiornato });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/unita-rimosse/:id', async (req, res) => {
  try {
    const payload = (req.body && req.body.campo !== undefined) ? { [req.body.campo]: req.body.valore } : req.body;
    const aggiornato = await UnitaRimossa.findByIdAndUpdate(req.params.id, { $set: payload }, { new: true });
    if (!aggiornato) return res.status(404).json({ error: 'Unit\u00e0 non trovata' });
    res.status(200).json({ status: 'success', data: aggiornato });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/unita-rimosse', async (req, res) => {
  try {
    res.status(200).json(await UnitaRimossa.find({}).sort({ createdAt: -1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================
   7. MOTORE TABELLE PERSONALIZZATE (STILE MONDAY)
   Tipi di colonna: testo | numero | email | telefono | data | select | collegamento | specchio
========================================== */
const ColonnaPersonalizzataSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  tipo: { type: String, required: true },
  opzioniSelect: { type: [String], default: [] },
  // Per tipo 'collegamento': a quale altra tabella punta
  tabellaCollegataId: { type: String, default: '' },
  // Per tipo 'specchio': quale colonna 'collegamento' di QUESTA tabella seguire,
  // e quale colonna della tabella collegata mostrare
  colonnaCollegamentoId: { type: String, default: '' },
  colonnaDaMostrareId: { type: String, default: '' }
});

const RigaPersonalizzataSchema = new mongoose.Schema({
  consulente: { type: String, default: '' },   // username del consulente a cui e' assegnata la riga
  valori: { type: mongoose.Schema.Types.Mixed, default: {} } // { colonnaId: valore (stringa, o array per 'collegamento') }
}, { timestamps: true });

const TabellaPersonalizzataSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  icona: { type: String, default: 'fa-table' },
  areaCartellaId: { type: String, default: '' }, // in quale cartella (Area) dell'albero laterale si trova
  colonne: [ColonnaPersonalizzataSchema],
  righe: [RigaPersonalizzataSchema]
}, { timestamps: true });
const TabellaPersonalizzata = mongoose.model('TabellaPersonalizzata', TabellaPersonalizzataSchema);

/* ==========================================
   ROTTE API: TABELLE PERSONALIZZATE
========================================== */
app.get('/api/tabelle', async (req, res) => {
  try { res.status(200).json(await TabellaPersonalizzata.find({}).sort({ nome: 1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tabelle/:id', async (req, res) => {
  try {
    const t = await TabellaPersonalizzata.findById(req.params.id);
    if (!t) return res.status(404).json({ error: 'Tabella non trovata' });
    res.status(200).json(t);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tabelle', async (req, res) => {
  try {
    const nuova = new TabellaPersonalizzata({
      nome: req.body.nome, icona: req.body.icona || 'fa-table',
      areaCartellaId: req.body.areaCartellaId || '',
      colonne: [], righe: []
    });
    res.status(201).json({ status: 'success', data: await nuova.save() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/tabelle/:id', async (req, res) => {
  try {
    const eliminata = await TabellaPersonalizzata.findByIdAndDelete(req.params.id);
    if (!eliminata) return res.status(404).json({ error: 'Tabella non trovata' });
    res.status(200).json({ status: 'success', message: 'Tabella eliminata' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Sposta una scheda (tabella) in un'altra cartella dell'albero laterale ('' = fuori da ogni cartella)
app.put('/api/tabelle/:id/cartella', async (req, res) => {
  try {
    const t = await TabellaPersonalizzata.findByIdAndUpdate(req.params.id, { $set: { areaCartellaId: req.body.areaCartellaId || '' } }, { new: true });
    if (!t) return res.status(404).json({ error: 'Tabella non trovata' });
    res.status(200).json({ status: 'success', data: t });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/tabelle/:id/colonne', async (req, res) => {
  try {
    const t = await TabellaPersonalizzata.findById(req.params.id);
    if (!t) return res.status(404).json({ error: 'Tabella non trovata' });
    t.colonne.push(req.body);
    await t.save();
    res.status(201).json({ status: 'success', data: t });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/tabelle/:id/colonne/:colonnaId', async (req, res) => {
  try {
    const t = await TabellaPersonalizzata.findById(req.params.id);
    if (!t) return res.status(404).json({ error: 'Tabella non trovata' });
    t.colonne = t.colonne.filter(c => String(c._id) !== req.params.colonnaId);
    await t.save();
    res.status(200).json({ status: 'success', data: t });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/tabelle/:id/righe', async (req, res) => {
  try {
    const t = await TabellaPersonalizzata.findById(req.params.id);
    if (!t) return res.status(404).json({ error: 'Tabella non trovata' });
    t.righe.push({ valori: {} });
    await t.save();
    res.status(201).json({ status: 'success', data: t });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/tabelle/:id/righe/:rigaId', async (req, res) => {
  try {
    const t = await TabellaPersonalizzata.findById(req.params.id);
    if (!t) return res.status(404).json({ error: 'Tabella non trovata' });
    const riga = t.righe.id(req.params.rigaId);
    if (!riga) return res.status(404).json({ error: 'Riga non trovata' });
    const valori = { ...(riga.valori || {}) };
    valori[req.body.colonnaId] = req.body.valore;
    riga.valori = valori;
    riga.markModified('valori');
    await t.save();
    res.status(200).json({ status: 'success', data: t });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/tabelle/:id/righe/:rigaId', async (req, res) => {
  try {
    const t = await TabellaPersonalizzata.findById(req.params.id);
    if (!t) return res.status(404).json({ error: 'Tabella non trovata' });
    t.righe = t.righe.filter(r => String(r._id) !== req.params.rigaId);
    await t.save();
    res.status(200).json({ status: 'success', data: t });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* ==========================================
   8. MOTORE CARTELLE (AREE) - ALBERO NEL MENU LATERALE
   Organizzano le Schede (tabelle personalizzate): annidabili, riordinabili
========================================== */
const AreaCartellaSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  parentId: { type: String, default: '' }, // '' = livello principale
  ordine: { type: Number, default: 0 }
}, { timestamps: true });
const AreaCartella = mongoose.model('AreaCartella', AreaCartellaSchema);

app.get('/api/aree-cartella', async (req, res) => {
  try { res.status(200).json(await AreaCartella.find({}).sort({ ordine: 1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/aree-cartella', async (req, res) => {
  try {
    const parentId = req.body.parentId || '';
    const conteggio = await AreaCartella.countDocuments({ parentId });
    const nuova = new AreaCartella({ nome: req.body.nome, parentId, ordine: conteggio });
    res.status(201).json({ status: 'success', data: await nuova.save() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/aree-cartella/:id', async (req, res) => {
  try {
    const campiConsentiti = ['nome', 'parentId', 'ordine'];
    const aggiornamento = {};
    for (const campo of campiConsentiti) {
      if (req.body[campo] !== undefined) aggiornamento[campo] = req.body[campo];
    }
    const aggiornata = await AreaCartella.findByIdAndUpdate(req.params.id, { $set: aggiornamento }, { new: true });
    if (!aggiornata) return res.status(404).json({ error: 'Area non trovata' });
    res.status(200).json({ status: 'success', data: aggiornata });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Elimina un'area: le sotto-aree diventano di livello principale, le schede al suo interno restano
// come schede ma senza cartella (non vengono cancellate, si ritrovano fuori da ogni cartella)
app.delete('/api/aree-cartella/:id', async (req, res) => {
  try {
    const eliminata = await AreaCartella.findByIdAndDelete(req.params.id);
    if (!eliminata) return res.status(404).json({ error: 'Area non trovata' });
    await AreaCartella.updateMany({ parentId: req.params.id }, { $set: { parentId: '' } });
    await TabellaPersonalizzata.updateMany({ areaCartellaId: req.params.id }, { $set: { areaCartellaId: '' } });
    res.status(200).json({ status: 'success', message: 'Area eliminata' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================
   9. MOTORE VISTE (RAGGRUPPAMENTO, FILTRI, COLONNE VISIBILI PER SCHEDA)
========================================== */
const VistaSchema = new mongoose.Schema({
  tabellaTipo: { type: String, required: true }, // es. 'incarichi', 'centralino', oppure l'id di una tabella personalizzata
  nome: { type: String, required: true },
  raggruppaPer: { type: String, default: '' },
  colonneNascoste: { type: [String], default: [] },
  filtroColonna: { type: String, default: '' },
  filtroValore: { type: String, default: '' },
  filtriAvanzati: { type: [mongoose.Schema.Types.Mixed], default: [] }, // [{ connettore, colonna, condizione, valore }]
  ordineGruppi: { type: [String], default: [] },
  coloriGruppi: { type: mongoose.Schema.Types.Mixed, default: {} },
  ordinamentoColonna: { type: String, default: '' },
  ordinamentoDirezione: { type: String, default: '' },
  ordine: { type: Number, default: 0 }
}, { timestamps: true });
const Vista = mongoose.model('Vista', VistaSchema);

app.get('/api/viste', async (req, res) => {
  try {
    const filtro = req.query.tabellaTipo ? { tabellaTipo: req.query.tabellaTipo } : {};
    res.status(200).json(await Vista.find(filtro).sort({ ordine: 1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/viste', async (req, res) => {
  try {
    const conteggio = await Vista.countDocuments({ tabellaTipo: req.body.tabellaTipo });
    const nuova = new Vista({ ...req.body, ordine: conteggio });
    res.status(201).json({ status: 'success', data: await nuova.save() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/viste/:id', async (req, res) => {
  try {
    const aggiornata = await Vista.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    if (!aggiornata) return res.status(404).json({ error: 'Vista non trovata' });
    res.status(200).json({ status: 'success', data: aggiornata });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/viste/:id', async (req, res) => {
  try {
    const eliminata = await Vista.findByIdAndDelete(req.params.id);
    if (!eliminata) return res.status(404).json({ error: 'Vista non trovata' });
    res.status(200).json({ status: 'success', message: 'Vista eliminata' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================
   10. IMPOSTAZIONI COLONNE (VISIBILITÀ PER RUOLO CONSULENTE)
========================================== */
const ImpostazioneColonneSchema = new mongoose.Schema({
  tabellaTipo: { type: String, required: true, unique: true },
  colonneNascosteConsulenti: { type: [String], default: [] }
}, { timestamps: true });
const ImpostazioneColonne = mongoose.model('ImpostazioneColonne', ImpostazioneColonneSchema);

app.get('/api/impostazioni-colonne/:tabellaTipo', async (req, res) => {
  try {
    let doc = await ImpostazioneColonne.findOne({ tabellaTipo: req.params.tabellaTipo });
    if (!doc) doc = { tabellaTipo: req.params.tabellaTipo, colonneNascosteConsulenti: [] };
    res.status(200).json(doc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/impostazioni-colonne/:tabellaTipo', async (req, res) => {
  try {
    const aggiornato = await ImpostazioneColonne.findOneAndUpdate(
      { tabellaTipo: req.params.tabellaTipo },
      { $set: { colonneNascosteConsulenti: req.body.colonneNascosteConsulenti || [] } },
      { new: true, upsert: true }
    );
    res.status(200).json({ status: 'success', data: aggiornato });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server CRM completo e attivo sulla porta ${PORT}`));
