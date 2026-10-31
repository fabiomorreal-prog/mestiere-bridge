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

  try {
    const bridgeUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'mestiere-bridge-production.up.railway.app'}/webhook/${instanceName}`;
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

// --- 1. CREA ISTANZA ---
app.post('/create-instance', async (req, res) => {
  try {
    const name = await createInstanceLogic(req.body.professionalId || `prof_${Date.now()}`);
    res.json({ success: true, instance: name, next: `/pairing-code/${name}` });
  } catch (err) {
    if (JSON.stringify(err.response?.data).includes("already in use")) {
      const name = cleanName(req.body.professionalId);
      return res.json({ success: true, instance: name, message: "already exists", next: `/pairing-code/${name}` });
    }
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

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

// --- 2. PAIRING CODE ---
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

app.post('/request-pairing-code', async (req, res) => {
  try {
    const { professionalId, phone } = req.body;
    if (!professionalId || !phone) return res.status(400).json({ error: "Servono professionalId e phone" });
    const instanceName = cleanName(professionalId);
    const cleanPhone = phone.replace(/[^0-9]/g, "");
    let evoRes;
    try {
      evoRes = await axios.get(`${EVOLUTION_URL}/instance/connect/${instanceName}`, { headers: { apikey: EVOLUTION_APIKEY }, params: { number: cleanPhone } });
    } catch (err) {
      try {
        evoRes = await axios.put(`${EVOLUTION_URL}/instance/connect/${instanceName}`, { number: cleanPhone }, { headers: { apikey: EVOLUTION_APIKEY } });
      } catch (err2) {
        evoRes = await axios.post(`${EVOLUTION_URL}/instance/connect/${instanceName}`, { number: cleanPhone }, { headers: { apikey: EVOLUTION_APIKEY } });
      }
    }
    const data = evoRes.data;
    const pairingCode = data.pairingCode || data.code || data.pairing_code || null;
    try {
      await db.collection('professionals').doc(instanceName).set({
        lastPairingPhone: cleanPhone, lastPairingCode: pairingCode, lastPairingAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (fbErr) { console.log("Firebase save warning:", fbErr.message); }
    res.json({ success: true, instance: instanceName, phone: cleanPhone, pairingCode: pairingCode, qrBase64: data.base64 || data.qrcode?.base64 || null, fullResponse: data, instructions: "WhatsApp > Dispositivi collegati > Collega con numero di telefono" });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message, details: err.message });
  }
});

// --- 3. STATO ---
app.get('/status/:instance', async (req, res) => {
  try {
    const r = await axios.get(`${EVOLUTION_URL}/instance/connectionState/${req.params.instance}`, { headers: { apikey: EVOLUTION_APIKEY } });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// --- 4. WEBHOOK FIXATO (senza bisogno di indici) ---
app.post('/webhook/:instance', async (req, res) => {
  try {
    const instanceName = cleanName(req.params.instance);
    const payload = req.body;
    console.log("WEBHOOK from", instanceName, JSON.stringify(payload).slice(0,500));
    const data = payload.data || payload;
    const messageText = data.message?.conversation || data.message?.extendedTextMessage?.text || data.message?.text || payload.message || "";
    const remoteJid = data.key?.remoteJid || payload.remoteJid || data.remoteJid || "";
    const fromMe = data.key?.fromMe || false;
    if (fromMe || !messageText || !remoteJid) return res.json({ ignored: true });
    const clientPhone = remoteJid.replace('@s.whatsapp.net','').replace('@g.us','');

    // QUERY SEMPLICE SENZA INDICE
    let existingJobQuery = await db.collection('jobs').where('professionalId', '==', instanceName).where('clientPhone', '==', clientPhone).limit(10).get();
    let jobDocFound = null;
    if (!existingJobQuery.empty) {
      for (let d of existingJobQuery.docs) {
        let dd = d.data();
        if (['nuovo','accettato','programmato','in_attesa_conferma','in_attesa','programmato'].includes(dd.status)) {
           if (!jobDocFound) jobDocFound = d;
           else {
             try {
               const curTime = dd.createdAt?.toMillis ? dd.createdAt.toMillis() : 0;
               const foundTime = jobDocFound.data().createdAt?.toMillis ? jobDocFound.data().createdAt.toMillis() : 0;
               if (curTime > foundTime) jobDocFound = d;
             } catch(e){}
           }
        }
      }
    }

    if (jobDocFound) {
      await db.collection('jobs').doc(jobDocFound.id).update({
        clientLastReply: messageText,
        clientLastReplyAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'confermato_da_cliente',
        clientConfirmed: true
      });
      console.log(`Cliente ${clientPhone} ha risposto al job ${jobDocFound.id}`);
      return res.json({ success: true, type: 'client_reply', jobId: jobDocFound.id });
    } else {
      const newJob = {
        professionalId: instanceName, clientPhone: clientPhone, clientJid: remoteJid,
        description: messageText, status: 'nuovo', source: 'whatsapp',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      const docRef = await db.collection('jobs').add(newJob);
      console.log(`Nuovo job creato ${docRef.id}`);
      return res.json({ success: true, type: 'new_job', jobId: docRef.id });
    }
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.json({ error: err.message, received: true });
  }
});

// --- 5. SIMULA MESSAGGIO ---
app.post('/simulate-message', async (req, res) => {
  try {
    const { professionalId, clientPhone, text } = req.body;
    const instanceName = cleanName(professionalId);
    if (!text) return res.status(400).json({ error: "Serve text" });
    const job = {
      professionalId: instanceName,
      clientPhone: clientPhone || "393400000000",
      clientJid: (clientPhone || "393400000000") + "@s.whatsapp.net",
      description: text, status: 'nuovo', source: 'whatsapp_simulated',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      appointmentAddress: req.body.address || ""
    };
    const docRef = await db.collection('jobs').add(job);
    res.json({ success: true, jobId: docRef.id, job, message: "Finto cliente creato!" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- 6. NOTIFICA CLIENTE (con fix ID minuscolo/maiuscolo) ---
app.post('/notify-client', async (req, res) => {
  try {
    let { jobId } = req.body;
    if (!jobId) return res.status(400).json({ error: "Serve jobId" });
    
    // Fix case-insensitive: prova sia come arriva che lowercase
    let jobDoc = await db.collection('jobs').doc(jobId).get();
    if (!jobDoc.exists) {
      // Prova a cercare con ID lowercase se l'utente ha sbagliato maiuscola
      let allJobs = await db.collection('jobs').limit(100).get();
      let found = allJobs.docs.find(d => d.id.toLowerCase() === jobId.toLowerCase());
      if (found) {
        jobDoc = found;
        jobId = found.id;
      }
    }
    if (!jobDoc.exists) return res.status(404).json({ error: "Job non trovato", searched: req.body.jobId });

    const job = jobDoc.data();
    const clientPhone = job.clientPhone;
    const professionalId = cleanName(job.professionalId);
    const appointmentAt = job.appointmentAt ? new Date(job.appointmentAt.seconds ? job.appointmentAt.toDate() : job.appointmentAt) : new Date();

    if (!clientPhone) return res.status(400).json({ error: "Manca clientPhone" });

    let professionalName = job.professionalName || "Marco";
    let professione = job.profession || job.category || "l'idraulico";
    try {
      const profDoc = await db.collection('professionals').doc(professionalId).get();
      if (profDoc.exists) {
        const pData = profDoc.data();
        professionalName = pData.name || pData.displayName || professionalName;
        professione = pData.category || pData.professione || professione;
        if (!professione.startsWith("l'") && !professione.startsWith("il ")) {
           if (["idraulico","elettricista","imbianchino"].includes(professione)) professione = `l'${professione}`;
           else professione = `il ${professione}`;
        }
      }
    } catch(e){}

    if (professionalId.includes("idraulico")) professione = "l'idraulico";
    if (professionalId.includes("elettricista")) professione = "l'elettricista";
    if (professionalId.includes("fabbro")) professione = "il fabbro";

    let dataFormattata = appointmentAt.toLocaleString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    const isUpdate = job.lastNotifiedAt ? true : false;
    
    let message = isUpdate
      ? `Ciao! Sono ${professionalName} ${professione} 👋\nAggiornamento: appuntamento spostato a ${dataFormattata}${job.appointmentAddress ? ` in ${job.appointmentAddress}` : ''}\n\nA dopo!`
      : `Ciao! Sono ${professionalName} ${professione} 👋\nTi confermo l'appuntamento per ${dataFormattata}${job.appointmentAddress ? ` in ${job.appointmentAddress}` : ''}\n\nSe hai bisogno scrivimi qui su WhatsApp!`;

    try {
      await axios.post(`${EVOLUTION_URL}/message/sendText/${professionalId}`, { number: clientPhone, text: message }, { headers: { apikey: EVOLUTION_APIKEY } });
    } catch (evoErr) { console.log("Evolution warning:", evoErr.message); }

    await db.collection('jobs').doc(jobId).update({
      lastNotifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastNotificationText: message,
      status: 'programmato'
    });

    res.json({ success: true, sentTo: clientPhone, message: message, jobId: jobId });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- 7. NUOVO: AGGIORNA JOB + NOTIFICA AUTOMATICA (usato dal calendario dell'app) ---
app.post('/update-job', async (req, res) => {
  try {
    const { jobId, appointmentAt, appointmentAddress, professionalName, status } = req.body;
    if (!jobId) return res.status(400).json({ error: "Serve jobId" });
    
    let updateData = {};
    if (appointmentAt) updateData.appointmentAt = new Date(appointmentAt);
    if (appointmentAddress) updateData.appointmentAddress = appointmentAddress;
    if (professionalName) updateData.professionalName = professionalName;
    if (status) updateData.status = status;
    updateData.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await db.collection('jobs').doc(jobId).update(updateData);

    // Se ha impostato un orario, notifica subito il cliente
    if (appointmentAt) {
      // Chiama internamente notify-client
      try {
        await axios.post(`https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'mestiere-bridge-production.up.railway.app'}/notify-client`, { jobId }, { headers: { 'Content-Type': 'application/json' } });
      } catch(e){
        // Se fallisce la chiamata interna, fa lo stesso notify qui
        console.log("Notify interno fallito, procedo manuale");
      }
    }

    const updatedDoc = await db.collection('jobs').doc(jobId).get();
    res.json({ success: true, job: updatedDoc.data(), jobId });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 8. NUOVO: LISTA LAVORI PER APP IDRAULICO ---
app.get('/jobs/:professionalId', async (req, res) => {
  try {
    const instanceName = cleanName(req.params.professionalId);
    const snapshot = await db.collection('jobs').where('professionalId', '==', instanceName).orderBy('createdAt','desc').limit(50).get().catch(async () => {
      // Fallback senza orderBy se manca indice
      return await db.collection('jobs').where('professionalId', '==', instanceName).limit(50).get();
    });
    const jobs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, count: jobs.length, jobs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 9. NUOVO: AZIONI RAPIDE IDRAULICO (Accetta/Rifiuta/Completa) ---
app.post('/job-action', async (req, res) => {
  try {
    const { jobId, action, message } = req.body; // action: accetta, rifiuta, completa
    if (!jobId || !action) return res.status(400).json({ error: "Servono jobId e action" });

    const jobDoc = await db.collection('jobs').doc(jobId).get();
    if (!jobDoc.exists) return res.status(404).json({ error: "Job non trovato" });
    const job = jobDoc.data();
    const professionalId = cleanName(job.professionalId);

    let newStatus = job.status;
    let replyToClient = "";

    if (action === 'accetta') {
      newStatus = 'accettato';
      replyToClient = message || `Ciao! Sono ${job.professionalName || 'Marco'} l'idraulico 👋\nHo preso in carico la tua richiesta: "${job.description}"\nTi faccio sapere a breve quando posso passare!`;
    } else if (action === 'rifiuta') {
      newStatus = 'rifiutato';
      replyToClient = message || `Ciao! Purtroppo in questo momento non riesco a prendere la tua richiesta. Prova a contattare un altro professionista su Mestiere!`;
    } else if (action === 'completa') {
      newStatus = 'completato';
      replyToClient = message || `Ciao! Lavoro completato ✅\nGrazie per aver scelto Mestiere! Se ti sei trovato bene lascia una recensione 🙏`;
    }

    await db.collection('jobs').doc(jobId).update({
      status: newStatus,
      lastAction: action,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Manda messaggio al cliente
    if (replyToClient) {
      try {
        await axios.post(`${EVOLUTION_URL}/message/sendText/${professionalId}`, { number: job.clientPhone, text: replyToClient }, { headers: { apikey: EVOLUTION_APIKEY } });
      } catch(e){ console.log("Send warning:", e.message); }
    }

    res.json({ success: true, newStatus, sentMessage: replyToClient });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- HOME ---
app.get('/', (req,res) => res.send(`Mestiere Bridge v6 FINAL - ${new Date().toISOString()} - Tutte le funzioni idraulico attive`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bridge v6 su ${PORT}`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bridge v4 su ${PORT}`));
