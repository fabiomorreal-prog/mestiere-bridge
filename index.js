const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- FIREBASE ---
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("✅ Firebase connesso");
} catch (e) {
  console.error("❌ Errore Firebase SERVICE_ACCOUNT:", e.message);
}
const db = admin.firestore();

// --- EVOLUTION CONFIG ---
const EVOLUTION_URL = process.env.EVOLUTION_URL || "https://zonal-vision-production.up.railway.app";
const EVOLUTION_APIKEY = process.env.EVOLUTION_APIKEY || process.env.AUTHENTICATION_API_KEY;

const evolutionHeaders = {
  'apikey': EVOLUTION_APIKEY,
  'Content-Type': 'application/json'
};

// --- 1. CREA ISTANZA PER UN PROFESSIONISTA ---
// Chiamata da FlutterFlow: POST /create-instance { "professionalId": "mario_rossi_123" }
app.post('/create-instance', async (req, res) => {
  const { professionalId } = req.body;
  if (!professionalId) return res.status(400).json({ error: "professionalId mancante" });

  const instanceName = professionalId.toLowerCase().replace(/[^a-z0-9_]/g, "_");

  try {
    // Crea istanza su Evolution
    await axios.post(`${EVOLUTION_URL}/instance/create`, {
      instanceName: instanceName,
      qrcode: true,
      integration: "WHATSAPP-BAILEYS"
    }, { headers: evolutionHeaders });

    // Imposta webhook per questa istanza specifica
    await axios.post(`${EVOLUTION_URL}/webhook/set/${instanceName}`, {
      webhook: {
        enabled: true,
        url: `${process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'https://mestiere-bridge-production.up.railway.app'}/webhook`,
        byEvents: false,
        base64: false,
        events: ["MESSAGES_UPSERT"]
      }
    }, { headers: evolutionHeaders });

    // Crea documento professionista su Firebase
    await db.collection('professionals').doc(instanceName).set({
      professionalId: instanceName,
      status: 'created',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`✅ Istanza creata: ${instanceName}`);
    res.json({ success: true, instance: instanceName, message: "Ora chiedi il pairing code con GET /pairing-code/" + instanceName });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// --- 2. PRENDI IL CODICE DI 8 CIFRE DA MOSTRARE IN APP ---
// Chiamata da FlutterFlow: GET /pairing-code/mario_rossi_123
app.get('/pairing-code/:instance', async (req, res) => {
  const instanceName = req.params.instance;
  try {
    // Questo endpoint di Evolution ritorna il pairing code
    const response = await axios.get(`${EVOLUTION_URL}/instance/connect/${instanceName}`, {
      headers: evolutionHeaders
    });
    // response.data può contenere pairingCode e base64 qrcode
    console.log(`Codice per ${instanceName}:`, response.data);
    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message, tip: "L'istanza esiste? Hai chiamato /create-instance prima?" });
  }
});

// --- 3. WEBHOOK CHE RICEVE MESSAGGI DA TUTTI I WHATSAPP ---
app.post('/webhook', async (req, res) => {
  try {
    const instanceName = req.body.instance || req.headers['instance'] || 'unknown';
    const data = req.body.data;

    if (!data) return res.sendStatus(200);

    const messageText = data.message?.conversation || data.message?.extendedTextMessage?.text || "";
    const remoteJid = data.key?.remoteJid || "";
    const fromMe = data.key?.fromMe;

    // Ignora i tuoi messaggi inviati e i gruppi
    if (fromMe || remoteJid.includes('@g.us') || !messageText) {
      return res.sendStatus(200);
    }

    const clientPhone = remoteJid.replace('@s.whatsapp.net', '');

    console.log(`📩 [${instanceName}] da ${clientPhone}: ${messageText}`);

    // SALVA JOB SOLO PER QUEL PROFESSIONISTA
    await db.collection('jobs').add({
      professionalId: instanceName, // <-- QUESTO è IL SEGRETO, solo lui lo vedrà
      clientPhone: clientPhone,
      description: messageText,
      rawMessage: messageText,
      status: 'nuovo',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      source: 'whatsapp_personal'
    });

    console.log(`✅ Job salvato per professionalId: ${instanceName}`);
    res.sendStatus(200);

  } catch (e) {
    console.error("Errore webhook:", e);
    res.sendStatus(200);
  }
});

// --- HEALTH CHECK ---
app.get('/', (req, res) => res.send('Mestiere Bridge - Segreteria Virtuale OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bridge su porta ${PORT}`));
