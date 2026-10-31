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
app.post('/request-pairing-code', async (req, res) => {
  try {
    const { professionalId, phone } = req.body;
    if (!professionalId || !phone) {
      return res.status(400).json({ error: "Servono professionalId e phone" });
    }
    const instanceName = cleanName(professionalId);
    const cleanPhone = phone.replace(/[^0-9]/g, "");

    let evoRes;
    try {
      evoRes = await axios.get(`${EVOLUTION_URL}/instance/connect/${instanceName}`, {
        headers: { apikey: EVOLUTION_APIKEY },
        params: { number: cleanPhone }
      });
    } catch (err) {
      try {
        evoRes = await axios.put(`${EVOLUTION_URL}/instance/connect/${instanceName}`, {
          number: cleanPhone
        }, { headers: { apikey: EVOLUTION_APIKEY } });
      } catch (err2) {
        // ultimo tentativo: POST /instance/connect/:instance
        evoRes = await axios.post(`${EVOLUTION_URL}/instance/connect/${instanceName}`, {
          number: cleanPhone
        }, { headers: { apikey: EVOLUTION_APIKEY } });
      }
    }

    const data = evoRes.data;
    const pairingCode = data.pairingCode || data.code || data.pairing_code || null;

    // Salva su Firebase ma NON bloccare se fallisce
    try {
      await db.collection('professionals').doc(instanceName).set({
        lastPairingPhone: cleanPhone,
        lastPairingCode: pairingCode,
        lastPairingAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (fbErr) {
      console.log("Firebase save warning (ignoro):", fbErr.message);
    }

    res.json({
      success: true,
      instance: instanceName,
      phone: cleanPhone,
      pairingCode: pairingCode,
      qrBase64: data.base64 || data.qrcode?.base64 || null,
      fullResponse: data,
      instructions: "WhatsApp > Dispositivi collegati > Collega con numero di telefono"
    });

  } catch (err) {
    console.error("Pairing error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message, details: err.message });
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
// --- 7. SIMULA MESSAGGIO CLIENTE (per testare senza WhatsApp) ---
app.post('/simulate-message', async (req, res) => {
  try {
    const { professionalId, clientPhone, text } = req.body;
    const instanceName = cleanName(professionalId);
    
    if (!text) return res.status(400).json({ error: "Serve text" });

    const job = {
      professionalId: instanceName,
      clientPhone: clientPhone || "393400000000",
      clientJid: (clientPhone || "393400000000") + "@s.whatsapp.net",
      description: text,
      status: 'nuovo',
      source: 'whatsapp_simulated',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Prova a scrivere, se Firebase da errore lo logghiamo ma non blocchiamo
    try {
      const docRef = await db.collection('jobs').add(job);
      res.json({ success: true, jobId: docRef.id, job, message: "Finto cliente creato! Controlla Firebase -> jobs" });
    } catch (fbErr) {
      console.log("Firebase err:", fbErr.message);
      res.json({ success: true, simulated: true, job, warning: "Firebase non scrive ancora, ma il webhook è OK", firebaseError: fbErr.message });
    }

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// --- 8. NOTIFICA CLIENTE QUANDO IDRAULICO IMPOSTA/SPOSTA APPUNTAMENTO ---
app.post('/notify-client', async (req, res) => {
  try {
    const { jobId } = req.body;
    if (!jobId) return res.status(400).json({ error: "Serve jobId" });

    // 1. Prendi il lavoro da Firestore
    const jobDoc = await db.collection('jobs').doc(jobId).get();
    if (!jobDoc.exists) return res.status(404).json({ error: "Job non trovato" });
    const job = jobDoc.data();

    const clientPhone = job.clientPhone;
    const professionalId = cleanName(job.professionalId);
    const appointmentAt = job.appointmentAt ? new Date(job.appointmentAt.seconds ? job.appointmentAt.toDate() : job.appointmentAt) : null;

    if (!clientPhone) return res.status(400).json({ error: "Manca clientPhone" });

    // 2. Prendi info professionista per nome + professione
    let professionalName = job.professionalName || "Marco";
    let professione = job.profession || "l'idraulico"; // default

    try {
      const profDoc = await db.collection('professionals').doc(professionalId).get();
      if (profDoc.exists) {
        const pData = profDoc.data();
        professionalName = pData.name || pData.displayName || professionalName;
        professione = pData.category || pData.professione || professione;
        // Se category è "idraulico" lo trasformiamo in "l'idraulico"
        if (!professione.startsWith("l'") && !professione.startsWith("il ")) {
           professione = `l'${professione}`;
        }
      }
    } catch(e){ console.log("Prof not found, uso default"); }

    // Se professione è nel professionalId (es: idraulico_test_torino)
    if (professione === "l'idraulico" && professionalId.includes("idraulico")) professione = "l'idraulico";
    if (professionalId.includes("elettricista")) professione = "l'elettricista";
    if (professionalId.includes("fabbro")) professione = "il fabbro";

    // 3. Crea messaggio - Opzione 1 col tuo tocco
    let dataFormattata = "appena possibile";
    if (appointmentAt) {
      dataFormattata = appointmentAt.toLocaleString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    }
    
    const isUpdate = job.lastNotifiedAt ? true : false;
    
    let message;
    if (isUpdate) {
      message = `Ciao! Sono ${professionalName} ${professione} 👋\nAggiornamento: appuntamento spostato a ${dataFormattata} in ${job.appointmentAddress || job.description || ''}\n\nA dopo!`;
    } else {
      message = `Ciao! Sono ${professionalName} ${professione} 👋\nTi confermo l'appuntamento per ${dataFormattata}${job.appointmentAddress ? ` in ${job.appointmentAddress}` : ''}\n\nSe hai bisogno scrivimi qui su WhatsApp!`;
    }

    // 4. Invia su WhatsApp tramite Evolution
    try {
      await axios.post(`${EVOLUTION_URL}/message/sendText/${professionalId}`, {
        number: clientPhone,
        text: message
      }, { headers: { apikey: EVOLUTION_APIKEY } });
    } catch (evoErr) {
      console.log("Evolution send warning (normale se non sei collegato):", evoErr.response?.data || evoErr.message);
      // Non blocchiamo, così puoi testare anche con il simulatore
    }

    // 5. Salva che abbiamo notificato
    await db.collection('jobs').doc(jobId).update({
      lastNotifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastNotificationText: message,
      status: 'programmato'
    });

    res.json({ success: true, sentTo: clientPhone, message: message, note: "Se Evolution non è collegato, il messaggio è salvato ma non inviato su WhatsApp - appena colleghi WhatsApp partirà" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- HOME ---
app.get('/', (req,res) => res.send(`Mestiere Bridge v4 OK - Auto-pairing ready - ${new Date().toISOString()}`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bridge v4 su ${PORT}`));
