const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const mongoURI = process.env.MONGO_URI; 

mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("Database MongoDB Cloud Connesso con Successo!"))
  .catch(err => console.error("Errore critico di connessione DB:", err));

const ConsulenteSchema = new mongoose.Schema({
  nomeCognome: String,
  telefono: String,
  mail: String,
  idTelegram: String,
  idWhatsapp: String,
  utente: { type: String, unique: true, required: true },
  pass: String,
  ruolo: String 
});

const Consulente = mongoose.model('Consulente', ConsulenteSchema);

app.get('/api/consulenti', async (req, res) => {
  try {
    const lista = await Consulente.find({});
    res.json(lista);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// IL PROBLEMA ERA QUI SOTTO: HO CORRETTO "nuevo" IN "nuovo"
app.post('/api/consulenti', async (req, res) => {
  try {
    const nuovo = new Consulente(req.body);
    await nuovo.save();
    res.json({ status: "success", data: nuovo }); 
  } catch (err) {
    res.status(400).json({ error: "Username già esistente o dati non validi." });
  }
});

app.put('/api/consulenti/:utente', async (req, res) => {
  try {
    const consulenteAggiornato = await Consulente.findOneAndUpdate(
      { utente: req.params.utente },
      req.body,
      { new: true, runValidators: true }
    );
    if (!consulenteAggiornato) {
      return res.status(404).json({ error: "Consulente non trovato" });
    }
    res.json({ status: "success", data: consulenteAggiornato });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/consulenti/:utente', async (req, res) => {
  try {
    const eliminato = await Consulente.findOneAndDelete({ utente: req.params.utente });
    if (!eliminato) return res.status(404).json({ error: "Consulente non trovato" });
    res.json({ status: "success", message: "Eliminato con successo" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server CRM in ascolto sulla porta ${PORT}`));

