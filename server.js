const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' })); // Supporto per caricamenti Excel massivi

const mongoURI = process.env.MONGO_URI;
if (!mongoURI) {
  console.error('ERRORE CRITICO: La variabile MONGO_URI non è configurata su Render!');
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
  utente: { type: String, unique: true, required: true, trim: true },
  pass: { type: String, default: '' },
  ruolo: { type: String, default: 'LISTING AGENT' }
}, { timestamps: true });
const Consulente = mongoose.model('Consulente', ConsulenteSchema);

const TodoSchema = new mongoose.Schema({
  data: { type: String, required: true, default: '19/07/2026' },
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
          citofoni: [
            {
              nome: { type: String, default: '' },
              stato: { type: String, default: 'Proprietario' },
              consulenteIncaricato: { type: String, default: '' },
              info: { type: String, default: '' }
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
  dataAnnuncio: { type: String, default: '19/07/2026' },
  link: { type: String, default: '' }
}, { timestamps: true });
const Concorrenza = mongoose.model('Concorrenza', ConcorrenzaSchema);

/* ==========================================
   ROTTE API INTERNE CORE & AUTENTICAZIONE
========================================== */
app.get('/', (req, res) => res.json({ status: 'success', message: 'Forte CRM Backend attivo e integro al 100%' }));

app.post('/api/login', async (req, res) => {
  try {
    const { utente, pass } = req.body;
    if (utente.trim().toLowerCase() === "admin" && pass === "Forte2026") {
      return res.status(200).json({ status: 'success', data: { nomeCognome: "Alessandro Forte (Master)", ruolo: "AMMINISTRATORE", utente: "admin" } });
    }
    const consulente = await Consulente.findOne({ utente: utente.trim().toLowerCase() });
    if (!consulente || consulente.pass !== pass) return res.status(401).json({ error: 'Username o password errati' });
    const datiSenzaPassword = consulente.toObject();
    delete datiSenzaPassword.pass;
    res.status(200).json({ status: 'success', data: datiSenzaPassword });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/consulenti', async (req, res) => {
  try { res.status(200).json(await Consulente.find({}).sort({ nomeCognome: 1 })); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/consulenti', async (req, res) => {
  try {
    const nuovo = new Consulente({ ...req.body, utente: req.body.utente.trim().toLowerCase() });
    res.status(201).json({ status: 'success', data: await nuovo.save() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/todo', async (req, res) => {
  try { res.status(200).json(await Todo.find({}).sort({ createdAt: -1 })); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/todo', async (req, res) => {
  try { const nuovo = new Todo(req.body); res.status(201).json({ status: 'success', data: await nuovo.save() }); } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/todo/:id', async (req, res) => {
  try { res.status(200).json({ status: 'success', data: await Todo.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true }) }); } catch (err) { res.status(400).json({ error: err.message }); }
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
    const aggiornato = await Stradario.findByIdAndUpdate(req.params.comuneId, { $set: { vie: req.body.vie } }, { new: true });
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

/* ==========================================
   ROTTE API: CONCORRENZA MANUALE ED EXCEL (PULITE)
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server CRM completo e attivo sulla porta ${PORT}`));
