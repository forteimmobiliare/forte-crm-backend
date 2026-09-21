<div class="ricerca-immobiliare-container">
    <div class="barra-filtri">
        <div class="filtro-gruppo">
            <label>Stato</label>
            <select id="filtro_stato" onchange="filtraImmobili()">
                <option value="disponibili">Disponibili</option>
                <option value="venduti">Venduti / Conclusi</option>
            </select>
        </div>

        <div class="filtro-gruppo">
            <label>Contratto</label>
            <select id="filtro_contratto" onchange="filtraImmobili()">
                <option value="tutti">Tutti</option>
                <option value="vendita">Vendita</option>
                <option value="affitto">Affitto</option>
                <option value="riscatto">Affitto a riscatto</option>
            </select>
        </div>

        <div class="filtro-gruppo">
            <label>Comune</label>
            <select id="filtro_comune" onchange="filtraImmobili()">
                <option value="tutti">Tutti i Comuni</option>
            </select>
        </div>

        <div class="filtro-gruppo">
            <label>Prezzo Massimo</label>
            <select id="filtro_prezzo" onchange="filtraImmobili()">
                <option value="inf">Qualsiasi</option>
                <option value="50000">Fino a 50.000 €</option>
                <option value="150000">Fino a 150.000 €</option>
                <option value="300000">Fino a 300.000 €</option>
                <option value="500000">Fino a 500.000 €</option>
                <option value="1500000">Fino a 1.500.000 €</option>
            </select>
        </div>

        <div class="filtro-gruppo">
            <label>Locali Minimi</label>
            <select id="filtro_locali" onchange="filtraImmobili()">
                <option value="0">Qualsiasi</option>
                <option value="1">1+ locale</option>
                <option value="2">2+ locali</option>
                <option value="3">3+ locali</option>
                <option value="4">4+ locali</option>
            </select>
        </div>
    </div>

    <div class="griglia-immobili" id="elenco_immobili">
        <div id="pfc_loading_status" style="grid-column: 1/-1; padding: 40px; color: #0b3b4a; font-weight: 600; text-align: center;">
            <i class="fa-solid fa-spinner fa-spin"></i> Caricamento immobili in tempo reale...
        </div>
    </div>

    <div id="pfc_lightbox_dettaglio" class="pfc-lightbox-overlay" onclick="chiudiLightboxViaOverlay(event)">
        <div class="pfc-lightbox-wrapper">
            <button class="btn-chiudi-lightbox" onclick="chiudiLightbox()">✕ Chiudi scheda</button>
            <div id="pfc_lightbox_contenuto_dinamico"></div>
        </div>
    </div>
</div>

<style>
    /* --- STRUTTURA CONTENITORE --- */
    .ricerca-immobiliare-container {
        font-family: 'Plus Jakarta Sans', 'Segoe UI', system-ui, sans-serif;
        max-width: 1200px;
        margin: 0 auto;
        padding: 15px;
        color: #334155;
        box-sizing: border-box;
    }

    /* --- BARRA FILTRI --- */
    .barra-filtri {
        display: flex;
        flex-direction: row;
        gap: 15px;
        background: #0b3b4a;
        padding: 20px;
        border-radius: 12px;
        margin-bottom: 30px;
        box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
        box-sizing: border-box;
        width: 100%;
    }
    .filtro-gruppo {
        display: flex;
        flex-direction: column;
        flex: 1;
    }
    .filtro-gruppo label {
        font-size: 11px;
        font-weight: 700;
        margin-bottom: 8px;
        text-transform: uppercase;
        color: #c6a777;
        letter-spacing: 1px;
    }
    .filtro-gruppo select {
        padding: 12px;
        border-radius: 8px;
        border: 1px solid #cbd5e1;
        font-size: 14px;
        background: white;
        color: #1e293b;
        cursor: pointer;
        height: 45px;
        box-sizing: border-box;
        width: 100%;
    }

    /* --- GRIGLIA CARDS --- */
    .griglia-immobili {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 25px;
        width: 100%;
    }

    .card-immobile { display: flex; flex-direction: column; background: white; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); transition: transform 0.2s, box-shadow 0.2s; cursor: pointer; box-sizing: border-box; position: relative; }
    .card-immobile:hover { transform: translateY(-5px); box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1); }
    .card-img-wrapper { position: relative; width: 100%; height: 180px; overflow: hidden; background: #f1f5f9; border-bottom: 1px solid #e2e8f0; }
    .card-img-top { width: 100%; height: 100%; object-fit: cover; }

    .pfc-card-diagonale-venduto { position: absolute; top: 25px; left: -45px; background: #0b3b4a; color: #ffffff; width: 160px; padding: 6px 0; text-align: center; font-size: 12px; font-weight: 800; letter-spacing: 1.5px; transform: rotate(-45deg); box-shadow: 0 2px 6px rgba(0,0,0,0.3); z-index: 5; border: 1px solid rgba(255,255,255,0.15); }

    .card-info { padding: 20px; flex-grow: 1; text-align: left; }
    .card-info h4 { margin: 0 0 8px 0 !important; color: #0b3b4a; font-size: 16px; font-weight: 700; line-height: 1.4; height: 45px; overflow: hidden; text-align: left; }
    .card-info .prezzo { font-size: 19px; font-weight: 800; color: #c6a777; text-align: left; }
    .card-info .prezzo-venduto-card { color: #0b3b4a !important; font-size: 19px; font-weight: 800; text-align: left; }
    .card-info .localita { font-size: 12px; color: #64748b; margin-top: 5px; font-weight: 600; text-align: left; }
    .card-dettagli-fascia { background-color: #0b3b4a; padding: 12px 20px; display: flex; justify-content: space-between; color: white; font-size: 13px; font-weight: 500; box-sizing: border-box; }

    .tag-contratto { display: inline-block; font-size: 11px; text-transform: uppercase; font-weight: 700; padding: 4px 10px; border-radius: 4px; margin-bottom: 10px; letter-spacing: 0.5px; }
    /* Vendita e Affitto stessa targhetta neutra (niente verde/rosso). */
    .tag-vendita { background: #eef2f4; color: #0b3b4a; }
    .tag-venduti { background: #e6e9ec; color: #475569; }

    /* --- LIGHTBOX DETTAGLIO --- */
    body > .pfc-lightbox-overlay {
        display: none;
        opacity: 0;
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        background: rgba(11, 59, 74, 0.75) !important;
        z-index: 99999999999 !important;
        backdrop-filter: blur(8px) !important;
        transition: opacity 0.25s ease-in-out;
        padding: 40px 20px;
        box-sizing: border-box;
        overflow-y: scroll !important;
    }

    body > .pfc-lightbox-overlay .pfc-lightbox-wrapper {
        background: #ffffff !important;
        width: 100%;
        max-width: 1100px;
        margin: 0 auto;
        border-radius: 12px !important;
        position: relative;
        box-shadow: 0 30px 70px rgba(15, 23, 42, 0.35) !important;
        padding: 60px 0 20px 0;
        box-sizing: border-box;
    }

    .scheda-immobile-singola-container { padding: 0 30px; box-sizing: border-box; width: 100%; }
    .btn-ritorno-pagina { display: inline-block; text-decoration: none; background: #f1f5f9; border: 1px solid #cbd5e1; padding: 10px 18px; border-radius: 6px; font-weight: 600; color: #334155; margin-bottom: 25px; transition: background 0.2s; cursor: pointer; }
    .btn-ritorno-pagina:hover { background: #e2e8f0; }

    .scheda-dettaglio-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 35px; text-align: left; }
    .scheda-dettaglio-principale { background: white; border: none; padding: 0; box-sizing: border-box; width: 100%; }

    .det-slideshow-container { position: relative; width: 100%; height: 460px; background: #f8fafc; border-radius: 12px; overflow: hidden; margin-bottom: 45px; border: 1px solid #e2e8f0; z-index: 1; }
    .pfc-diagonale-venduto { position: absolute; top: 40px; left: -50px; background: #0b3b4a; color: #ffffff; width: 220px; padding: 10px 0; text-align: center; font-size: 16px; font-weight: 800; letter-spacing: 2px; transform: rotate(-45deg); box-shadow: 0 4px 10px rgba(0,0,0,0.3); z-index: 10; border: 1px solid rgba(255,255,255,0.2); }
    .prezzo-venduto-testo { color: #0b3b4a !important; font-weight: 800; }

    /* NUVOLA INFORMAZIONI STRUTTURATA NELLA FOTO DETTAGLIO */
    .det-info-overlay-foto {
        position: absolute;
        bottom: 0;
        left: 0;
        width: 100%;
        background: linear-gradient(transparent, rgba(11, 59, 74, 0.95));
        padding: 25px 20px 15px 20px;
        box-sizing: border-box;
        display: flex;
        gap: 15px;
        z-index: 4;
        flex-wrap: wrap;
    }
    .det-info-overlay-badge {
        background: rgba(255, 255, 255, 0.15);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        border: 1px solid rgba(255, 255, 255, 0.25);
        color: white;
        padding: 6px 12px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.5px;
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .det-info-overlay-badge span {
        color: #c6a777;
        font-weight: 800;
        text-transform: uppercase;
        font-size: 10px;
    }

    .pfc-slide { display: none; width: 100%; height: 100%; }
    .pfc-slide img { width: 100%; height: 100%; object-fit: cover; }

    .pfc-prev, .pfc-next { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(11, 59, 74, 0.7); color: white; border: none; padding: 14px 18px; font-size: 18px; font-weight: bold; cursor: pointer; border-radius: 4px; transition: background 0.2s; user-select: none; z-index: 5; }
    .pfc-prev:hover, .pfc-next:hover { background: #c6a777; }
    .pfc-prev { left: 15px; } .pfc-next { right: 15px; }

    .pfc-dots-container { position: absolute; bottom: -30px; left: 50%; transform: translateX(-50%); display: flex; gap: 8px; z-index: 99; }
    .pfc-dot { cursor: pointer; height: 12px; width: 12px; background-color: rgba(11, 59, 74, 0.2); border-radius: 50%; display: inline-block; border: 1px solid rgba(0,0,0,0.1); transition: background-color 0.2s; }
    .pfc-dot.active, .pfc-dot:hover { background-color: #c6a777; }

    .fade { animation: fadeAnim 0.4s ease-in-out; }
    @keyframes fadeAnim { from {opacity: .7} to {opacity: 1} }

    .det-titolo-principale { color: #0b3b4a; font-size: 28px; font-weight: 800; margin: 15px 0 5px 0 !important; line-height: 1.3; }
    .det-localita-sub { font-size: 14px; color: #64748b; margin-bottom: 15px; font-weight: 600; }
    .det-prezzo-grande { font-size: 32px; font-weight: 800; color: #c6a777; margin-bottom: 25px; }

    /* GRIGLIA CARATTERISTICHE */
    .det-caratteristiche-box {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 15px 25px;
        background: #ffffff;
        padding: 20px;
        border-radius: 8px;
        border: 1px solid #eef1f4;
        box-sizing: border-box;
        margin-bottom: 30px;
    }
    .det-car-item { font-size: 14px; color: #475569; display: flex; align-items: center; gap: 10px; }
    .det-car-item b { color: #0b3b4a; font-weight: 700; }
    .det-car-item .badge-ape { background-color: #c6a777; color: white; padding: 2px 7px; border-radius: 4px; font-size: 12px; font-weight: 800; }

    /* RIQUADRO MAPPA */
    .pfc-mappa-container {
        width: 100%;
        height: 250px;
        border-radius: 8px;
        overflow: hidden;
        border: 1px solid #0b3b4a;
        margin-top: 15px;
        margin-bottom: 35px;
    }

    /* RIQUADRO OPEN HOUSE ELEGANTE E MINIMALE */
    .pfc-openhouse-box {
        background-color: #fcfbf9;
        border: 1px solid #ebdcc5;
        border-left: 4px solid #c6a777;
        border-radius: 8px;
        padding: 20px;
        margin-bottom: 30px;
        box-sizing: border-box;
        text-align: left;
    }
    .pfc-openhouse-titolo-linea {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 16px;
        font-weight: 700;
        color: #0b3b4a;
        margin: 0 0 8px 0;
    }
    .pfc-openhouse-titolo-linea .pfc-oh-label {
        color: #475569;
        font-weight: 600;
    }
    .pfc-openhouse-titolo-linea .pfc-oh-data {
        color: #c6a777;
        font-weight: 800;
    }
    .pfc-openhouse-spiegazione {
        font-size: 13px;
        line-height: 1.5;
        color: #64748b;
        font-style: italic;
        margin: 0;
    }

    .sezione-titolo { color: #0b3b4a; margin: 0 0 15px 0 !important; font-weight: 700; font-size: 20px; border-bottom: 2px solid #f1f5f9; padding-bottom: 10px; }
    .testo-descrizione { line-height: 1.7; color: #475569; font-size: 15px; }

    .det-pulsanti-group { display: flex; gap: 15px; flex-wrap: wrap; margin-top: 15px; margin-bottom: 35px; }
    .btn-box-link { flex: 1; min-width: 180px; background: #ffffff; border: 1px solid #0b3b4a; border-radius: 8px; padding: 20px; text-align: center; }
    .btn-box-link h5 { font-size: 14px; color: #0b3b4a; margin-bottom: 12px; font-weight: 700; text-transform: uppercase; }
    .btn-box-action { text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 8px; background: #0b3b4a; color: white; border: none; padding: 10px 18px; font-size: 13px; font-weight: 700; border-radius: 6px; cursor: pointer; transition: background 0.2s; width: 100%; box-sizing: border-box; }
    .btn-box-action:hover { background: #c6a777; }

    .scheda-dettaglio-sidebar { display: flex; flex-direction: column; gap: 25px; width: 100%; }
    .box-contatto-agenzia { background: #f8fafc; border: 1px solid #0b3b4a; padding: 25px; box-sizing: border-box; text-align: center; border-radius: 8px; }
    .pfc-input-field { width: 100%; padding: 12px; margin-bottom: 15px; border: 1px solid #cbd5e1; border-radius: 6px; box-sizing: border-box; font-size: 14px; background: white; color: #334155; text-align: left; }
    .pfc-btn-submit { width: 100%; background: #0b3b4a; color: white; border: none; padding: 14px; font-weight: bold; border-radius: 6px; cursor: pointer; font-size: 15px; transition: background 0.2s; }
    .pfc-btn-submit:hover { background: #c6a777; }

    .box-consulente-immobile { background: white; border: 1px solid #0b3b4a; border-radius: 8px; padding: 25px; box-sizing: border-box; text-align: center; }
    .titolo-consulente { margin: 0 0 15px 0 !important; font-size: 16px; font-weight: 700; color: #0b3b4a; border-bottom: 1px solid #f1f5f9; padding-bottom: 8px; text-align: center !important; }
    .pfc-consulente-foto { width: 110px; height: 110px; border-radius: 50%; overflow: hidden; margin: 0 auto 12px auto; border: 3px solid #f1f5f9; background: #f8fafc; }
    .pfc-consulente-foto img { width: 100%; height: 100%; object-fit: cover; }
    .pfc-consulente-nome { font-size: 16px; font-weight: 700; color: #0b3b4a; margin: 0 0 6px 0; text-align: center; }
    .pfc-consulente-desc { font-size: 13px; color: #64748b; line-height: 1.5; margin: 0 0 18px 0; text-align: center; }
    .pfc-btn-chiamata { text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%; background: #0b3b4a; color: white; padding: 12px; font-weight: 700; border-radius: 6px; font-size: 15px; box-sizing: border-box; transition: background 0.2s; }
    .pfc-btn-chiamata:hover { background: #c6a777; }
    .pfc-ufficio-indirizzo { font-size: 12px; color: #64748b; margin-top: 15px; font-weight: 600; text-align: center; border-top: 1px solid #f1f5f9; padding-top: 12px; }

    /* --- NUOVO BOX SERVIZI EXTRA --- */
    .box-servizi-extra { background: white; border: 1px solid #0b3b4a; border-radius: 8px; padding: 25px; box-sizing: border-box; text-align: center; }
    .servizio-extra-item h5 { font-size: 14px; font-weight: 800; color: #0b3b4a; margin: 0 0 6px 0; text-transform: uppercase; letter-spacing: 0.5px; }
    .servizio-extra-item p { font-size: 13px; color: #64748b; line-height: 1.5; margin: 0 0 12px 0; }
    .pfc-divider { border: 0; height: 1px; background: #cbd5e1; margin: 20px 0; }
    .btn-extra-link { text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%; background: #0b3b4a; color: white; padding: 10px; font-weight: 700; border-radius: 6px; font-size: 13px; box-sizing: border-box; transition: background 0.2s; }
    .btn-extra-link:hover { background: #c6a777; }
    .btn-extra-link.secondary { background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; }
    .btn-extra-link.secondary:hover { background: #e2e8f0; color: #0b3b4a; }

    .btn-chiudi-lightbox { position: absolute; top: 15px; right: 20px; background: none; border: none; font-size: 14px; font-weight: bold; color: #0b3b4a; cursor: pointer; z-index: 10; }
    .btn-chiudi-lightbox:hover { color: #c6a777; }

    /* --- BREAKPOINTS REATTIVI PER MOBILE --- */
    @media (max-width: 992px) {
        .scheda-dettaglio-grid { grid-template-columns: 1fr !important; gap: 35px; width: 100% !important; }
        .scheda-dettaglio-principale { width: 100% !important; display: block; text-align: center !important; }
        .scheda-dettaglio-sidebar { width: 100% !important; }

        .sezione-titolo { text-align: center !important; justify-content: center; padding-bottom: 8px; border-bottom: 2px solid #f1f5f9; }
        .testo-descrizione { text-align: center !important; font-size: 15px; line-height: 1.6; }

        .det-slideshow-container { height: 320px; margin-bottom: 45px !important; width: 100%; }
        body > .pfc-lightbox-overlay { padding: 5px 0px !important; }
        body > .pfc-lightbox-overlay .pfc-lightbox-wrapper { border-radius: 0px !important; padding-top: 55px; max-height: 100vh !important; height: 100% !important; }
        .scheda-immobile-singola-container { padding: 0 15px !important; }

        .btn-chiudi-lightbox { top: 12px; right: 12px; padding: 8px 14px; font-size: 13px; background: #f1f5f9; border-radius: 6px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .pfc-dots-container { bottom: -30px !important; }
    }

    @media (max-width: 768px) {
        .barra-filtri { flex-direction: column !important; gap: 15px !important; padding: 15px !important; width: 100% !important;}
        .filtro-gruppo { width: 100% !important; flex: none !important;}
        .filtro-gruppo select { width: 100% !important; }
        .det-info-overlay-foto { gap: 8px; padding: 15px 10px; }
        .det-info-overlay-badge { font-size: 10px; padding: 4px 8px; }

        .scheda-immobile-singola-container { padding: 0 12px !important; }
        .det-caratteristiche-box { grid-template-columns: 1fr 1fr; gap: 12px; padding: 12px !important; margin-bottom: 25px; }
        .det-car-item { font-size: 13px !important; }
        .det-titolo-principale { font-size: 23px !important; text-align: center !important; }
        .det-localita-sub { text-align: center !important; }
        .det-prezzo-grande { text-align: center !important; }

        .det-slideshow-container { margin-bottom: 45px !important; }
        .pfc-dots-container { bottom: -30px !important; }
    }
</style>

<script>
/* ============================================================
   FONTE DATI: adesso la pagina legge direttamente dal CRM Forte
   (sezione Incarichi) tramite la rotta pubblica /api/pubblico/immobili.
   Niente più file Excel: gli immobili, il prezzo, lo stato e il consulente
   arrivano da dove i consulenti li lavorano davvero.
   ============================================================ */
const API_IMMOBILI_URL = "https://forte-crm-backend.onrender.com/api/pubblico/immobili";

let immobiliElenco = [];
const originalPageTitle = document.title;
const dizionarioProvince = {
    "mozzate": "CO", "lomazzo": "CO", "rovellasca": "CO",
    "canegrate": "MI", "legnano": "MI", "san vittore olona": "MI", "magnago": "MI", "milano": "MI",
    "solbiate olona": "VA", "caronno pertusella": "VA", "cairate": "VA", "gallarate": "VA", "busto arsizio": "VA", "samarate": "VA", "mornago": "VA"
};

// Sede agenzia usata come ripiego se un immobile non ha un consulente collegato.
const AGENZIA_FALLBACK = {
    nome: "Forte Immobiliare",
    ruolo: "Consulente di riferimento",
    foto: "",
    telefono: "+39 0331 173 4391",
    telefonoRaw: "03311734391"
};

function parseDriveUrl(url) {
    if (!url) return '';
    let u = String(url).trim();
    u = u.replace(/^"+|"+$/g, '');
    if (!u) return '';
    if (!u.startsWith('http')) return '';
    // Link "condividi" di Google Drive -> immagine mostrabile
    let match = u.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) match = u.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (match && match[1]) {
        return `https://drive.google.com/thumbnail?id=${match[1]}&sz=w1600`;
    }
    // Già un URL immagine diretto (es. lh3.googleusercontent.com): lascialo com'è
    return u;
}

function ottieniComuneEProvincia(comuneGrezzo) {
    let comune = (comuneGrezzo || "").trim();
    if (!comune) return { comune: "", provincia: "", testoCompleto: "" };
    let chiave = comune.toLowerCase();
    let prov = dizionarioProvince[chiave];
    if (prov) return { comune: comune, provincia: prov, testoCompleto: `${comune} (${prov})` };
    return { comune: comune, provincia: "", testoCompleto: comune };
}

async function analizzaData() {
    try {
        const response = await fetch(API_IMMOBILI_URL);
        if (!response.ok) throw new Error("Errore nel recupero dei dati.");
        const dati = await response.json();

        if (!Array.isArray(dati) || dati.length === 0) {
            document.getElementById("pfc_loading_status").innerHTML = "⚠️ Nessun immobile disponibile al momento.";
            immobiliElenco = [];
            return;
        }

        // Converte la data dell'evento: gestisce il numero seriale Excel (es. 46193),
        // il formato AAAA-MM-GG e GG/MM/AAAA. Restituisce GG/MM/AAAA leggibile.
        const formattaDataEvento = (v) => {
            if (v === null || v === undefined) return '';
            const s = String(v).trim();
            if (!s) return '';
            if (/^\d{4,6}$/.test(s)) { // seriale Excel (giorni dal 30/12/1899)
                const d = new Date(Date.UTC(1899, 11, 30) + parseInt(s, 10) * 86400000);
                if (!isNaN(d.getTime())) return ('0' + d.getUTCDate()).slice(-2) + '/' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '/' + d.getUTCFullYear();
            }
            let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
            if (m) return m[3] + '/' + m[2] + '/' + m[1];
            return s;
        };

        // Adatto la risposta del CRM alla forma che il resto della pagina usa già.
        immobiliElenco = dati.map((r, i) => {
            const fotoSane = (r.foto || []).map(parseDriveUrl).filter(x => x !== '');
            const cop = fotoSane.length > 0 ? fotoSane[0] : "https://placehold.co/600x400?text=Foto+In+Arrivo";
            const cons = r.consulente || null;
            return {
                rif: r.rif || `IF-${i}`,
                titolo: r.titolo || '',
                contratto: r.contratto || 'vendita',
                isVenduto: !!r.isVenduto,
                comuneOriginale: r.comune || '',
                via: r.via || '',
                civico: r.civico || '',
                contesto: r.contesto || '',
                tipologia: r.tipologia || '',
                prezzo: parseFloat(r.prezzo) || 0,
                locales: parseInt(r.locali) || 0,
                mq: parseInt(r.mq) || 0,
                bagni: parseInt(r.bagni) || 0,
                prossimoOh: formattaDataEvento(r.prossimoOh),
                prossimoOhOrario: r.prossimoOhOrario || '',
                linkVideo: (r.linkVideo || '').trim(),
                linkVirtual: (r.linkVirtual || '').trim(),
                linkDoc: (r.linkDoc || '').trim(),
                copertina: cop,
                descrizione: r.descrizione || '',
                fotoArray: fotoSane,
                ape: r.ape || 'N.D.',
                ipe: r.ipe || '',
                speseCondominiali: r.speseCondominiali || '',
                piano: r.piano || 'N.D.',
                ascensore: r.ascensore || 'NO',
                consulente: cons
            };
        }).filter(x => x.titolo);

        const lightboxEl = document.getElementById("pfc_lightbox_dettaglio");
        if (lightboxEl && lightboxEl.parentNode !== document.body) {
            document.body.appendChild(lightboxEl);
        }

        inizializzaFiltroComuni();
        filtraImmobili();   // parte dai Disponibili (default del filtro Stato)

        const queryParams = new URLSearchParams(window.location.search);
        const rifParam = queryParams.get('rif');
        if (rifParam) apriLightboxImmobile(rifParam, true);

    } catch (error) {
        console.error(error);
        document.getElementById("pfc_loading_status").innerHTML = "⚠️ Si è verificato un errore durante la sincronizzazione dei dati.";
    }
}

function inizializzaFiltroComuni() {
    const selectComune = document.getElementById("filtro_comune");
    selectComune.innerHTML = '<option value="tutti">Tutti i Comuni</option>';
    const comuniSet = new Set();
    immobiliElenco.forEach(immobile => { if(immobile.comuneOriginale) comuniSet.add(immobile.comuneOriginale); });
    const comuniOrdinati = Array.from(comuniSet).sort();
    comuniOrdinati.forEach(comune => {
        const info = ottieniComuneEProvincia(comune);
        const option = document.createElement("option");
        option.value = info.comune; option.text = info.testoCompleto;
        selectComune.appendChild(option);
    });
}

function mostraImmobili(lista) {
    const contenitore = document.getElementById("elenco_immobili");
    contenitore.innerHTML = "";

    if(lista.length === 0) {
        contenitore.innerHTML = "<div style='grid-column:1/-1; padding:20px; color:#64748b; text-align:center;'>Nessun immobile disponibile.</div>";
        return;
    }

    lista.sort((a, b) => {
        const cA = a.comuneOriginale.toLowerCase();
        const cB = b.comuneOriginale.toLowerCase();
        if (cA < cB) return -1; if (cA > cB) return 1;
        return b.prezzo - a.prezzo;
    });

    lista.forEach(immobile => {
        const stringaLocali = immobile.locales > 0 ? `${immobile.locales} Locali` : "Uso Speciale";
        const localitaConProvincia = ottieniComuneEProvincia(immobile.comuneOriginale).testoCompleto;

        let prezzoHtml = ""; let badgeVendutoHtml = "";
        let etichettaContratto = immobile.contratto.toUpperCase();
        let classeTag = "tag-vendita";

        if (immobile.isVenduto) {
            if (immobile.contratto === "affitto") {
                etichettaContratto = "AFFITTATO";
                classeTag = "tag-venduti";
                prezzoHtml = `<div class="prezzo-venduto-card">AFFITTATO</div>`;
                badgeVendutoHtml = `<div class="pfc-colonna-diagonale-v"><div class="pfc-card-diagonale-venduto">AFFITTATO</div></div>`;
            } else {
                etichettaContratto = "VENDUTO";
                classeTag = "tag-venduti";
                prezzoHtml = `<div class="prezzo-venduto-card">VENDUTO</div>`;
                badgeVendutoHtml = `<div class="pfc-colonna-diagonale-v"><div class="pfc-card-diagonale-venduto">VENDUTO</div></div>`;
            }
        } else {
            prezzoHtml = `<div class="prezzo">€ ${immobile.prezzo.toLocaleString('it-IT')}</div>`;
        }

        contenitore.innerHTML += `
            <div class="card-immobile" data-rif="${immobile.rif}" onclick="intercettaClicCard(event, '${immobile.rif}')">
                <div class="card-img-wrapper">
                    ${badgeVendutoHtml}
                    <img src="${immobile.copertina}" class="card-img-top" alt="Anteprima" referrerpolicy="no-referrer">
                </div>
                <div class="card-info">
                    <span class="tag-contratto ${classeTag}">${etichettaContratto}</span>
                    <h4><a href="?rif=${immobile.rif}" style="text-decoration:none; color:inherit; pointer-events:none;">${immobile.titolo}</a></h4>
                    ${prezzoHtml}
                    <div class="localita">📍 ${localitaConProvincia}</div>
                </div>
                <div class="card-dettagli-fascia">
                    <span>🚪 ${stringaLocali}</span>
                    <span>📐 ${immobile.mq} mq</span>
                </div>
            </div>
        `;
    });
}

function filtraImmobili() {
    const statoScelto = document.getElementById("filtro_stato").value;          // disponibili | venduti
    const contrattoScelto = document.getElementById("filtro_contratto").value;  // tutti | vendita | affitto | riscatto
    const comuneScelto = document.getElementById("filtro_comune").value;
    const prezzoScelto = document.getElementById("filtro_prezzo").value;
    const localesScelti = parseInt(document.getElementById("filtro_locali").value);

    const immobiliFiltrati = immobiliElenco.filter(immobile => {
        // STATO: disponibili = ancora sul mercato; venduti = conclusi (rogitati + preliminari)
        const matchStato = (statoScelto === "venduti") ? immobile.isVenduto : !immobile.isVenduto;

        // CONTRATTO: solo il tipo (lo stato è gestito sopra)
        let matchContratto = true;
        if (contrattoScelto === "vendita") matchContratto = (immobile.contratto === "vendita" || immobile.contratto === "asta");
        else if (contrattoScelto === "affitto") matchContratto = (immobile.contratto === "affitto");
        else if (contrattoScelto === "riscatto") matchContratto = (immobile.contratto === "affitto a riscatto");

        const matchComune = (comuneScelto === "tutti" || immobile.comuneOriginale === comuneScelto);
        const matchPrezzo = (prezzoScelto === "inf" || immobile.prezzo <= parseInt(prezzoScelto));
        const matchLocali = (immobile.locales >= localesScelti);
        return matchStato && matchContratto && matchComune && matchPrezzo && matchLocali;
    });
    mostraImmobili(immobiliFiltrati);
}

function intercettaClicCard(e, rif) { e.preventDefault(); apriLightboxImmobile(rif); }

function apriLightboxImmobile(rif, skipHistoryUpdate = false) {
    let immobile = immobiliElenco.find(item => item.rif === rif);
    if(!immobile) return;

    let azioneContratto = "in vendita";
    if (immobile.contratto === "affitto") azioneContratto = immobile.isVenduto ? "affittata" : "in affitto";
    else if (immobile.contratto === "asta") azioneContratto = "in asta";
    else if (immobile.contratto === "affitto a riscatto") azioneContratto = "in affitto a riscatto";
    else if (immobile.isVenduto) azioneContratto = "venduta";

    document.title = `Casa ${azioneContratto} a ${immobile.comuneOriginale} - Rif. ${immobile.rif} | Forte Immobiliare`;
    let slugUrlParam = `casa-${azioneContratto.replace(/[^a-z0-9]+/g, '-')}-a-${immobile.comuneOriginale.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

    const localitaConProvincia = ottieniComuneEProvincia(immobile.comuneOriginale).testoCompleto;

    let prezzoTesto = "";
    let etichettaContratto = immobile.contratto.toUpperCase();
    let classeTag = "tag-vendita";

    if (immobile.isVenduto) {
        if (immobile.contratto === "affitto") {
            prezzoTesto = `<div class="det-prezzo-grande prezzo-venduto-testo">AFFITTATO</div>`;
            etichettaContratto = "AFFITTATO"; classeTag = "tag-venduti";
        } else {
            prezzoTesto = `<div class="det-prezzo-grande prezzo-venduto-testo">VENDUTO</div>`;
            etichettaContratto = "VENDUTO"; classeTag = "tag-venduti";
        }
    } else {
        prezzoTesto = `<div class="det-prezzo-grande">€ ${immobile.prezzo.toLocaleString('it-IT')}</div>`;
    }

    let fotoArray = immobile.fotoArray;
    if (fotoArray.length === 0) fotoArray = ["https://placehold.co/600x400?text=Foto+In+Arrivo"];

    let slideHtml = ""; let dotsHtml = "";
    fotoArray.forEach((foto, index) => {
        slideHtml += `<div class="pfc-slide fade" style="display: ${index === 0 ? 'block' : 'none'}"><img src="${foto}" alt="Slide" referrerpolicy="no-referrer"></div>`;
        dotsHtml += `<span class="pfc-dot ${index === 0 ? 'active' : ''}" onclick="vaiAllaSlide(${index + 1})"></span>`;
    });

    let badgeDiagonaleVenduto = "";
    if (immobile.isVenduto) badgeDiagonaleVenduto = `<div class="pfc-diagonale-venduto">${immobile.contratto === "affitto" ? "AFFITTATO" : "VENDUTO"}</div>`;

    let infoOverlayHtml = `
        <div class="det-info-overlay-foto">
            <div class="det-info-overlay-badge"><span>Rif.</span> ${immobile.rif}</div>
            ${immobile.contesto ? `<div class="det-info-overlay-badge"><span>Contesto:</span> ${immobile.contesto}</div>` : ''}
            ${immobile.tipologia ? `<div class="det-info-overlay-badge"><span>Tipo:</span> ${immobile.tipologia}</div>` : ''}
        </div>
    `;

    let openHouseHtml = "";
    if (immobile.prossimoOh && immobile.prossimoOh.trim() !== "") {
        openHouseHtml = `
            <div class="pfc-openhouse-box">
                <div class="pfc-openhouse-titolo-linea">
                    <span>📅</span>
                    <span class="pfc-oh-label">Prossimo Evento Casa Forte:</span>
                    <span class="pfc-oh-data">${immobile.prossimoOh}${immobile.prossimoOhOrario ? ' &middot; ' + immobile.prossimoOhOrario : ''}</span>
                </div>
                <p class="pfc-openhouse-spiegazione">
                    (Evento Casa Forte è la nostra giornata di porte aperte per visitare l'immobile. Se la data è già passata o non ci sono date disponibili, contatta il consulente dedicato per fissare una visita privata).
                </p>
            </div>
        `;
    }

    let formatoSpese = (immobile.speseCondominiali && immobile.speseCondominiali !== "0" && immobile.speseCondominiali.toLowerCase() !== "nessuna") ? `${immobile.speseCondominiali}` : "Nessuna";
    let formatoAscensore = (immobile.ascensore && immobile.ascensore.toUpperCase() === "SI") ? "🟢 Sì" : "⚪ No";

    let indirizzoMappaCodificato = encodeURIComponent(`${immobile.via} ${immobile.civico}, ${immobile.comuneOriginale}`);
    let mappaIframeHtml = `
        <div class="pfc-mappa-container">
            <iframe width="100%" height="100%" frameborder="0" style="border:0;"
                src="https://maps.google.com/maps?q=${indirizzoMappaCodificato}&t=&z=14&ie=UTF8&iwloc=&output=embed" allowfullscreen>
            </iframe>
        </div>
    `;

    // --- CONSULENTE: dati reali dal CRM (con ripiego sull'agenzia) ---
    let cons = immobile.consulente || AGENZIA_FALLBACK;
    let agenteNome = cons.nome || AGENZIA_FALLBACK.nome;
    let agenteRuolo = cons.ruolo || AGENZIA_FALLBACK.ruolo;
    let agenteTelefono = cons.telefono || AGENZIA_FALLBACK.telefono;
    let agenteTelefonoRaw = (cons.telefonoRaw || cons.telefono || AGENZIA_FALLBACK.telefonoRaw).replace(/[^0-9+]/g, '');
    let agenteFotoConvertita = cons.foto ? parseDriveUrl(cons.foto) : "https://placehold.co/200x200?text=Forte";

    let moduloContattiHtml = "";
    if (immobile.isVenduto) {
        moduloContattiHtml = `
            <div class="box-contatto-agenzia" style="opacity: 0.85;">
                <h4 style="margin:0 0 5px 0 !important; font-weight:700; color:#0b3b4a;">Richiedi Informazioni</h4>
                <p style="font-size: 13px; color: #64748b; margin: 0 0 20px 0;">Forte Immobiliare</p>
                <div style="background: #fee2e2; color: #b91c1c; padding: 15px; border-radius: 6px; font-weight: 600; font-size: 14px; text-align: center;">
                    Le trattative commerciali per questo immobile sono ufficialmente concluse.
                </div>
            </div>`;
    } else {
        moduloContattiHtml = `
            <div class="box-contatto-agenzia">
                <h4 style="margin:0 0 5px 0 !important; font-weight:700; color:#0b3b4a;">Richiedi Informazioni</h4>
                <p style="font-size: 13px; color: #64748b; margin: 0 0 20px 0;">Forte Immobiliare</p>
                <form action="https://formspree.io/f/mlgywjdk" method="POST">
                    <input type="hidden" name="Riferimento_Immobile" value="${immobile.rif}">
                    <input type="hidden" name="Immobile_Interesse" value="${immobile.titolo}">
                    <input type="text" name="Nome_Cliente" placeholder="Il tuo Nome" required class="pfc-input-field">
                    <input type="email" name="Email_Cliente" placeholder="La tua Email" required class="pfc-input-field">
                    <input type="tel" name="Telefono_Cliente" placeholder="Il tuo Telefono" required class="pfc-input-field">
                    <textarea name="Messaggio" rows="4" class="pfc-input-field" style="resize:none;">Buongiorno, desidero ricevere dettagli commerciali in merito all'immobile Rif: ${immobile.rif}.</textarea>
                    <button type="submit" class="pfc-btn-submit">Contatta Agenzia</button>
                </form>
            </div>`;
    }

    // --- PRENOTA VISITA (Open House): link diretto alla disponibilità, solo se c'è un OH futuro ---
    let prenotaOhHtml = "";
    if (!immobile.isVenduto && immobile.prossimoOhId) {
        const linkPren = `https://forte-crm-backend.onrender.com/prenota-openhouse?id=${encodeURIComponent(immobile.prossimoOhId)}`;
        prenotaOhHtml = `
            <div class="box-consulente-immobile" style="border-color:#c9a86a; background:linear-gradient(180deg,#fffdf7,#ffffff);">
                <h4 class="titolo-consulente" style="border-bottom-color:#f0e6cf;">📅 Prenota una visita</h4>
                <p style="font-size:13px; color:#64748b; margin:0 0 16px 0; text-align:center; line-height:1.5;">
                    Scegli tu l'orario all'Open House${immobile.prossimoOh ? ' del <b>' + immobile.prossimoOh + '</b>' : ''}: prenotazione immediata online, ti confermiamo subito lo slot.
                </p>
                <a href="${linkPren}" target="_blank" rel="noopener" class="pfc-btn-submit" style="display:block; text-align:center; text-decoration:none;">Prenota il tuo slot →</a>
            </div>`;
    }

    let multimedialeHtml = `<h3 class="sezione-titolo">Materiale Multimediale</h3><div class="det-pulsanti-group">`;
    if (immobile.linkVideo) multimedialeHtml += `<div class="btn-box-link"><h5>Video Visita</h5><a href="${immobile.linkVideo}" target="_blank" class="btn-box-action">▶ Guarda il Video</a></div>`;
    else multimedialeHtml += `<div class="btn-box-link" style="opacity: 0.65;"><h5>Video Visita</h5><button class="btn-box-action" style="background:#cbd5e1; color:#64748b; cursor:not-allowed;" disabled>Non Disponibile</button></div>`;
    if (immobile.linkVirtual) multimedialeHtml += `<div class="btn-box-link"><h5>Virtual Tour 3D</h5><a href="${immobile.linkVirtual}" target="_blank" class="btn-box-action">📐 Esplora Virtual Tour</a></div>`;
    else multimedialeHtml += `<div class="btn-box-link" style="opacity: 0.65;"><h5>Virtual Tour 3D</h5><button class="btn-box-action" style="background:#cbd5e1; color:#64748b; cursor:not-allowed;" disabled>Non Disponibile</button></div>`;
    if (immobile.linkDoc) multimedialeHtml += `<div class="btn-box-link"><h5>Documenti</h5><a href="${immobile.linkDoc}" target="_blank" class="btn-box-action">📂 Scarica Allegati</a></div>`;
    else multimedialeHtml += `<div class="btn-box-link" style="opacity: 0.65;"><h5>Documenti</h5><button class="btn-box-action" style="background:#cbd5e1; color:#64748b; cursor:not-allowed;" disabled>Non Disponibile</button></div>`;
    multimedialeHtml += `</div>`;

    let extraServicesHtml = "";
    if (immobile.contratto === "affitto") {
        extraServicesHtml = `
            <div class="box-servizi-extra">
                <h4 class="titolo-consulente">I Nostri Servizi</h4>
                <div class="servizio-extra-item">
                    <h5>Vuoi affittare il tuo immobile?</h5>
                    <p>Affidati a Forte Immobiliare per trovare inquilini referenziati grazie a un piano di marketing e selezione su misura.</p>
                    <a href="https://www.immobiliareforte.com/vendere-casa" target="_blank" class="btn-extra-link">📈 Affitta il tuo Immobile</a>
                </div>
                <hr class="pfc-divider">
                <div class="servizio-extra-item">
                    <h5>Vuoi prendere in affitto questa casa?</h5>
                    <p>Contatta direttamente il consulente dedicato per preparare la tua proposta di locazione e i documenti necessari.</p>
                    <a href="tel:${agenteTelefonoRaw}" class="btn-extra-link secondary">📊 Parla con il Consulente</a>
                </div>
            </div>`;
    } else {
        extraServicesHtml = `
            <div class="box-servizi-extra">
                <h4 class="titolo-consulente">I Nostri Servizi</h4>
                <div class="servizio-extra-item">
                    <h5>Devi vendere casa?</h5>
                    <p>Scopri la valutazione del tuo immobile e il piano marketing personalizzato Forte Immobiliare.</p>
                    <a href="https://www.immobiliareforte.com/vendere-casa" target="_blank" class="btn-extra-link">📈 Valuta il tuo Immobile</a>
                </div>
                <hr class="pfc-divider">
                <div class="servizio-extra-item">
                    <h5>Vuoi comprare questa casa?</h5>
                    <p>Calcola preventivamente le imposte e le spese di acquisto previste per l'immobile dei tuoi sogni.</p>
                    <a href="https://www.immobiliareforte.com/comprare-casa" target="_blank" class="btn-extra-link secondary">📊 Calcola spese d'acquisto</a>
                </div>
            </div>`;
    }

    const target = document.getElementById("pfc_lightbox_contenuto_dinamico");
    target.innerHTML = `
        <div class="scheda-immobile-singola-container">
            <a href="javascript:void(0)" onclick="chiudiLightbox()" class="btn-ritorno-pagina">❮ Torna all'elenco immobili</a>

            <div class="scheda-dettaglio-grid">
                <div class="scheda-dettaglio-principale">
                    <div class="det-slideshow-container">
                        ${badgeDiagonaleVenduto}
                        ${slideHtml}
                        <button class="pfc-prev" onclick="cambiaSlide(-1)">❮</button>
                        <button class="pfc-next" onclick="cambiaSlide(1)">❯</button>
                        <div class="pfc-dots-container">${dotsHtml}</div>
                        ${infoOverlayHtml}
                    </div>

                    <span class="tag-contratto ${classeTag}">${etichettaContratto}</span>
                    <h1 class="det-titolo-principale">${immobile.titolo}</h1>
                    <div class="det-localita-sub">📍 ${[[immobile.via, immobile.civico].filter(Boolean).join(' ').trim(), localitaConProvincia].filter(Boolean).join(', ') || 'Indirizzo non disponibile'}</div>
                    ${prezzoTesto}

                    <div class="det-caratteristiche-box">
                        <div class="det-car-item"><span>🚪</span> Locali: <b>${immobile.locales}</b></div>
                        <div class="det-car-item"><span>📐</span> Superficie: <b>${immobile.mq} mq</b></div>
                        <div class="det-car-item"><span>🛀</span> Bagni: <b>${immobile.bagni}</b></div>
                        <div class="det-car-item"><span>⚡</span> Classe Energetica: <span class="badge-ape">${immobile.ape}</span>${immobile.ipe ? ` <span style="color:#64748b; font-size:13px;">(IPE ${immobile.ipe} kWh/m²a)</span>` : ''}</div>
                        <div class="det-car-item"><span>🏢</span> Piano: <b>${immobile.piano}</b></div>
                        <div class="det-car-item"><span>🛗</span> Ascensore: <b>${formatoAscensore}</b></div>
                        <div class="det-car-item" style="grid-column: 1 / -1;"><span>🪙</span> Spese Condominiali: <b>${formatoSpese}</b></div>
                    </div>

                    ${openHouseHtml}

                    <h3 class="sezione-titolo">Descrizione dell'immobile</h3>
                    <p class="testo-descrizione" style="margin-bottom: 25px;">
                        ${immobile.descrizione.replace(/\n/g, '<br>')}
                    </p>

                    ${multimedialeHtml}

                    <h3 class="sezione-titolo">Posizione e Servizi</h3>
                    ${mappaIframeHtml}
                </div>

                <div class="scheda-dettaglio-sidebar">
                    ${moduloContattiHtml}

                    ${prenotaOhHtml}

                    <div class="box-consulente-immobile">
                        <h4 class="titolo-consulente">Consulente di Riferimento</h4>
                        <div class="pfc-consulente-foto">
                            <img src="${agenteFotoConvertita}" alt="Consulente" referrerpolicy="no-referrer">
                        </div>
                        <p class="pfc-consulente-nome">${agenteNome}</p>
                        <p class="pfc-consulente-desc">${agenteRuolo} dedicato alla gestione dell'immobile.</p>
                        <a href="tel:${agenteTelefonoRaw}" class="pfc-btn-chiamata">📞 Chiama ${agenteTelefono}</a>
                        <div class="pfc-ufficio-indirizzo">📍 Legnano, via Cesare Beccaria 9</div>
                    </div>

                    ${extraServicesHtml}
                </div>
            </div>
        </div>
    `;

    const lightbox = document.getElementById("pfc_lightbox_dettaglio");
    lightbox.style.display = "block";
    document.body.style.overflow = "hidden";
    setTimeout(() => { lightbox.style.opacity = "1"; }, 10);

    slideIndex = 1;
    mostraSlide(slideIndex);

    if(!skipHistoryUpdate) history.pushState({rif: rif}, '', `?rif=${rif}&${slugUrlParam}`);
}

function chiudiLightbox() {
    const lightbox = document.getElementById("pfc_lightbox_dettaglio");
    if(lightbox) {
        lightbox.style.opacity = "0";
        setTimeout(() => { lightbox.style.display = "none"; document.body.style.overflow = "auto"; }, 200);
    }
    document.title = originalPageTitle;
    history.pushState(null, '', window.location.pathname);
}

function chiudiLightboxViaOverlay(e) { if(e.target.classList.contains("pfc-lightbox-overlay")) chiudiLightbox(); }
let slideIndex = 1;
function cambiaSlide(n) { mostraSlide(slideIndex += n); }
function vaiAllaSlide(n) { mostraSlide(slideIndex = n); }
function mostraSlide(n) {
    let i; let slides = document.getElementsByClassName("pfc-slide"); let dots = document.getElementsByClassName("pfc-dot");
    if (slides.length === 0) return;
    if (n > slides.length) { slideIndex = 1 } if (n < 1) { slideIndex = slides.length }
    for (i = 0; i < slides.length; i++) { slides[i].style.display = "none"; }
    for (i = 0; i < dots.length; i++) { dots[i].className = dots[i].className.replace(" active", ""); }
    if(slides[slideIndex-1]) slides[slideIndex-1].style.display = "block";
    if(dots[slideIndex-1]) dots[slideIndex-1].className += " active";
}

window.addEventListener('popstate', () => {
    const queryParams = new URLSearchParams(window.location.search);
    const rifParam = queryParams.get('rif');
    if (rifParam) apriLightboxImmobile(rifParam, true);
    else chiudiLightbox();
});

document.addEventListener("DOMContentLoaded", analizzaData);
</script>
