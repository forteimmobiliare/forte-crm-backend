const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();

/* ==========================================
   MIDDLEWARE CORE
========================================== */
app.use(cors());
app.use(express.json());

/* ==========================================
   CONNESSIONE AUTOMATICA AL DATABASE CLOUD
========================================== */
const mongoURI = process.env.MONGO_URI;
if (!mongoURI) {
  console.error('ERRORE CRITICO: La variabile MONGO_URI non è configurata nella scheda Environment di Render!');
}

mongoose.connect(mongoURI)
  .then(() => console.log('Database MongoDB Cloud Connesso con Successo!'))
  .catch((err) => console.error('Errore critico di connessione DB:', err));

/* ==========================================
   MODELLO DATI SCHEMATIZZATO (CONSULENTE)
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
   ROTTE API (ENDPOINTS CORRETTI PER IL CRM)
========================================== */

// 1. TEST DI RUNTIME DI BASE
app.get('/', (req, res) => {
  res.json({ status: 'success', message: 'Forte CRM Backend attivo e reattivo' });
});

// 2. GET - LEGGERE TUTTI I CONSULENTI ORDINATI PER NOME
app.get('/api/consulenti', async (req, res) => {
  try {
    const lista = await Consulente.find({}).sort({ nomeCognome: 1 });
    res.status(200).json(lista);
  } catch (err) {
    console.error('Errore caricamento lista consulenti:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. POST - CREAZIONE PROTETTA DA DUPLICATI O STRINGHE VUOTE ACCIDENTALI
app.post('/api/consulenti', async (req, res) => {
  try {
    if (!req.body.utente || req.body.utente.trim() === "") {
      return res.status(400).json({ error: "Il campo Nome Utente (Login Univoco) è strettamente obbligatorio!" });
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
    console.log('Nuovo consulente registrato nel Cloud:', salvato.utente);
    res.status(201).json({ status: 'success', data: salvato });
  } catch (err) {
    console.error('Errore creazione consulente:', err);
    if (err.code === 11000) {
      return res.status(400).json({ error: 'Username già esistente nel database.' });
    }
    res.status(400).json({ error: err.message });
  }
});

// 4. PUT - MODIFICA RAPIDA IN-LINE AGGIORNANDO IL PROFILO VIA USERNAME
app.put('/api/consulenti/:utente', async (req, res) => {
  try {
    const utenteParametro = req.params.utente.trim().toLowerCase();
    
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
      { utente: utenteParametro },
      { $set: datiDaAggiornare },
      { new: true, runValidators: true }
    );

    if (!consulenteAggiornato) {
      return res.status(404).json({ error: 'Consulente non trovato nel database' });
    }

    console.log('Dati aggiornati correttamente nel Cloud per:', utenteParametro);
    res.status(200).json({ status: 'success', data: consulenteAggiornato });
  } catch (err) {
    console.error('Errore durante l\'aggiornamento via PUT:', err);
    res.status(400).json({ error: err.message });
  }
});

// 5. DELETE - RIMOZIONE DI UN PROFILO DAL CLOUD
app.delete('/api/consulenti/:utente', async (req, res) => {
  try {
    const utenteDaEliminare = req.params.utente.trim().toLowerCase();
    const eliminato = await Consulente.findOneAndDelete({ utente: utenteDaEliminare });
    
    if (!eliminato) {
      return res.status(404).json({ error: 'Consulente non trovato' });
    }
    
    console.log('Consulente rimosso dal database:', utenteDaEliminare);
    res.status(200).json({ status: 'success', message: 'Consulente eliminato con successo' });
  } catch (err) {
    console.error('Errore durante l\'eliminazione:', err);
    res.status(500).json({ error: err.message });
  }
});

// 6. LOGIN - VERIFICA CREDENZIALI DI ACCESSO
app.post('/api/login', async (req, res) => {
  try {
    const { utente, pass } = req.body;
    if (!utente || !pass) {
      return res.status(400).json({ error: 'Username e password sono obbligatori' });
    }
    const consulente = await Consulente.findOne({ utente: utente.trim().toLowerCase() });
    if (!consulente || consulente.pass !== pass) {
      return res.status(401).json({ error: 'Username o password errati' });
    }
    const { pass: _, ...datiSenzaPassword } = consulente.toObject();
    console.log('Login effettuato con successo:', consulente.utente);
    res.status(200).json({ status: 'success', data: datiSenzaPassword });
  } catch (err) {
    console.error('Errore durante il login:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ==========================================
   AVVIO SERVER SULLA PORTA DI RENDER
========================================== */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server CRM in ascolto ed operativo sulla porta standard ${PORT}`);
});
