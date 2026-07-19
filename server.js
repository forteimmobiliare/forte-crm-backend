const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const mongoURI = process.env.MONGO_URI;
if (!mongoURI) {
  console.error('ERRORE CRITICO: La variabile MONGO_URI non è configurata su Render!');
}

mongoose.connect(mongoURI)
  .then(() => console.log('Database MongoDB Cloud Connesso con Successo!'))
  .catch((err) => console.error('Errore critico di connessione DB:', err));

/* ==========================================
   MODELLO 1: CONSULENTI
========================================== */
const ConsulenteSchema = new mongoose.Schema(
  {
    nomeCognome: { type: String, required: true },
    telefono: { type: String, default: '' },
    mail: { type: String, default: '' },
    idTelegram: { type: String, default: '' },
    idWhatsapp: { type: String, default: '' },
    utente: { type: String, unique: true, required: true, trim: true },
    pass: { type: String, default: '' },
    ruolo: { type: String, default: 'LISTING AGENT' }
  },
  { timestamps: true }
);
const Consulente = mongoose.model('Consulente', ConsulenteSchema);

/* ==========================================
   MODELLO 2: TO DO LIST
========================================== */
const TodoSchema = new mongoose.Schema(
  {
    data: { type: String, required: true, default: '19/07/2026' },
    task: { type: String, required: true },
    consulente: { type: String, default: '' },
    stato: { type: String, default: 'Attivo' },
    note: { type: String, default: '' }
  },
  { timestamps: true }
);
const Todo = mongoose.model('Todo', TodoSchema);

/* ==========================================
   MODELLO 3: SETTAGGIO OBY (TARGET BUDGET)
========================================== */
const ObyBudgetSchema = new mongoose.Schema(
  {
    consulente: { type: String, required: true, unique: true },
    percentualeProvvigione: { type: Number, default: 40 },
    guadagnoNettoDesiderato: { type: Number, default: 30000 },
    lordoFatturareAgenzia: { type: Number, default: 75000 },
    immobiliDaVendere: { type: Number, default: 0 },
    immobiliDaAcquisire: { type: Number, default: 0 },
    cdv2Necessarie: { type: Number, default: 0 },
    cdv1Necessarie: { type: Number, default: 0 },
    notizieNecessarie: { type: Number, default: 0 }
  },
  { timestamps: true }
);
const ObyBudget = mongoose.model('ObyBudget', ObyBudgetSchema);

/* ==========================================
   ROTTE API: GENERALI & LOGIN
========================================== */
app.get('/', (req, res) => {
  res.json({ status: 'success', message: 'Forte CRM Backend attivo' });
});

app.post('/api/login', async (req, res) => {
  try {
    const { utente, pass } = req.body;
    if (!utente || !pass) return res.status(400).json({ error: 'Campi obbligatori mancanti' });
    
    if (utente.trim().toLowerCase() === "admin" && pass === "Forte2026") {
      return res.status(200).json({
        status: 'success',
        data: { nomeCognome: "Alessandro Forte (Master)", ruolo: "AMMINISTRATORE", utente: "admin" }
      });
    }

    const consulente = await Consulente.findOne({ utente: utente.trim().toLowerCase() });
    if (!consulente || consulente.pass !== pass) {
      return res.status(401).json({ error: 'Username o password errati' });
    }
    const datiSenzaPassword = consulente.toObject();
    delete datiSenzaPassword.pass;
    res.status(200).json({ status: 'success', data: datiSenzaPassword });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ==========================================
   ROTTE API: CONSULENTI
========================================== */
app.get('/api/consulenti', async (req, res) => {
  try {
    const lista = await Consulente.find({}).sort({ nomeCognome: 1 });
    res.status(200).json(lista);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/consulenti', async (req, res) => {
  try {
    if (!req.body.utente || req.body.utente.trim() === "") return res.status(400).json({ error: "Utente obbligatorio" });
    const nuovo = new Consulente({
      nomeCognome: req.body.nomeCognome || '', telefono: req.body.telefono || '', mail: req.body.mail || '',
      idTelegram: req.body.idTelegram || '', idWhatsapp: req.body.idWhatsapp || '', utente: req.body.utente.trim().toLowerCase(), pass: req.body.pass || '', ruolo: req.body.ruolo || 'LISTING AGENT'
    });
    const salvato = await nuovo.save();
    res.status(201).json({ status: 'success', data: salvato });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/consulenti/:utente', async (req, res) => {
  try {
    const aggiornato = await Consulente.findOneAndUpdate(
      { utente: req.params.utente.trim().toLowerCase() },
      { $set: req.body },
      { new: true }
    );
    res.status(200).json({ status: 'success', data: aggiornato });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/consulenti/:utente', async (req, res) => {
  try {
    await Consulente.findOneAndDelete({ utente: req.params.utente.trim().toLowerCase() });
    res.status(200).json({ status: 'success', message: 'Eliminato' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================
   ROTTE API: TO DO LIST
========================================== */
app.get('/api/todo', async (req, res) => {
  try {
    const lista = await Todo.find({}).sort({ createdAt: -1 });
    res.status(200).json(lista);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/todo', async (req, res) => {
  try {
    const nuovo = new Todo(req.body);
    const salvato = await nuovo.save();
    res.status(201).json({ status: 'success', data: salvato });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/todo/:id', async (req, res) => {
  try {
    const aggiornato = await Todo.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    res.status(200).json({ status: 'success', data: aggiornato });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* ==========================================
   ROTTE API: OBY BUDGET (LIVE CALCOLO FUNNEL)
========================================== */
app.get('/api/oby-budget/:consulente', async (req, res) => {
  try {
    let budget = await ObyBudget.findOne({ consulente: req.params.consulente });
    if (!budget) {
      budget = { consulente: req.params.consulente, percentualeProvvigione: 40, guadagnoNettoDesiderato: 30000, lordoFatturareAgenzia: 75000, immobiliDaVendere: 9, immobiliDaAcquisire: 13, cdv2Necessarie: 44, cdv1Necessarie: 63, notizieNecessarie: 210 };
    }
    res.status(200).json(budget);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/oby-budget', async (req, res) => {
  try {
    const { consulente } = req.body;
    const aggiornato = await ObyBudget.findOneAndUpdate(
      { consulente },
      { $set: req.body },
      { new: true, upsert: true }
    );
    res.status(200).json({ status: 'success', data: aggiornato });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server CRM attivo sulla porta ${PORT}`));
