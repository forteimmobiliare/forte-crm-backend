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
      civici: [
        {
          numero: { type: String, required: true },
          note: { type: String, default: '' },
          contestoCivico: { type: String, default: 'Palazzina' },
          foglio: { type: String, default: '' },
          particella: { type: String, default: '' },
          citofoni: [
            {
              nome: { type: String, default: '' },
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
                  annoNascita: { type: String, default: '' }
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
  mexClienteInviato: { type: String, default: '' }
}, { timestamps: true });
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
  acquirenti: { type: [{ nome: String, codiceFiscale: String, allegatoDocumento: String }], default: [] },
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
  acquirenti: { type: [{ nome: String, codiceFiscale: String }], default: [] },
  venditori: { type: [{ nome: String, codiceFiscale: String }], default: [] },
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

    // Per ogni nome di agenzia presente nel file, cerca l'Agenzia Immobiliare già censita (per nome,
    // senza distinguere maiuscole/minuscole); se non esiste ancora, la crea al volo.
    const agenzieEsistenti = await AgenziaImmobiliare.find({});
    const mappaNomeAgenziaId = new Map(agenzieEsistenti.map(a => [a.nomeAgenzia.trim().toLowerCase(), a._id.toString()]));

    const nomiAgenziaNelFile = [...new Set(
      righeRicevute.map(r => (r.agenzia || '').trim()).filter(nome => nome && nome.toLowerCase() !== 'n.d.' && nome.toLowerCase() !== 'concorrente')
    )];
    for (const nomeAgenzia of nomiAgenziaNelFile) {
      if (!mappaNomeAgenziaId.has(nomeAgenzia.toLowerCase())) {
        const nuovaAgenzia = await new AgenziaImmobiliare({ nomeAgenzia }).save();
        mappaNomeAgenziaId.set(nomeAgenzia.toLowerCase(), nuovaAgenzia._id.toString());
      }
    }

    const linkGiaPresenti = new Set(
      (await Concorrenza.find({}, 'link')).map(r => (r.link || '').trim().toLowerCase()).filter(l => l)
    );

    const daInserire = [];
    let saltatiPerDoppione = 0;
    const linkVistiInQuestoImport = new Set();

    righeRicevute.forEach(riga => {
      const linkNormalizzato = (riga.link || '').trim().toLowerCase();
      const eGiaPresente = linkNormalizzato && (linkGiaPresenti.has(linkNormalizzato) || linkVistiInQuestoImport.has(linkNormalizzato));
      if (eGiaPresente) {
        saltatiPerDoppione++;
      } else {
        if (linkNormalizzato) linkVistiInQuestoImport.add(linkNormalizzato);
        const nomeAgenziaRiga = (riga.agenzia || '').trim().toLowerCase();
        riga.agenziaId = mappaNomeAgenziaId.get(nomeAgenziaRiga) || '';
        daInserire.push(riga);
      }
    });

    const inseriti = daInserire.length > 0 ? await Concorrenza.insertMany(daInserire) : [];
    res.status(201).json({ status: 'success', count: inseriti.length, saltatiPerDoppione, agenzieNuoveCreate: nomiAgenziaNelFile.filter(n => !agenzieEsistenti.some(a => a.nomeAgenzia.trim().toLowerCase() === n.toLowerCase())).length });
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
    res.status(200).json({ status: 'success', data: aggiornato });
  } catch (err) { res.status(400).json({ error: err.message }); }
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

app.post('/api/analizza-citofono', async (req, res) => {
  try {
    const { immagineBase64, tipoMime, messaggio } = req.body;
    if (!immagineBase64) return res.status(400).json({ error: 'Immagine mancante' });

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
    const { nome, cf, tel, mail, inseritoDa, casaCensita } = req.body;

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
        await proprietarioEsistente.save();
        return res.status(200).json({ status: 'success', message: 'Anagrafica aggiornata.', data: proprietarioEsistente });
      } else {
        // Nuovo proprietario assoluto, creiamo il record con la prima casa dentro l'array
        const nuovoRecord = new CapitaleSociale({
          nome, cf, tel, mail, inseritoDa,
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
    const campiConsentiti = ['dataNascita', 'tel', 'mail', 'social', 'cf', 'residenzaId'];
    const aggiornamento = {};
    for (const campo of campiConsentiti) {
      if (req.body[campo] !== undefined) aggiornamento[campo] = req.body[campo];
    }
    const aggiornato = await CapitaleSociale.findByIdAndUpdate(req.params.id, { $set: aggiornamento }, { new: true });
    if (!aggiornato) return res.status(404).json({ error: 'Proprietario non trovato' });
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
