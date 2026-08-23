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
  consulentiVisibili: { type: [String], default: [] },
  /* Campi PUBBLICI: usati dalla home del sito (sezione Team). Sono separati da
     quelli interni perche' il ruolo interno (es. "BackOffice") non e' il titolo
     che si mostra ai clienti, e bio/video/telefono pubblico nel resto del
     gestionale non servono. */
  ruoloPubblico: { type: String, default: '' },     // titolo mostrato sul sito (es. "Broker Titolare")
  bioPubblica: { type: String, default: '' },        // presentazione lunga (puo' contenere <br> e <strong>)
  videoPubblico: { type: String, default: '' },      // URL di embed YouTube (facoltativo)
  telefonoPubblico: { type: String, default: '' },   // numero mostrato sul sito
  pubblicaInHome: { type: Boolean, default: true },  // se appare nella sezione Team della home
  ordinePubblico: { type: Number, default: 999 },    // ordine nella home (piu' basso = prima)
  /* Agenda settimanale tipo PERSONALIZZATA di questo consulente: fasce fisse
     ricorrenti mostrate come sfondo nel calendario (Giorno/Settimana). La
     imposta il Broker. Se vuota, il CRM usa l'agenda predefinita del team.
     Ogni voce: { giorno (0=lun..6=dom), inizio, fine (ore decimali), label, colore }. */
  agendaTipo: { type: Array, default: [] }
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
  inseritoDa: { type: String, default: '' },
  unitaCensId: { type: String, default: '' }   // _id dell'unità del censimento (proprietario/civico) collegata, per specchio Piano/Mq/proprietario
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
  valoreAlMq: { type: String, default: '' },
  /* Campi che arrivano dall'Opportunity quando la Cdv è "Fatta": la valutazione
     eredita i dati del lead così non si riscrivono a mano. */
  nome: { type: String, default: '' },
  telefono: { type: String, default: '' },
  posizione: { type: String, default: '' },
  richiesta: { type: String, default: '' },
  fonte: { type: String, default: '' },
  dataCdv: { type: String, default: '' },
  dataPotCdv: { type: String, default: '' },
  dataProssimaAttivita: { type: String, default: '' },
  tipologiaContesto: { type: String, default: '' },
  noteContesto: { type: String, default: '' },
  piuLivelli: { type: String, default: '' },
  pertinenze: { type: String, default: '' },
  giaVendita: { type: String, default: '' },
  opportunityId: { type: String, default: '' }   // da quale opportunity è nata (evita doppioni)
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
  gestioneDocumenti: { type: mongoose.Schema.Types.Mixed, default: {} }, // venditori, provenienza, mutuo, accesso atti, foto, pubblicazione
  /* Interruttore "Pubblica sul sito": '' = automatico (segue lo stato immobile),
     'sempre' = mostralo comunque online, 'mai' = tienilo fuori dalla vetrina. */
  pubblicaSito: { type: String, default: '' }
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

/* ==========================================
   APP CALENDARIO (PWA "Agenda Forte")
   Serve l'app installabile e offline su /app. I file (HTML, service worker,
   manifest, icone) sono "cotti" qui dentro dallo script di build, cosi' basta
   ridistribuire questo solo server.js per pubblicare anche l'app.
========================================== */
// <<APP_CALENDARIO_START>>
// (contenuto generato dallo script di build — non modificare a mano)
const APP_CAL_HTML = "<!doctype html>\n<html lang=\"it\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1\">\n<meta name=\"theme-color\" content=\"#0b2029\">\n<title>Agenda Forte</title>\n<link rel=\"manifest\" href=\"/app/manifest.webmanifest\">\n<link rel=\"apple-touch-icon\" href=\"/app/icon-192.png\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<meta name=\"apple-mobile-web-app-status-bar-style\" content=\"black-translucent\">\n<meta name=\"apple-mobile-web-app-title\" content=\"Agenda Forte\">\n<style>\n  :root{\n    --bg:#0e1013; --bg2:#15181c; --card:#1c1f24; --card2:#202226;\n    --line:#282c32; --line2:#33383f; --txt:#e8ecf1; --mut:#8b939f; --mut2:#5f6672;\n    --oro:#C6A777; --petrolio:#0b2029; --ok:#00c875; --danger:#f43f5e;\n    --ora-da:7; --ora-a:22; --h-ora:52px;\n  }\n  *{box-sizing:border-box; -webkit-tap-highlight-color:transparent;}\n  html,body{margin:0; padding:0; background:var(--bg); color:var(--txt);\n    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Plus Jakarta Sans',sans-serif;\n    overscroll-behavior-y:none;}\n  body{padding-top:env(safe-area-inset-top); padding-bottom:env(safe-area-inset-bottom);}\n  button{font-family:inherit; cursor:pointer;}\n  .hide{display:none !important;}\n\n  /* ---- LOGIN ---- */\n  #login{position:fixed; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px; padding:28px; background:radial-gradient(120% 90% at 50% 0%, #123 0%, var(--bg) 60%);}\n  #login .logo{width:74px; height:74px; border-radius:20px; background:var(--petrolio); border:1px solid #24404a; display:flex; align-items:center; justify-content:center; color:var(--oro); font-weight:800; font-size:34px; box-shadow:0 10px 30px rgba(0,0,0,.4);}\n  #login h1{margin:4px 0 0; font-size:20px; letter-spacing:.5px;}\n  #login p{margin:0; color:var(--mut); font-size:13px;}\n  #login .box{width:100%; max-width:340px; display:flex; flex-direction:column; gap:10px; margin-top:8px;}\n  #login input{width:100%; padding:14px; background:var(--card); border:1px solid var(--line2); color:#fff; border-radius:12px; font-size:16px;}\n  #login button{width:100%; padding:14px; background:var(--oro); color:#1a1205; border:none; border-radius:12px; font-weight:800; font-size:16px;}\n  #login .err{color:var(--danger); font-size:13px; min-height:18px; text-align:center;}\n\n  /* ---- HEADER ---- */\n  header{position:sticky; top:0; z-index:20; background:rgba(14,16,19,.92); backdrop-filter:blur(10px); border-bottom:1px solid var(--line);}\n  .topbar{display:flex; align-items:center; gap:10px; padding:10px 12px 6px;}\n  .topbar .titolo{font-size:17px; font-weight:800; flex:1; text-transform:capitalize;}\n  .icona-btn{width:38px; height:38px; border-radius:10px; background:var(--card); border:1px solid var(--line2); color:var(--txt); font-size:16px; display:flex; align-items:center; justify-content:center; padding:0;}\n  .navbar{display:flex; align-items:center; gap:8px; padding:0 12px 10px;}\n  .navbar .oggi{padding:7px 12px; background:var(--card); border:1px solid var(--line2); color:var(--txt); border-radius:9px; font-weight:700; font-size:13px;}\n  .segmented{margin-left:auto; display:flex; background:var(--card); border:1px solid var(--line2); border-radius:10px; overflow:hidden;}\n  .segmented button{padding:7px 12px; background:transparent; border:none; color:var(--mut); font-size:13px; font-weight:700;}\n  .segmented button.on{background:var(--oro); color:#1a1205;}\n  .stato{display:flex; align-items:center; gap:8px; padding:0 12px 8px; font-size:12px; color:var(--mut);}\n  .badge-off{background:#3a2a1a; border:1px solid #6b5836; color:#e0c896; padding:4px 9px; border-radius:8px; font-weight:700;}\n  .badge-on{color:var(--mut2);}\n  .filtro-wrap{position:relative;}\n  #tendina-filtri{position:absolute; right:0; top:44px; background:var(--card2); border:1px solid var(--line2); border-radius:12px; padding:8px; width:230px; z-index:40; box-shadow:0 12px 30px rgba(0,0,0,.5);}\n  #tendina-filtri label{display:flex; align-items:center; gap:8px; padding:7px 8px; border-radius:8px; font-size:13px;}\n  #tendina-filtri label:active{background:var(--card);}\n  #tendina-filtri .dot{width:10px; height:10px; border-radius:3px; flex-shrink:0;}\n  #tendina-filtri .riga-azioni{display:flex; gap:6px; margin:4px 4px 6px;}\n  #tendina-filtri .riga-azioni button{flex:1; padding:6px; font-size:12px; font-weight:700; border-radius:7px; background:var(--card); border:1px solid var(--line2); color:var(--txt);}\n\n  /* ---- VISTE ---- */\n  main{padding:0 0 90px;}\n  .griglia{display:flex; position:relative;}\n  .colonna-ore{width:44px; flex-shrink:0; position:relative;}\n  .colonna-ore .ora{position:absolute; right:6px; transform:translateY(-6px); font-size:10.5px; color:var(--mut2);}\n  .giorni{flex:1; display:flex; position:relative; overflow:hidden;}\n  .giorno{flex:1; position:relative; border-left:1px solid var(--line);}\n  .giorno:first-child{border-left:none;}\n  .righe-ore{position:absolute; inset:0; z-index:0;}\n  .riga-ora{position:absolute; left:0; right:0; border-top:1px solid var(--line);}\n  .intestazione-giorni{display:flex; position:sticky; top:0; z-index:5;}\n  .intestazione-giorni .sp{width:44px; flex-shrink:0;}\n  .intestazione-giorni .gg{flex:1; text-align:center; padding:6px 0; font-size:11px; color:var(--mut); border-left:1px solid transparent;}\n  .intestazione-giorni .gg .num{display:block; font-size:16px; font-weight:800; color:var(--txt); line-height:1.1;}\n  .intestazione-giorni .gg.oggi .num{color:var(--oro);}\n  .intestazione-giorni .gg.oggi{background:rgba(198,167,119,.08); border-radius:10px;}\n  .fascia{position:absolute; left:2px; right:2px; border-radius:6px; box-sizing:border-box; padding:2px 5px; overflow:hidden; pointer-events:none; z-index:0;}\n  .fascia span{font-size:8.5px; font-weight:700; letter-spacing:.2px; opacity:.5;}\n  .evt{position:absolute; left:2px; right:2px; border-radius:7px; box-sizing:border-box; padding:3px 6px; overflow:hidden; z-index:2; color:#fff; box-shadow:0 2px 6px rgba(0,0,0,.35); border-left:3px solid rgba(255,255,255,.25);}\n  .evt .t{font-size:11px; font-weight:700; line-height:1.15; overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;}\n  .evt .o{font-size:9.5px; opacity:.85;}\n  .fascia-giorno-alldy{padding:6px 10px;}\n  .chip{display:flex; align-items:center; gap:8px; background:var(--card); border:1px solid var(--line2); border-left-width:4px; border-radius:9px; padding:8px 10px; margin:4px 8px;}\n  .chip .dot{width:9px;height:9px;border-radius:3px;flex-shrink:0;}\n  .chip .txt{flex:1; min-width:0;}\n  .chip .txt .t{font-size:13.5px; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}\n  .chip .txt .d{font-size:11.5px; color:var(--mut); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}\n  .chip .ora{font-size:12px; color:var(--mut); font-weight:700; white-space:nowrap;}\n  .linea-ora-adesso{position:absolute; left:0; right:0; height:2px; background:var(--danger); z-index:3;}\n  .linea-ora-adesso::before{content:''; position:absolute; left:-3px; top:-3px; width:8px; height:8px; border-radius:50%; background:var(--danger);}\n\n  /* MESE */\n  .mese-intest{display:grid; grid-template-columns:repeat(7,1fr); gap:4px; padding:8px 8px 4px;}\n  .mese-intest div{text-align:center; font-size:10.5px; color:var(--mut); text-transform:uppercase; letter-spacing:.5px;}\n  .mese-griglia{display:grid; grid-template-columns:repeat(7,1fr); gap:4px; padding:0 8px 8px;}\n  .cella{background:var(--card); border:1px solid var(--line); border-radius:9px; min-height:74px; padding:4px; overflow:hidden; display:flex; flex-direction:column;}\n  .cella.fuori{background:var(--bg2); opacity:.5;}\n  .cella.oggi{border-color:var(--oro); background:rgba(198,167,119,.07);}\n  .cella .n{font-size:12px; font-weight:700; color:var(--mut); margin-bottom:2px; align-self:flex-start; padding:1px 4px;}\n  .cella.oggi .n{color:var(--oro);}\n  .cella .punti{display:flex; flex-wrap:wrap; gap:2px;}\n  .cella .p{width:6px; height:6px; border-radius:50%;}\n  .cella .mini{font-size:9px; line-height:1.25; color:var(--txt); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; border-left:2px solid; padding-left:3px; margin-top:1px;}\n  .cella .piu{font-size:9px; color:var(--mut2); margin-top:1px;}\n\n  /* LISTA */\n  .lista-giorno{margin:0 0 4px;}\n  .lista-giorno .data-h{position:sticky; top:0; background:var(--bg); padding:12px 14px 6px; font-size:12px; color:var(--oro); font-weight:800; text-transform:uppercase; letter-spacing:.6px;}\n  .lista-vuota{color:var(--mut2); text-align:center; padding:60px 20px; font-size:14px;}\n\n  /* FAB */\n  .fab{position:fixed; right:18px; bottom:calc(22px + env(safe-area-inset-bottom)); width:58px; height:58px; border-radius:50%; background:var(--oro); color:#1a1205; border:none; font-size:30px; font-weight:400; box-shadow:0 8px 24px rgba(0,0,0,.5); z-index:30; display:flex; align-items:center; justify-content:center;}\n\n  /* SHEET */\n  .overlay{position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:50; display:flex; align-items:flex-end; justify-content:center;}\n  .sheet{background:var(--card2); width:100%; max-width:520px; border-radius:20px 20px 0 0; border:1px solid var(--line2); border-bottom:none; padding:18px 18px calc(20px + env(safe-area-inset-bottom)); max-height:92vh; overflow-y:auto; animation:su .18s ease;}\n  @keyframes su{from{transform:translateY(30px); opacity:.5;} to{transform:translateY(0); opacity:1;}}\n  .sheet h3{margin:2px 0 14px; font-size:17px;}\n  .sheet .grip{width:40px; height:4px; background:var(--line2); border-radius:2px; margin:0 auto 12px;}\n  .campo{margin-bottom:12px;}\n  .campo label{display:block; font-size:11px; text-transform:uppercase; letter-spacing:.4px; color:var(--mut); margin-bottom:5px;}\n  .campo input, .campo textarea, .campo select{width:100%; padding:12px; background:var(--bg2); border:1px solid var(--line2); color:#fff; border-radius:10px; font-size:16px; font-family:inherit;}\n  .campo textarea{resize:vertical; min-height:60px;}\n  .due{display:grid; grid-template-columns:1fr 1fr; gap:10px;}\n  .azioni{display:flex; gap:10px; margin-top:6px;}\n  .azioni button{flex:1; padding:13px; border-radius:11px; font-weight:800; font-size:15px; border:none;}\n  .btn-salva{background:var(--ok); color:#08110b;}\n  .btn-annulla{background:var(--card); color:var(--txt); border:1px solid var(--line2)!important;}\n  .btn-elimina{background:#2a1a1d; color:var(--danger); border:1px solid #4a2a2f!important;}\n  .dett-riga{display:flex; gap:10px; padding:9px 0; border-bottom:1px solid var(--line); font-size:14px;}\n  .dett-riga .k{color:var(--mut); width:92px; flex-shrink:0; font-size:12px; text-transform:uppercase; letter-spacing:.3px; padding-top:1px;}\n  .dett-riga .v{flex:1; color:var(--txt);}\n  .pill-tipo{display:inline-flex; align-items:center; gap:7px; font-size:12px; font-weight:800; padding:5px 11px; border-radius:20px; margin-bottom:8px;}\n  .toast{position:fixed; left:50%; bottom:calc(96px + env(safe-area-inset-bottom)); transform:translateX(-50%); background:#000; border:1px solid var(--line2); color:#fff; padding:10px 16px; border-radius:12px; font-size:13px; z-index:60; opacity:0; transition:opacity .2s; pointer-events:none; max-width:90%; text-align:center;}\n  .toast.on{opacity:1;}\n</style>\n</head>\n<body>\n\n<!-- LOGIN -->\n<div id=\"login\">\n  <div class=\"logo\">F</div>\n  <h1>Agenda Forte</h1>\n  <p>Il calendario del consulente</p>\n  <form class=\"box\" id=\"form-login\" autocomplete=\"on\">\n    <input type=\"text\" id=\"l-utente\" placeholder=\"Username\" autocapitalize=\"none\" autocorrect=\"off\" autocomplete=\"username\">\n    <input type=\"password\" id=\"l-pass\" placeholder=\"Password\" autocomplete=\"current-password\">\n    <div class=\"err\" id=\"l-err\"></div>\n    <button type=\"submit\" id=\"l-btn\">Entra</button>\n  </form>\n</div>\n\n<!-- APP -->\n<div id=\"app\" class=\"hide\">\n  <header>\n    <div class=\"topbar\">\n      <button class=\"icona-btn\" id=\"btn-prec\" aria-label=\"Precedente\">\u2039</button>\n      <div class=\"titolo\" id=\"titolo-periodo\">\u2014</div>\n      <div class=\"filtro-wrap\">\n        <button class=\"icona-btn\" id=\"btn-filtri\" aria-label=\"Filtri\">\u2630</button>\n        <div id=\"tendina-filtri\" class=\"hide\"></div>\n      </div>\n      <button class=\"icona-btn\" id=\"btn-succ\" aria-label=\"Successivo\">\u203a</button>\n    </div>\n    <div class=\"navbar\">\n      <button class=\"oggi\" id=\"btn-oggi\">Oggi</button>\n      <div class=\"segmented\" id=\"segmented\">\n        <button data-v=\"giorno\" class=\"on\">Giorno</button>\n        <button data-v=\"settimana\">Sett.</button>\n        <button data-v=\"mese\">Mese</button>\n        <button data-v=\"lista\">Lista</button>\n      </div>\n    </div>\n    <div class=\"stato\">\n      <span id=\"stato-rete\" class=\"badge-on\">\u25cf&nbsp;Online</span>\n      <span id=\"stato-agg\" style=\"margin-left:auto;\"></span>\n      <button id=\"btn-notifiche\" onclick=\"attivaNotifiche()\" style=\"margin-left:8px; background:rgba(198,167,119,.14); border:1px solid rgba(198,167,119,.4); color:#e0c896; padding:5px 10px; border-radius:8px; font-size:11.5px; font-weight:700;\">\ud83d\udd14 Attiva notifiche</button>\n      <button class=\"icona-btn\" id=\"btn-esci\" title=\"Esci\" style=\"width:32px;height:30px;font-size:13px;margin-left:8px;\">\u238b</button>\n    </div>\n  </header>\n  <main id=\"vista\"></main>\n  <button class=\"fab\" id=\"fab\">+</button>\n</div>\n\n<div id=\"toast\" class=\"toast\"></div>\n\n<script>\n\"use strict\";\n/* ============================================================\n   AGENDA FORTE \u2014 PWA offline del calendario consulente\n   Un solo feed (server) tenuto in cache + coda di scrittura per\n   gli appuntamenti creati/modificati offline.\n============================================================ */\nvar API = ''; // stesso dominio del backend (l'app \u00e8 servita da /app)\nvar ORA_DA = 7, ORA_A = 22;\n\n/* Tipi evento: colore/etichetta uguali al CRM */\nvar TIPI = {\n  appuntamento:{et:'Appuntamento', c:'#C6A777'},\n  visione:{et:'Visione', c:'#0086d6'},\n  cdv:{et:'Cdv', c:'#a855f7'},\n  preliminare:{et:'Preliminare', c:'#38bdf8'},\n  rogito:{et:'Rogito', c:'#00c875'},\n  vincolo:{et:'Vincolo', c:'#e2b13c'},\n  incarico:{et:'Scadenza incarico', c:'#f43f5e'},\n  provvigione:{et:'Provvigione', c:'#C6A777'},\n  attivita:{et:'Attivit\u00e0', c:'#868b98'},\n  acquisizione:{et:'Attivit\u00e0 di acquisizione', c:'#e2b13c'},\n  opportunity:{et:'Opportunity', c:'#10b981'},\n  openhouse:{et:'Open House', c:'#00c875'}\n};\nfunction tipoInfo(t){ return TIPI[t] || {et:t||'Evento', c:'#868b98'}; }\n\n/* Agenda tipo PREDEFINITA (fallback se il consulente non ne ha una sua) */\nvar AGENDA_DEFAULT = [\n  {giorno:0,inizio:9.5,fine:11,label:'Riunione',colore:'#f43f5e'},\n  {giorno:0,inizio:15,fine:16,label:'Foto necrologi',colore:'#10b981'},\n  {giorno:0,inizio:18,fine:19.5,label:'Call',colore:'#a855f7'},\n  {giorno:1,inizio:9.5,fine:11,label:'Lettere',colore:'#C6A777'},\n  {giorno:1,inizio:11,fine:12.5,label:'Citofoni',colore:'#0086d6'},\n  {giorno:1,inizio:15,fine:17,label:'Lettere',colore:'#C6A777'},\n  {giorno:1,inizio:17,fine:19,label:'Citofoni',colore:'#0086d6'},\n  {giorno:2,inizio:9.5,fine:11,label:'Lettere',colore:'#C6A777'},\n  {giorno:2,inizio:11,fine:12.5,label:'Citofoni',colore:'#0086d6'},\n  {giorno:2,inizio:13.5,fine:15,label:'Call',colore:'#a855f7'},\n  {giorno:2,inizio:15,fine:17,label:'Lettere',colore:'#C6A777'},\n  {giorno:2,inizio:17,fine:19,label:'Citofoni',colore:'#0086d6'},\n  {giorno:3,inizio:18,fine:19.5,label:'Call',colore:'#a855f7'},\n  {giorno:4,inizio:11,fine:12.5,label:'Citofoni',colore:'#0086d6'},\n  {giorno:4,inizio:15,fine:17,label:'Cdv',colore:'#e2b13c'},\n  {giorno:4,inizio:17,fine:19,label:'Citofoni',colore:'#0086d6'},\n  {giorno:5,inizio:9.5,fine:12.5,label:'Open House',colore:'#00c875'},\n  {giorno:5,inizio:15,fine:18,label:'Visioni',colore:'#38bdf8'}\n];\n\n/* ---- storage ---- */\nvar K_USER='fc_user', K_FEED='fc_cal_feed', K_QUEUE='fc_cal_queue', K_FILT='fc_cal_filtri';\nfunction lget(k,def){ try{ var v=localStorage.getItem(k); return v?JSON.parse(v):def; }catch(e){ return def; } }\nfunction lset(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }\n\n/* ---- stato app ---- */\nvar UTENTE=null, FEED={eventi:[],agendaTipo:[],generatoIl:''}, CODA=[], FILTRI=[];\nvar VISTA='giorno', ANCORA=oggiIso();\n\n/* ---- utilit\u00e0 date ---- */\nfunction oggiIso(){ var d=new Date(); return isoDi(d); }\nfunction isoDi(d){ return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate()); }\nfunction p2(n){ return (n<10?'0':'')+n; }\nfunction dataDaIso(s){ var p=String(s).split('-'); return new Date(+p[0], +p[1]-1, +p[2], 12, 0, 0); }\nfunction addGiorni(iso,n){ var d=dataDaIso(iso); d.setDate(d.getDate()+n); return isoDi(d); }\nfunction addMesi(iso,n){ var d=dataDaIso(iso); var g=d.getDate(); d.setDate(1); d.setMonth(d.getMonth()+n); var ultimo=new Date(d.getFullYear(),d.getMonth()+1,0).getDate(); d.setDate(Math.min(g,ultimo)); return isoDi(d); }\nfunction idxLun(iso){ return (dataDaIso(iso).getDay()+6)%7; } // 0=lun\nfunction lunediDi(iso){ return addGiorni(iso, -idxLun(iso)); }\nfunction oraDec(hhmm){ var m=String(hhmm||'').match(/(\\d{1,2})[:.](\\d{2})/); return m? (+m[1] + (+m[2])/60) : null; }\nfunction etOra(x){ var h=Math.floor(x), m=Math.round((x-h)*60); return p2(h)+':'+p2(m); }\nvar NOMI_G=['lun','mar','mer','gio','ven','sab','dom'];\nvar NOMI_GL=['Luned\u00ec','Marted\u00ec','Mercoled\u00ec','Gioved\u00ec','Venerd\u00ec','Sabato','Domenica'];\nvar NOMI_MESI=['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'];\nfunction esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;'); }\n\n/* ============================================================\n   EVENTI VISIBILI = feed + coda offline\n============================================================ */\nfunction eventiCorrenti(){\n  var base = (FEED.eventi||[]).slice();\n  // applica la coda (appuntamenti creati/modificati/eliminati offline)\n  (CODA||[]).forEach(function(op){\n    if(op.tipo==='elimina'){ base = base.filter(function(e){ return !(e.registro==='appuntamenti' && e.id===op.id); }); }\n    else if(op.tipo==='salva'){\n      var id = op.id || op.tempId;\n      base = base.filter(function(e){ return !(e.registro==='appuntamenti' && e.id===id); });\n      var a=op.payload;\n      base.push({ tipo:'appuntamento', data:a.data, orario:a.ora||'', titolo:a.titolo||'Appuntamento',\n        dettaglio:[a.luogo,a.conChi].filter(Boolean).join(' \u00b7 '), luogo:a.luogo||'', conChi:a.conChi||'',\n        note:a.note||'', durata:a.durata||60, promemoria:(a.promemoria!=null?a.promemoria:10), registro:'appuntamenti', id:id, campo:'data',\n        modificabile:true, inCoda:true });\n    }\n  });\n  if(FILTRI.length) base = base.filter(function(e){ return FILTRI.indexOf(e.tipo)!==-1; });\n  return base;\n}\nfunction eventiDelGiorno(iso){ return eventiCorrenti().filter(function(e){ return e.data===iso; }); }\n\n/* ============================================================\n   RENDER\n============================================================ */\nfunction render(){\n  document.querySelectorAll('#segmented button').forEach(function(b){ b.classList.toggle('on', b.dataset.v===VISTA); });\n  aggiornaTitolo();\n  var v=document.getElementById('vista');\n  if(VISTA==='giorno') v.innerHTML=vistaGiorno();\n  else if(VISTA==='settimana') v.innerHTML=vistaSettimana();\n  else if(VISTA==='mese') v.innerHTML=vistaMese();\n  else v.innerHTML=vistaLista();\n  agganciaEventi();\n  if(VISTA==='giorno'||VISTA==='settimana') setTimeout(scrollAllOra, 30);\n}\n\n/* sposta il periodo in base alla vista (usato da frecce e swipe) */\nfunction spostaPeriodo(dir){\n  if(VISTA==='settimana') ANCORA=addGiorni(ANCORA, 7*dir);\n  else if(VISTA==='mese') ANCORA=addMesi(ANCORA, dir);\n  else ANCORA=addGiorni(ANCORA, dir);\n  render();\n}\n\nfunction aggiornaTitolo(){\n  var t=document.getElementById('titolo-periodo');\n  if(VISTA==='settimana'){\n    var lun=lunediDi(ANCORA), dom=addGiorni(lun,6);\n    var dl=dataDaIso(lun), dd=dataDaIso(dom);\n    t.textContent = dl.getDate()+' '+NOMI_MESI[dl.getMonth()].slice(0,3)+' \u2013 '+dd.getDate()+' '+NOMI_MESI[dd.getMonth()].slice(0,3);\n  } else if(VISTA==='mese'){\n    var dm=dataDaIso(ANCORA);\n    t.textContent = NOMI_MESI[dm.getMonth()]+' '+dm.getFullYear();\n  } else {\n    var d=dataDaIso(ANCORA);\n    t.textContent = NOMI_GL[idxLun(ANCORA)]+' '+d.getDate()+' '+NOMI_MESI[d.getMonth()];\n  }\n}\n\nfunction altezzaGriglia(){ return (ORA_A-ORA_DA)* (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--h-ora'))||52); }\nfunction hOra(){ return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--h-ora'))||52; }\n\nfunction righeOreHtml(){\n  var h='', ho=hOra();\n  for(var o=ORA_DA;o<=ORA_A;o++){ h+='<div class=\"riga-ora\" style=\"top:'+((o-ORA_DA)*ho)+'px;\"></div>'; }\n  return '<div class=\"righe-ore\">'+h+'</div>';\n}\nfunction colonnaOreHtml(){\n  var h='', ho=hOra();\n  for(var o=ORA_DA;o<=ORA_A;o++){ h+='<div class=\"ora\" style=\"top:'+((o-ORA_DA)*ho)+'px;\">'+p2(o)+':00</div>'; }\n  return '<div class=\"colonna-ore\" style=\"height:'+altezzaGriglia()+'px;\">'+h+'</div>';\n}\n\n/* agenda tipo del giorno (sfondo in dissolvenza) */\nfunction agendaAttiva(){ return (FEED.agendaTipo && FEED.agendaTipo.length)? FEED.agendaTipo : AGENDA_DEFAULT; }\nfunction fasceHtml(iso){\n  var gg=idxLun(iso), ho=hOra(), out='';\n  agendaAttiva().filter(function(a){ return +a.giorno===gg; }).forEach(function(a){\n    var top=(a.inizio-ORA_DA)*ho, hh=(a.fine-a.inizio)*ho;\n    if(hh<=0) return;\n    out+='<div class=\"fascia\" style=\"top:'+top+'px; height:'+(hh-2)+'px; background:linear-gradient(180deg,'+a.colore+'1c 0%,'+a.colore+'05 100%);\"><span style=\"color:'+a.colore+'\">'+esc(a.label)+'</span></div>';\n  });\n  return out;\n}\n\n/* eventi con ora posizionati; senza ora = fascia in cima */\nfunction eventiColonna(iso){\n  var lista=eventiDelGiorno(iso), conOra=[], senza=[];\n  lista.forEach(function(e){ var o=oraDec(e.orario); if(o!=null) conOra.push({e:e,o:o}); else senza.push(e); });\n  conOra.sort(function(a,b){ return a.o-b.o; });\n  var ho=hOra(), html='';\n  // sovrapposizioni: colonne affiancate\n  var gruppi=raggruppaSovrapposti(conOra);\n  gruppi.forEach(function(g){\n    var n=g.length;\n    g.forEach(function(item,i){\n      var e=item.e, o=item.o;\n      var dur=(e.durata||60)/60; var fine=o+Math.max(dur,0.5);\n      var top=(o-ORA_DA)*ho; var h=(fine-o)*ho - 2;\n      var t=tipoInfo(e.tipo);\n      var w=100/n, left=w*i;\n      html+='<div class=\"evt\" data-reg=\"'+esc(e.registro)+'\" data-id=\"'+esc(e.id)+'\" '+\n        'style=\"top:'+top+'px; height:'+Math.max(h,20)+'px; left:calc('+left+'% + 2px); width:calc('+w+'% - 4px); background:'+t.c+'; border-left-color:'+ombra(t.c)+';\">'+\n        '<div class=\"t\">'+esc(e.titolo)+'</div><div class=\"o\">'+esc(e.orario||'')+(e.inCoda?' \u00b7 da inviare':'')+'</div></div>';\n    });\n  });\n  return html;\n}\nfunction raggruppaSovrapposti(conOra){\n  var gruppi=[], cur=[], finePrec=-1;\n  conOra.forEach(function(item){\n    var dur=(item.e.durata||60)/60; var fine=item.o+Math.max(dur,0.5);\n    if(cur.length && item.o < finePrec){ cur.push(item); finePrec=Math.max(finePrec,fine); }\n    else { if(cur.length) gruppi.push(cur); cur=[item]; finePrec=fine; }\n  });\n  if(cur.length) gruppi.push(cur);\n  return gruppi;\n}\nfunction ombra(hex){ return hex; }\n\nfunction bandaAllDay(iso){\n  var senza=eventiDelGiorno(iso).filter(function(e){ return oraDec(e.orario)==null; });\n  if(!senza.length) return '';\n  return senza.map(function(e){ return chipEvento(e); }).join('');\n}\nfunction chipEvento(e){\n  var t=tipoInfo(e.tipo);\n  return '<div class=\"chip\" data-reg=\"'+esc(e.registro)+'\" data-id=\"'+esc(e.id)+'\" style=\"border-left-color:'+t.c+';\">'+\n    '<span class=\"dot\" style=\"background:'+t.c+'\"></span>'+\n    '<div class=\"txt\"><div class=\"t\">'+esc(e.titolo)+'</div>'+(e.dettaglio?'<div class=\"d\">'+esc(e.dettaglio)+'</div>':'')+'</div>'+\n    (e.orario?'<span class=\"ora\">'+esc(e.orario)+'</span>':'')+'</div>';\n}\n\nfunction vistaGiorno(){\n  var iso=ANCORA;\n  var all=bandaAllDay(iso);\n  return (all?'<div class=\"fascia-giorno-alldy\">'+all+'</div>':'')+\n    '<div class=\"griglia\">'+colonnaOreHtml()+\n    '<div class=\"giorni\"><div class=\"giorno\" data-data=\"'+iso+'\" style=\"height:'+altezzaGriglia()+'px;\">'+\n      righeOreHtml()+fasceHtml(iso)+eventiColonna(iso)+ lineaAdesso(iso) +\n    '</div></div></div>';\n}\n\nfunction vistaSettimana(){\n  var lun=lunediDi(ANCORA), ho=hOra(), oggi=oggiIso();\n  var giorni=[]; for(var i=0;i<7;i++) giorni.push(addGiorni(lun,i));\n  var intest='<div class=\"intestazione-giorni\"><div class=\"sp\"></div>'+giorni.map(function(g){\n    var d=dataDaIso(g), on=g===oggi;\n    return '<div class=\"gg'+(on?' oggi':'')+'\"><div>'+NOMI_G[idxLun(g)]+'</div><span class=\"num\">'+d.getDate()+'</span></div>';\n  }).join('')+'</div>';\n  // banda all-day compatta\n  var allRighe = giorni.map(function(g){ return bandaAllDay(g); });\n  var haAll = allRighe.some(function(x){ return x; });\n  var colonne = giorni.map(function(g){\n    return '<div class=\"giorno\" data-data=\"'+g+'\" style=\"height:'+altezzaGriglia()+'px;\">'+righeOreHtml()+fasceHtml(g)+eventiColonna(g)+lineaAdesso(g)+'</div>';\n  }).join('');\n  var all = haAll ? '<div class=\"fascia-giorno-alldy\" style=\"display:flex; gap:0; padding:4px 0 4px 44px;\">'+\n      allRighe.map(function(x){ return '<div style=\"flex:1; min-width:0;\">'+x+'</div>'; }).join('')+'</div>' : '';\n  return intest+all+'<div class=\"griglia\">'+colonnaOreHtml()+'<div class=\"giorni\">'+colonne+'</div></div>';\n}\n\nfunction lineaAdesso(iso){\n  if(iso!==oggiIso()) return '';\n  var now=new Date(); var o=now.getHours()+now.getMinutes()/60;\n  if(o<ORA_DA||o>ORA_A) return '';\n  return '<div class=\"linea-ora-adesso\" style=\"top:'+((o-ORA_DA)*hOra())+'px;\"></div>';\n}\n\nfunction vistaMese(){\n  var d=dataDaIso(ANCORA);\n  var anno=d.getFullYear(), mese=d.getMonth();\n  var primo=new Date(anno,mese,1);\n  var offset=(primo.getDay()+6)%7;           // lun=0\n  var inizioGriglia=new Date(anno,mese,1-offset);\n  var oggi=oggiIso();\n  // mappa eventi per giorno\n  var perGiorno={};\n  eventiCorrenti().forEach(function(e){ (perGiorno[e.data]=perGiorno[e.data]||[]).push(e); });\n  var celle='';\n  for(var i=0;i<42;i++){\n    var cur=new Date(inizioGriglia); cur.setDate(inizioGriglia.getDate()+i);\n    var iso=isoDi(cur);\n    var fuori = cur.getMonth()!==mese;\n    var lista=(perGiorno[iso]||[]).slice().sort(function(a,b){ return (a.orario||'zz').localeCompare(b.orario||'zz'); });\n    var mini='';\n    lista.slice(0,2).forEach(function(e){ var t=tipoInfo(e.tipo);\n      mini+='<div class=\"mini\" style=\"border-left-color:'+t.c+'\">'+(e.orario?'<span style=\"color:'+t.c+'\">'+esc(e.orario)+'</span> ':'')+esc(e.titolo)+'</div>'; });\n    var piu = lista.length>2 ? '<div class=\"piu\">+'+(lista.length-2)+' altri</div>' : '';\n    celle+='<div class=\"cella'+(fuori?' fuori':'')+(iso===oggi?' oggi':'')+'\" data-vaigiorno=\"'+iso+'\">'+\n      '<div class=\"n\">'+cur.getDate()+'</div>'+mini+piu+'</div>';\n    if(i>=34 && cur.getMonth()!==mese && (i+1)%7===0) break; // non disegnare una 6\u00aa riga tutta fuori mese\n  }\n  return '<div class=\"mese-intest\">'+NOMI_G.map(function(g){ return '<div>'+g+'</div>'; }).join('')+'</div>'+\n    '<div class=\"mese-griglia\">'+celle+'</div>';\n}\n\nfunction vistaLista(){\n  var da=ANCORA;\n  var lista=eventiCorrenti().filter(function(e){ return e.data>=da; }).sort(function(a,b){\n    return (a.data+(a.orario||'')).localeCompare(b.data+(b.orario||''));\n  });\n  if(!lista.length) return '<div class=\"lista-vuota\">Nessun evento da oggi in poi.<br>Tocca + per aggiungere un appuntamento.</div>';\n  var perGiorno={}, ordine=[];\n  lista.forEach(function(e){ if(!perGiorno[e.data]){ perGiorno[e.data]=[]; ordine.push(e.data); } perGiorno[e.data].push(e); });\n  return ordine.map(function(d){\n    var dd=dataDaIso(d);\n    var h='<div class=\"lista-giorno\"><div class=\"data-h\">'+NOMI_GL[idxLun(d)]+' '+dd.getDate()+' '+NOMI_MESI[dd.getMonth()]+'</div>';\n    h+=perGiorno[d].map(function(e){ return chipEvento(e); }).join('');\n    return h+'</div>';\n  }).join('');\n}\n\nfunction scrollAllOra(){\n  var main=document.getElementById('vista');\n  var target = (VISTA==='giorno'||VISTA==='settimana') ? (hOra()*(9-ORA_DA)) : 0; // scrolla verso le 9\n  if(main) main.scrollTop = target;\n}\n\n/* click su evento \u2192 dettaglio/sheet */\nfunction agganciaEventi(){\n  document.querySelectorAll('#vista .evt, #vista .chip').forEach(function(el){\n    el.addEventListener('click', function(){\n      var reg=el.getAttribute('data-reg'), id=el.getAttribute('data-id');\n      var e=eventiCorrenti().find(function(x){ return x.registro===reg && x.id===id; });\n      if(e) apriDettaglio(e);\n    });\n  });\n  document.querySelectorAll('#vista .giorno').forEach(function(col){\n    col.addEventListener('dblclick', function(){ nuovoAppuntamento(col.getAttribute('data-data')); });\n  });\n  document.querySelectorAll('#vista .cella').forEach(function(c){\n    c.addEventListener('click', function(){ ANCORA=c.getAttribute('data-vaigiorno'); VISTA='giorno'; render(); });\n  });\n}\n\n/* ============================================================\n   SHEET dettaglio + form appuntamento\n============================================================ */\nfunction chiudiSheet(){ var o=document.getElementById('sheet-overlay'); if(o) o.remove(); }\nfunction apriSheet(html){\n  chiudiSheet();\n  var ov=document.createElement('div'); ov.id='sheet-overlay'; ov.className='overlay';\n  ov.innerHTML='<div class=\"sheet\" onclick=\"event.stopPropagation()\"><div class=\"grip\"></div>'+html+'</div>';\n  ov.addEventListener('click', chiudiSheet);\n  document.body.appendChild(ov);\n}\n\nfunction apriDettaglio(e){\n  var t=tipoInfo(e.tipo);\n  var righe='';\n  function riga(k,v){ if(v) righe+='<div class=\"dett-riga\"><div class=\"k\">'+k+'</div><div class=\"v\">'+esc(v)+'</div></div>'; }\n  var dd=dataDaIso(e.data);\n  riga('Quando', NOMI_GL[idxLun(e.data)]+' '+dd.getDate()+' '+NOMI_MESI[dd.getMonth()]+(e.orario?(' \u00b7 '+e.orario):' \u00b7 tutto il giorno'));\n  if(e.tipo==='appuntamento'){ riga('Luogo', e.luogo); riga('Con chi', e.conChi); riga('Note', e.note); }\n  else { riga('Dettaglio', e.dettaglio); riga('Note', e.note); }\n  var azioni='';\n  if(e.modificabile){\n    azioni='<div class=\"azioni\"><button class=\"btn-annulla\" onclick=\"chiudiSheet()\">Chiudi</button>'+\n      '<button class=\"btn-elimina\" onclick=\"eliminaAppuntamento(\\''+esc(e.id)+'\\')\">Elimina</button>'+\n      '<button class=\"btn-salva\" onclick=\"nuovoAppuntamento(null,\\''+esc(e.id)+'\\')\">Modifica</button></div>';\n  } else if(e.completabile){\n    azioni='<div class=\"azioni\"><button class=\"btn-annulla\" onclick=\"chiudiSheet()\">Chiudi</button>'+\n      '<button class=\"btn-salva\" onclick=\"completaAttivita(\\''+esc(e.id)+'\\')\">Segna fatta</button></div>';\n  } else {\n    azioni='<div class=\"azioni\"><button class=\"btn-annulla\" onclick=\"chiudiSheet()\">Chiudi</button></div>';\n  }\n  apriSheet('<div class=\"pill-tipo\" style=\"background:'+t.c+'22; color:'+t.c+'\">'+esc(t.et)+'</div>'+\n    '<h3>'+esc(e.titolo)+'</h3>'+righe+\n    (e.inCoda?'<div style=\"color:#e0c896; font-size:12px; margin:8px 0;\">In attesa di invio (creato offline)</div>':'')+\n    azioni);\n}\n\nfunction nuovoAppuntamento(dataPre, idEsistente){\n  var e=null;\n  if(idEsistente){ e=eventiCorrenti().find(function(x){ return x.registro==='appuntamenti' && x.id===idEsistente; }); }\n  var data=(e&&e.data)|| dataPre || ANCORA;\n  var ora=(e&&e.orario)||'';\n  apriSheet(\n    '<h3>'+(e?'Modifica appuntamento':'Nuovo appuntamento')+'</h3>'+\n    '<div class=\"campo\"><label>Titolo</label><input id=\"f-titolo\" value=\"'+esc(e?e.titolo:'')+'\" placeholder=\"Es. Cdv Sig. Rossi\"></div>'+\n    '<div class=\"due\"><div class=\"campo\"><label>Data</label><input type=\"date\" id=\"f-data\" value=\"'+esc(data)+'\"></div>'+\n    '<div class=\"campo\"><label>Ora (vuoto = tutto il giorno)</label><input type=\"time\" id=\"f-ora\" value=\"'+esc(ora)+'\"></div></div>'+\n    '<div class=\"due\"><div class=\"campo\"><label>Durata (min)</label><input type=\"number\" id=\"f-durata\" value=\"'+esc(e&&e.durata?e.durata:60)+'\" step=\"15\" min=\"15\"></div>'+\n    '<div class=\"campo\"><label>Luogo</label><input id=\"f-luogo\" value=\"'+esc(e?e.luogo:'')+'\" placeholder=\"Indirizzo / ufficio\"></div></div>'+\n    '<div class=\"campo\"><label>Con chi</label><input id=\"f-conchi\" value=\"'+esc(e?e.conChi:'')+'\" placeholder=\"Cliente / persona\"></div>'+\n    '<div class=\"campo\"><label>Promemoria (notifica prima dell\\'appuntamento)</label>'+\n      '<select id=\"f-promemoria\">'+[\n        {v:0,t:'Nessuno'},{v:10,t:'10 minuti prima'},{v:15,t:'15 minuti prima'},{v:30,t:'30 minuti prima'}\n      ].map(function(o){ var sel=((e&&e.promemoria!=null?e.promemoria:10)==o.v)?' selected':''; return '<option value=\"'+o.v+'\"'+sel+'>'+o.t+'</option>'; }).join('')+'</select></div>'+\n    '<div class=\"campo\"><label>Note</label><textarea id=\"f-note\" placeholder=\"Note...\">'+esc(e?e.note:'')+'</textarea></div>'+\n    '<div class=\"azioni\"><button class=\"btn-annulla\" onclick=\"chiudiSheet()\">Annulla</button>'+\n    '<button class=\"btn-salva\" onclick=\"salvaAppuntamento('+(idEsistente?('\\''+esc(idEsistente)+'\\''):'null')+')\">Salva</button></div>'\n  );\n}\n\nfunction valInput(id){ var el=document.getElementById(id); return el?el.value.trim():''; }\n\nfunction salvaAppuntamento(id){\n  var titolo=valInput('f-titolo');\n  if(!titolo){ toast('Metti un titolo'); return; }\n  var promEl=document.getElementById('f-promemoria');\n  var payload={\n    titolo:titolo, data:valInput('f-data')||ANCORA, ora:valInput('f-ora'),\n    durata:parseInt(valInput('f-durata'),10)||60, luogo:valInput('f-luogo'),\n    conChi:valInput('f-conchi'), note:valInput('f-note'),\n    promemoria: promEl?parseInt(promEl.value,10)||0:0, promemoriaInviato:false,\n    consulente:UTENTE.utente, tipo:'appuntamento', creatoDa:UTENTE.utente\n  };\n  var op={ tipo:'salva', payload:payload };\n  if(id){ op.id=id; if(String(id).indexOf('temp_')===0){ op.tempId=id; delete op.id; } }\n  else { op.tempId='temp_'+Date.now(); }\n  // sostituisci eventuale op in coda sullo stesso id/tempId\n  var chiave=op.id||op.tempId;\n  CODA=CODA.filter(function(x){ return (x.id||x.tempId)!==chiave; });\n  CODA.push(op); lset(K_QUEUE,CODA);\n  chiudiSheet(); render();\n  toast(navigator.onLine?'Salvato, invio in corso\u2026':'Salvato offline, partir\u00e0 da solo');\n  sincronizza();\n}\n\nfunction eliminaAppuntamento(id){\n  if(!confirm('Eliminare questo appuntamento?')) return;\n  // se era solo in coda (mai inviato), togli dalla coda\n  var soloCoda = CODA.some(function(x){ return (x.tempId===id) && !x.id; });\n  CODA=CODA.filter(function(x){ return (x.id||x.tempId)!==id; });\n  if(!soloCoda && String(id).indexOf('temp_')!==0){ CODA.push({tipo:'elimina', id:id}); }\n  lset(K_QUEUE,CODA);\n  chiudiSheet(); render();\n  toast(navigator.onLine?'Eliminato':'Eliminato offline');\n  sincronizza();\n}\n\nfunction completaAttivita(id){\n  // richiede rete; se offline avvisa\n  chiudiSheet();\n  if(!navigator.onLine){ toast('Serve la connessione per segnarla fatta'); return; }\n  fetch(API+'/api/pubblico/attivita/'+id, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({stato:'Completato'})})\n    .then(function(r){ if(r.ok){ toast('Attivit\u00e0 segnata come fatta'); scaricaFeed(); } else toast('Non riuscito'); })\n    .catch(function(){ toast('Non riuscito'); });\n}\n\n/* ============================================================\n   SINCRONIZZAZIONE\n============================================================ */\nfunction aggiornaStatoRete(){\n  var el=document.getElementById('stato-rete');\n  var nInCoda=CODA.length;\n  if(!navigator.onLine){ el.className='badge-off'; el.innerHTML='\u25cf&nbsp;Offline'+(nInCoda?' \u00b7 '+nInCoda+' in coda':''); }\n  else if(nInCoda){ el.className='badge-off'; el.innerHTML='\u2191&nbsp;Invio '+nInCoda+'\u2026'; }\n  else { el.className='badge-on'; el.innerHTML='\u25cf&nbsp;Online'; }\n  var agg=document.getElementById('stato-agg');\n  if(FEED.generatoIl){ var d=new Date(FEED.generatoIl); agg.textContent='agg. '+p2(d.getHours())+':'+p2(d.getMinutes()); }\n}\n\nfunction scaricaFeed(){\n  if(!navigator.onLine || !UTENTE) return Promise.resolve();\n  return fetch(API+'/api/pubblico/calendario/'+encodeURIComponent(UTENTE.utente))\n    .then(function(r){ return r.ok?r.json():null; })\n    .then(function(d){ if(d && Array.isArray(d.eventi)){ FEED=d; lset(K_FEED,FEED); render(); aggiornaStatoRete(); } })\n    .catch(function(){});\n}\n\nvar sincIn=false;\nfunction sincronizza(){\n  aggiornaStatoRete();\n  if(sincIn || !navigator.onLine || !UTENTE) return;\n  if(!CODA.length){ scaricaFeed(); return; }\n  sincIn=true;\n  var coda=CODA.slice();\n  (function next(i){\n    if(i>=coda.length){\n      sincIn=false;\n      scaricaFeed().then(function(){ aggiornaStatoRete(); });\n      return;\n    }\n    var op=coda[i];\n    var fatto=function(ok){\n      if(ok){ CODA=CODA.filter(function(x){ return x!==op; }); lset(K_QUEUE,CODA); aggiornaStatoRete(); }\n      next(i+1);\n    };\n    try{\n      if(op.tipo==='elimina'){\n        fetch(API+'/api/appuntamenti/'+op.id,{method:'DELETE'}).then(function(r){ fatto(r.ok||r.status===404); }).catch(function(){ fatto(false); });\n      } else if(op.tipo==='salva' && op.id){\n        fetch(API+'/api/appuntamenti/'+op.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(op.payload)}).then(function(r){ fatto(r.ok); }).catch(function(){ fatto(false); });\n      } else {\n        fetch(API+'/api/appuntamenti',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(op.payload)}).then(function(r){ fatto(r.ok||r.status===201); }).catch(function(){ fatto(false); });\n      }\n    }catch(e){ fatto(false); }\n  })(0);\n}\n\n/* ============================================================\n   FILTRI\n============================================================ */\nfunction apriFiltri(){\n  var d=document.getElementById('tendina-filtri');\n  if(!d.classList.contains('hide')){ d.classList.add('hide'); return; }\n  var chiavi=Object.keys(TIPI);\n  d.innerHTML='<div class=\"riga-azioni\"><button onclick=\"tuttiFiltri()\">Tutti</button><button onclick=\"nessunFiltro()\">Nessuno</button></div>'+\n    chiavi.map(function(k){\n      var on = !FILTRI.length || FILTRI.indexOf(k)!==-1;\n      return '<label><input type=\"checkbox\" data-k=\"'+k+'\" '+(on?'checked':'')+'><span class=\"dot\" style=\"background:'+TIPI[k].c+'\"></span>'+esc(TIPI[k].et)+'</label>';\n    }).join('');\n  d.classList.remove('hide');\n  d.querySelectorAll('input').forEach(function(cb){\n    cb.addEventListener('change', function(){\n      var sel=[]; d.querySelectorAll('input:checked').forEach(function(x){ sel.push(x.getAttribute('data-k')); });\n      FILTRI = (sel.length===Object.keys(TIPI).length)? [] : sel;\n      lset(K_FILT,FILTRI); render();\n    });\n  });\n}\nfunction tuttiFiltri(){ FILTRI=[]; lset(K_FILT,FILTRI); render(); apriFiltri(); apriFiltri(); }\nfunction nessunFiltro(){ FILTRI=['__nessuno__']; lset(K_FILT,FILTRI); render(); }\n\n/* ============================================================\n   TOAST\n============================================================ */\nvar toastT=null;\nfunction toast(msg){\n  var t=document.getElementById('toast'); t.textContent=msg; t.classList.add('on');\n  clearTimeout(toastT); toastT=setTimeout(function(){ t.classList.remove('on'); }, 2600);\n}\n\n/* ============================================================\n   LOGIN / AVVIO\n============================================================ */\nfunction mostraApp(){\n  document.getElementById('login').classList.add('hide');\n  document.getElementById('app').classList.remove('hide');\n  FEED=lget(K_FEED, FEED); CODA=lget(K_QUEUE, []); FILTRI=lget(K_FILT, []);\n  render(); aggiornaStatoRete(); aggiornaStatoNotifiche(); sincronizza();\n}\n\nfunction login(utente, pass){\n  var err=document.getElementById('l-err'); err.textContent='';\n  var btn=document.getElementById('l-btn'); btn.disabled=true; btn.textContent='Accesso\u2026';\n  fetch(API+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({utente:utente,pass:pass})})\n    .then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })\n    .then(function(res){\n      btn.disabled=false; btn.textContent='Entra';\n      if(res.ok && res.j.data){ UTENTE={utente:res.j.data.utente, nomeCognome:res.j.data.nomeCognome, ruolo:res.j.data.ruolo}; lset(K_USER,UTENTE); mostraApp(); }\n      else { err.textContent=(res.j&&res.j.error)||'Accesso non riuscito'; }\n    })\n    .catch(function(){ btn.disabled=false; btn.textContent='Entra'; err.textContent='Nessuna connessione. Riprova online la prima volta.'; });\n}\n\nfunction esci(){ if(!confirm('Uscire dall\\'app?')) return; localStorage.removeItem(K_USER); location.reload(); }\n\n/* ---- listeners ---- */\ndocument.getElementById('form-login').addEventListener('submit', function(ev){ ev.preventDefault(); login(valInput('l-utente'), document.getElementById('l-pass').value); });\ndocument.getElementById('btn-prec').addEventListener('click', function(){ spostaPeriodo(-1); });\ndocument.getElementById('btn-succ').addEventListener('click', function(){ spostaPeriodo(1); });\n\n/* SWIPE orizzontale col dito per cambiare periodo (giorno/settimana/mese/lista).\n   Ignoro se il movimento \u00e8 pi\u00f9 verticale (scroll) che orizzontale. */\n(function(){\n  var x0=null, y0=null, t0=0, mosso=false;\n  var area=document.getElementById('vista');\n  area.addEventListener('touchstart', function(ev){\n    if(ev.touches.length!==1){ x0=null; return; }\n    x0=ev.touches[0].clientX; y0=ev.touches[0].clientY; t0=Date.now(); mosso=false;\n  }, {passive:true});\n  area.addEventListener('touchmove', function(ev){\n    if(x0==null) return;\n    var dx=ev.touches[0].clientX-x0, dy=ev.touches[0].clientY-y0;\n    if(Math.abs(dx)>10 || Math.abs(dy)>10) mosso=true;\n  }, {passive:true});\n  area.addEventListener('touchend', function(ev){\n    if(x0==null || !mosso) { x0=null; return; }\n    var t=ev.changedTouches[0];\n    var dx=t.clientX-x0, dy=t.clientY-y0, dt=Date.now()-t0;\n    x0=null;\n    // orizzontale netto, abbastanza ampio e rapido\n    if(Math.abs(dx)>55 && Math.abs(dx)>Math.abs(dy)*1.6 && dt<700){\n      spostaPeriodo(dx<0 ? 1 : -1);\n    }\n  }, {passive:true});\n})();\ndocument.getElementById('btn-oggi').addEventListener('click', function(){ ANCORA=oggiIso(); render(); });\ndocument.getElementById('segmented').addEventListener('click', function(ev){ var b=ev.target.closest('button'); if(b){ VISTA=b.dataset.v; render(); } });\ndocument.getElementById('fab').addEventListener('click', function(){ nuovoAppuntamento(); });\ndocument.getElementById('btn-filtri').addEventListener('click', apriFiltri);\ndocument.getElementById('btn-esci').addEventListener('click', esci);\nwindow.addEventListener('online', sincronizza);\nwindow.addEventListener('offline', aggiornaStatoRete);\ndocument.addEventListener('click', function(ev){ var d=document.getElementById('tendina-filtri'); if(d && !d.classList.contains('hide') && !ev.target.closest('.filtro-wrap')) d.classList.add('hide'); });\n// aggiorna il feed quando l'app torna in primo piano\ndocument.addEventListener('visibilitychange', function(){ if(!document.hidden) sincronizza(); });\nsetInterval(function(){ if(!document.hidden) sincronizza(); }, 120000);\n\n/* ============================================================\n   NOTIFICHE PUSH (promemoria stile Google Calendar)\n============================================================ */\nfunction urlB64ToUint8(base64){\n  var pad='='.repeat((4-base64.length%4)%4);\n  var b=(base64+pad).replace(/-/g,'+').replace(/_/g,'/');\n  var raw=atob(b), arr=new Uint8Array(raw.length);\n  for(var i=0;i<raw.length;i++) arr[i]=raw.charCodeAt(i);\n  return arr;\n}\nfunction notifichePronte(){ return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window); }\nfunction aggiornaStatoNotifiche(){\n  var b=document.getElementById('btn-notifiche'); if(!b) return;\n  if(!notifichePronte()){\n    // iPhone non installato: PushManager non c'\u00e8 finch\u00e9 non aggiungi alla Home\n    b.textContent='\ud83d\udd14 Aggiungi alla Home per le notifiche'; b.style.opacity='.7'; return;\n  }\n  if(Notification.permission==='granted'){ b.textContent='\ud83d\udd14 Notifiche attive'; b.style.opacity='.75'; }\n  else { b.textContent='\ud83d\udd14 Attiva notifiche'; b.style.opacity='1'; }\n}\nfunction attivaNotifiche(){\n  if(!notifichePronte()){\n    toast('Su iPhone: prima \"Aggiungi a schermata Home\", poi riapri l\\'app e attiva.');\n    return;\n  }\n  Notification.requestPermission().then(function(perm){\n    if(perm!=='granted'){ toast('Permesso notifiche negato'); return; }\n    navigator.serviceWorker.ready.then(function(reg){\n      fetch(API+'/api/push/vapid').then(function(r){ return r.json(); }).then(function(v){\n        return reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey: urlB64ToUint8(v.publicKey) });\n      }).then(function(sub){\n        return fetch(API+'/api/push/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},\n          body:JSON.stringify({ utente:UTENTE.utente, subscription:sub })});\n      }).then(function(){ toast('Notifiche attivate \u2713'); aggiornaStatoNotifiche(); })\n      .catch(function(e){ toast('Attivazione non riuscita'); });\n    });\n  });\n}\nwindow.attivaNotifiche=attivaNotifiche;\n\n// esposizione per onclick inline\nwindow.chiudiSheet=chiudiSheet; window.nuovoAppuntamento=nuovoAppuntamento; window.salvaAppuntamento=salvaAppuntamento;\nwindow.eliminaAppuntamento=eliminaAppuntamento; window.completaAttivita=completaAttivita; window.tuttiFiltri=tuttiFiltri; window.nessunFiltro=nessunFiltro;\n\n/* avvio */\nUTENTE=lget(K_USER,null);\nif(UTENTE) mostraApp();\n\n/* service worker */\nif('serviceWorker' in navigator){\n  window.addEventListener('load', function(){ navigator.serviceWorker.register('/app/sw.js', {scope:'/app'}).catch(function(){}); });\n}\n</script>\n</body>\n</html>\n";
const APP_CAL_SW = "/* Service worker Agenda Forte \u2014 apre l'app anche da spenta e senza rete.\n   Il guscio (HTML/icone) sta in cache; i dati li gestisce l'app in localStorage. */\nvar CACHE = 'agenda-forte-v2';\nvar SHELL = [\n  '/app',\n  '/app/',\n  '/app/manifest.webmanifest',\n  '/app/icon-192.png',\n  '/app/icon-512.png'\n];\n\nself.addEventListener('install', function (e) {\n  self.skipWaiting();\n  e.waitUntil(caches.open(CACHE).then(function (c) {\n    // aggiungo uno per uno: se una risorsa manca non voglio far fallire tutto\n    return Promise.all(SHELL.map(function (u) {\n      return c.add(new Request(u, { cache: 'reload' })).catch(function () {});\n    }));\n  }));\n});\n\nself.addEventListener('activate', function (e) {\n  e.waitUntil(\n    caches.keys().then(function (chiavi) {\n      return Promise.all(chiavi.map(function (k) { if (k !== CACHE) return caches.delete(k); }));\n    }).then(function () { return self.clients.claim(); })\n  );\n});\n\n/* Notifiche push: mostra la notifica e apre l'app al tocco */\nself.addEventListener('push', function (e) {\n  var d = {};\n  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'Agenda Forte', body: (e.data && e.data.text()) || '' }; }\n  e.waitUntil(self.registration.showNotification(d.title || 'Agenda Forte', {\n    body: d.body || '', icon: '/app/icon-192.png', badge: '/app/icon-192.png',\n    data: d.url || '/app', tag: d.tag, renotify: !!d.tag, vibrate: [80, 40, 80]\n  }));\n});\nself.addEventListener('notificationclick', function (e) {\n  e.notification.close();\n  var dest = e.notification.data || '/app';\n  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {\n    for (var i = 0; i < list.length; i++) { if (list[i].url.indexOf('/app') !== -1) return list[i].focus(); }\n    return self.clients.openWindow(dest);\n  }));\n});\n\nself.addEventListener('fetch', function (e) {\n  var req = e.request;\n  if (req.method !== 'GET') return;                 // POST/PUT/DELETE: sempre in rete\n  var url = new URL(req.url);\n  if (url.origin !== self.location.origin) return;  // altri domini: lascio stare\n  if (url.pathname.indexOf('/api/') === 0) return;   // le API le gestisce l'app (rete + cache localStorage)\n\n  // Navigazione (aprire l'app): rete, con ripiego sul guscio in cache\n  if (req.mode === 'navigate') {\n    e.respondWith(\n      fetch(req).catch(function () {\n        return caches.match('/app').then(function (r) { return r || caches.match('/app/'); });\n      })\n    );\n    return;\n  }\n\n  // Risorse statiche del guscio: cache-first, poi rete (e aggiorno la cache)\n  e.respondWith(\n    caches.match(req).then(function (cached) {\n      var rete = fetch(req).then(function (resp) {\n        if (resp && resp.status === 200) {\n          var copia = resp.clone();\n          caches.open(CACHE).then(function (c) { c.put(req, copia); });\n        }\n        return resp;\n      }).catch(function () { return cached; });\n      return cached || rete;\n    })\n  );\n});\n";
const APP_CAL_MANIFEST = "{\n  \"name\": \"Agenda Forte\",\n  \"short_name\": \"Agenda\",\n  \"description\": \"Il calendario del consulente Immobiliare Forte, sempre disponibile anche offline.\",\n  \"start_url\": \"/app\",\n  \"scope\": \"/app\",\n  \"display\": \"standalone\",\n  \"orientation\": \"portrait\",\n  \"background_color\": \"#0e1013\",\n  \"theme_color\": \"#0b2029\",\n  \"lang\": \"it\",\n  \"icons\": [\n    { \"src\": \"/app/icon-192.png\", \"sizes\": \"192x192\", \"type\": \"image/png\", \"purpose\": \"any\" },\n    { \"src\": \"/app/icon-512.png\", \"sizes\": \"512x512\", \"type\": \"image/png\", \"purpose\": \"any\" },\n    { \"src\": \"/app/icon-512.png\", \"sizes\": \"512x512\", \"type\": \"image/png\", \"purpose\": \"maskable\" }\n  ]\n}\n";
const APP_CAL_ICON192 = Buffer.from("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", 'base64');
const APP_CAL_ICON512 = Buffer.from("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", 'base64');
app.get(['/app', '/app/', '/app/index.html'], (req, res) => { res.set('Content-Type', 'text/html; charset=utf-8'); res.send(APP_CAL_HTML); });
app.get('/app/sw.js', (req, res) => { res.set('Content-Type', 'application/javascript; charset=utf-8'); res.set('Service-Worker-Allowed', '/app'); res.send(APP_CAL_SW); });
app.get('/app/manifest.webmanifest', (req, res) => { res.set('Content-Type', 'application/manifest+json; charset=utf-8'); res.send(APP_CAL_MANIFEST); });
app.get('/app/icon-192.png', (req, res) => { res.set('Content-Type', 'image/png'); res.set('Cache-Control', 'public, max-age=604800'); res.send(APP_CAL_ICON192); });
app.get('/app/icon-512.png', (req, res) => { res.set('Content-Type', 'image/png'); res.set('Cache-Control', 'public, max-age=604800'); res.send(APP_CAL_ICON512); });
const APP_KPI_HTML = "<!doctype html>\n<html lang=\"it\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1\">\n<meta name=\"theme-color\" content=\"#0b2029\">\n<title>KPI Forte</title>\n<link rel=\"manifest\" href=\"/kpi/manifest.webmanifest\">\n<link rel=\"apple-touch-icon\" href=\"/kpi/icon-192.png\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<meta name=\"apple-mobile-web-app-status-bar-style\" content=\"black-translucent\">\n<meta name=\"apple-mobile-web-app-title\" content=\"KPI Forte\">\n<style>\n  :root{\n    --bg:#0b0d10; --bg2:#111418; --card:#14171c; --card2:#191d23;\n    --hair:rgba(255,255,255,.07); --hair2:rgba(255,255,255,.12);\n    --txt:#f0f2f5; --mut:#9aa2ad; --mut2:#646c78;\n    --oro:#c9a86a; --oro2:#e3ca94; --petrolio:#0b2029; --ok:#57c98b; --danger:#f0616f;\n    --serif:ui-serif, 'Iowan Old Style', 'Palatino Linotype', Georgia, 'Times New Roman', serif;\n    --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Plus Jakarta Sans',sans-serif;\n  }\n  *{box-sizing:border-box; -webkit-tap-highlight-color:transparent;}\n  html,body{margin:0; padding:0; background:var(--bg); color:var(--txt); font-family:var(--sans); overscroll-behavior-y:none; -webkit-font-smoothing:antialiased;}\n  body{padding-top:env(safe-area-inset-top); padding-bottom:env(safe-area-inset-bottom);}\n  button{font-family:inherit; cursor:pointer;}\n  .hide{display:none !important;}\n  .num{font-variant-numeric:tabular-nums; font-feature-settings:\"tnum\";}\n\n  /* LOGIN */\n  #login{position:fixed; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; padding:28px; background:radial-gradient(130% 80% at 50% -10%, #17323d 0%, #0b0d10 55%);}\n  #login .logo{width:82px; height:82px; border-radius:22px; background:linear-gradient(160deg,#123640,#0a1a20); border:1px solid rgba(201,168,106,.35); display:flex; align-items:center; justify-content:center; color:var(--oro); font-family:var(--serif); font-weight:600; font-size:30px; letter-spacing:1px; box-shadow:0 16px 40px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.06);}\n  #login h1{margin:8px 0 0; font-family:var(--serif); font-weight:600; font-size:23px; letter-spacing:.3px;}\n  #login p{margin:0; color:var(--mut); font-size:12.5px; letter-spacing:.4px;}\n  #login .box{width:100%; max-width:340px; display:flex; flex-direction:column; gap:11px; margin-top:10px;}\n  #login input{width:100%; padding:15px; background:rgba(255,255,255,.04); border:1px solid var(--hair2); color:#fff; border-radius:14px; font-size:16px;}\n  #login input:focus{outline:none; border-color:rgba(201,168,106,.6);}\n  #login button{width:100%; padding:15px; background:linear-gradient(135deg,var(--oro2),var(--oro)); color:#20160a; border:none; border-radius:14px; font-weight:800; font-size:16px; letter-spacing:.3px;}\n  #login .err{color:var(--danger); font-size:13px; min-height:18px; text-align:center;}\n\n  /* HEADER */\n  header{position:sticky; top:0; z-index:20; background:rgba(11,13,16,.86); backdrop-filter:blur(14px); border-bottom:1px solid var(--hair);}\n  .topbar{display:flex; align-items:center; gap:10px; padding:14px 16px 10px;}\n  .topbar .chi{flex:1; min-width:0;}\n  .topbar .chi .nome{font-family:var(--serif); font-size:20px; font-weight:600; letter-spacing:.2px; text-transform:capitalize; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}\n  .topbar .chi .periodo{font-size:11px; color:var(--mut); letter-spacing:.4px; margin-top:1px;}\n  .icona-btn{width:38px; height:38px; border-radius:12px; background:rgba(255,255,255,.04); border:1px solid var(--hair2); color:var(--txt); font-size:15px; display:flex; align-items:center; justify-content:center; padding:0; flex-shrink:0;}\n  select.sel-cons{max-width:150px; padding:9px 10px; background:rgba(255,255,255,.04); border:1px solid var(--hair2); color:var(--txt); border-radius:11px; font-size:12.5px; font-family:inherit;}\n  .tabs{display:flex; gap:6px; padding:2px; margin:0 16px 12px; background:rgba(255,255,255,.04); border:1px solid var(--hair); border-radius:14px;}\n  .tabs button{flex:1; padding:10px; background:transparent; border:none; color:var(--mut); border-radius:11px; font-weight:700; font-size:13.5px; letter-spacing:.2px; transition:all .2s;}\n  .tabs button.on{background:linear-gradient(135deg,var(--oro2),var(--oro)); color:#20160a;}\n  .stato{display:flex; align-items:center; gap:8px; padding:0 16px 10px; font-size:11px; color:var(--mut); letter-spacing:.3px;}\n  .badge-off{background:rgba(201,168,106,.12); border:1px solid rgba(201,168,106,.35); color:var(--oro2); padding:3px 9px; border-radius:20px; font-weight:700;}\n\n  main{padding:14px 14px 46px;}\n\n  /* HERO */\n  .hero{position:relative; background:linear-gradient(150deg,#123640 0%,#0c1f27 60%,#0b171d 100%); border:1px solid rgba(201,168,106,.22); border-radius:22px; padding:20px; margin-bottom:12px; overflow:hidden; box-shadow:0 12px 34px rgba(0,0,0,.4);}\n  .hero::after{content:''; position:absolute; right:-40px; top:-40px; width:160px; height:160px; background:radial-gradient(circle, rgba(201,168,106,.16), transparent 70%);}\n  .hero .row{display:flex; align-items:center; gap:16px; position:relative; z-index:1;}\n  .hero .info{flex:1; min-width:0;}\n  .hero .lab{font-size:10.5px; text-transform:uppercase; letter-spacing:1.2px; color:var(--oro); margin-bottom:7px; font-weight:700;}\n  .hero .val{font-family:var(--serif); font-size:34px; font-weight:600; color:#fff; line-height:1; letter-spacing:.3px;}\n  .hero .sub{font-size:12px; color:#a9c2cb; margin-top:8px; letter-spacing:.2px;}\n  .ring-wrap{flex-shrink:0;}\n  .ring-cap{text-align:center; font-size:9.5px; text-transform:uppercase; letter-spacing:.6px; color:var(--mut); margin-top:4px;}\n\n  /* STAT TILES */\n  .tiles{display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:20px;}\n  .tile{background:var(--card); border:1px solid var(--hair); border-radius:16px; padding:15px;}\n  .tile .lab{font-size:10px; text-transform:uppercase; letter-spacing:.9px; color:var(--mut); margin-bottom:7px; font-weight:600;}\n  .tile .val{font-family:var(--serif); font-size:25px; font-weight:600; color:#fff; line-height:1;}\n  .tile .val.ok{color:var(--ok);}\n  .tile .sub{font-size:11px; color:var(--mut2); margin-top:5px;}\n\n  .sez-tit{font-size:11px; text-transform:uppercase; letter-spacing:1.4px; color:var(--mut2); font-weight:700; margin:4px 4px 10px;}\n\n  /* FUNNEL \u2014 un'unica card editoriale con righe separate da hairline */\n  .funnel{background:var(--card); border:1px solid var(--hair); border-radius:18px; padding:4px 16px; box-shadow:0 8px 24px rgba(0,0,0,.28);}\n  .frow{padding:16px 0; border-bottom:1px solid var(--hair);}\n  .frow:last-child{border-bottom:none;}\n  .frow .top{display:flex; align-items:baseline; justify-content:space-between; gap:12px;}\n  .frow .t{font-family:var(--serif); font-size:16.5px; font-weight:600; letter-spacing:.2px;}\n  .frow .pct{font-family:var(--serif); font-size:17px; font-weight:600; flex-shrink:0;}\n  .frow .nota{font-size:11px; color:var(--mut2); margin-top:2px;}\n  .frow .track{height:3px; border-radius:2px; background:rgba(255,255,255,.08); overflow:hidden; margin:11px 0 8px;}\n  .frow .track > div{height:100%; border-radius:2px; background:linear-gradient(90deg,var(--oro),var(--oro2));}\n  .frow .fig{display:flex; align-items:baseline; gap:6px; font-size:12.5px; color:var(--mut);}\n  .frow .fig b{font-family:var(--serif); color:#fff; font-size:16px; font-weight:600;}\n  .frow .fig .man{margin-left:auto; color:var(--mut2); font-size:11.5px;}\n  .frow .fig .man.done{color:var(--ok);}\n\n  /* CANALI ACQUISIZIONE */\n  .chan{background:var(--card); border:1px solid var(--hair); border-radius:18px; padding:16px; margin-bottom:11px; box-shadow:0 8px 24px rgba(0,0,0,.24); position:relative; overflow:hidden;}\n  .chan .accent{position:absolute; left:0; top:0; bottom:0; width:3px;}\n  .chan .head{display:flex; align-items:center; gap:14px;}\n  .chan .info{flex:1; min-width:0;}\n  .chan .et{font-family:var(--serif); font-size:17px; font-weight:600; letter-spacing:.2px;}\n  .chan .sp{font-size:11px; color:var(--mut2); margin-top:3px; line-height:1.35;}\n  .chan .amt{font-family:var(--serif); margin-top:8px; font-size:15px; color:var(--mut);}\n  .chan .amt b{font-size:23px; color:#fff; font-weight:600;}\n  .chan .toggle{margin-top:12px; font-size:11.5px; color:var(--oro); font-weight:700; letter-spacing:.3px;}\n  .piano{margin-top:12px; border-top:1px solid var(--hair); padding-top:6px;}\n  .piano .cad{background:rgba(201,168,106,.09); border:1px solid rgba(201,168,106,.26); border-radius:11px; padding:9px 12px; color:var(--oro2); font-size:11.5px; line-height:1.4; margin:8px 0;}\n  .prow{display:grid; grid-template-columns:1fr auto auto; gap:10px; align-items:center; padding:10px 0; border-bottom:1px solid var(--hair);}\n  .prow:last-child{border-bottom:none;}\n  .prow .pn{font-size:13px; font-weight:600;}\n  .prow .pnn{font-size:10.5px; color:var(--mut2); margin-top:1px;}\n  .prow .pv{text-align:right; min-width:56px;}\n  .prow .pv .x{font-family:var(--serif); font-size:16px; font-weight:600;}\n  .prow .pv .k{font-size:8.5px; color:var(--mut2); text-transform:uppercase; letter-spacing:.5px; margin-top:1px;}\n\n  .toast{position:fixed; left:50%; bottom:30px; transform:translateX(-50%); background:rgba(10,12,15,.96); border:1px solid var(--hair2); color:#fff; padding:11px 18px; border-radius:14px; font-size:13px; z-index:60; opacity:0; transition:opacity .2s; pointer-events:none; max-width:90%; text-align:center; box-shadow:0 10px 30px rgba(0,0,0,.5);}\n  .toast.on{opacity:1;}\n  .vuoto{color:var(--mut2); text-align:center; padding:50px 20px; font-size:14px; line-height:1.6;}\n  .note-fondo{color:var(--mut2); font-size:11px; padding:12px 6px 0; line-height:1.5;}\n</style>\n</head>\n<body>\n\n<div id=\"login\">\n  <div class=\"logo\">F</div>\n  <h1>KPI Forte</h1>\n  <p>I RISULTATI DEL CONSULENTE</p>\n  <form class=\"box\" id=\"form-login\" autocomplete=\"on\">\n    <input type=\"text\" id=\"l-utente\" placeholder=\"Username\" autocapitalize=\"none\" autocorrect=\"off\" autocomplete=\"username\">\n    <input type=\"password\" id=\"l-pass\" placeholder=\"Password\" autocomplete=\"current-password\">\n    <div class=\"err\" id=\"l-err\"></div>\n    <button type=\"submit\" id=\"l-btn\">Entra</button>\n  </form>\n</div>\n\n<div id=\"app\" class=\"hide\">\n  <header>\n    <div class=\"topbar\">\n      <div class=\"chi\"><div class=\"nome\" id=\"hd-nome\">\u2014</div><div class=\"periodo\" id=\"hd-periodo\">\u2014</div></div>\n      <select class=\"sel-cons hide\" id=\"sel-cons\" onchange=\"cambiaConsulente(this.value)\"></select>\n      <button class=\"icona-btn\" id=\"btn-agg\" title=\"Aggiorna\">\u21bb</button>\n      <button class=\"icona-btn\" id=\"btn-esci\" title=\"Esci\">\u238b</button>\n    </div>\n    <div class=\"tabs\">\n      <button data-t=\"generali\" class=\"on\" onclick=\"cambiaTab('generali')\">Generali</button>\n      <button data-t=\"acquisizione\" onclick=\"cambiaTab('acquisizione')\">Acquisizione</button>\n    </div>\n    <div class=\"stato\"><span id=\"stato-rete\">\u25cf&nbsp;Online</span><span id=\"stato-agg\" style=\"margin-left:auto;\"></span></div>\n  </header>\n  <main id=\"vista\"></main>\n</div>\n\n<div id=\"toast\" class=\"toast\"></div>\n\n<script>\n\"use strict\";\n/* ============================================================\n   KPI FORTE \u2014 PWA offline dei risultati del consulente\n   Legge un riepilogo gi\u00e0 calcolato dal server e lo tiene in cache.\n============================================================ */\nvar API='';\nvar K_USER='fck_user', K_DATA='fck_data', K_CONS='fck_cons';\nfunction lget(k,def){ try{ var v=localStorage.getItem(k); return v?JSON.parse(v):def; }catch(e){ return def; } }\nfunction lset(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }\nfunction esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;'); }\nfunction nf(n){ return (Number(n)||0).toLocaleString('it-IT'); }\nfunction euro(n){ return '\u20ac '+nf(Math.round(Number(n)||0)); }\n\nvar UTENTE=null, DATA=null, TAB='generali', CONS_SEL='', APERTI={};\n\n/* colore avanzamento (tenue, elegante): dal bronzo scuro all'oro */\nfunction coloreAv(p){\n  var q=Math.max(0,Math.min(100,p))/100, da=[122,86,54], a=[201,168,106];\n  return 'rgb('+da.map(function(c,i){ return Math.round(c+(a[i]-c)*q); }).join(',')+')';\n}\n\n/* anello di progresso SVG */\nfunction ring(perc, size, stroke, colore){\n  var p=Math.max(0,Math.min(100,Math.round(perc)));\n  var r=(size-stroke)/2, c=2*Math.PI*r, off=c*(1-p/100), cx=size/2;\n  return '<svg width=\"'+size+'\" height=\"'+size+'\" viewBox=\"0 0 '+size+' '+size+'\">'+\n    '<circle cx=\"'+cx+'\" cy=\"'+cx+'\" r=\"'+r+'\" fill=\"none\" stroke=\"rgba(255,255,255,.09)\" stroke-width=\"'+stroke+'\"/>'+\n    '<circle cx=\"'+cx+'\" cy=\"'+cx+'\" r=\"'+r+'\" fill=\"none\" stroke=\"'+colore+'\" stroke-width=\"'+stroke+'\" stroke-linecap=\"round\" stroke-dasharray=\"'+c.toFixed(1)+'\" stroke-dashoffset=\"'+off.toFixed(1)+'\" transform=\"rotate(-90 '+cx+' '+cx+')\"/>'+\n    '<text x=\"50%\" y=\"50%\" text-anchor=\"middle\" dominant-baseline=\"central\" fill=\"#fff\" font-family=\"Georgia, serif\" font-size=\"'+(size*0.28).toFixed(0)+'\" font-weight=\"600\">'+p+'%</text></svg>';\n}\n\nfunction render(){\n  document.querySelectorAll('.tabs button').forEach(function(b){ b.classList.toggle('on', b.dataset.t===TAB); });\n  var v=document.getElementById('vista');\n  if(!DATA){ v.innerHTML='<div class=\"vuoto\">Nessun dato. Tocca \u21bb per aggiornare (serve la connessione la prima volta).</div>'; return; }\n  document.getElementById('hd-nome').textContent = DATA.nomeCognome || DATA.utente || '';\n  document.getElementById('hd-periodo').textContent = (DATA.periodo && DATA.periodo.etichetta) ? ('Periodo: '+DATA.periodo.etichetta) : '';\n  v.innerHTML = TAB==='generali' ? vistaGenerali() : vistaAcquisizione();\n  var st=document.getElementById('stato-agg');\n  if(DATA.generatoIl){ var d=new Date(DATA.generatoIl); st.textContent='agg. '+d.toLocaleDateString('it-IT')+' '+('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); }\n}\n\nfunction vistaGenerali(){\n  var g=DATA.generali||{};\n  var percTot = g.fatturatoLordo>0 ? Math.round((g.provvigioniMaturate||0)/g.fatturatoLordo*100) : 0;\n  var hero='<div class=\"hero\"><div class=\"row\">'+\n    '<div class=\"info\"><div class=\"lab\">Obiettivo netto \u00b7 Oby</div>'+\n      '<div class=\"val num\">'+euro(g.obiettivoNetto)+'</div>'+\n      '<div class=\"sub\">Fatturato lordo da fare \u00b7 '+euro(g.fatturatoLordo)+'</div></div>'+\n    '<div class=\"ring-wrap\">'+ring(percTot,88,7,'#e3ca94')+'<div class=\"ring-cap\">provvigioni</div></div>'+\n    '</div></div>';\n  var tiles='<div class=\"tiles\">'+\n    '<div class=\"tile\"><div class=\"lab\">Provvigioni maturate</div><div class=\"val ok num\">'+euro(g.provvigioniMaturate)+'</div><div class=\"sub\">nel periodo</div></div>'+\n    '<div class=\"tile\"><div class=\"lab\">Vendite \u00b7 rogiti</div><div class=\"val num\">'+nf(g.vendite)+'</div><div class=\"sub\">su '+nf(g.proposte)+' proposte</div></div>'+\n    '</div>';\n  var righe=(g.funnel||[]).map(function(o){\n    var perc = o.obiettivo>0 ? Math.min(100, Math.round(o.attuale/o.obiettivo*100)) : 0;\n    var manca = Math.max(0, o.obiettivo-o.attuale), fatto=manca===0;\n    return '<div class=\"frow\"><div class=\"top\"><div><div class=\"t\">'+esc(o.titolo)+'</div>'+\n        (o.nota?'<div class=\"nota\">'+esc(o.nota)+'</div>':'')+'</div>'+\n      '<span class=\"pct\" style=\"color:'+coloreAv(perc)+'\">'+perc+'%</span></div>'+\n      '<div class=\"track\"><div style=\"width:'+perc+'%\"></div></div>'+\n      '<div class=\"fig\"><b class=\"num\">'+nf(o.attuale)+'</b> di <span class=\"num\">'+nf(o.obiettivo)+'</span> '+esc(o.unita||'')+\n        '<span class=\"man'+(fatto?' done':'')+' num\">'+(fatto?'\u2713 raggiunto':('mancano '+nf(manca)))+'</span></div>'+\n    '</div>';\n  }).join('');\n  return hero+tiles+'<div class=\"sez-tit\">Percorso verso l\\'obiettivo</div><div class=\"funnel\">'+righe+'</div>';\n}\n\nfunction vistaAcquisizione(){\n  var a=DATA.acquisizione||{};\n  var percTot = a.obiettivoOpportunity>0 ? Math.round((a.fatteTotale||0)/a.obiettivoOpportunity*100) : 0;\n  var hero='<div class=\"hero\"><div class=\"row\">'+\n    '<div class=\"info\"><div class=\"lab\">Opportunity da acquisire</div>'+\n      '<div class=\"val num\">'+nf(a.fatteTotale)+' <span style=\"font-size:20px; color:var(--mut);\">/ '+nf(a.obiettivoOpportunity)+'</span></div>'+\n      '<div class=\"sub\">nel periodo di monitoraggio</div></div>'+\n    '<div class=\"ring-wrap\">'+ring(percTot,88,7,'#e3ca94')+'<div class=\"ring-cap\">acquisite</div></div>'+\n    '</div></div>';\n  var canali=(a.canali||[]).map(function(c){\n    var perc = c.obiettivo>0 ? Math.min(100, Math.round(c.fatte/c.obiettivo*100)) : 0;\n    var col=c.colore||'#c9a86a';\n    var aperto=!!APERTI[c.chiave];\n    var piano='';\n    if(aperto && c.piano && c.piano.length){\n      piano='<div class=\"piano\">'+(c.cadenza?'<div class=\"cad\">'+esc(c.cadenza)+'</div>':'')+\n        c.piano.map(function(p){\n          var haFatte = p.fatte!==null && p.fatte!==undefined;\n          return '<div class=\"prow\"><div><div class=\"pn\">'+esc(p.nome)+'</div>'+(p.nota?'<div class=\"pnn\">'+esc(p.nota)+'</div>':'')+'</div>'+\n            '<div class=\"pv\"><div class=\"x num\">'+nf(p.daFare)+'</div><div class=\"k\">da fare</div></div>'+\n            '<div class=\"pv\"><div class=\"x num\" style=\"color:'+(haFatte?'var(--ok)':'var(--mut2)')+'\">'+(haFatte?nf(p.fatte):'\u2014')+'</div><div class=\"k\">fatte</div></div></div>';\n        }).join('')+'</div>';\n    }\n    return '<div class=\"chan\" onclick=\"apriCanale(\\''+esc(c.chiave)+'\\')\"><div class=\"accent\" style=\"background:'+col+'\"></div>'+\n      '<div class=\"head\">'+ring(perc,60,5,col)+\n        '<div class=\"info\"><div class=\"et\">'+esc(c.etichetta)+'</div>'+(c.spiega?'<div class=\"sp\">'+esc(c.spiega)+'</div>':'')+\n          '<div class=\"amt\"><b class=\"num\">'+nf(c.fatte)+'</b> / '+nf(c.obiettivo)+' opportunity</div></div>'+\n      '</div>'+\n      (c.piano && c.piano.length ? '<div class=\"toggle\">'+(aperto?'\u25b2 Nascondi piano di lavoro':'\u25bc Vedi piano di lavoro')+'</div>' : '')+\n      piano+'</div>';\n  }).join('');\n  return hero+'<div class=\"sez-tit\">Canali di acquisizione</div>'+canali+\n    '<div class=\"note-fondo\">Lettere, citofoni e call non lasciano traccia nel CRM: dove non rilevabili appaiono come \u201c\u2014\u201d.</div>';\n}\n\nfunction apriCanale(ch){ APERTI[ch]=!APERTI[ch]; render(); }\nfunction cambiaTab(t){ TAB=t; render(); }\n\n/* ---- rete/dati ---- */\nfunction aggiornaStatoRete(){\n  var el=document.getElementById('stato-rete');\n  if(!navigator.onLine){ el.className='badge-off'; el.textContent='\u25cf Offline'; el.parentNode.style.color=''; }\n  else { el.className=''; el.textContent='\u25cf Online'; }\n}\nfunction chiediUtenteTarget(){ return CONS_SEL || (UTENTE?UTENTE.utente:''); }\n\nfunction scarica(){\n  aggiornaStatoRete();\n  if(!navigator.onLine){ toast('Sei offline: mostro l\u2019ultimo dato salvato'); return Promise.resolve(); }\n  var u=chiediUtenteTarget();\n  toast('Aggiorno\u2026');\n  return fetch(API+'/api/pubblico/kpi-app/'+encodeURIComponent(u))\n    .then(function(r){ return r.ok?r.json():null; })\n    .then(function(d){ if(d && d.generali){ DATA=d; lset(K_DATA,{ver:u,d:d}); render(); if(UTENTE&&UTENTE.ruoloBroker) popolaSelettore(d); } else toast('Dati non disponibili'); })\n    .catch(function(){ toast('Aggiornamento non riuscito'); });\n}\n\nfunction popolaSelettore(d){\n  if(!d.consulenti || !d.consulenti.length) return;\n  var sel=document.getElementById('sel-cons'); sel.classList.remove('hide');\n  sel.innerHTML=d.consulenti.map(function(c){ return '<option value=\"'+esc(c.utente)+'\" '+(c.utente===chiediUtenteTarget()?'selected':'')+'>'+esc(c.nomeCognome||c.utente)+'</option>'; }).join('');\n}\nfunction cambiaConsulente(u){ CONS_SEL=u; lset(K_CONS,u); scarica(); }\n\n/* ---- toast ---- */\nvar tt=null;\nfunction toast(m){ var t=document.getElementById('toast'); t.textContent=m; t.classList.add('on'); clearTimeout(tt); tt=setTimeout(function(){ t.classList.remove('on'); },2400); }\n\n/* ---- login/avvio ---- */\nfunction mostraApp(){\n  document.getElementById('login').classList.add('hide');\n  document.getElementById('app').classList.remove('hide');\n  CONS_SEL=lget(K_CONS,'');\n  var cache=lget(K_DATA,null);\n  if(cache && cache.d){ DATA=cache.d; }\n  render(); aggiornaStatoRete(); scarica();\n}\nfunction login(u,p){\n  var err=document.getElementById('l-err'); err.textContent='';\n  var btn=document.getElementById('l-btn'); btn.disabled=true; btn.textContent='Accesso\u2026';\n  fetch(API+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({utente:u,pass:p})})\n    .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j}; }); })\n    .then(function(res){\n      btn.disabled=false; btn.textContent='Entra';\n      if(res.ok && res.j.data){\n        var ru=String(res.j.data.ruolo||'').toUpperCase();\n        UTENTE={utente:res.j.data.utente, nomeCognome:res.j.data.nomeCognome, ruolo:res.j.data.ruolo, ruoloBroker:(ru==='BROKER'||ru==='AMMINISTRATORE')};\n        lset(K_USER,UTENTE); mostraApp();\n      } else err.textContent=(res.j&&res.j.error)||'Accesso non riuscito';\n    })\n    .catch(function(){ btn.disabled=false; btn.textContent='Entra'; err.textContent='Nessuna connessione. Riprova online la prima volta.'; });\n}\nfunction esci(){ if(!confirm('Uscire?')) return; localStorage.removeItem(K_USER); location.reload(); }\n\ndocument.getElementById('form-login').addEventListener('submit', function(e){ e.preventDefault(); login(document.getElementById('l-utente').value.trim(), document.getElementById('l-pass').value); });\ndocument.getElementById('btn-agg').addEventListener('click', scarica);\ndocument.getElementById('btn-esci').addEventListener('click', esci);\nwindow.addEventListener('online', function(){ aggiornaStatoRete(); scarica(); });\nwindow.addEventListener('offline', aggiornaStatoRete);\ndocument.addEventListener('visibilitychange', function(){ if(!document.hidden && navigator.onLine) scarica(); });\nwindow.apriCanale=apriCanale; window.cambiaTab=cambiaTab; window.cambiaConsulente=cambiaConsulente;\n\nUTENTE=lget(K_USER,null);\nif(UTENTE) mostraApp();\nif('serviceWorker' in navigator){ window.addEventListener('load', function(){ navigator.serviceWorker.register('/kpi/sw.js', {scope:'/kpi'}).catch(function(){}); }); }\n</script>\n</body>\n</html>\n";
const APP_KPI_SW = "/* Service worker KPI Forte \u2014 apre l'app anche offline. Il guscio sta in cache;\n   i dati li gestisce l'app in localStorage. */\nvar CACHE = 'kpi-forte-v1';\nvar SHELL = ['/kpi', '/kpi/', '/kpi/manifest.webmanifest', '/kpi/icon-192.png', '/kpi/icon-512.png'];\n\nself.addEventListener('install', function (e) {\n  self.skipWaiting();\n  e.waitUntil(caches.open(CACHE).then(function (c) {\n    return Promise.all(SHELL.map(function (u) { return c.add(new Request(u, { cache: 'reload' })).catch(function () {}); }));\n  }));\n});\nself.addEventListener('activate', function (e) {\n  e.waitUntil(caches.keys().then(function (ks) {\n    return Promise.all(ks.map(function (k) { if (k !== CACHE) return caches.delete(k); }));\n  }).then(function () { return self.clients.claim(); }));\n});\nself.addEventListener('fetch', function (e) {\n  var req = e.request;\n  if (req.method !== 'GET') return;\n  var url = new URL(req.url);\n  if (url.origin !== self.location.origin) return;\n  if (url.pathname.indexOf('/api/') === 0) return;   // le API le gestisce l'app\n  if (req.mode === 'navigate') {\n    e.respondWith(fetch(req).catch(function () { return caches.match('/kpi').then(function (r) { return r || caches.match('/kpi/'); }); }));\n    return;\n  }\n  e.respondWith(caches.match(req).then(function (cached) {\n    var rete = fetch(req).then(function (resp) {\n      if (resp && resp.status === 200) { var copia = resp.clone(); caches.open(CACHE).then(function (c) { c.put(req, copia); }); }\n      return resp;\n    }).catch(function () { return cached; });\n    return cached || rete;\n  }));\n});\n";
const APP_KPI_MANIFEST = "{\n  \"name\": \"KPI Forte\",\n  \"short_name\": \"KPI\",\n  \"description\": \"I risultati del consulente Immobiliare Forte: obiettivi Oby e acquisizione, sempre a portata di mano.\",\n  \"start_url\": \"/kpi\",\n  \"scope\": \"/kpi\",\n  \"display\": \"standalone\",\n  \"orientation\": \"portrait\",\n  \"background_color\": \"#0b0d10\",\n  \"theme_color\": \"#0b2029\",\n  \"lang\": \"it\",\n  \"icons\": [\n    { \"src\": \"/kpi/icon-192.png\", \"sizes\": \"192x192\", \"type\": \"image/png\", \"purpose\": \"any\" },\n    { \"src\": \"/kpi/icon-512.png\", \"sizes\": \"512x512\", \"type\": \"image/png\", \"purpose\": \"any\" },\n    { \"src\": \"/kpi/icon-512.png\", \"sizes\": \"512x512\", \"type\": \"image/png\", \"purpose\": \"maskable\" }\n  ]\n}\n";
const APP_KPI_ICON192 = Buffer.from("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", 'base64');
const APP_KPI_ICON512 = Buffer.from("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", 'base64');
app.get(['/kpi', '/kpi/', '/kpi/index.html'], (req, res) => { res.set('Content-Type', 'text/html; charset=utf-8'); res.send(APP_KPI_HTML); });
app.get('/kpi/sw.js', (req, res) => { res.set('Content-Type', 'application/javascript; charset=utf-8'); res.set('Service-Worker-Allowed', '/kpi'); res.send(APP_KPI_SW); });
app.get('/kpi/manifest.webmanifest', (req, res) => { res.set('Content-Type', 'application/manifest+json; charset=utf-8'); res.send(APP_KPI_MANIFEST); });
app.get('/kpi/icon-192.png', (req, res) => { res.set('Content-Type', 'image/png'); res.set('Cache-Control', 'public, max-age=604800'); res.send(APP_KPI_ICON192); });
app.get('/kpi/icon-512.png', (req, res) => { res.set('Content-Type', 'image/png'); res.set('Cache-Control', 'public, max-age=604800'); res.send(APP_KPI_ICON512); });
// <<APP_CALENDARIO_END>>

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
    const campiConsentiti = ['nomeCognome', 'utente', 'pass', 'mail', 'telefono', 'idTelegram', 'idWhatsapp', 'fotoProfilo', 'ruolo', 'ruoloPubblico', 'bioPubblica', 'videoPubblico', 'telefonoPubblico', 'pubblicaInHome', 'ordinePubblico', 'agendaTipo'];
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
         link: 1, agenzia: 1, privato: 1, dataAnnuncio: 1, mq: 1, _id: 0 })
      .sort({ updatedAt: -1 }).limit(300);

    const numero = (v) => Number(String(v == null ? '' : v).replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.')) || 0;
    /* La superficie ora c'e' nell'archivio (campo mq, riempito dallo scraping di
       immobiliare): quando c'e' la restituisco e calcolo il prezzo al metro. Se manca
       resta 0, e sara' il consulente a scrivere i metri per gli annunci che sceglie. */
    const utili = righe
      .map(r => {
        const prezzo = numero(r.prezzo);
        const mq = Number(r.mq) || 0;
        const alMq = (mq > 0 && prezzo > 0) ? Math.round(prezzo / mq) : 0;
        /* se via e civico non sono compilati uso l'indirizzo completo del vecchio formato */
        const indirizzo = [r.via, r.civico].filter(x => x && x !== 'N.D.').join(' ').trim();
        return { via: indirizzo || (r.paeseVia || ''), civico: '', comune: r.comune || '',
                 prezzo: prezzo, mq: mq, tipo: r.unita || '', piano: r.piano || '',
                 bagni: r.bagni || '', contesto: r.contesto || '', link: r.link || '',
                 fonte: (r.privato ? 'Privato' : (r.agenzia || 'Agenzia')),
                 data: r.dataAnnuncio || '', alMq: alMq };
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
  fotoFronte: { type: String, default: '' },   // foto caricata dal broker per il fronte (data URI o URL)
  fotoRetro: { type: String, default: '' },    // foto per il retro
  telefono: { type: String, default: '' },     // numeri di riferimento mostrati sul volantino
  sottotitolo: { type: String, default: '' },  // riga piccola sotto il richiamo del QR (es. "Valutazione istantanea · gratis")
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
  creatoDa: { type: String, default: '' },
  promemoria: { type: Number, default: 0 },          // minuti prima per la notifica push (0 = nessuno)
  promemoriaInviato: { type: Boolean, default: false } // per non re-inviare lo stesso promemoria
}, { timestamps: true });

const Appuntamento = mongoose.model('Appuntamento', AppuntamentoSchema);
registraRotteScheda('appuntamenti', Appuntamento);

/* Quando un appuntamento viene modificato (spostato d'orario o cambiato promemoria),
   azzero il flag così il nuovo promemoria può ripartire. Lo faccio con un hook leggero
   sulla rotta PUT generica: vedi registraRotteScheda (il campo promemoriaInviato viene
   resettato lato client re-inviandolo nel payload). */

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

/* ==========================================
   VETRINA PUBBLICA IMMOBILI (per la pagina "immobili" del sito).
   Prende gli incarichi del CRM e restituisce SOLO i campi pubblici e SOLO gli
   immobili da mostrare in vetrina. Nessun dato riservato del venditore
   (telefono, provvigioni, catasto, password) esce mai da qui.
========================================== */

// Come lo stato dell'incarico decide se e come appare in vetrina.
// disponibile = in vendita/affitto (prezzo visibile); venduto = concluso (fascia diagonale).
const STATI_VETRINA_DISPONIBILE = ['On Line'];
const STATI_VETRINA_VENDUTO = ['Rogitato', 'Prel Ok', 'Da Fare Prel'];
// Tutti gli altri (Acquisito, Scaduto, Vincolato, vuoto...) di default NON vanno online,
// a meno che l'interruttore "Pubblica sul sito" sia su 'sempre'.

function _numeroPrezzo(v) {
  const n = parseInt(String(v || '').replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}
function _contrattoPubblico(tip) {
  const t = String(tip || '').trim().toLowerCase();
  if (t.includes('affitto a riscatto') || t.includes('riscatto')) return 'affitto a riscatto';
  if (t.includes('affitto') || t.includes('locazione')) return 'affitto';
  if (t.includes('asta')) return 'asta';
  return 'vendita';
}
function _fotoArrayIncarico(inc) {
  const out = [];
  const spingi = (s) => {
    if (!s) return;
    const link = String(s).match(/https?:\/\/[^\s,;"']+/g) || [];
    link.forEach(l => { if (!out.includes(l)) out.push(l); });
  };
  spingi(inc.foto);
  (inc.fotoAllegati || []).forEach(spingi);
  return out;
}

app.get('/api/pubblico/immobili', async (req, res) => {
  try {
    const [incarichi, consulenti] = await Promise.all([
      Incarico.find({}).sort({ createdAt: -1 }).limit(500),
      Consulente.find({}).select('nomeCognome telefono fotoProfilo utente ruolo')
    ]);

    // Mappa username -> dati pubblici del consulente
    const mappaCons = {};
    consulenti.forEach(c => {
      mappaCons[(c.utente || '').toLowerCase().trim()] = {
        nome: c.nomeCognome || '',
        ruolo: c.ruolo || '',
        foto: c.fotoProfilo || '',
        telefono: c.telefono || '',
        telefonoRaw: String(c.telefono || '').replace(/[^0-9+]/g, '')
      };
    });

    const vetrina = [];
    incarichi.forEach(inc => {
      const stato = String(inc.statoImmobile || '').trim();
      const flag = String(inc.pubblicaSito || '').trim().toLowerCase();

      if (flag === 'mai') return; // escluso a mano

      const eDisponibile = STATI_VETRINA_DISPONIBILE.includes(stato);
      const eVenduto = STATI_VETRINA_VENDUTO.includes(stato);
      const autoMostra = eDisponibile || eVenduto;

      // In automatico mostro solo gli stati previsti; 'sempre' forza comunque online.
      if (flag !== 'sempre' && !autoMostra) return;

      // Se forzo online uno stato "non venduto" (es. Acquisito), lo tratto come disponibile.
      const isVenduto = eVenduto;

      const cons = mappaCons[(inc.consulente || '').toLowerCase().trim()] || null;

      vetrina.push({
        rif: inc.idElemento || String(inc._id),
        titolo: inc.nome || '',
        contratto: _contrattoPubblico(inc.tipologiaContratto),
        isVenduto: isVenduto,
        comune: inc.comune || '',
        via: inc.via || '',
        civico: inc.civico || '',
        contesto: inc.contesto || '',
        tipologia: inc.tipologiaUnita || '',
        prezzo: _numeroPrezzo(inc.prezzoIncarico),
        locali: parseInt(inc.locali) || 0,
        mq: parseInt(inc.mq) || 0,
        bagni: parseInt(inc.bagni) || 0,
        piano: inc.piano || 'N.D.',
        ascensore: inc.ascensore || 'NO',
        ape: inc.classeApe || 'N.D.',
        speseCondominiali: inc.speseCondominiali || '',
        prossimoOh: inc.nextOpenHouse || '',
        linkVideo: (inc.linkVideo || '').trim(),
        linkVirtual: (inc.linkVirtualTour || '').trim(),
        linkDoc: (inc.linkDocumenti || '').trim(),
        descrizione: inc.testoAnnuncio || '',
        foto: _fotoArrayIncarico(inc),
        consulente: cons
      });
    });

    res.status(200).json(vetrina);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================
   TEAM PUBBLICO (sezione consulenti della home del sito).
   Restituisce solo i consulenti da mostrare online e solo i loro dati pubblici.
   Cosi' la home si aggiorna da sola quando aggiungi/togli un consulente o cambi
   foto/testi nel gestionale. Nessun dato interno (password, provvigioni,
   permessi, id telegram...) esce da qui.
========================================== */
app.get('/api/pubblico/consulenti', async (req, res) => {
  try {
    const righe = await Consulente.find({ pubblicaInHome: { $ne: false } });
    const team = righe.map(c => ({
      utente: c.utente || '',
      nome: c.nomeCognome || '',
      ruolo: (c.ruoloPubblico || '').trim() || (c.ruolo || ''),
      foto: c.fotoProfilo || '',
      bio: c.bioPubblica || '',
      video: (c.videoPubblico || '').trim(),
      telefono: (c.telefonoPubblico || '').trim() || (c.telefono || ''),
      telefonoRaw: ((c.telefonoPubblico || '').trim() || (c.telefono || '')).replace(/[^0-9+]/g, ''),
      ordine: (typeof c.ordinePubblico === 'number') ? c.ordinePubblico : 999
    }));
    // Ordino per "ordinePubblico" (piu' basso prima), poi per nome.
    team.sort((a, b) => (a.ordine - b.ordine) || a.nome.localeCompare(b.nome));
    res.status(200).json(team);
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
   CALENDARIO COMPLETO PER L'APP (PWA offline)
   Un unico feed normalizzato di TUTTI gli eventi del consulente, uguale a
   quello che il CRM mostra nel calendario (raccogliEventiCalendario), piu'
   la sua agenda tipo settimanale. L'app lo scarica e lo tiene in cache per
   funzionare anche senza rete.
========================================== */
app.get('/api/pubblico/calendario/:utente', async (req, res) => {
  try {
    const utente = String(req.params.utente || '').trim();

    // Risolve un valore "consulente" (username o Nome Cognome) allo username.
    const consulenti = await Consulente.find({}, { utente: 1, nomeCognome: 1, agendaTipo: 1 });
    const perNome = {};
    consulenti.forEach(c => { if (c.nomeCognome) perNome[c.nomeCognome] = c.utente; });
    const chiDe = (r) => {
      const g = (r && (r.consulente || r.inseritoDa || r.persone)) || '';
      if (!g) return '';
      if (consulenti.some(c => c.utente === g)) return g;
      return perNome[g] || '';
    };
    const suo = (r) => !utente || chiDe(r) === utente;

    const iso = (d) => {
      const s = String(d || '').trim();
      if (!s) return '';
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      const p = s.split('/');
      return p.length === 3 ? `${p[2]}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}` : '';
    };

    const eventi = [];
    const push = (o) => { if (o.data) eventi.push(o); };

    const [appuntamenti, visioni, cdvs, opportunity, proposte, incarichi, todo, openHouse] = await Promise.all([
      Appuntamento.find({}).limit(1500),
      Visioni.find({}).limit(1500),
      Cdv.find({}).limit(1500),
      Opportunity.find({}).limit(1500),
      Proposta.find({}).limit(1500),
      Incarico.find({}).limit(1500),
      Todo.find({}).limit(2000),
      OpenHouse.find({}).limit(600)
    ]);

    appuntamenti.filter(suo).forEach(a => push({
      tipo: 'appuntamento', data: iso(a.data), orario: a.ora || '',
      titolo: a.titolo || 'Appuntamento',
      dettaglio: [a.luogo, a.conChi].filter(Boolean).join(' · '),
      luogo: a.luogo || '', conChi: a.conChi || '', note: a.note || '', durata: a.durata || 60,
      promemoria: (a.promemoria != null ? a.promemoria : 0),
      registro: 'appuntamenti', id: String(a._id), campo: 'data', modificabile: true
    }));

    visioni.filter(suo).forEach(v => push({
      tipo: 'visione', data: iso(v.dataVisione || v.createdAt), orario: v.oraVisione || '',
      titolo: ('Visione ' + (v.nomeCognome || '')).trim(),
      dettaglio: v.incaricoUfficio ? ('Immobile ' + v.incaricoUfficio) : (v.feedbackAdv || ''),
      registro: 'visioni', id: String(v._id), campo: 'dataVisione', modificabile: false
    }));

    cdvs.filter(suo).forEach(c => {
      const nome = c.nomeProprietario || c.nome || '';
      if (c.dataCdv1) push({ tipo: 'cdv', data: iso(c.dataCdv1), orario: c.orarioCdv1 || '',
        titolo: ('Cdv 1 ' + nome).trim(), dettaglio: c.indirizzo || c.comune || '',
        registro: 'cdv', id: String(c._id), campo: 'dataCdv1', modificabile: false });
      if (c.dataCdv2) push({ tipo: 'cdv', data: iso(c.dataCdv2), orario: c.orarioCdv2 || '',
        titolo: ('Cdv 2 ' + nome).trim(), dettaglio: c.indirizzo || c.comune || '',
        registro: 'cdv', id: String(c._id), campo: 'dataCdv2', modificabile: false });
      if (c.dataProssimaAttivita) push({ tipo: 'opportunity', data: iso(c.dataProssimaAttivita), orario: '',
        titolo: ('Attività su ' + (nome || 'Cdv')).trim(), dettaglio: c.comune || '',
        registro: 'cdv', id: String(c._id), campo: 'dataProssimaAttivita', modificabile: false });
    });

    opportunity.filter(suo).forEach(o => {
      if (!o.dataProssimaAttivita) return;
      push({ tipo: 'opportunity', data: iso(o.dataProssimaAttivita), orario: '',
        titolo: ('Opportunity ' + (o.nomeProprietario || o.nome || '')).trim(),
        dettaglio: o.comune || o.indirizzo || '',
        registro: 'opportunity', id: String(o._id), campo: 'dataProssimaAttivita', modificabile: false });
    });

    proposte.filter(suo).forEach(p => {
      const nome = p.nomeCognome || 'proposta';
      const st = p.statoProposta || '';
      if (st === 'Accettata (Vincolata)' && p.vincoloDataFine)
        push({ tipo: 'vincolo', data: iso(p.vincoloDataFine), orario: '',
          titolo: 'Scade il vincolo di ' + nome, dettaglio: p.vincoloSpecifica || '',
          registro: 'proposte', id: String(p._id), campo: 'vincoloDataFine', modificabile: false });
      if (st === 'Accettata (No Vincolo)') {
        if (p.dataPreliminare) push({ tipo: 'preliminare', data: iso(p.dataPreliminare), orario: '',
          titolo: 'Preliminare ' + nome, dettaglio: '',
          registro: 'proposte', id: String(p._id), campo: 'dataPreliminare', modificabile: false });
        if (p.dataRogito) push({ tipo: 'rogito', data: iso(p.dataRogito), orario: '',
          titolo: 'Rogito ' + nome, dettaglio: p.nomeNotaio ? ('Notaio ' + p.nomeNotaio) : '',
          registro: 'proposte', id: String(p._id), campo: 'dataRogito', modificabile: false });
        if (p.provvAcquirenteScadenza && p.provvAcquirenteStato !== 'Incassata')
          push({ tipo: 'provvigione', data: iso(p.provvAcquirenteScadenza), orario: '',
            titolo: 'Provvigione acquirente ' + nome, dettaglio: '',
            registro: 'proposte', id: String(p._id), campo: 'provvAcquirenteScadenza', modificabile: false });
        if (p.provvVenditoreScadenza && p.provvVenditoreStato !== 'Incassata')
          push({ tipo: 'provvigione', data: iso(p.provvVenditoreScadenza), orario: '',
            titolo: 'Provvigione venditore ' + nome, dettaglio: '',
            registro: 'proposte', id: String(p._id), campo: 'provvVenditoreScadenza', modificabile: false });
      }
    });

    incarichi.filter(suo).forEach(i => {
      if (!i.dataScadenza || i.statoImmobile === 'Rogitato' || i.statoImmobile === 'Archiviato') return;
      push({ tipo: 'incarico', data: iso(i.dataScadenza), orario: '',
        titolo: "Scade l'incarico " + (i.nome || i.idElemento || ''), dettaglio: i.posizione || '',
        registro: 'incarichi', id: String(i._id), campo: 'dataScadenza', modificabile: false });
    });

    // Attività di acquisizione = da sollecito concorrenza ('sviluppo:') o da scatto di acquisizione
    const scattiAcq = ['opportunita', 'cdv-fisso', 'cdv-eseguo'];
    const eDiAcquisizione = (t) => {
      const o = String(t.origine || '');
      if (o.indexOf('sviluppo:') === 0) return true;
      // modello:<id>:<scatto>  →  l'ultimo pezzo è lo scatto
      if (o.indexOf('modello:') === 0) { const parti = o.split(':'); return scattiAcq.indexOf(parti[parti.length - 1]) !== -1; }
      return false;
    };
    todo.filter(suo).forEach(t => {
      if (t.stato === 'Completato') return;
      const data = iso(t.scadenza) || iso(t.data);
      push({ tipo: eDiAcquisizione(t) ? 'acquisizione' : 'attivita', data: data, orario: '',
        titolo: t.task || 'Attività', dettaglio: t.priorita || '', note: t.note || '',
        registro: 'todo', id: String(t._id), campo: 'scadenza', modificabile: false, completabile: true });
    });

    openHouse.filter(o => suo(o) && o.stato !== 'Annullato').forEach(o => push({
      tipo: 'openhouse', data: iso(o.data), orario: String(o.orario || '').split('-')[0].trim(),
      titolo: 'Open House ' + (o.immobile || ''),
      dettaglio: (o.stato || '') + (o.visitatori ? ' · ' + o.visitatori + ' visitatori' : ''),
      registro: 'open-house', id: String(o._id), campo: 'data', modificabile: false
    }));

    eventi.sort((x, y) => (x.data + '|' + (x.orario || '')).localeCompare(y.data + '|' + (y.orario || '')));

    const schedaMia = consulenti.find(c => c.utente === utente);
    const agendaTipo = (schedaMia && Array.isArray(schedaMia.agendaTipo)) ? schedaMia.agendaTipo : [];

    res.set('Cache-Control', 'no-store');
    res.status(200).json({ utente, eventi, agendaTipo, generatoIl: new Date().toISOString() });
  } catch (err) {
    console.error('Calendario app non letto:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ==========================================
   KPI PER L'APP (PWA "KPI Forte")
   Riepilogo dei numeri del consulente — generali (Oby, funnel, provvigioni) e
   acquisizione (per canale) — calcolati come nel CRM (calcolaObiettiviOby,
   acquisizioniPerCanale). L'app lo scarica e lo tiene in cache offline.
   Nota: la parte "visure/proprietari fatte" del piano usa lo statoSviluppo
   salvato (senza l'auto-derivazione da stradario): può differire di poco.
========================================== */
const KPI_OBY_STANDARD = {
  provvigioneMediaVendita: 9000, transazioniPerImmobile: 2, chiusuraProposte: 80,
  visioniPerProposta: 20, venditaSuAcquisito: 70, cdv2SuIncarico: 40, cdv1SuCdv2: 70, opportunityPerCdv: 30
};
const CANALI_ACQUISIZIONE_SRV = [
  { chiave: 'concorrenza', etichetta: 'Concorrenza', quota: 10, colore: '#4a90c2', spiega: 'annunci di altre agenzie diventati opportunity' },
  { chiave: 'vdp',         etichetta: 'Vdp',         quota: 20, colore: '#5bbf8a', spiega: 'vendite da privato con recapito' },
  { chiave: 'vdpNoNum',    etichetta: 'Vdp no numero', quota: 20, colore: '#5bbf8a', spiega: 'vendite da privato senza recapito, da rintracciare' },
  { chiave: 'necrologio',  etichetta: 'Necrologi',   quota: 20, colore: '#a884c9', spiega: 'successioni e immobili da erede' },
  { chiave: 'zona',        etichetta: 'Zona',        quota: 20, colore: '#c9a86a', spiega: 'ricerca sul territorio, notizia fresca, volantino, lettere' },
  { chiave: 'leadUfficio', etichetta: 'Lead ufficio', quota: 10, colore: '#d4b36a', spiega: 'contatti da ufficio, social e segnalatori' }
];
const ATTIVITA_CANALE_SRV = {
  concorrenza: [
    { chiave: 'inserimento', nome: 'Inserimento annunci', tipo: 'resa', valore: 30, nota: 'annunci di agenzia caricati in Concorrenza' },
    { chiave: 'visure', nome: 'Incrocio visure', tipo: 'suLead', valore: 100, nota: 'sui lead individuati' },
    { chiave: 'proprietari', nome: 'Trovare il proprietario', tipo: 'suLead', valore: 100, nota: 'nome e recapito di chi possiede' },
    { chiave: 'lettere', nome: 'Lettere', tipo: 'perOpportunity', valore: 30, nota: 'invii postali mirati' },
    { chiave: 'citofoni', nome: 'Citofoni', tipo: 'perOpportunity', valore: 20, nota: 'passaggi sul posto e citofonate' }
  ],
  vdpNoNum: [
    { chiave: 'inserimento', nome: 'Inserimento annunci', tipo: 'resa', valore: 30, nota: 'privati senza recapito' },
    { chiave: 'visure', nome: 'Incrocio visure', tipo: 'suLead', valore: 100, nota: 'sui lead individuati' },
    { chiave: 'proprietari', nome: 'Trovare il proprietario', tipo: 'suLead', valore: 100, nota: 'nome e recapito' },
    { chiave: 'lettere', nome: 'Lettere', tipo: 'perOpportunity', valore: 30, nota: 'invii postali mirati' },
    { chiave: 'citofoni', nome: 'Citofoni', tipo: 'perOpportunity', valore: 20, nota: 'passaggi sul posto' }
  ],
  vdp: [
    { chiave: 'inserimento', nome: 'Vdp inseriti', tipo: 'resa', valore: 20, nota: 'privati con recapito caricati in Concorrenza' },
    { chiave: 'whatsapp', nome: 'Messaggi WhatsApp', tipo: 'perLead', valore: 10, nota: 'circa 10 WhatsApp per ogni Vdp' },
    { chiave: 'call', nome: 'Telefonate', tipo: 'perLead', valore: 10, nota: 'circa 10 chiamate per ogni Vdp' },
    { chiave: 'lettere', nome: 'Lettere / Volantino', tipo: 'perLead', valore: 10, nota: 'circa 10 invii per ogni Vdp' }
  ],
  necrologio: [
    { chiave: 'inserimento', nome: 'Necrologi controllati', tipo: 'resa', valore: 15, nota: 'segnalazioni dal controllo settimanale' },
    { chiave: 'eredi', nome: 'Trovare eredi / Visure', tipo: 'suLead', valore: 100, nota: 'visure per risalire agli eredi' },
    { chiave: 'lettere', nome: 'Lettere', tipo: 'perLead', valore: 5, nota: 'almeno 5 lettere per Vdp' },
    { chiave: 'citofoni', nome: 'Citofoni', tipo: 'perLead', valore: 5, nota: 'almeno 5 citofonate' }
  ],
  zona: [
    { chiave: 'censimento', nome: 'Citofoni censiti', tipo: 'fisso', valore: 5000, nota: 'censimento del territorio' },
    { chiave: 'visure', nome: 'Visure incrociate', tipo: 'fisso', valore: 5000, nota: 'incrocio visure sulle unità censite' },
    { chiave: 'citofoni', nome: 'Citofonate (passaggi)', tipo: 'fisso', valore: 7000, nota: 'citofonate sul posto' },
    { chiave: 'call', nome: 'Telefonate', tipo: 'fisso', valore: 3000, nota: 'chiamate sul territorio' },
    { chiave: 'lettere', nome: 'Lettere', tipo: 'fisso', valore: 12000, nota: 'invii postali sulla zona' },
    { chiave: 'volantini', nome: 'Volantini', tipo: 'fisso', valore: 12000, nota: 'volantini distribuiti in zona' }
  ],
  leadUfficio: [
    { chiave: 'inserimento', nome: 'Lead ricevuti', tipo: 'resa', valore: 25, nota: 'contatti da ufficio, social e segnalatori' },
    { chiave: 'call', nome: 'Telefonate', tipo: 'perLead', valore: 6, nota: '6 chiamate per ogni lead' },
    { chiave: 'whatsapp', nome: 'Messaggi WhatsApp', tipo: 'perLead', valore: 6, nota: '6 messaggi per ogni lead' },
    { chiave: 'lettere', nome: 'Lettere', tipo: 'perLead', valore: 6, nota: '6 lettere per ogni lead' }
  ]
};
const CADENZA_CANALE_SRV = {
  vdp: 'Ritmo: un’attività ogni 3 giorni per ogni Vdp, alternando WhatsApp → Volantino → Telefonata.',
  necrologio: 'Controllo necrologi 1 volta a settimana. Per ogni segnalazione: 5 lettere e 5 citofonate, oltre alle visure.'
};

app.get('/api/pubblico/kpi-app/:utente', async (req, res) => {
  try {
    const utente = String(req.params.utente || '').trim();

    const consulenti = await Consulente.find({}, { utente: 1, nomeCognome: 1, ruolo: 1 });
    const perNome = {};
    consulenti.forEach(c => { if (c.nomeCognome) perNome[c.nomeCognome] = c.utente; });
    const chiDe = (r) => {
      const g = (r && (r.consulente || r.inseritoDa || r.persone)) || '';
      if (!g) return '';
      if (consulenti.some(c => c.utente === g)) return g;
      return perNome[g] || '';
    };

    const oby = (await ObyBudget.findOne({ consulente: utente })) || {};
    const inizio = oby.dataInizioMonitoraggio || '', fine = oby.dataFineMonitoraggio || '';
    const annoCorr = String(new Date().getFullYear());

    // aaaa-mm-gg da ISO o gg/mm/aaaa
    const iso = (d) => {
      const s = String(d || '').trim(); if (!s) return '';
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      const p = s.split(/[\/\-]/); return (p.length === 3 && p[2].length === 4) ? `${p[2]}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}` : '';
    };
    const annoDi = (d) => { const i = iso(d); return i ? i.slice(0, 4) : ''; };
    const nelPeriodo = (raw) => {
      const d = iso(raw);
      if (!d) return !inizio && !fine;
      if (inizio || fine) { if (inizio && d < inizio) return false; if (fine && d > fine) return false; return true; }
      return annoDi(raw) === annoCorr;
    };
    const num = (v) => {
      if (v === null || v === undefined) return 0;
      const s = String(v).replace(/[€\s%]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
      return parseFloat(s) || 0;
    };
    const giorniTra = (a, b) => { const d1 = new Date(String(a).slice(0, 10)), d2 = new Date(String(b).slice(0, 10)); if (isNaN(d1) || isNaN(d2)) return null; return Math.round((d2 - d1) / 86400000); };
    const preliminareServe = (p) => { if (!p) return false; if (p.dataPreliminare) return true; const gg = giorniTra(p.dataPresaProposta, p.dataRogito); return gg !== null && gg > 30; };
    const statoAvanz = (p) => (p && p.statoAttuale) ? p.statoAttuale : (preliminareServe(p) ? 'Preliminare da fare' : 'Rogito da fissare');
    const statoProp = (p) => { const s = (p && p.statoProposta) || 'In Corso'; if (s === 'Accettata') return (p.vincolo === 'si') ? 'Accettata (Vincolata)' : 'Accettata (No Vincolo)'; return s; };
    const provvVend = (inc, prezzo) => { if (!inc) return 0; const g = String(inc.provvigioneVenditore || '').trim(); if (!g) return 0; const n = num(g); return g.indexOf('%') !== -1 ? Math.round((prezzo || 0) * n / 100) : n; };

    const [proposteAll, incarichiAll, cdvAll, visioniAll, opportunityAll, concorrenzaAll] = await Promise.all([
      Proposta.find({}).limit(4000), Incarico.find({}).limit(4000), Cdv.find({}).limit(4000),
      Visioni.find({}).limit(4000), Opportunity.find({}).limit(4000), Concorrenza.find({}).limit(20000)
    ]);
    const righe = (coll, campo) => coll.filter(r => chiDe(r) === utente && nelPeriodo(r[campo] || r.createdAt));

    const proposte = righe(proposteAll, 'dataPresaProposta');
    const incarichi = righe(incarichiAll, 'dataIncarico');
    const cdv = righe(cdvAll, 'createdAt');
    const visioni = righe(visioniAll, 'createdAt');
    const opportunity = righe(opportunityAll, 'createdAt');
    const vendute = proposte.filter(p => statoAvanz(p) === 'Rogito fatto');
    const accettateLibere = proposte.filter(p => statoProp(p) === 'Accettata (No Vincolo)');

    const provvigioniMaturate = vendute.reduce((s, p) => {
      const inc = incarichiAll.find(i => i.idElemento === p.incaricoUfficio);
      return s + num(p.provvigioneAcquirente) + provvVend(inc, num(p.prezzoProposta));
    }, 0);

    const K = Object.assign({}, KPI_OBY_STANDARD, oby.kpi || {});
    const provv = oby.percentualeProvvigione || 40;
    const netto = oby.guadagnoNettoDesiderato || 30000;
    const lordo = Math.round((netto / provv) * 100);
    const k = {
      pmv: K.provvigioneMediaVendita, tpi: K.transazioniPerImmobile, chp: K.chiusuraProposte / 100,
      vpp: K.visioniPerProposta, vsa: K.venditaSuAcquisito / 100, c2i: K.cdv2SuIncarico / 100,
      c1c2: K.cdv1SuCdv2 / 100, opc: K.opportunityPerCdv
    };
    const immobili = Math.ceil(lordo / k.pmv), transazioni = immobili * k.tpi, propObj = Math.ceil(immobili / k.chp);
    const visObj = propObj * k.vpp, incObj = Math.ceil(immobili / k.vsa), cdv2Obj = Math.ceil(incObj / k.c2i);
    const cdv1Obj = Math.ceil(cdv2Obj / k.c1c2), oppObj = cdv1Obj * k.opc;
    const R = (n) => Math.round(n);
    const funnel = [
      { titolo: 'Opportunity', obiettivo: R(oppObj), attuale: opportunity.length, unita: 'opportunity', nota: k.opc + ' opportunity per una Cdv' },
      { titolo: 'Cdv 1', obiettivo: R(cdv1Obj), attuale: cdv.filter(c => c.cdv1 === 'Sì').length, unita: 'Cdv 1', nota: 'il ' + Math.round(k.c1c2 * 100) + '% diventa Cdv 2' },
      { titolo: 'Cdv 2', obiettivo: R(cdv2Obj), attuale: cdv.filter(c => c.cdv2 === 'Sì').length, unita: 'Cdv 2', nota: 'il ' + Math.round(k.c2i * 100) + '% diventa incarico' },
      { titolo: 'Incarichi da prendere', obiettivo: R(incObj), attuale: incarichi.length, unita: 'incarichi', nota: 'si vende il ' + Math.round(k.vsa * 100) + '% degli acquisiti' },
      { titolo: 'Adv da fare (visioni)', obiettivo: R(visObj), attuale: visioni.length, unita: 'visioni', nota: k.vpp + ' appuntamenti per una proposta' },
      { titolo: 'Proposte da ritirare', obiettivo: R(propObj), attuale: proposte.length, unita: 'proposte', nota: 'si chiude l’' + Math.round(k.chp * 100) + '% delle proposte' },
      { titolo: 'N° Transazioni', obiettivo: R(transazioni), attuale: incarichi.length + accettateLibere.length, unita: 'transazioni', nota: k.tpi + ' per immobile' },
      { titolo: 'Immobili da vendere', obiettivo: R(immobili), attuale: vendute.length, unita: 'rogiti', nota: 'una vendita ogni € ' + Math.round(k.pmv).toLocaleString('it-IT') }
    ];

    // ---- ACQUISIZIONE ----
    const tipoAnnuncio = (r) => {
      const m = String((r && r.privato) || '').toUpperCase().replace(/[^A-Z ]/g, ' ');
      const ag = String((r && r.agenzia) || '').toUpperCase();
      if (m.indexOf('NO NUMERO') !== -1 || m.indexOf('SENZA NUMERO') !== -1) return 'vdp-no-numero';
      if (m.indexOf('VDP') !== -1 || m.indexOf('PRIVAT') !== -1) return 'vdp';
      if (!m && ag.indexOf('PRIVAT') !== -1) return 'vdp';
      return 'agenzia';
    };
    const canaleFonte = (fonte) => {
      const f = String(fonte || '').toLowerCase(); if (!f) return '';
      if (f.indexOf('concorrenza') !== -1) return 'concorrenza';
      if (f.indexOf('privatello') !== -1 || f.indexOf('vdp') !== -1) return 'vdp';
      if (f.indexOf('necrolog') !== -1) return 'necrologio';
      if (f.indexOf('zona') !== -1 || f.indexOf('fresca') !== -1 || f.indexOf('volantino') !== -1 || f.indexOf('lettere') !== -1) return 'zona';
      if (f.indexOf('ufficio') !== -1 || f.indexOf('lead') !== -1 || f.indexOf('social') !== -1 || f.indexOf('segnalatori') !== -1) return 'leadUfficio';
      return '';
    };
    const concMie = concorrenzaAll.filter(r => chiDe(r) === utente && nelPeriodo(r.createdAt));
    const reali = {}; CANALI_ACQUISIZIONE_SRV.forEach(c => reali[c.chiave] = 0);
    opportunity.forEach(o => { const ch = canaleFonte(o.fonte); if (ch && reali[ch] !== undefined) reali[ch]++; });
    concMie.forEach(r => {
      if (r.statoSviluppo !== 'Opportunity') return;
      const t = tipoAnnuncio(r);
      if (t === 'agenzia') reali.concorrenza++; else if (t === 'vdp') reali.vdp++; else if (t === 'vdp-no-numero') reali.vdpNoNum++;
    });
    const totaleAcq = CANALI_ACQUISIZIONE_SRV.reduce((s, c) => s + reali[c.chiave], 0);
    const obyOpportunity = R(oppObj);

    const fattoDi = (canale) => {
      const tipoAtteso = canale === 'concorrenza' ? 'agenzia' : canale === 'vdpNoNum' ? 'vdp-no-numero' : canale === 'vdp' ? 'vdp' : null;
      if (tipoAtteso === null) return {};
      const rr = concMie.filter(r => tipoAnnuncio(r) === tipoAtteso);
      const avanzato = rr.filter(r => r.statoSviluppo === 'Proprietario 100%' || r.statoSviluppo === 'Opportunity').length;
      return { inserimento: rr.length, visure: avanzato, proprietari: avanzato, lettere: null, citofoni: null };
    };

    const canali = CANALI_ACQUISIZIONE_SRV.map(c => {
      const obiettivo = R(obyOpportunity * c.quota / 100);
      const passi = ATTIVITA_CANALE_SRV[c.chiave] || [];
      const fatto = fattoDi(c.chiave);
      const resaPasso = passi.filter(p => p.tipo === 'resa')[0];
      const resa = resaPasso ? resaPasso.valore : 30;
      const lead = resa > 0 ? Math.ceil(obiettivo * 100 / resa) : obiettivo;
      const piano = passi.map(p => {
        let daFare;
        if (p.tipo === 'resa') daFare = lead;
        else if (p.tipo === 'suLead') daFare = Math.ceil(lead * p.valore / 100);
        else if (p.tipo === 'perLead') daFare = Math.ceil(lead * p.valore);
        else if (p.tipo === 'fisso') daFare = p.valore;
        else daFare = Math.ceil(obiettivo * p.valore);
        const sv = fatto[p.chiave];
        return { nome: p.nome, nota: p.nota, daFare: daFare, fatte: (sv === undefined ? null : sv) };
      });
      return { chiave: c.chiave, etichetta: c.etichetta, colore: c.colore, spiega: c.spiega, quota: c.quota,
        obiettivo: obiettivo, fatte: reali[c.chiave] || 0, cadenza: CADENZA_CANALE_SRV[c.chiave] || '', piano: piano };
    });

    // etichetta periodo
    const ddmmaaaa = (s) => { const i = iso(s); if (!i) return ''; const p = i.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; };
    let etichetta = 'anno ' + annoCorr;
    if (inizio && fine) etichetta = ddmmaaaa(inizio) + ' – ' + ddmmaaaa(fine);
    else if (inizio) etichetta = 'dal ' + ddmmaaaa(inizio);
    else if (fine) etichetta = 'fino al ' + ddmmaaaa(fine);

    const schedaMia = consulenti.find(c => c.utente === utente);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      utente, nomeCognome: (schedaMia && schedaMia.nomeCognome) || utente,
      periodo: { etichetta, inizio, fine },
      obySettato: !!(oby && oby.guadagnoNettoDesiderato),
      consulenti: consulenti.map(c => ({ utente: c.utente, nomeCognome: c.nomeCognome || c.utente })),
      generali: { obiettivoNetto: netto, fatturatoLordo: lordo, provvigioniMaturate: Math.round(provvigioniMaturate),
        vendite: vendute.length, proposte: proposte.length, funnel },
      acquisizione: { obiettivoOpportunity: obyOpportunity, fatteTotale: totaleAcq, canali },
      generatoIl: new Date().toISOString()
    });
  } catch (err) {
    console.error('KPI app non letti:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ==========================================================================
   NOTIFICHE PUSH (promemoria appuntamenti, stile Google Calendar)
   Implementazione Web Push (RFC 8291/8292) SENZA librerie esterne: usa solo
   il modulo 'crypto' di Node, così basta ridistribuire questo server.js.
   La derivazione delle chiavi è stata verificata contro il test vector RFC 8291.
========================================================================== */
const crypto = require('crypto');

// Chiavi VAPID dell'applicazione (generate una volta; la pubblica è nota ai client).
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || 'BP_po8X1ri7KzFBOSF1_Wsva242bzQZLX1R07SObQhV4KHAPl0pXLzrS_93Nfzw-5nYFFTRQ28XmbKKxDrDNtAk';
const VAPID_PRIVATE_PEM = process.env.VAPID_PRIVATE_PEM || [
  '-----BEGIN EC PRIVATE KEY-----',
  'MHcCAQEEIGhH+UQj9sE+qhSL/CSWoUFGaMXuVZMm6Aa9Hr2UkeIjoAoGCCqGSM49',
  'AwEHoUQDQgAE/+mjxfWuLsrMUE5IXX9ay9rbjZvNBktfVHTtI5tCFXgocA+XSlcv',
  'OtL/3c1/PD7mdgUVNFDbxeZsorEOsM20CQ==',
  '-----END EC PRIVATE KEY-----'
].join('\n');
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:aforte@immobiliareforte.it';

const PushSubscriptionSchema = new mongoose.Schema({
  utente: { type: String, default: '' },
  endpoint: { type: String, required: true, unique: true },
  p256dh: { type: String, default: '' },
  auth: { type: String, default: '' }
}, { timestamps: true });
const PushSub = mongoose.model('PushSub', PushSubscriptionSchema);

function b64urlDec(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
function b64urlEnc(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function hmacSha256(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
function hkdfExpand(prk, info, len) {
  let out = Buffer.alloc(0), t = Buffer.alloc(0), i = 1;
  while (out.length < len) { t = hmacSha256(prk, Buffer.concat([t, info, Buffer.from([i])])); out = Buffer.concat([out, t]); i++; }
  return out.slice(0, len);
}

/* Cifra il payload per una sottoscrizione (aes128gcm, RFC 8291) */
function cifraPayloadPush(sub, plaintext) {
  const uaPublic = b64urlDec(sub.p256dh);   // 65 byte
  const authSecret = b64urlDec(sub.auth);   // 16 byte
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();     // 65 byte, uncompressed
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const prkKey = hmacSha256(authSecret, sharedSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);

  const salt = crypto.randomBytes(16);
  const prk = hmacSha256(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);

  const record = Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.from([0x02])]); // delimitatore ultimo record
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096, 0);
  const idlen = Buffer.from([asPublic.length]);
  return Buffer.concat([salt, rs, idlen, asPublic, encrypted]);
}

/* Token VAPID (JWT ES256) per l'endpoint */
function tokenVapid(endpoint) {
  const u = new URL(endpoint);
  const aud = u.origin;
  const header = b64urlEnc(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64urlEnc(Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT })));
  const signingInput = header + '.' + payload;
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key: VAPID_PRIVATE_PEM, dsaEncoding: 'ieee-p1363' });
  return signingInput + '.' + b64urlEnc(sig);
}

/* Invia una notifica push a una sottoscrizione. Risolve {ok, status}. */
function inviaPush(sub, dataObj) {
  return new Promise((resolve) => {
    try {
      const body = cifraPayloadPush(sub, JSON.stringify(dataObj));
      const u = new URL(sub.endpoint);
      const opzioni = {
        method: 'POST', hostname: u.hostname, path: u.pathname + u.search,
        port: u.port || 443,
        headers: {
          'TTL': '86400',
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          'Content-Length': body.length,
          'Authorization': 'vapid t=' + tokenVapid(sub.endpoint) + ', k=' + VAPID_PUBLIC
        }
      };
      const req = https.request(opzioni, (resp) => {
        resp.on('data', () => {}); resp.on('end', () => resolve({ ok: resp.statusCode >= 200 && resp.statusCode < 300, status: resp.statusCode }));
      });
      req.on('error', (e) => { console.error('push errore:', e.message); resolve({ ok: false, status: 0 }); });
      req.write(body); req.end();
    } catch (e) { console.error('push eccezione:', e.message); resolve({ ok: false, status: -1 }); }
  });
}

/* Invia a tutte le sottoscrizioni di un utente; elimina quelle scadute (404/410) */
async function inviaPushUtente(utente, dataObj) {
  const subs = await PushSub.find({ utente });
  let inviate = 0;
  for (const s of subs) {
    const r = await inviaPush(s, dataObj);
    if (r.ok) inviate++;
    else if (r.status === 404 || r.status === 410) { try { await PushSub.deleteOne({ _id: s._id }); } catch (e) {} }
  }
  return { inviate, totali: subs.length };
}

// La chiave pubblica VAPID, per l'iscrizione lato app
app.get('/api/push/vapid', (req, res) => res.json({ publicKey: VAPID_PUBLIC }));

// Registra (o aggiorna) una sottoscrizione push
app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { utente, subscription } = req.body || {};
    if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Sottoscrizione mancante' });
    const keys = subscription.keys || {};
    await PushSub.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      { $set: { utente: utente || '', endpoint: subscription.endpoint, p256dh: keys.p256dh || '', auth: keys.auth || '' } },
      { upsert: true, new: true }
    );
    res.json({ status: 'success' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Rimuove una sottoscrizione
app.post('/api/push/unsubscribe', async (req, res) => {
  try { if (req.body && req.body.endpoint) await PushSub.deleteOne({ endpoint: req.body.endpoint }); res.json({ status: 'success' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Notifica di prova (per collaudare sul telefono)
app.post('/api/push/test/:utente', async (req, res) => {
  try {
    const r = await inviaPushUtente(req.params.utente, { title: 'Agenda Forte', body: 'Notifica di prova ✓ Funziona!', url: '/app', tag: 'test' });
    res.json({ status: 'success', ...r });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Converte data 'aaaa-mm-gg' + ora 'hh:mm' (orario di Roma) in millisecondi UTC */
function romeWallToUtcMs(dataStr, oraStr) {
  const p = String(dataStr).split('-').map(Number), t = String(oraStr).split(':').map(Number);
  if (p.length < 3 || t.length < 2) return null;
  const asUTC = Date.UTC(p[0], p[1] - 1, p[2], t[0], t[1], 0);
  const romeStr = new Date(asUTC).toLocaleString('en-US', { timeZone: 'Europe/Rome' });
  const offset = new Date(romeStr).getTime() - asUTC;   // quanto Roma è avanti su UTC
  return asUTC - offset;
}

/* Lo "sveglia-promemoria": ogni minuto controlla gli appuntamenti con promemoria
   in scadenza e manda la notifica push a chi li ha in agenda. */
async function controllaPromemoria() {
  try {
    const ora = Date.now();
    const candidati = await Appuntamento.find({ promemoria: { $gt: 0 }, promemoriaInviato: { $ne: true }, data: { $ne: '' }, ora: { $ne: '' } }).limit(500);
    for (const a of candidati) {
      const eventoMs = romeWallToUtcMs(a.data, a.ora);
      if (eventoMs === null) continue;
      const promemoriaMs = eventoMs - (a.promemoria * 60000);
      if (ora < promemoriaMs) continue;                 // troppo presto
      // segno subito come inviato per non ripetere, poi provo a mandare
      await Appuntamento.updateOne({ _id: a._id }, { $set: { promemoriaInviato: true } });
      if (ora > eventoMs + 10 * 60000) continue;        // troppo tardi (evento già passato da un po'): solo marca
      const utente = a.consulente || a.creatoDa || '';
      if (!utente) continue;
      const quando = a.ora ? ('alle ' + a.ora) : '';
      inviaPushUtente(utente, {
        title: a.titolo || 'Appuntamento',
        body: [a.promemoria >= 60 ? 'Tra 1 ora' : ('Tra ' + a.promemoria + ' min'), quando, a.luogo].filter(Boolean).join(' · '),
        url: '/app', tag: 'appuntamento-' + a._id
      });
    }
  } catch (e) { console.error('controllaPromemoria:', e.message); }
}
setInterval(controllaPromemoria, 60 * 1000);

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
  colonneNascosteConsulenti: { type: [String], default: [] },
  ordineColonne: { type: [String], default: [] }   // ordine delle colonne (chiavi), impostato dal Broker
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
    // aggiorno SOLO i campi presenti nel body, così salvare l'ordine non azzera le nascoste (e viceversa)
    const set = {};
    if (req.body.colonneNascosteConsulenti !== undefined) set.colonneNascosteConsulenti = req.body.colonneNascosteConsulenti || [];
    if (req.body.ordineColonne !== undefined) set.ordineColonne = req.body.ordineColonne || [];
    const aggiornato = await ImpostazioneColonne.findOneAndUpdate(
      { tabellaTipo: req.params.tabellaTipo },
      { $set: set },
      { new: true, upsert: true }
    );
    res.status(200).json({ status: 'success', data: aggiornato });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server CRM completo e attivo sulla porta ${PORT}`));
