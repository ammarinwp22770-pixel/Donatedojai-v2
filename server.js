import express from "express";
import { WebSocketServer } from "ws";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import generatePayload from "promptpay-qr";
import http from "http";
import cors from "cors";
import admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));
const __dirname = path.resolve();

// ✅ โหลด Firebase
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_CREDENTIALS))
  });
}
const db = admin.firestore();

// 📁 ไฟล์รอการชำระ
const pendingFile = path.join(__dirname, "pending.json");
if (!fs.existsSync(pendingFile)) fs.writeFileSync(pendingFile, "[]", "utf8");

// ✅ API สร้าง QR
app.post("/generateQR", async (req, res) => {
  try {
    const { amount, name, comment } = req.body;
    if (!amount || !name) return res.status(400).json({ error: "Missing name or amount" });

    const mobileNumber = process.env.PROMPTPAY_ID;
    const payload = generatePayload(mobileNumber, { amount });
    const qrDataUrl = await QRCode.toDataURL(payload);

    // 🧠 บันทึกรายการรอชำระ
    const pending = JSON.parse(fs.readFileSync(pendingFile, "utf8"));
    pending.push({ name, amount: parseFloat(amount), comment, time: Date.now() });
    fs.writeFileSync(pendingFile, JSON.stringify(pending, null, 2), "utf8");

    console.log(`🆕 สร้าง QR สำหรับ ${name} (${amount} บาท)`);

    res.json({ result: qrDataUrl });
  } catch (err) {
    console.error("❌ generateQR error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ✅ Tasker webhook (เปิดรอไว้ก่อน — จับยอดตรง)
app.use(express.text({ type: '*/*' }));
app.post("/bankhook", async (req, res) => {
  try {
    const text = req.body;
    console.log("📩 Tasker message:", text);

    // ดึงยอดจากข้อความ
    const match = text.match(/(\d+(?:[.,]\d+)?)\s*(บาท|฿|บ\.|THB)?/i);
    const amount = match ? parseFloat(match[1].replace(",", "")) : null;
    if (!amount) return res.status(400).json({ error: "ไม่พบจำนวนเงินในข้อความ" });

    // โหลด pending
    const pending = JSON.parse(fs.readFileSync(pendingFile, "utf8"));
    if (pending.length === 0) return res.status(400).json({ error: "ไม่มีรายการรอชำระ" });

    // ตรวจยอดตรง
    const found = pending.find(p => Math.abs(p.amount - amount) < 0.1);
    if (!found) return res.status(404).json({ error: "ไม่พบรายการยอดตรง" });

    console.log(`✅ ยอดตรง ${amount} บาท กับ ${found.name}`);

    // ลบออกจาก pending
    const updated = pending.filter(p => p !== found);
    fs.writeFileSync(pendingFile, JSON.stringify(updated, null, 2), "utf8");

    // บันทึก Firestore
    await db.collection("donations").add({
      name: found.name,
      amount: found.amount,
      comment: found.comment || "",
      time: new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }),
    });

    // ส่งไป OBS alert
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(JSON.stringify({
          type: "donate",
          name: found.name,
          amount: found.amount,
          comment: found.comment,
        }));
      }
    });

    console.log("🎉 ส่ง Alert ไป OBS เรียบร้อยแล้ว!");
    res.json({ success: true, message: "ส่ง Alert สำเร็จ!" });
  } catch (err) {
    console.error("❌ bankhook error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ✅ WebSocket
wss.on("connection", (ws) => {
  console.log("🟢 WebSocket ใหม่เชื่อมต่อแล้ว!");
});

// ✅ start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server Running on Port ${PORT}`));
