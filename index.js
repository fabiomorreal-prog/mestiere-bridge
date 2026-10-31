const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// --- FIREBASE ---
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log("✅ Firebase connesso");
} catch (e) { 
  console.error("❌ Firebase:", e.message); 
}
const db = admin.firestore();

// --- CONFIG ---
const EVOLUTION_URL = (process.env.EVOLUTION_URL || "").replace(/\/$/, "");
const EVOLUTION_APIKEY = process.env.EVOLUTION_APIKEY;

function cleanName(id) {
  return id.toLowerCase().replace(/[^a-z0-9_]/g, "_").substring(0, 30);
}

// --- LOGICA CREAZIONE ISTANZA ---
async function createInstanceLogic(professionalId) {
  const instanceName = cleanName(professionalId);
  console.log(`Creating instance: ${instanceName}`);
  
  await axios.post(`${EVOLUTION_URL}/instance/create`, {
    instanceName,
    qrcode: true,
    integration: "WHATSAPP-BAILEYS"
  }, { headers: { apikey: EVOLUTION_APIKEY } });

  await db.collection('professionals').doc(instanceName).set({
    professionalId: instanceName,
    status: 'created',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  // Imposta webhook automatico verso questo bridge
  try {
    const bridgeUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'mestiere-bridge-production.up.railway.app'}/webhook`;
    await axios.post(`${EVOLUTION_URL}/webhook/set/${instanceName}`, {
      url: bridgeUrl,
      webhookByEvents: true,
      webhookBase64: false,
      events: ["MESSAGES_UPSERT"]
    }, { headers: { apikey: EVOLUTION_APIKEY } });
    console.log(`Webhook impostato per ${instanceName} -> ${bridgeUrl}`);
  } catch (e) {
    console.log("Webhook set warning:", e.response?.data || e.message);
  }

  return instanceName;
}

// --- 1. CREA ISTANZA (POST per app) ---
app.post('/create-instance', async (req, res) => {
  try {
    const name = await createInstanceLogic(req.body.professionalId || `prof_${Date.now()}`);
    res.json({ success: true, instance: name, next: `/pairing-code/${name}` });
  } catch (err) {
    // Se esiste già, non è errore
    if (JSON.stringify(err.response?.data).includes("already in use")) {
      const name = cleanName(req.body.professionalId);
      return res.json({ success: true, instance: name, message: "already exists", next: `/pairing-code/${name}` });
    }
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// --- 2. CREA ISTANZA (GET per test da browser) ---
app.get('/create-instance/:professionalId', async (req, res) => {
  try {
    const name = await createInstanceLogic(req.params.professionalId);
    res.json({ success: true, instance: name, next: `/pairing-code/${name}` });
  } catch (err) {
    if (JSON.stringify(err.response?.data).includes("already in use")) {
      const name = cleanName(req.params.professionalId);
      return res.json({ success: true, instance: name, message: "already exists", next: `/pairing-code/${name}` });
    }
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// --- 3. OTTIENI QR CODE (vecchio) ---
app.get('/pairing-code/:instance', async (req, res) => {
  try {
    const r = await axios.get(`${EVOLUTION_URL}/instance/connect/${req.params.instance}`, {
      headers: { apikey: EVOLUTION_APIKEY }
    });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// --- 4. NUOVO: RICHIESTA CODICE 8 CIFRE PER AUTO-COLLEGAMENTO APP ---
// Chiamata dall'app Mestiere: POST /request-pairing-code { professionalId, phone: "39347..." }
app.post('/request-pairing-code', async (req, res) => {
  try {
    const { professionalId, phone } = req.body;
    if (!professionalId || !phone) {
      return res.status(400).json({ error: "Servono professionalId e phone" });
    }
    const instanceName = cleanName(professionalId);
    const cleanPhone = phone.replace(/[^0-9]/g, ""); // solo numeri, es 393471234567

    // Prova a creare l'istanza se non esiste
    try { await createInstanceLogic(instanceName); } catch (e) {
      if (!JSON.stringify(e.response?.data).includes("already in use")) throw e;
    }

    // Evolution v2: pairing code si ottiene con ?number=
    // Proviamo due formati per compatibilità
    let evoRes;
    try {
      // Formato 1: GET con number come query
      evoRes = await axios.get(`${EVOLUTION_URL}/instance/connect/${instanceName}`, {
        headers: { apikey: EVOLUTION_APIKEY },
        params: { number: cleanPhone }
      });
    } catch (err) {
      // Formato 2: PUT con body { number }
      evoRes = await axios.put(`${EVOLUTION_URL}/instance/connect/${instanceName}`, {
        number: cleanPhone
      }, { headers: { apikey: EVOLUTION_APIKEY } });
    }

    const data = evoRes.data;
    // Normalizza risposta: può essere pairingCode, code, ecc.
    const pairingCode = data.pairingCode || data.code || data.pairing_code || null;

    await db.collection('professionals').doc(instanceName).set({
      lastPairingPhone: cleanPhone,
      lastPairingCode: pairingCode,
      lastPairingAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({
      success: true,
      instance: instanceName,
      phone: cleanPhone,
      pairingCode: pairingCode, // es. "A1B2C3D4" o "2@...."
      qrBase64: data.base64 || data.qrcode?.base64 || null,
      fullResponse: data, // utile per debug
      instructions: "Vai su WhatsApp > Dispositivi collegati > Collega un dispositivo > Collega con numero di telefono invece > Inserisci il pairingCode"
    });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// --- 5. STATO CONNESSIONE ---
app.get('/status/:instance', async (req, res) => {
  try {
    const r = await axios.get(`${EVOLUTION_URL}/instance/connectionState/${req.params.instance}`, {
      headers: { apikey: EVOLUTION_APIKEY }
    });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// --- 6. WEBHOOK: ARRIVO MESSAGGI -> FIREBASE JOBS (isolato per idraulico) ---
app.post('/webhook', async (req, res) => {
  try {
    const instanceName = req.body.instance || req.body.instanceName || 'unknown';
    const data = req.body.data;
    const txt = data?.message?.conversation || data?.message?.extendedTextMessage?.text || "";
    const jid = data?.key?.remoteJid || "";
    
    // Filtri sicurezza
    if (data?.key?.fromMe) return res.sendStatus(200); // non salvare i miei messaggi
    if (jid.includes('@g.us')) return res.sendStatus(200); // ignora gruppi
    if (!txt || txt.length < 2) return res.sendStatus(200);

    console.log(`[JOB] ${instanceName} da ${jid}: ${txt.substring(0,50)}`);

    await db.collection('jobs').add({
      professionalId: instanceName,
      clientPhone: jid.replace('@s.whatsapp.net',''),
      clientJid: jid,
      description: txt,
      status: 'nuovo',
      source: 'whatsapp',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.sendStatus(200);
  } catch(e){ 
    console.error("Webhook err:", e.message);
    res.sendStatus(200); 
  }
});

// --- HOME ---
app.get('/', (req,res) => res.send(`Mestiere Bridge v4 OK - Auto-pairing ready - ${new Date().toISOString()}`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bridge v4 su ${PORT}`));
