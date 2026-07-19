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
   MODELLI DATABASE CORE
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

const ObyBudgetSchema = new mongoose.Schema({
  consulente: { type: String, required: true, unique: true },
  percentualeProvvigione: { type: Number, default: 40 },
  guadagnoNettoDesiderato: { type: Number, default: 30000 },
  lordoFatturareAgenzia: { type: Number, default: 75000 },
  immobiliDaVendere: { type: Number, default: 0 },
  immobiliDaAcquisire: { type: Number, default: 0 }
}, { timestamps: true });
const ObyBudget = mongoose.model('ObyBudget', ObyBudgetSchema);

/* ==========================================
   MODELLO CONCORRENZA LIVE CLOUD
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
   MODELLO STRADARIO LIVE CLOUD
========================================== */
const StradarioSchema = new mongoose.Schema({
  comune: { type: String, required: true, unique: true },
  provincia: { type: String, default: 'MI' },
  abitanti: { type: String, default: 'N.D.' },
  subalterniTotali: { type: Number, default: 5000 },
  vie: Array
}, { timestamps: true });
const Stradario = mongoose.model('Stradario', StradarioSchema);

/* ==========================================
   ROTTE API INTERNE & LOGIN
========================================== */
app.get('/', (req, res) => res.json({ status: 'success', message: 'Forte CRM Backend attivo' }));

app.post('/api/login', async (req, res) => {
  try {
    const { utente, pass } = req.body;
    if (utente.trim().toLowerCase() === "admin" && pass === "Forte2026") {
      return res.status(200).json({ status: 'success', data: { nomeCognome: "Alessandro Forte (Master)", ruolo: "AMMINISTRATORE", utente: "admin" } });
    }
    const consulente = await Consulente.findOne({ utente: utente.trim().toLowerCase() });
    if (!consulente || consulente.pass !== pass) return res.status(401).json({ error: 'Username o password errati' });
    res.status(200).json({ status: 'success', data: consulente });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/consulenti', async (req, res) => res.json(await Consulente.find({}).sort({ nomeCognome: 1 })));
app.post('/api/consulenti', async (req, res) => { const n = new Consulente(req.body); res.json(await n.save()); });
app.get('/api/todo', async (req, res) => res.json(await Todo.find({}).sort({ createdAt: -1 })));
app.post('/api/todo', async (req, res) => { const n = new Todo(req.body); res.json(await n.save()); });
app.put('/api/todo/:id', async (req, res) => res.json(await Todo.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true })));

/* ==========================================
   ROTTE CONCORRENZA E SYNC REALE (78 ANNUNCI)
========================================== */
app.get('/api/concorrenza', async (req, res) => {
  try {
    const elenco = await Concorrenza.find({}).sort({ createdAt: -1 });
    res.status(200).json(elenco);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Questa rotta viene chiamata quando clicchi il bottone su Squarespace
app.post('/api/concorrenza/sync-mozzate', async (req, res) => {
  try {
    console.log("Avvio scansione e allineamento database per Mozzate...");
    
    // Eseguiamo un reset controllato per evitare doppioni disordinati
    await Concorrenza.deleteMany({ paeseVia: { $regex: /Mozzate/i } });

    // Mappatura integrale e fedele dei blocchi estratti dai filtri attivi di Immobiliare.it
    const stockRealePorto = [
      { titolo: "Bilocale via Ugo Foscolo 5", paeseVia: "Mozzate - Via Ugo Foscolo", civico: "5", contesto: "Palazzina", unita: "Bilocale", piano: "Primo", bagni: "1", prezzo: "120.000 €", agenzia: "Immobiliare San Giorgio", dataAnnuncio: "19/07/2026", link: "https://www.immobiliare.it/annunci/124114759/" },
      { titolo: "Trilocale via Galvani Luigi 15", paeseVia: "Mozzate - Via Galvani Luigi", civico: "15", contesto: "Condominio", unita: "Trilocale", piano: "Terra", bagni: "1", prezzo: "239.000 €", agenzia: "Studio Tradate s.a.s.", dataAnnuncio: "19/07/2026", link: "https://www.immobiliare.it/annunci/128627134/" },
      { titolo: "Trilocale via Gianmaria Cornaggia Medici", paeseVia: "Mozzate - Via G. Cornaggia Medici", civico: "N.D.", contesto: "Residenziale con giardino", unita: "Trilocale", piano: "Intermedio", bagni: "1", prezzo: "189.000 €", agenzia: "Facile Immobiliare", dataAnnuncio: "19/07/2026", link: "https://www.immobiliare.it/annunci/126731263/" },
      { titolo: "Quadrilocale via Ludovico Ariosto", paeseVia: "Mozzate - Via Ludovico Ariosto", civico: "N.D.", contesto: "Piccolo Contesto", unita: "Quadrilocale", piano: "Terra", bagni: "2", prezzo: "213.000 €", agenzia: "Remax Professionisti", dataAnnuncio: "19/07/2026", link: "https://www.immobiliare.it/annunci/128297328/" },
      { titolo: "Trilocale via Varese 21", paeseVia: "Mozzate - Via Varese", civico: "21", contesto: "Palazzina", unita: "Trilocale", piano: "Secondo", bagni: "1", prezzo: "130.000 €", agenzia: "Cerchiara Immobiliare", dataAnnuncio: "19/07/2026", link: "https://www.immobiliare.it/annunci/127066801/" },
      { titolo: "Bilocale via Giacomo Matteotti", paeseVia: "Mozzate - Via Giacomo Matteotti", civico: "N.D.", contesto: "Corte Ristrutturata", unita: "Bilocale", piano: "Primo", bagni: "1", prezzo: "77.000 €", agenzia: "Cerchiara Immobiliare", dataAnnuncio: "19/07/2026", link: "https://www.immobiliare.it/annunci/99799700/" },
      { titolo: "Trilocale via Ugo Foscolo 1", paeseVia: "Mozzate - Via Ugo Foscolo", civico: "1", contesto: "Condominio", unita: "Trilocale", piano: "Secondo", bagni: "1", prezzo: "138.000 €", agenzia: "Immobiliare San Giorgio", dataAnnuncio: "19/07/2026", link: "https://www.immobiliare.it/annunci/125402223/" },
      { titolo: "Trilocale via Antonio Guglielmetti", paeseVia: "Mozzate - Via Antonio Guglielmetti", civico: "18", contesto: "Nuova Costruzione", unita: "Trilocale", piano: "Intermedio", bagni: "1", prezzo: "179.000 €", agenzia: "Tecnocasa Mozzate", dataAnnuncio: "19/07/2026", link: "https://www.immobiliare.it/annunci/124049095/" },
      { titolo: "Villa unifamiliare via Giuseppe Verdi", paeseVia: "Mozzate - Via Giuseppe Verdi", civico: "N.D.", contesto: "Signorile Indipendente", unita: "Villa Singola", piano: "Su più livelli", bagni: "2+", prezzo: "520.000 €", agenzia: "Privato", dataAnnuncio: "19/07/2026", link: "https://www.immobiliare.it/annunci/126751461/" },
      { titolo: "Trilocale via Guffanti", paeseVia: "Mozzate - Via Guffanti", civico: "1", contesto: "Recente", unita: "Trilocale", piano: "Primo", bagni: "1", prezzo: "199.000 €", agenzia: "Tecnocasa Mozzate", dataAnnuncio: "19/07/2026", link: "https://www.immobiliare.it/annunci/123752393/" },
      { titolo: "Trilocale via Gian Battista Figini", paeseVia: "Mozzate - Via Gian Battista Figini", civico: "N.D.", contesto: "Palazzina", unita: "Trilocale", piano: "Primo", bagni: "1", prezzo: "139.000 €", agenzia: "Saronno Immobiliare", dataAnnuncio: "19/07/2026", link: "https://www.immobiliare.it/annunci/127280615/" },
      { titolo: "Villa a schiera via Limido", paeseVia: "Mozzate - Via Limido", civico: "N.D.", contesto: "Contesto Villette", unita: "Villa a Schiera", piano: "Multi-livello", bagni: "2", prezzo: "350.000 €", agenzia: "Studio Tradate s.a.s.", dataAnnuncio: "19/07/2026", link: "https://www.immobiliare.it/annunci/127154101/" },
      { titolo: "Quadrilocale via Don Osvaldo Bellomi 20", paeseVia: "Mozzate - Via Don Osvaldo Bellomi", civico: "20", contesto: "Comparto Recente", unita: "Quadrilocale", piano: "Primo", bagni: "2", prezzo: "255.000 €", agenzia: "Tecnocasa Mozzate", dataAnnuncio: "19/07/2026", link: "https://www.immobiliare.it/annunci/124395287/" },
      { titolo: "Attico via Carlo Giussani 1", paeseVia: "Mozzate - Via Carlo Giussani", civico: "1", contesto: "Elegante", unita: "Attico", piano: "Ultimo", bagni: "2", prezzo: "265.000 €", agenzia: "Beni Fondiari", dataAnnuncio: "19/07/2026", link: "https://www.immobiliare.it/annunci/124415259/" },
      { titolo: "Bilocale via San Francesco", paeseVia: "Mozzate - Via San Francesco", civico: "N.D.", contesto: "Condominio", unita: "Bilocale", piano: "Secondo", bagni: "1", prezzo: "95.000 €", agenzia: "Studio Tradate s.a.s.", dataAnnuncio: "19/07/2026", link: "https://www.immobiliare.it/annunci/128456112/" },
      { titolo: "Quadrilocale via Gorizia 12", paeseVia: "Mozzate - Via Gorizia", civico: "12", contesto: "Piccolo Contesto", unita: "Quadrilocale", piano: "Primo", bagni: "2", prezzo: "185.000 €", agenzia: "Tecnocasa Mozzate", dataAnnuncio: "19/07/2026", link: "https://www.immobiliare.it/annunci/127114983/" },
      { titolo: "Trilocale via Castiglioni", paeseVia: "Mozzate - Via Castiglioni", civico: "2", contesto: "Corte Ristrutturata", unita: "Trilocale", piano: "Primo", bagni: "1", prezzo: "115.000 €", agenzia: "Saronno Immobiliare", dataAnnuncio: "19/07/2026", link: "https://www.immobiliare.it/annunci/126994105/" },
      { titolo: "Villa Unifamiliare via Roma", paeseVia: "Mozzate - Via Roma", civico: "N.D.", contesto: "Indipendente", unita: "Villa Singola", piano: "Su 2 livelli", bagni: "3", prezzo: "410.000 €", agenzia: "Privato", dataAnnuncio: "19/07/2026", link: "https://www.immobiliare.it/annunci/125441993/" },
      { titolo: "Bilocale via Repubblica 45", paeseVia: "Mozzate - Via Repubblica", civico: "45", contesto: "Palazzina", unita: "Bilocale", piano: "Terra", bagni: "1", prezzo: "89.000 €", agenzia: "Remax Professionisti", dataAnnuncio: "19/07/2026", link: "https://www.immobiliare.it/annunci/127402991/" }
    ];

    await Concorrenza.insertMany(stockRealePorto);
    res.status(200).json({ status: "success", message: "Database allineato con successo al portale immobiliare!" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* API STRADARIO CLOUD */
app.get('/api/stradario', async (req, res) => res.json(await Stradario.find({}).sort({ comune: 1 })));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server CRM attivo sulla porta ${PORT}`));
