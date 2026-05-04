# Permanent Backend Deployment Guide (Free Tier)

## Prerequisites
- MongoDB Atlas account (free tier)
- Redis Cloud account (free tier)
- Render account (free tier)

## Step 1: MongoDB Atlas Setup

1. Go to https://www.mongodb.com/cloud/atlas/register
2. Create free account
3. Create new cluster:
   - Cluster Name: digital-classroom
   - Cloud Provider: AWS
   - Region: Mumbai (ap-south-1) or nearest
   - Cluster Tier: M0 Sandbox (Free)
4. Create Database User:
   - Username: digitalclassroom
   - Password: [Generate strong password - SAVE THIS]
5. Network Access:
   - Add IP: 0.0.0.0/0 (allow all for Render)
6. Get Connection String:
   - Click "Connect" → "Connect your application"
   - Copy connection string: `mongodb+srv://digitalclassroom:PASSWORD@cluster.mongodb.net/digital_classroom`

## Step 2: Redis Cloud Setup

1. Go to https://redis.com/try-free/
2. Create free account
3. Create new database:
   - Name: digital-classroom-redis
   - Cloud Provider: AWS
   - Region: ap-south-1 (Mumbai)
   - Tier: Free
4. Get Connection Details:
   - Host: [redis-host]
   - Port: 6379
   - Password: [Generate password - SAVE THIS]

## Step 3: Render Deployment

1. Go to https://render.com/register
2. Create free account
3. Create new Web Service:
   - Connect GitHub repository
   - Root Directory: (Leave blank)
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: Free

## Step 4: Environment Variables in Render

Add these environment variables in Render dashboard:

**Database Config:**
- `MONGODB_URI` = `mongodb+srv://digitalclassroom:YOUR_PASSWORD@cluster.mongodb.net/digital_classroom`
- `REDIS_HOST` = `YOUR_REDIS_HOST`
- `REDIS_PORT` = `6379`
- `REDIS_PASSWORD` = `YOUR_REDIS_PASSWORD`

**Server Config:**
- `NODE_ENV` = `production`
- `PORT` = `10000`

**Security:**
- `JWT_SECRET` = [Generate random string - use: `openssl rand -base64 32`]
- `QR_SECRET` = [Generate random string]
- `CLIENT_URL` = `https://your-vercel-app.vercel.app`

**Optional (set as needed):**
- `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` (for email)
- `AI_API_KEY` (for AI features)
- `FIREBASE_PROJECT_ID` (for push notifications)

## Step 5: Deploy

Click "Deploy Web Service" in Render. Wait for deployment to complete.

## Step 6: Get Backend URL

After deployment, Render will provide a URL like:
`https://digital-classroom-backend.onrender.com`

## Step 7: Update Vercel

**Student App:**
- `VITE_API_URL` = `https://digital-classroom-backend.onrender.com`

**Teacher App:**
- `VITE_BASE_URL` = `https://digital-classroom-backend.onrender.com`

Redeploy both apps.

## Notes

- Render free tier spins down after 15 min inactivity (takes ~30 sec to wake up)
- MongoDB Atlas free tier: 512MB storage
- Redis Cloud free tier: 30MB storage
- For production, upgrade to paid plans
