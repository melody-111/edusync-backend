# 🎓 Digital Classroom Ecosystem - Backend Documentation

This project is a high-performance, production-grade EdTech backend designed for a real-time digital classroom environment involving three distinct platforms:
1. **Teacher Web Application** (Board/Control Center)
2. **Student Tablet Application** (Interactive Surface)
3. **Mobile Companion App** (Notes & Profile Access)

---

## 🛠 Tech Stack
- **Engine:** Node.js + Express.js
- **Database:** MongoDB (Mongoose) - Cloud Atlas Ready
- **Real-time:** Socket.io (with WebSockets & Polling fallback)
- **Caching:** Redis (with in-memory fallback)
- **PDF Engine:** Puppeteer (Headless Chrome)
- **Security:** JWT, Google OAuth 2.0, OTP & QR Authentication
- **Notifications:** Firebase Admin SDK (FCM)
- **Storage:** Hierarchical Local/Cloud Storage (`exports/pdfs/{userId}/{Subject}/{Date}/`)

---

## 🔥 Key Business Logic & Features

### 1. The 80/20 Rule (Canvas Isolation)
The backend enforces a strict data separation policy for live classroom interaction:
- **Teacher Broadcast (20% Preview):** Real-time data from the teacher’s board is broadcasted to all students’ 20% preview area.
- **Student Privacy (80% Writing):** A student’s writing in their personal 80% area is privately synced to the backend and never broadcasted to other students.

### 2. High-Fidelity Stylus & S-Pen Support
Optimized for hardware like Samsung S-Pen:
- **Pressure Sensitivity:** Captures and stores 0.0 to 1.0 pressure values for calligraphy effects.
- **Palm Rejection Support:** Pointer types (pen vs touch) are tracked to ignore accidental hand touches while drawing.
- **Touch Gestures:** Native support for multi-touch (zoom in/out) while the pen is in use.
- **Batching:** Strokes are batched every 4 seconds to prevent server CPU overloads during high-frequency writing.

### 3. Native QR Authentication & Session Lifecycle
- **QR Sign-In:** Mobile apps can login instantly by scanning a unique user QR token.
- **Session QR:** Rotating QR codes for every session to ensure secure room entry.
- **Auto-Pipeline:** When a teacher ends a session, the backend automatically:
    - Merges teacher and student notes.
    - Generates a combined PDF.
    - Stores the file in the hierarchical subject-wise folder.
    - Triggers push notifications and emails.

### 4. Hierarchical File/Folder Management
- **Subject-wise Folders:** Users can create folders for "Physics", "Maths", etc.
- **Categories:** Folders can be tagged as "Assignments", "Experiments", or "Class Notes".
- **Dynamic Paths:** PDFs are exported into: `/exports/pdfs/{userId}/{Subject}/{YYYY-MM-DD}/{sessionId}.pdf`.

---

## 📡 API Endpoints Summary

### Authentication
- `POST /auth/login` (Send OTP)
- `POST /auth/verify-otp` (Exchange for JWT)
- `POST /auth/qr-login` (Scan-to-login)
- `GET /auth/me` (Profile Check)
- `PUT /auth/profile` (Update RollNo, Branch, Semester, Course, Gmail)

### Sessions & Real-Time
- `POST /session/start` (Generate Room & QR)
- `POST /session/join` (Enter active class)
- `POST /session/:id/end` (Trigger lock & auto-save)

### Folders & Notes
- `POST /folders` (Create subject-wise folder)
- `GET /folders` (List active folders)
- `GET /user/notes` (Access session PDFs for Students & Teachers)

### AI & Media Controls (Teacher Only)
- `POST /ai/chat` (200 limit for Teachers, 20 for Students)
- `POST /ai/control` (Enable/Disable AI for the whole class)

---

## ⚡ Socket.io Events
| Event | Sender | Receiver | Purpose |
| :--- | :--- | :--- | :--- |
| `draw` | Teacher | Students | Broadcast board writing to 20% area |
| `draw:student` | Student | Backend Only | Save 80% area writing privately |
| `videoPlay` | Teacher | Students | Sync YouTube playback |
| `controlUpdate`| Teacher | Students | Lock/Unlock Keyboard, AI, or Copy-Paste |
| `session:ended`| Backend | All | Force disconnect and trigger local save |

---

## 🛡 Performance & Kiosk Optimization
Designed for dedicated hardware (Kiosk Mode):
- **Memory Monitor:** Logs heap/RSS usage every 5 minutes.
- **Hardware Recovery:** Docker config `restart: unless-stopped` for power loss recovery.
- **Bandwidth:** `perMessageDeflate` active for WebSocket compression.
- **Rate Limiting:** Protects against hardware-level API spamming.

---

## 🚀 Getting Started
1. **Env Setup:** Rename `.env.example` to `.env`.
2. **Install:** `npm install`
3. **Start:** `npm start`
4. **Local IP:** The server prints your Local IP on startup (e.g., `192.168.1.5`). Use this IP in your Mobile/Tablet app to connect instantly over WiFi.

---
**Maintained by Antigravity AI Engine** 🚀🦾🛸
