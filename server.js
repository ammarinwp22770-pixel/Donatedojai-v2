import dotenv from "dotenv";
dotenv.config();

import admin from "firebase-admin";

const serviceAccount = {
  type: process.env.TYPE,
  project_id: process.env.PROJECT_ID,
  private_key_id: process.env.PRIVATE_KEY_ID,
private_key: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.CLIENT_EMAIL,
  client_id: process.env.CLIENT_ID,
  auth_uri: process.env.AUTH_URI,
  token_uri: process.env.TOKEN_URI,
  auth_provider_x509_cert_url: process.env.AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.CLIENT_X509_CERT_URL,
  universe_domain: process.env.UNIVERSE_DOMAIN
};


import express from "express";
import { WebSocketServer } from "ws";
import bodyParser from "body-parser";
import fs from "fs";
import QRCode from "qrcode";
import generatePayload from "promptpay-qr";
import multer from "multer";
import http from "http";
import path from "path"; // ✅ เพิ่มตรงนี้สำคัญมาก!


admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// 📁 ตั้งค่า multer สำหรับอัปโหลดรูป popup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "public/uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage });

// ✅ route สำหรับอัปโหลดรูป popup
app.post("/upload-popup", upload.single("popupImage"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ไม่พบไฟล์" });
  const imagePath = "/uploads/" + req.file.filename;
  console.log("🖼️ อัปโหลดภาพ popup แล้ว:", imagePath);
  res.json({ path: imagePath });
});

// 🌐 รวม Express + WebSocket ในเซิร์ฟเวอร์เดียว (ใช้พอร์ตเดียว)
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// ✅ เมื่อมี client เชื่อมต่อเข้ามา (OBS)
wss.on("connection", () => console.log("🟢 WebSocket ใหม่เชื่อมต่อเข้ามาแล้ว!"));

// ✅ ระบบ Queue สำหรับ Alert (แก้ปัญหา alert ทับกัน)
let alertQueue = [];
let isBroadcasting = false;

function broadcastNext() {
  if (alertQueue.length === 0) {
    isBroadcasting = false;
    return;
  }
  isBroadcasting = true;
  const data = alertQueue.shift();

  wss.clients.forEach(c => {
    if (c.readyState === 1) c.send(JSON.stringify(data));
  });

  setTimeout(broadcastNext, 6000); // หน่วง 6 วิ
}

function enqueueBroadcast(type, name, amount, comment) {
  alertQueue.push({ type, name, amount, comment, time: new Date().toISOString() });

  if (!isBroadcasting) broadcastNext();
}

// 🧠 ตัวเก็บข้อมูลโดเนท
let pendingDonations = []; // [{ name, amount, comment, time }]
const donateFile = path.join(process.cwd(), "donates.json"); // ✅ ใช้ path เดียวกันทุก environment
if (!fs.existsSync(donateFile)) fs.writeFileSync(donateFile, "[]", "utf8");

// 💾 ฟังก์ชันบันทึกข้อมูลโดเนท 

 
// 📡 ส่งข้อมูลแบบเรียลไทม์ไป OBS
function sendToOBS(data) {
  let sent = 0;
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(data));
      sent++;
    }
  });
  console.log(`📡 ส่งข้อมูลไป OBS ${sent} ตัว`, data);
}

// เพิ่มด้านบนสุดสุดของไฟล์
import fetch from "node-fetch";

// ✅ API สร้าง QR พร้อมบันทึกข้อมูลไว้
app.post("/generateQR", async (req, res) => {
  const { amount, name, comment, token } = req.body;
  console.log("🧩 Token ที่ได้รับ:", token);
  if (!amount) return res.status(400).json({ error: "กรุณาระบุจำนวนเงิน" });

  // ✅ ตรวจสอบ CAPTCHA จาก Cloudflare Turnstile
  try {
    const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `secret=0x4AAAAAAB6qazXLsDqjv-hftjzkBFfNbS0&response=${token}`
    });

    const data = await verify.json();
    if (!data.success) {
      console.log("❌ CAPTCHA verification failed");
      return res.status(400).json({ error: "Captcha verification failed" });
    }
  } catch (err) {
    console.error("❌ Error verifying CAPTCHA:", err);
    return res.status(500).json({ error: "Captcha verification error" });
  }

  // ✅ ดำเนินการต่อถ้า CAPTCHA ผ่าน
  const payload = generatePayload("0815404297", { amount: parseFloat(amount) });
  QRCode.toDataURL(payload, (err, url) => {
    if (err) return res.status(500).json({ error: err.message });

    const now = Date.now();
    pendingDonations = pendingDonations.filter(p => now - p.time < 600000);
    pendingDonations.push({
      name: name || "ไม่ระบุชื่อ",
      amount: parseFloat(amount),
      comment: comment || "",
      time: now
    });

    console.log(`🕓 รอการโอนจริงจาก ${name || "ไม่ระบุชื่อ"} (${amount} บาท)`);
    res.json({ result: url });
  });
});


// ✅ API สำหรับดึงประวัติโดเนททั้งหมด
app.get("/donates", async (req, res) => {
  try {
    const snapshot = await db.collection("donations").orderBy("time", "desc").get();
    const data = snapshot.docs.map(doc => doc.data());
    res.json(data);
  } catch (err) {
    console.error("❌ อ่านข้อมูล Firestore ไม่ได้:", err);
    res.json([]);
  }
});

// 💾 ฟังก์ชันบันทึกข้อมูลโดเนท (Firestore)
async function saveDonate(name, amount, comment = "") {
  const record = {
    name,
    amount,
    comment,
    time: new Date().toLocaleString("th-TH")
  };
  await db.collection("donations").add(record);
  console.log("💾 บันทึกโดเนท (Firestore):", record);
}


// ✅ รับ webhook จากมือถือ (Tasker)
app.post("/bankhook", (req, res) => {
  console.log("✅ ได้รับ Webhook จากมือถือ:", req.body);
  const text = req.body.text || "";
  if (!text) return res.json({ ok: false });

  const looksLikeIncoming = /(ยอดเงิน|จำนวนเงิน|รับเงิน|ฝาก|โอนเข้า|เงินเข้า)/i.test(text);
  if (!looksLikeIncoming) return res.json({ ok: true });

  const match = text.match(/([\d,]+(?:\.\d+)?)\s*บาท/i);
  const amount = match ? parseFloat(match[1].replace(/,/g, "")) : 0;

  if (amount > 0) {
    const pending = pendingDonations.find(p => Math.abs(p.amount - amount) < 0.2);
    const donorName = pending ? pending.name : "ผู้บริจาคจากมือถือ 📱";
    const comment = pending ? (pending.comment || "") : "";

    console.log(`💖 ตรวจพบยอดเงิน ${amount} บาท จาก ${donorName}`);
    saveDonate(donorName, amount, comment);

    enqueueBroadcast("donate", donorName, amount, comment || "ขอบคุณสำหรับการสนับสนุน 💖");

    if (pending) {
      pendingDonations = pendingDonations.filter(p => p !== pending);
      sendToOBS({ type: "payment_done", name: donorName, amount });
    }
  }
  res.json({ ok: true });
});

// ✅ ทดสอบส่ง Alert ไป OBS
app.get("/test", (req, res) => {
  sendToOBS({
    type: "donate",
    name: "เฟอ",
    amount: 99,
    comment: "ขอบคุณที่เทสต์ระบบ 💖"
  });
  console.log("📡 ส่งทดสอบ alert ไป OBS แล้ว!");
  res.send("✅ ส่งทดสอบ Alert แล้ว! ดู OBS ได้เลย");
});

// ✅ Route สำหรับกด Alert ซ้ำจาก Dashboard
app.post("/test-alert", (req, res) => {
  const { name, amount, comment } = req.body;
  sendToOBS({
    type: "alert_repeat",
    name,
    amount,
    comment: comment || "ขอบคุณสำหรับการสนับสนุน 💖",
    fromDashboard: true
  });
  console.log(`🔔 ส่ง Alert ซ้ำจาก Dashboard: ${name} - ${amount}฿`);
  res.json({ ok: true });
});

// ✅ Route ทดสอบ Alert จากหน้า customize.html
app.post("/customize-test", (req, res) => {
  const { text, color, effect } = req.body;
  sendToOBS({
    type: "alert_test",
    name: "H0LLoWx 💖",
    amount: 99,
    comment: text || "ขอบคุณสำหรับการสนับสนุน 💖",
    color: color || "#69eaff",
    effect: effect || "pop"
  });
  console.log("🎨 ส่ง alert_test ไป OBS สำเร็จ!");
  res.json({ ok: true });
});

// ✅ โหลด config ล่าสุด
app.get("/config", (req, res) => {
  try {
    const config = fs.readFileSync("config.json", "utf8");
    res.json(JSON.parse(config));
  } catch {
    res.json({
      sound: "alert.mp3",
      popupImage: "images/default.png",
      color: "#69eaff",
      animation: "pop",
      minAmount: 10
    });
  }
});

// ✅ บันทึก config ใหม่
app.post("/save-config", (req, res) => {
  fs.writeFileSync("config.json", JSON.stringify(req.body, null, 2));
  console.log("✅ บันทึกการตั้งค่าใหม่แล้ว:", req.body);
  sendToOBS({ type: "config_update", config: req.body });
  res.json({ ok: true });
});

// ✅ เสิร์ฟหน้าเว็บหลัก
app.get("/", (req, res) => res.sendFile("index.html", { root: "public" }));
app.get("/alert", (req, res) => res.sendFile("alert.html", { root: "public" }));

// 🧹 ล้าง QR ที่หมดอายุ
setInterval(() => {
  const before = pendingDonations.length;
  const now = Date.now();
  pendingDonations = pendingDonations.filter(p => now - p.time < 600000);
  if (pendingDonations.length !== before)
    console.log(`🧹 ล้าง QR เก่าทิ้ง ${before - pendingDonations.length} รายการ`);
}, 60000);

app.get("/ws", (req, res) => res.sendStatus(200));
app.get("/dashboard", (req, res) => res.sendFile("dashboard.html", { root: "public" }));
app.get("/eventlist", (req, res) => res.sendFile("eventlist.html", { root: "public" }));

// ✅ เริ่มรันเซิร์ฟเวอร์
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
