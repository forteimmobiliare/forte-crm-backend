const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors()); // Consente le richieste asincrone da Squarespace

// STRINGA DI CONNESSIONE AGGIORNATA CON LE TUE CREDENZIALI ATTIVE
const MONGO_URI = "mongodb+srv://aforte_db_user:JlHus5D3MmjuaTpm@cluster0.mongodb.net/forte_crm?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
  .then(() => console.log("Database MongoDB Cloud Connesso con Successo!"))
  .catch(err => console.error("Errore critico di connessione DB:", err));

// Schema strutturato per l'archiviazione dei consulenti e dati di login
const ConsulenteSchema = new mongoose.Schema({
  nomeCognome: String,
  telefono: String,
  mail: String,
  idTelegram: String,
  idWhatsapp: String,
  utente: { type: String, unique: true, required: true },
  pass: { type: String, required: true },
  ruolo: String
});

const Consulente = mongoose.model('Consulente', ConsulenteSchema);

// API 1: Estrarre la lista completa di utenze
app.get('/api/consulenti', async (req, res) => {
  try {
    const consulenti = await Consulente.find();
    res.json(consulenti);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API 2: Salvare una nuova credenziale inviata dalla plancia
app.post('/api/consulenti', async (req, res) => {
  try {
    const nuovo = new Consulente(req.body);
    await nuovo.save();
    res.status(201).json({ status: "success", data: nuovo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Controllo stato di salute per Render
app.get('/', (req, res) => res.send("Server di Rete per CRM Forte Immobiliare online. Database Connesso."));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Motore di backend operativo sulla porta ${PORT}`));
