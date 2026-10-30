const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' })); // Fix CORS
app.use(express.json());

try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log("✅ Firebase connesso");
} catch (e) {
  console.error("❌ Errore FIREBASE_SERVICE_ACCOUNT:", e.message);
}
const db = admin.firestore();

const EVOLUTION_URL = process.env.EVOLUTION_URL;
const EVOLUTION_APIKEY = process.env.EVOLUTION_APIKEY;

app.post('/create-instance', async (req, res) => {
  const { professionalId } = req.body;
  const instanceName = professionalId.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  try {
    await axios.post(`${EVOLUTION_URL}/instance/create`, {
      instanceName, qrcode: true, integration: "WHATSAPP-BAILEYS"
    }, { headers: { apikey: EVOLUTION_APIKEY } });
    
    await db.collection('professionals').doc(instanceName).set({
      professionalId: instanceName, status: 'created', createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ success: true, instance: instanceName });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

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

app.post('/webhook', async (req, res) => {
  try {
    const instanceName = req.body.instance || 'unknown';
    const data = req.body.data;
    const messageText = data?.message?.conversation || data?.message?.extendedTextMessage?.text || "";
    const remoteJid = data?.key?.remoteJid || "";
    if (data?.key?.fromMe || remoteJid.includes('@g.us') || !messageText) return res.sendStatus(200);
    
    await db.collection('jobs').add({
      professionalId: instanceName,
      clientPhone: remoteJid.replace('@s.whatsapp.net',''),
      description: messageText,
      status: 'nuovo',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.sendStatus(200);
  } catch(e){ res.sendStatus(200); }
});

app.get('/', (req,res) => res.send('Mestiere Bridge OK - ' + new Date().toISOString()));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bridge su porta ${PORT}`));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bridge su porta ${PORT}`));
