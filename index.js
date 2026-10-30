const express = require('express');
const admin = require('firebase-admin');
const app = express();
app.use(express.json());

// Usa la variabile che hai già messo su Railway
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

app.post('/webhook', async (req, res) => {
  try {
    // Evolution manda tutto qui
    const data = req.body;
    console.log("Messaggio da Evolution:", JSON.stringify(data).slice(0, 500));

    // Estrai numero e messaggio (formato Evolution)
    const phone = data?.data?.key?.remoteJid || data?.data?.pushName || "sconosciuto";
    const message = data?.data?.message?.conversation || data?.data?.message?.extendedTextMessage?.text || "foto/video";
    
    if (!message) return res.json({ ok: true });

    const cleanPhone = phone.replace('@s.whatsapp.net','');

    // Scrivi su Firebase per Mestiere
    await db.collection('jobs').add({
      clientPhone: cleanPhone,
      problem: message,
      sourceMessage: message,
      status: "new",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log("✅ Job creato:", cleanPhone);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req,res) => res.send('Mestiere Bridge OK'));

app.listen(process.env.PORT || 3000, () => console.log("Bridge acceso"));
