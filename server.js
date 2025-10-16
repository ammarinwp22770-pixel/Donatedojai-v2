import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { WebSocketServer } from "ws";
import bodyParser from "body-parser";
import fs from "fs";
import QRCode from "qrcode";
import generatePayload from "promptpay-qr";
import multer from "multer";
import http from "http";
import path from "path";
import admin from "firebase-admin";
import fetch from "node-fetch";

const __dirname = path.resolve();

// ✅ โหลด Firebase Credentials จาก ENV
const serviceAccount = {
  type: process.env.TYPE,
  project_id: process.env.PROJECT_ID,
  private_key_id: process.env.PRIVATE_KEY_ID,
  private_key: process.env.PRIVATE_KEY.replace(/\\n/g, "\n"),
  client_email: process.env.CLIENT_EMAIL,
  client_id: process.env.CLIENT_ID,
  auth_uri: process.env.AUTH_URI,
  token_uri: process.env.TOKEN_URI,
  auth_provider_x509_cert_url: process.env.AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.CLIENT_X509_CERT_URL,
  universe_domain: process.env.UNIVERSE_DOMAIN,
};

// ✅ เริ่ม Firebase แค่ครั้งเดียว
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// ✅ Express
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// 📁 Upload system
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "public/uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage });

app.post("/upload-popup", upload.single("popupImage"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ไม่พบไฟล์" });
  const imagePath = "/uploads/" + req.file.filename;
  res.json({ path: imagePath });
});

// 🌐 รวม Express + WebSocket (Render ต้องใช้พอร์ตเดียว)
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", () => console.log("🟢 WebSocket ใหม่เชื่อมต่อเข้ามาแล้ว!"));


// ✅ Queue สำหรับ Alert
let alertQueue = [];
let isBroadcasting = false;

function broadcastNext() {
  if (alertQueue.length === 0) {
    isBroadcasting = false;
    return;
  }
  isBroadcasting = true;
  const data = alertQueue.shift();

  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(JSON.stringify(data));
  });

  setTimeout(broadcastNext, 6000);
}

function enqueueBroadcast(type, name, amount, comment) {
  alertQueue.push({ type, name, amount, comment, time: new Date().toISOString() });
  if (!isBroadcasting) broadcastNext();
}

// 🧠 Pending QR
let pendingDonations = [];
const donateFile = path.join(__dirname, "donates.json");
if (!fs.existsSync(donateFile)) fs.writeFileSync(donateFile, "[]", "utf8");

// ✅ สร้าง QR PromptPay + Captcha
app.post("/generateQR", async (req, res) => {
  const { amount, name, comment, token } = req.body;
  if (!amount) return res.status(400).json({ error: "กรุณาระบุจำนวนเงิน" });

  try {
    const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `secret=0x4AAAAAAB6qazXLsDqjv-hftjzkBFfNbS0&response=${token}`,
    });

    const data = await verify.json();
    if (!data.success) return res.status(400).json({ error: "Captcha verification failed" });
  } catch (err) {
    console.error("❌ Error verifying CAPTCHA:", err);
    return res.status(500).json({ error: "Captcha verification error" });
  }

  const payload = generatePayload("0815404297", { amount: parseFloat(amount) });
  QRCode.toDataURL(payload, (err, url) => {
    if (err) return res.status(500).json({ error: err.message });

    const now = Date.now();
    pendingDonations = pendingDonations.filter((p) => now - p.time < 600000);
    pendingDonations.push({
      
      name: name || "ไม่ระบุชื่อ",
      amount: parseFloat(amount),
      comment: comment || "",
      time: now,
    });

    res.json({ result: url });
  });
});

// ✅ บันทึกลง Firestore
async function saveDonate(name, amount, comment = "") {
  try {
    const record = { name, amount, comment, time: new Date().toLocaleString("th-TH") };
    await db.collection("donations").add(record);
    console.log("💾 บันทึกโดเนท (Firestore):", record);
  } catch (err) {
    console.error("❌ Firestore Save Error:", err);
  }
}

// ✅ รับ Webhook จากมือถือ
// ✅ รับ Webhook จากมือถือ (Tasker / MacroDroid)
app.post("/bankhook", async (req, res) => {
  try {
    const text = req.body.text || "";
    console.log("📩 ได้รับข้อความจาก Tasker:", text);

    // 🔍 ดึงชื่อและจำนวนเงินจากข้อความมือถือ
    const match = text.match(/(\d+(?:\.\d+)?)\s*บาท/);
    const amount = match ? parseFloat(match[1]) : 0;
    const nameMatch = text.match(/จาก\s(.+)/);
    const name = nameMatch ? nameMatch[1].trim() : "ไม่ทราบชื่อ";

    if (!amount) {
      console.log("⚠️ ไม่พบจำนวนเงินในข้อความ");
      return res.sendStatus(400);
    }

    // ✅ ตรวจว่าตรงกับ QR ที่รออยู่ไหม
    const matchDonate = pendingDonations.find(
      (d) => Math.abs(d.amount - amount) < 0.5 // ยอมให้คลาดเคลื่อน 0.5 บาท
    );

    if (!matchDonate) {
      console.log("⚠️ ไม่มี QR ที่รอตรงกับยอดนี้:", amount);
    } else {
      console.log("✅ พบการโอนตรงกับ QR ที่รอ:", matchDonate);
      // ลบ QR ที่ตรงออกจาก pending list
      pendingDonations = pendingDonations.filter((d) => d !== matchDonate);
      fs.writeFileSync(donateFile, JSON.stringify(pendingDonations, null, 2), "utf8");
    }

    // 💾 บันทึกลง Firestore
    const donate = {
      name: name || matchDonate?.name || "ไม่ระบุชื่อ",
      amount: amount || matchDonate?.amount,
      comment: matchDonate?.comment || "",
      time: new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }),
    };

    await db.collection("donations").add(donate);
    console.log("💾 บันทึกโดเนท Firestore:", donate);

    // 📡 แจ้ง OBS ผ่าน WebSocket (alert.html)
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(
          JSON.stringify({
            type: "donate", // 👈 ต้องใช้ type นี้เท่านั้น!
            name: donate.name,
            amount: donate.amount,
            comment: donate.comment || "ขอบคุณสำหรับการสนับสนุน 💖",
          })
        );
      }
    });

    // ✅ ล็อกสถานะ
    console.log("🎉 Alert ส่งไป OBS แล้ว!");
    res.sendStatus(200);

  } catch (err) {
    console.error("❌ Error ใน bankhook:", err);
    res.sendStatus(500);
  }
});


// ✅ ดึงประวัติโดเนททั้งหมด
app.get("/donates", async (req, res) => {
  try {
    const snapshot = await db.collection("donations").orderBy("time", "desc").get();
    const data = snapshot.docs.map((doc) => doc.data());
    res.json(data);
  } catch (err) {
    console.error("❌ อ่านข้อมูล Firestore ไม่ได้:", err);
    res.json([]);
  }
});

// ✅ Alert test
app.get("/test", (req, res) => {
  enqueueBroadcast("donate", "เฟอ", 99, "ทดสอบระบบ 💖");
  res.send("✅ ส่ง alert ทดสอบไป OBS แล้ว!");
});

app.get("/", (req, res) => res.sendFile("index.html", { root: "public" }));
app.get("/alert", (req, res) => res.sendFile("alert.html", { root: "public" }));
app.get("/dashboard", (req, res) => res.sendFile("dashboard.html", { root: "public" }));
app.get("/goal", (req, res) => res.sendFile("goal.html", { root: "public" }));

// ✅ Start server
const PORT = process.env.PORT || 3000;

// ✅ Hook สำหรับรับข้อมูลโดเนทจาก Tasker หรือ curl
app.post("/api/payment-hook", (req, res) => {
  try {
    const { name, amount, comment } = req.body;

    if (!name || !amount) {
      return res.status(400).json({ error: "Missing name or amount" });
    }

    // 🔹 โหลดข้อมูลเดิม
    const donateFile = "donates.json";
    const data = JSON.parse(fs.readFileSync(donateFile, "utf8"));

    // 🔹 เพิ่มข้อมูลใหม่
    const record = {
      name,
      amount,
      comment: comment || "",
      time: new Date().toLocaleString("th-TH"),
    };
    data.push(record);
    fs.writeFileSync(donateFile, JSON.stringify(data, null, 2));

    console.log("💖 มีโดเนทใหม่เข้ามา:", record);

    // 🔹 ส่ง event ไปหา WebSocket alert.html
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(
          JSON.stringify({
            type: "donate",
            name,
            amount,
            comment,
          })
        );
      }
    });

    res.json({ success: true, message: "บันทึกโดเนทเรียบร้อย", record });
  } catch (err) {
    console.error("❌ payment-hook error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
