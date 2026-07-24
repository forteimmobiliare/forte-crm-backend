const express = require('express');
const https = require('https');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

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
  .then(() => console.log('Database MongoDB Cloud Connesso con Successo!'))
  .catch((err) => console.error('Errore critico di connessione DB:', err));

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
  ruolo: { type: String, default: 'LISTING AGENT' },
  areeVisibili: { type: [String], default: [] },
  consulentiVisibili: { type: [String], default: [] }
}, { timestamps: true });
const Consulente = mongoose.model('Consulente', ConsulenteSchema);

const TodoSchema = new mongoose.Schema({
  data: { type: String, required: true, default: '20/07/2026' },
  task: { type: String, required: true },
  consulente: { type: String, default: '' },
  stato: { type: String, default: 'Attivo' },
  note: { type: String, default: '' }
}, { timestamps: true });
const Todo = mongoose.model('Todo', TodoSchema);

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
  notizieNecessarie: { type: Number, default: 0 }
}, { timestamps: true });
const ObyBudget = mongoose.model('ObyBudget', ObyBudgetSchema);

/* ==========================================
   3. MODELLO STRADARIO LIVE CLOUD E COPERTURA
========================================== */
const StradarioSchema = new mongoose.Schema({
  comune: { type: String, required: true, unique: true },
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
  titolo: { type: String, required: true },
  paeseVia: { type: String, required: true },
  civico: { type: String, default: 'N.D.' },
  contesto: { type: String, default: 'Residenziale' },
  unita: { type: String, default: 'Appartamento' },
  piano: { type: String, default: 'Intermedio' },
  bagni: { type: String, default: '1' },
  prezzo: { type: String, required: true },
  agenzia: { type: String, default: 'Concorrente' },
  dataAnnuncio: { type: String, default: '20/07/2026' },
  link: { type: String, default: '' },
  statoAnnuncio: { type: String, default: 'Attivo' } // 'Attivo' | 'Venduto o Ritirato' (modificabile a mano dalla tabella)
}, { timestamps: true });
const Concorrenza = mongoose.model('Concorrenza', ConcorrenzaSchema);

/* ==========================================
   4b. MODELLO CENTRALINO (REGISTRO CHIAMATE) MANUALE ED EXCEL
========================================== */
const CentralinoSchema = new mongoose.Schema({
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
  nomeCognome: { type: String, required: true },
  telefono: { type: String, default: '' },
  mail: { type: String, default: '' },
  incaricoUfficio: { type: String, default: '' }, // idElemento dell'incarico collegato
  feedbackAdv: { type: String, default: '' }, // Interessa | Valuta | Non Interessa
  testoFeedback: { type: String, default: '' },
  valorePercepito: { type: String, default: '' },
  bancaDatiOrigineId: { type: String, default: '' } // evita duplicati quando l'item torna "Fissato"
}, { timestamps: true });
const Visioni = mongoose.model('Visioni', VisioniSchema);

/* ==========================================
   4c. MODELLO INCARICHI GESTIONE MANUALE ED EXCEL
========================================== */
const IncaricoSchema = new mongoose.Schema({
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
  reportPassword: { type: String, default: '' }
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

app.delete('/api/todo/:id', async (req, res) => {
  try {
    const eliminato = await Todo.findByIdAndDelete(req.params.id);
    if (!eliminato) return res.status(404).json({ error: 'Task non trovato' });
    res.status(200).json({ status: 'success', message: 'Task eliminato con successo' });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    const inseriti = await Concorrenza.insertMany(req.body);
    res.status(201).json({ status: 'success', count: inseriti.length });
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

    res.status(200).json({
      indirizzo: incarico.posizione || incarico.nome || '',
      richieste: { totale: richieste.length, perStato: contaPerCampo(richieste, 'statoAdvFix') },
      visioni: { totale: visioni.length, perFeedback: contaPerCampo(visioni, 'feedbackAdv') }
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
    const { campo, valore } = req.body;
    const aggiornato = await Incarico.findByIdAndUpdate(req.params.id, { $set: { [campo]: valore } }, { new: true });
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
