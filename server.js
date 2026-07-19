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

app.get('/', (req, res) => {
  res.json({ status: 'success', message: 'Forte CRM Backend attivo' });
});

app.get('/api/consulenti', async (req, res) => {
  try {
    const lista = await Consulente.find({}).sort({ nomeCognome: 1 });
    res.status(200).json(lista);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/consulenti', async (req, res) => {
  try {
    if (!req.body.utente || req.body.utente.trim() === "") {
      return res.status(400).json({ error: "Il campo Nome Utente è obbligatorio!" });
    }
    const nuovo = new Consulente({
      nomeCognome: req.body.nomeCognome || '',
      telefono: req.body.telefono || '',
      mail: req.body.mail || '',
      idTelegram: req.body.idTelegram || '',
      idWhatsapp: req.body.idWhatsapp || '',
      utente: req.body.utente.trim().toLowerCase(),
      pass: req.body.pass || '',
      ruolo: req.body.ruolo || 'LISTING AGENT'
    });
    const salvato = await nuovo.save();
    res.status(201).json({ status: 'success', data: salvato });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: 'Username già esistente nel database.' });
    }
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/consulenti/:utente', async (req, res) => {
  try {
    const datiDaAggiornare = {
      nomeCognome: req.body.nomeCognome,
      telefono: req.body.telefono,
      mail: req.body.mail,
      idTelegram: req.body.idTelegram,
      idWhatsapp: req.body.idWhatsapp,
      pass: req.body.pass,
      ruolo: req.body.ruolo
    };
    const consulenteAggiornato = await Consulente.findOneAndUpdate(
      { utente: req.params.utente.trim().toLowerCase() },
      { $set: datiDaAggiornare },
      { new: true, runValidators: true }
    );
    if (!consulenteAggiornato) {
      return res.status(404).json({ error: 'Consulente non trovato' });
    }
    res.status(200).json({ status: 'success', data: consulenteAggiornato });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/consulenti/:utente', async (req, res) => {
  try {
    const eliminato = await Consulente.findOneAndDelete({ utente: req.params.utente.trim().toLowerCase() });
    if (!eliminato) return res.status(404).json({ error: 'Consulente non trovato' });
    res.status(200).json({ status: 'success', message: 'Consulente eliminato' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { utente, pass } = req.body;
    if (!utente || !pass) {
      return res.status(400).json({ error: 'Campi obbligatori mancanti' });
    }
    
    // ACCESSO MASTER BYPASS EMERGENZA
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server CRM attivo sulla porta ${PORT}`));
