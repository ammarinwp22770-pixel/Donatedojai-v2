// make-silent.js
import fs from "fs";

// ความยาวเสียงเงียบ (0.2 วินาที)
const duration = 0.2;
const sampleRate = 44100;

// สร้าง buffer เงียบ (ไม่มีเสียงเลย)
const samples = new Int16Array(duration * sampleRate);
const buffer = Buffer.from(samples.buffer);

// ตรวจให้แน่ใจว่ามีโฟลเดอร์ public
if (!fs.existsSync("public")) fs.mkdirSync("public");

// เขียนไฟล์ออกมาใน public/silent.wav
fs.writeFileSync("public/silent.wav", buffer);
console.log("✅ สร้างไฟล์ silent.wav เรียบร้อยแล้ว ✅");
