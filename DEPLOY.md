# Deploy บน Railway

repo นี้มี 2 service แยกกัน แต่ละตัวมีไฟล์ `railway.json` ของตัวเอง

| Service | Root Directory | Config File Path | ต้องมี Volume |
|---|---|---|---|
| ระบบคิวพิมพ์ + สต็อก (LINE) | `apps/print-queue` | `/apps/print-queue/railway.json` | ✅ mount ที่ `/data` |
| เว็บไซต์ (Next.js) | `apps/web` | `/apps/web/railway.json` | – |

> Railway ไม่หา config file ตาม Root Directory ให้อัตโนมัติ ต้องใส่ **Config File Path** แบบ absolute ตามตารางในหน้า Settings ของแต่ละ service

## ขั้นตอน
1. **New Project → Deploy from GitHub repo** แล้วเลือก repo นี้ (ได้ 1 service)
2. Service แรก (ระบบคิว)
   - Settings: ตั้ง Root Directory = `apps/print-queue` และ Config File Path = `/apps/print-queue/railway.json`
   - กด **+ New → Volume** แล้ว mount ที่ `/data` (เก็บฐานข้อมูลและไฟล์ STL ที่ลูกค้าอัปโหลด)
   - Variables: `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `INTEGRATION_API_KEY`, `ADMIN_PASSWORD`
   - Networking: กด **Generate Domain** แล้วนำ URL + `/webhook` ไปใส่เป็น Webhook URL ใน LINE Developers
3. **+ New → GitHub Repo** (repo เดิม) เพื่อสร้าง service ที่สอง (เว็บไซต์)
   - Settings: ตั้ง Root Directory = `apps/web` และ Config File Path = `/apps/web/railway.json`
   - Variables: `PRINT_QUEUE_URL` = `https://${{<ชื่อ service ระบบคิว>.RAILWAY_PUBLIC_DOMAIN}}` และ `PRINT_QUEUE_API_KEY` = ค่าเดียวกับ `INTEGRATION_API_KEY`
   - Networking: กด **Generate Domain**

สร้างคีย์ลับด้วยคำสั่ง `openssl rand -hex 32`

`watchPatterns` ทำให้แต่ละ service deploy ใหม่เฉพาะเมื่อไฟล์ในโฟลเดอร์ของตัวเองเปลี่ยน

ส่วน `apps/worker` (CuraEngine) ยังไม่ได้เชื่อมกับเว็บ จึงยังไม่ต้อง deploy
