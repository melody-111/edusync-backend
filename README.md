# 📚 EduSync — Complete Project Documentation (A to Z)

> **Project:** EduSync — Digital Classroom Platform  
> **Author:** Sudhanshu  
> **Version:** 1.0 (July 2026)  
> **GitHub Repos:** edusync-backend · edysync-mobile-app · (admin/teacher/student on separate repos)

---

## 🗺️ Project Overview

EduSync is a full-stack, multi-platform digital classroom ecosystem connecting:

| App | Platform | Purpose |
|---|---|---|
| **Backend** | Node.js / Express | Central API server for all apps |
| **Mobile App** | React Native (Expo) | Students — attend classes, scan QR, take notes |
| **Admin Dashboard** | React (Vite) | Super admin — manage all users, colleges, sessions |
| **Teacher App** | React (Vite) | Teacher — run live classes, whiteboard, media |
| **Student App** | React (Vite) | Student web version — join classes, view notes |

---

# 🖥️ 1. BACKEND (`web-app backend/`)

## Tech Stack
| Technology | Purpose |
|---|---|
| **Node.js + Express** | Core web server |
| **MongoDB + Mongoose** | Primary database |
| **Redis (ioredis)** | OTP cache, session cache, Socket.IO adapter |
| **Socket.IO** | Real-time canvas sync, notifications, QR events |
| **JWT (jsonwebtoken)** | Auth tokens (access 7d + refresh 30d) |
| **Nodemailer (SMTP)** | OTP email delivery (Gmail App Password) |
| **@sendgrid/mail** | SendGrid fallback if SMTP fails |
| **Twilio** | WhatsApp OTP for phone number signups |
| **Cloudinary** | Cloud image/file storage |
| **Firebase Admin** | Push notifications to mobile app |
| **Passport + Google OAuth** | Google login |
| **Multer** | File uploads |
| **PDFKit + Puppeteer** | PDF generation from notes |
| **BullMQ** | Background job queues |
| **Winston** | Structured logging |
| **Helmet / cors / hpp / xss-clean** | Security middleware |
| **express-rate-limit** | Rate limiting per route |
| **Swagger** | API documentation |

## Folder Structure
```
web-app backend/
├── src/
│   ├── server.js              ← Entry point, starts HTTP + Socket.IO
│   ├── app.js                 ← Express app setup, middleware, routes
│   ├── config/
│   │   ├── db.js              ← MongoDB connection
│   │   └── redis.js           ← Redis + in-memory fallback cache
│   ├── controllers/
│   │   ├── authController.js  ← Signup, Login, OTP, QR, 2FA, Google OAuth
│   │   ├── adminController.js ← User management, stats, college CRUD
│   │   ├── sessionController.js ← Create/join/end live class sessions
│   │   ├── classroomController.js ← Classroom CRUD, enrollment
│   │   ├── fileController.js  ← File upload, notes, strokes, PDF
│   │   ├── aiController.js    ← AI chat, image generation
│   │   ├── folderController.js ← Folder management
│   │   ├── freeStudyController.js ← Student self-study sessions
│   │   ├── notificationController.js ← Push notifications
│   │   ├── deviceController.js ← Device registration
│   │   ├── syncController.js  ← Offline sync queue
│   │   └── youtubeController.js ← YouTube search integration
│   ├── models/
│   │   ├── User.js            ← Users (student/teacher/super_admin)
│   │   ├── Session.js         ← Live class sessions
│   │   ├── Classroom.js       ← Teacher classrooms
│   │   ├── College.js         ← College/Institution records
│   │   ├── File.js            ← Uploaded files & notes
│   │   ├── Page.js            ← Canvas whiteboard pages
│   │   ├── StrokeBatch.js     ← Canvas drawing strokes
│   │   ├── ActivityLog.js     ← Audit logs
│   │   ├── Notification.js    ← Push notifications
│   │   ├── Device.js          ← Registered mobile devices
│   │   ├── TerminalSession.js ← QR login terminal sessions
│   │   ├── Assignment.js      ← Assignments
│   │   ├── Folder.js          ← File folders
│   │   └── MediaSession.js    ← YouTube/video media in sessions
│   ├── routes/
│   │   ├── auth.js            ← /auth/* endpoints
│   │   ├── admin.js           ← /admin/* endpoints
│   │   ├── sessions.js        ← /session/* endpoints
│   │   ├── classrooms.js      ← /classroom/* endpoints
│   │   ├── files.js           ← /files/* endpoints
│   │   ├── ai.js              ← /ai/* endpoints
│   │   ├── folders.js         ← /folders/* endpoints
│   │   ├── freeStudy.js       ← /study/* endpoints
│   │   ├── notifications.js   ← /notifications/* endpoints
│   │   ├── devices.js         ← /devices/* endpoints
│   │   ├── sync.js            ← /sync/* endpoints
│   │   └── youtube.js         ← /youtube/* endpoints
│   ├── middleware/
│   │   ├── auth.js            ← JWT authentication + role guard
│   │   ├── rateLimiter.js     ← Per-route rate limits
│   │   ├── validate.js        ← express-validator error handler
│   │   └── upload.js          ← Multer config
│   ├── socket/                ← Socket.IO event handlers
│   ├── services/
│   │   └── twoFactorAuth.js   ← 2FA TOTP logic (speakeasy)
│   ├── utils/
│   │   ├── email.js           ← SMTP (Gmail) + SendGrid fallback
│   │   ├── sms.js             ← Twilio WhatsApp OTP
│   │   ├── jwt.js             ← Token generation/verification
│   │   ├── helpers.js         ← sendSuccess, sendError, getClientIp
│   │   ├── logger.js          ← Winston logger
│   │   └── activityLogger.js  ← Audit log middleware
│   └── workers/               ← BullMQ background workers
├── .env                       ← Environment variables (NOT in git)
├── package.json
└── firebase-service-account.json
```

## Environment Variables (`.env`)
```env
# Server
NODE_ENV=production
PORT=5001

# MongoDB
MONGODB_URI=mongodb+srv://...

# JWT
JWT_SECRET=...
JWT_EXPIRES_IN=7d
JWT_REFRESH_SECRET=...
JWT_REFRESH_EXPIRES_IN=30d

# SMTP (Primary email)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=sudhanshusonkar210@gmail.com
SMTP_PASS=<gmail-app-password>
EMAIL_FROM="EduSync 🎓 <sudhanshusonkar210@gmail.com>"

# SendGrid (Fallback email)
SENDGRID_API_KEY=SG.xxx...

# Twilio (WhatsApp OTP for phone signups)
TWILIO_ACCOUNT_SID=ACxxx...
TWILIO_AUTH_TOKEN=xxx...
TWILIO_PHONE_NUMBER=+919369243684
TWILIO_WHATSAPP_FROM=+14155238886  ← Sandbox sender

# Google OAuth
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# Cloudinary
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...

# Firebase
FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json
```

---

## 📡 All API Endpoints

### 🔐 AUTH (`/auth`)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/auth/signup` | ❌ | Register new user → sends OTP via SMTP |
| POST | `/auth/verify-otp` | ❌ | Verify signup OTP → creates MongoDB user → returns JWT |
| POST | `/auth/login-password` | ❌ | Login with email + password → JWT |
| POST | `/auth/login` | ❌ | Email-only login → sends OTP |
| POST | `/auth/forgot-password` | ❌ | Send password reset OTP |
| POST | `/auth/verify-reset-otp` | ❌ | Verify reset OTP |
| POST | `/auth/reset-password` | ❌ | Set new password with OTP |
| POST | `/auth/qr-login` | ❌ | Mobile QR scan → JWT login |
| GET | `/auth/me` | ✅ | Get current user profile |
| PUT | `/auth/profile` | ✅ | Update academic profile |
| POST | `/auth/set-password` | ✅ | Set/change password |
| GET | `/auth/dashboard-stats` | ✅ | Personal dashboard stats |
| POST | `/auth/refresh` | ❌ | Exchange refresh token → new access token |
| POST | `/auth/logout` | ✅ | Invalidate token |
| GET | `/auth/qr-token` | ✅ | Get personal QR code image |
| GET | `/auth/qr-token/refresh` | ✅ | Refresh QR every 60s |
| POST | `/auth/qr-token/regenerate` | ✅ | Rotate QR token |
| GET | `/auth/terminal/init` | ❌ | Initialize terminal QR |
| POST | `/auth/terminal/sync` | ✅ | Sync mobile → terminal login |
| GET | `/auth/google` | ❌ | Start Google OAuth |
| GET | `/auth/google/callback` | ❌ | Google OAuth callback |
| POST | `/auth/2fa/setup` | ✅ | Setup 2FA secret |
| POST | `/auth/2fa/enable` | ✅ | Enable 2FA |
| POST | `/auth/2fa/verify` | ❌ | Verify 2FA token |
| POST | `/auth/2fa/disable` | ✅ | Disable 2FA |
| GET | `/auth/2fa/status` | ✅ | Check 2FA status |

### 🛡️ ADMIN (`/admin`) — super_admin only

| Method | Endpoint | Description |
|---|---|---|
| GET | `/admin/stats` | Global dashboard stats (users, sessions, colleges) |
| GET | `/admin/logs` | System-wide audit logs |
| GET | `/admin/system-stats` | CPU/RAM usage |
| GET | `/admin/users` | All users (filter: role, isActive) |
| GET | `/admin/sessions` | All sessions (filter: status) |
| PUT | `/admin/users/:id/status` | Activate/deactivate user |
| PUT | `/admin/users/:id/role` | Change user role |
| POST | `/admin/users/:id/notify` | Send notification to user |
| GET | `/admin/users/:id/activities` | User file/PDF activities |
| GET | `/admin/users/:id/details` | Full user history + profile |
| POST | `/admin/users/:id/block` | Block user |
| POST | `/admin/users/:id/unblock` | Unblock user |
| POST | `/admin/colleges` | Create new college |
| GET | `/admin/colleges` | List all colleges |
| PUT | `/admin/colleges/:id/block` | Block/unblock college |
| GET | `/admin/hierarchy` | Institution → teachers/students tree |

### 📅 SESSIONS (`/session`) — auth required

| Method | Endpoint | Role | Description |
|---|---|---|---|
| POST | `/session/start` | teacher | Start a new live class session |
| POST | `/session/self-start` | student/teacher | Start self-study session |
| POST | `/session/join` | student | Join session via QR code |
| POST | `/session/join-direct` | student | Join without QR scan |
| POST | `/session/join-teacher/:teacherId` | student | Join teacher's live class by ID |
| GET | `/session/active/:classroomId` | both | Discover active sessions in classroom |
| GET | `/session/active/desk/:deskId` | both | Discover by teacher desk ID |
| POST | `/session/:id/end` | teacher/student | End session |
| POST | `/session/save` | both | Save canvas progress |
| PATCH | `/session/:id/controls` | teacher | Update classroom controls |
| POST | `/session/:id/media` | teacher | Set YouTube/video for session |
| GET | `/session/:id/media` | both | Get current media state |
| POST | `/session/:id/refresh-qr` | teacher | Refresh session QR code |
| GET | `/session/:id/notes` | both | Get notes for session |
| GET | `/session/mine` | both | My session history |
| GET | `/session/:id` | both | Session details + participants |

### 🏫 CLASSROOMS (`/classroom`) — auth required

| Method | Endpoint | Role | Description |
|---|---|---|---|
| POST | `/classroom/` | teacher | Create classroom |
| GET | `/classroom/mine` | teacher | My classrooms |
| PUT | `/classroom/:id` | teacher | Update classroom |
| DELETE | `/classroom/:id` | teacher | Delete classroom |
| GET | `/classroom/:id/sessions` | both | Session history |
| GET | `/classroom/students` | teacher | College students list |
| POST | `/classroom/students/:id/block` | teacher | Block/unblock student |
| GET | `/classroom/students/:id/activity` | teacher | Student activity |
| POST | `/classroom/enroll` | student | Enroll in classroom |
| POST | `/classroom/:id/leave` | student | Leave classroom |
| GET | `/classroom/enrolled` | student | My enrolled classrooms |
| GET | `/classroom/recordings` | both | Recorded class sessions |
| GET | `/classroom/:id` | both | Classroom details |

### 📁 FILES (`/files`) — auth required

| Method | Endpoint | Description |
|---|---|---|
| GET | `/files/notes` | Get user's notes |
| GET | `/files/shared` | Get teacher-shared files |
| POST | `/files/upload` | Upload a file (multipart) |
| POST | `/files/note` | Save a note |
| GET | `/files/:id/pdf` | Generate PDF from note |
| GET | `/files/:id` | Get file by ID |
| DELETE | `/files/:id` | Delete file |
| POST | `/files/strokes/batch` | Save canvas strokes (batch) |
| GET | `/files/strokes/page/:pageId` | Get strokes for a page |
| POST | `/files/pages` | Create new canvas page |
| GET | `/files/pages/session/:sessionId` | Get pages for session |

### 🤖 AI (`/ai`) — auth required

| Method | Endpoint | Description |
|---|---|---|
| POST | `/ai/chat` | AI chat (OpenAI) |
| POST | `/ai/generate-image` | AI image generation |
| GET | `/ai/usage` | AI usage stats |

### 📁 FOLDERS, 📢 NOTIFICATIONS, 📱 DEVICES, 🔄 SYNC, 🎬 YOUTUBE

| Route | Description |
|---|---|
| `/folders/*` | Create/get/delete note folders |
| `/notifications/*` | Push notification management |
| `/devices/*` | Mobile device registration |
| `/sync/*` | Offline data sync queue |
| `/youtube/*` | YouTube video search |
| `/study/*` | Free study session management |

---

## 🔄 OTP Email Flow (Complete)

```
Mobile App → POST /auth/signup (name, email, password, role…)
     ↓
Backend: Validate → Generate 6-digit OTP
     ↓
Store in Redis (key: otp:<email>, TTL: 10 min)
     ↓
email.js: Try SMTP (smtp.gmail.com:587)
     ↓ success
Send HTML email → User's Gmail inbox ✅
     ↓ fail (if Render blocks SMTP)
email.js: Try SendGrid API
     ↓ success/fail
Return fallbackOtp in response for testing
     ↓
User receives email → types OTP in app
     ↓
POST /auth/verify-otp
     ↓
Backend: Match OTP → Create user in MongoDB → Delete Redis key → Return JWT
     ↓
Mobile App: Stores token → Opens MainTabs → User appears in Admin Dashboard ✅
```

---

## 🔌 Socket.IO Events

| Event (client → server) | Description |
|---|---|
| `session:join` | Join a live session room |
| `stroke:batch` | Send canvas strokes |
| `control:update` | Teacher updates class controls |
| `media:set` | Teacher sets YouTube URL |
| `session:end` | End session |
| `qr:scanned` | Mobile scanned QR code |
| `terminal:sync` | Sync terminal login |

| Event (server → client) | Description |
|---|---|
| `stroke:batch` | Broadcast strokes to all in session |
| `control:update` | Broadcast control changes |
| `media:update` | Broadcast media change |
| `session:ended` | Notify all participants |
| `qr:authenticated` | Confirm QR login |
| `notification:new` | Push notification |

---

## 🚀 Deployment

- **Backend:** [Render.com](https://render.com) (Free Tier)
  - URL: `https://edusync-backend-application.onrender.com`
  - ⚠️ Free tier blocks SMTP (port 587). Upgrade to paid OR use SendGrid API.
- **Local Dev:** `npm run dev` → `http://localhost:5001`

---
---

# 📱 2. MOBILE APP (`mobile-app/`)

## Tech Stack
| Technology | Purpose |
|---|---|
| **React Native + Expo** | Cross-platform iOS & Android |
| **TypeScript** | Type safety |
| **React Navigation** | Screen navigation (Stack + Tabs) |
| **Zustand** | Global state management (auth store) |
| **Axios** | HTTP API calls |
| **Expo SecureStore** | Secure token storage |
| **expo-camera** | QR code scanning |
| **expo-linear-gradient** | Beautiful gradient UI |
| **expo-notifications** | Push notifications |
| **lucide-react-native** | Icons |
| **expo-sqlite** | Offline local database |

## Folder Structure
```
mobile-app/
├── App.tsx                    ← Entry point, initializes DB, notifications
├── src/
│   ├── navigation/
│   │   └── AppNavigator.tsx   ← Root navigator (Auth stack vs MainTabs)
│   ├── screens/
│   │   ├── auth/
│   │   │   ├── LoginScreen.tsx        ← Email + Password login
│   │   │   ├── SignupScreen.tsx       ← 2-page registration form
│   │   │   ├── OtpScreen.tsx         ← 6-box OTP verification
│   │   │   ├── ForgotPasswordScreen.tsx ← Send reset OTP
│   │   │   └── SetPasswordScreen.tsx ← Set new password
│   │   ├── dashboard/
│   │   │   └── DashboardScreen.tsx   ← Home (stats, classes, quick actions)
│   │   ├── notes/
│   │   │   └── NotesScreen.tsx       ← My notes list
│   │   ├── ai/
│   │   │   └── AiScreen.tsx          ← AI chat assistant
│   │   ├── qr/
│   │   │   └── QrScreen.tsx          ← Scan QR to join class or login to web
│   │   ├── profile/
│   │   │   └── ProfileScreen.tsx     ← User profile, settings
│   │   ├── pdf/
│   │   │   └── PdfViewerScreen.tsx   ← View PDF notes
│   │   └── common/
│   │       └── LoadingScreen.tsx     ← Splash loading
│   ├── api/
│   │   ├── client.ts          ← Axios instance with JWT interceptor
│   │   ├── auth.api.ts        ← All auth API calls
│   │   ├── notes.api.ts       ← Notes API calls
│   │   ├── session.api.ts     ← Session API calls
│   │   ├── ai.api.ts          ← AI API calls
│   │   └── device.api.ts      ← Device registration
│   ├── store/
│   │   └── auth.store.ts      ← Zustand: token, user, setToken, setUser, logout
│   ├── services/
│   │   ├── storage.service.ts ← SecureStore wrapper (get/set/remove token)
│   │   └── notification.service.ts ← Push notification setup
│   ├── database/
│   │   └── sqlite.ts          ← Offline SQLite DB init
│   └── utils/
│       ├── constants.ts       ← API_URL, COLORS, FONTS
│       └── device.ts          ← Get unique device ID
```

## Navigation Flow
```
App Start
  ↓
AppNavigator checks token in SecureStore
  ├── No token  → AuthStack (Login / Signup / OTP / ForgotPassword / SetPassword)
  └── Has token → MainTabs (Dashboard / Notes / QR / AI / Profile)
```

## Signup → OTP Flow (Mobile)
```
SignupScreen (page 1: name, email, role, institution)
  → (Continue) →
SignupScreen (page 2: academic details + password)
  → (Create Account) →
  POST /auth/signup
  ↓ success
OtpScreen (6-box input, 60s resend timer)
  → (Verify & Sign In) →
  POST /auth/verify-otp
  ↓ success
Token + User stored in Zustand + SecureStore
AppNavigator detects token → switches to MainTabs ✅
```

---
---

# 🛡️ 3. ADMIN DASHBOARD (`admin dashboard/`)

## Tech Stack
| Technology | Purpose |
|---|---|
| **React + TypeScript** | Frontend framework |
| **Vite** | Build tool |
| **TailwindCSS** | Styling |
| **Axios** | API calls |
| **Recharts** | Charts & graphs |

## Folder Structure
```
admin dashboard/
├── src/
│   ├── pages/
│   │   ├── AuthPage.tsx       ← Admin login page
│   │   └── DashboardPage.tsx  ← Main dashboard (all features)
│   ├── App.tsx                ← Route: / → Auth, /dashboard → Dashboard
│   └── main.tsx               ← Entry point
```

## Features
| Feature | Description |
|---|---|
| **Login** | Secure admin login (role = super_admin) |
| **Global Stats** | Total users, sessions, colleges, active sessions |
| **User Management** | View all users, activate/deactivate, change role, block |
| **Session Monitoring** | All live and past sessions |
| **College Management** | Create colleges, block/unblock |
| **Institution Hierarchy** | College → Teachers → Students tree view |
| **Audit Logs** | Full system activity logs |
| **User Details** | Deep dive into individual user history |
| **Push Notifications** | Send notifications to any user |

## API Used
All `/admin/*` endpoints (protected — only super_admin role or `ADMIN_EMAIL`)

---
---

# 👨‍🏫 4. TEACHER APP (`teacher-app/`)

## Tech Stack
| Technology | Purpose |
|---|---|
| **React + TypeScript** | Frontend framework |
| **Vite** | Build tool |
| **TailwindCSS** | Styling |
| **Zustand** | State management |
| **Socket.IO client** | Real-time canvas + session sync |
| **Axios** | API calls |

## Folder Structure
```
teacher-app/
├── src/
│   ├── components/            ← Reusable UI components
│   ├── store/                 ← Zustand stores (auth, session)
│   ├── lib/                   ← Shared utilities
│   ├── App.tsx                ← Main app + routing
│   └── main.tsx               ← Entry point
├── vercel.json                ← Vercel deployment config
```

## Features
| Feature | Description |
|---|---|
| **Login** | Teacher login via email + password |
| **Live Classroom** | Start class, display QR code for students |
| **Whiteboard** | Real-time drawing canvas synced via Socket.IO |
| **YouTube Integration** | Embed YouTube videos in live class |
| **Session Controls** | Mute, lock, disable student drawing |
| **Student Management** | View enrolled students, block/unblock |
| **Notes & Files** | Upload and share files with students |
| **QR Code Login** | Scan QR from mobile app to log into teacher app |
| **Session History** | View past class recordings |

## Key API Used
- POST `/auth/login-password`
- POST `/session/start`
- PATCH `/session/:id/controls`
- POST `/session/:id/media`
- GET `/classroom/mine`
- GET `/classroom/students`
- Socket.IO: `stroke:batch`, `control:update`, `media:set`

---
---

# 🎓 5. STUDENT APP (`student-app/`)

## Tech Stack
| Technology | Purpose |
|---|---|
| **React + TypeScript** | Frontend framework |
| **Vite** | Build tool |
| **TailwindCSS** | Styling |
| **Zustand** | State management |
| **Socket.IO client** | Real-time canvas sync |
| **Axios** | API calls |
| **Docker + k8s** | Container deployment (k8s-infra folder) |

## Folder Structure
```
student-app/
├── src/
│   ├── api/                   ← API clients
│   ├── components/            ← Reusable UI
│   ├── features/              ← Feature modules
│   ├── store/                 ← Zustand state
│   ├── hooks/                 ← Custom React hooks
│   ├── types/                 ← TypeScript types
│   ├── utils/                 ← Helpers
│   ├── App.tsx                ← Main app
│   └── main.tsx               ← Entry point
├── docker-compose.yml         ← Docker setup
├── k8s-infra/                 ← Kubernetes manifests
└── vercel.json                ← Vercel deployment
```

## Features
| Feature | Description |
|---|---|
| **Login** | Student login via email + password |
| **Join Class** | Join teacher's live class by QR or direct join |
| **Live Canvas** | View teacher's whiteboard in real-time |
| **Notes** | View and save session notes |
| **File Library** | Access shared teacher files |
| **Session History** | View past sessions |
| **Self-Study** | Start personal study session |

## Key API Used
- POST `/auth/login-password`
- POST `/session/join`
- GET `/session/active/:classroomId`
- GET `/classroom/enrolled`
- GET `/files/shared`
- Socket.IO: `stroke:batch`, `media:update`

---
---

# 🌊 Complete End-to-End Flow

## Flow 1: New User Registration
```
1. User opens Mobile App → Signup Screen
2. Fills: Name, Email, Role (student/teacher), Institution
3. Fills: Academic details + Password
4. Clicks "Create Account"
5. Mobile App → POST /auth/signup → Backend
6. Backend: Validates → Generates OTP → Stores in Redis (10 min TTL)
7. Backend: Sends OTP email via SMTP (Gmail App Password)
8. OTP email arrives in user's inbox
9. User enters 6-digit OTP in Mobile App
10. Mobile App → POST /auth/verify-otp → Backend
11. Backend: OTP matches → Deletes Redis key → Creates user in MongoDB
12. User instantly visible in Admin Dashboard
13. Backend returns JWT access + refresh tokens
14. Mobile App stores tokens securely → Opens MainTabs
```

## Flow 2: Teacher Starts a Live Class
```
1. Teacher logs into Teacher App (web browser)
2. POST /auth/login-password → JWT
3. Creates/selects a Classroom
4. Clicks "Start Class" → POST /session/start
5. Teacher App displays QR code (changes every 60s via Socket.IO)
6. Student opens Mobile App → Scans QR
7. POST /auth/qr-login → JWT for web (or join session)
8. Student joins live session room via Socket.IO
9. Teacher draws on whiteboard → strokes synced via Socket.IO to all students
10. Teacher sets YouTube video → all students see it simultaneously
11. Teacher ends class → POST /session/:id/end
12. Session saved to MongoDB → accessible in history
```

## Flow 3: QR Code Web Login
```
1. Student is already logged into Mobile App
2. Student visits Student App (web browser)
3. Student App shows a terminal QR code
4. Student taps "Scan QR" on Mobile App
5. Camera scans QR → POST /auth/terminal/sync
6. Socket.IO event fires → Student App detects authentication
7. Student is instantly logged into Student App without typing password
```

---
---

# 🔑 Security Architecture

| Layer | Method |
|---|---|
| **Auth** | JWT (access 7d + refresh 30d) |
| **OTP** | Redis-cached, 10-minute TTL, 6-digit random |
| **Rate Limiting** | Auth: 10 req/15min, OTP: 5 req/15min, API: 100 req/min |
| **Input Validation** | express-validator on all POST routes |
| **SQL/NoSQL Injection** | express-mongo-sanitize |
| **XSS** | xss-clean middleware |
| **HTTP Headers** | Helmet.js |
| **CORS** | Configured origins only |
| **Role Guards** | `requireRole('teacher')`, `requireRole('student')`, `requireAdmin` |
| **2FA** | TOTP (Google Authenticator) via speakeasy |
| **Passwords** | bcryptjs (salt rounds: 12) |

---

# 📊 MongoDB Collections

| Collection | Purpose |
|---|---|
| `users` | All users (student/teacher/super_admin) |
| `sessions` | Live class sessions |
| `classrooms` | Teacher classrooms |
| `colleges` | Institution records |
| `files` | Uploaded files & notes |
| `pages` | Whiteboard canvas pages |
| `strokebatches` | Canvas drawing strokes |
| `activitylogs` | Audit trail |
| `notifications` | Push notifications |
| `devices` | Registered mobile devices |
| `terminalsessions` | QR terminal sessions |
| `folders` | File folders |
| `mediasessions` | YouTube/video sessions |

---

# ⚡ Key Environment Setup

## Add Render Environment Variables
Go to Render Dashboard → Your Service → Environment → Add:
```
SENDGRID_API_KEY=SG.xxx (if you want SendGrid fallback)
TWILIO_WHATSAPP_FROM=+14155238886 (Twilio sandbox sender)
```

## Local Development
```bash
# Backend
cd "web-app backend"
npm install
npm run dev    # → http://localhost:5001

# Mobile App
cd mobile-app
npm install
npx expo start   # → Scan QR with Expo Go

# Admin Dashboard
cd "admin dashboard"
npm install
npm run dev    # → http://localhost:5173

# Teacher App
cd teacher-app
npm install
npm run dev    # → http://localhost:5174

# Student App
cd student-app
npm install
npm run dev    # → http://localhost:5175
```

---

> **Last Updated:** July 15, 2026  
> **Status:** Production Ready (SMTP email verified ✅, MongoDB ✅, Socket.IO ✅)
