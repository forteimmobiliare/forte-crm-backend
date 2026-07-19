const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

/* =========================
   MIDDLEWARE
========================= */

app.use(cors());
app.use(express.json());

/* =========================
   CONNESSIONE MONGODB ATLAS
========================= */

const mongoURI = process.env.MONGO_URI;

if (!mongoURI) {
  console.error('ERRORE: variabile MONGO_URI non configurata su Render');
}

mongoose.connect(mongoURI)
  .then(() => {
    console.log('Database MongoDB Cloud Connesso con Successo!');
  })
  .catch((err) => {
    console.error('Errore critico di connessione DB:', err);
  });

/* =========================
   MODELLO CONSULENTE
========================= */

const ConsulenteSchema = new mongoose.Schema(
  {
    nomeCognome: {
      type: String,
      required: true
    },

    telefono: {
      type: String,
      default: ''
    },

    mail: {
      type: String,
      default: ''
    },

    idTelegram: {
      type: String,
      default: ''
    },

    idWhatsapp: {
      type: String,
      default: ''
    },

    utente: {
      type: String,
      unique: true,
      required: true
    },

    pass: {
      type: String,
      default: ''
    },

    ruolo: {
      type: String,
      default: 'Consulente'
    }
  },
  {
    timestamps: true
  }
);

const Consulente = mongoose.model(
  'Consulente',
  ConsulenteSchema
);

/* =========================
   TEST SERVER
========================= */

app.get('/', (req, res) => {
  res.json({
    status: 'success',
    message: 'Forte CRM Backend attivo'
  });
});

/* =========================
   GET
   LEGGERE TUTTI I CONSULENTI
========================= */

app.get('/api/consulenti', async (req, res) => {
  try {
    const lista = await Consulente.find({}).sort({
      nomeCognome: 1
    });

    res.status(200).json(lista);

  } catch (err) {
    console.error('Errore caricamento consulenti:', err);

    res.status(500).json({
      error: err.message
    });
  }
});

/* =========================
   POST
   CREARE NUOVO CONSULENTE
========================= */

app.post('/api/consulenti', async (req, res) => {
  try {

    const nuovo = new Consulente({
      nomeCognome: req.body.nomeCognome || '',
      telefono: req.body.telefono || '',
      mail: req.body.mail || '',
      idTelegram: req.body.idTelegram || '',
      idWhatsapp: req.body.idWhatsapp || '',
      utente: req.body.utente || '',
      pass: req.body.pass || '',
      ruolo: req.body.ruolo || 'Consulente'
    });

    const salvato = await nuovo.save();

    res.status(201).json({
      status: 'success',
      data: salvato
    });

  } catch (err) {

    console.error('Errore creazione consulente:', err);

    if (err.code === 11000) {
      return res.status(400).json({
        error: 'Username già esistente'
      });
    }

    res.status(400).json({
      error: err.message
    });
  }
});

/* =========================
   PUT
   MODIFICARE CONSULENTE
========================= */

app.put('/api/consulenti/:utente', async (req, res) => {
  try {

    const utenteOriginale = req.params.utente;

    const datiDaAggiornare = {
      nomeCognome: req.body.nomeCognome || '',
      telefono: req.body.telefono || '',
      mail: req.body.mail || '',
      idTelegram: req.body.idTelegram || '',
      idWhatsapp: req.body.idWhatsapp || '',
      pass: req.body.pass || '',
      ruolo: req.body.ruolo || 'Consulente'
    };

    const consulenteAggiornato =
      await Consulente.findOneAndUpdate(
        {
          utente: utenteOriginale
        },
        {
          $set: datiDaAggiornare
        },
        {
          new: true,
          runValidators: true
        }
      );

    if (!consulenteAggiornato) {
      return res.status(404).json({
        error: 'Consulente non trovato'
      });
    }

    console.log(
      'Consulente aggiornato:',
      consulenteAggiornato.utente
    );

    res.status(200).json({
      status: 'success',
      data: consulenteAggiornato
    });

  } catch (err) {

    console.error(
      'Errore aggiornamento consulente:',
      err
    );

    res.status(400).json({
      error: err.message
    });
  }
});

/* =========================
   DELETE
   ELIMINARE CONSULENTE
========================= */

app.delete('/api/consulenti/:utente', async (req, res) => {
  try {

    const utenteDaEliminare = req.params.utente;

    const eliminato =
      await Consulente.findOneAndDelete({
        utente: utenteDaEliminare
      });

    if (!eliminato) {
      return res.status(404).json({
        error: 'Consulente non trovato'
      });
    }

    console.log(
      'Consulente eliminato:',
      utenteDaEliminare
    );

    res.status(200).json({
      status: 'success',
      message: 'Consulente eliminato con successo'
    });

  } catch (err) {

    console.error(
      'Errore eliminazione consulente:',
      err
    );

    res.status(500).json({
      error: err.message
    });
  }
});

/* =========================
   AVVIO SERVER
========================= */

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(
    `Server CRM in ascolto sulla porta ${PORT}`
  );
});

