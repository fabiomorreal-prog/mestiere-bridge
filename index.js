const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log("✅ Firebase connesso");
} catch (e) { console.error("❌ Firebase:", e.message); }
const db = admin.firestore();

const EVOLUTION_URL = process.env.EVOLUTION_URL;
const EVOLUTION_APIKEY = process.env.EVOLUTION_APIKEY;

async function createInstanceLogic(professionalId) {
  const instanceName = professionalId.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  await axios.post(`${EVOLUTION_URL}/instance/create`, {
    instanceName, qrcode: true, integration: "WHATSAPP-BAILEYS"
  }, { headers: { apikey: EVOLUTION_APIKEY } });
  await db.collection('professionals').doc(instanceName).set({
    professionalId: instanceName, status: 'created', createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  return instanceName;
}

app.post('/create-instance', async (req, res) => {
  try {
    const name = await createInstanceLogic(req.body.professionalId || "test");
    res.json({ success: true, instance: name, next: `/pairing-code/${name}` });
  } catch (err) { res.status(500).json({ error: err.response?.data || err.message }); }
});

app.get('/create-instance/:professionalId', async (req, res) => {
  try {
    const name = await createInstanceLogic(req.params.professionalId);
    res.json({ success: true, instance: name, next: `/pairing-code/${name}` });
  } catch (err) { res.status(500).json({ error: err.response?.data || err.message }); }
});

app.get('/pairing-code/:instance', async (req, res) => {
  try {
    const r = await axios.get(`${EVOLUTION_URL}/instance/connect/${req.params.instance}`, {
      headers: { apikey: EVOLUTION_APIKEY }
    });
    res.json(r.data);
  } catch (err) { res.status(500).json({ error: err.response?.data || err.message }); }
});

app.post('/webhook', async (req, res) => {
  try {
    const instanceName = req.body.instance || 'unknown';
    const data = req.body.data;
    const txt = data?.message?.conversation || data?.message?.extendedTextMessage?.text || "";
    const jid = data?.key?.remoteJid || "";
    if (data?.key?.fromMe || jid.includes('@g.us') || !txt) return res.sendStatus(200);
    await db.collection('jobs').add({
      professionalId: instanceName, clientPhone: jid.replace('@s.whatsapp.net',''),
      description: txt, status: 'nuovo', createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.sendStatus(200);
  } catch(e){ res.sendStatus(200); }
});

app.get('/', (req,res) => res.send('Mestiere Bridge v3 OK - ' + new Date().toISOString()));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bridge su ${PORT}`));
