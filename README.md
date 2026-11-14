# Student Manager — Turso + Render + Vercel

The backend now uses **Turso (libSQL)** for its live database. The frontend and existing API routes are retained.

## 1. Deploy the backend on Render

Set the backend service Root Directory to `sms2/backend` (if your repository contains the `sms2` folder).

Build command:
```bash
npm install
```

Start command:
```bash
npm start
```

Add these environment variables in Render:

- `TURSO_DATABASE_URL` — your Turso database URL (`libsql://...`)
- `TURSO_AUTH_TOKEN` — token generated for that database
- `FRONTEND_URL` — exact deployed Vercel frontend origin
- `ADMIN_EMAIL` — admin email address (or comma-separated addresses)
- `AUTH_SECRET` — a long random secret (keep it stable between deploys)
- `BREVO_API_KEY` — Brevo API key
- `MAIL_FROM` — verified sender email in Brevo
- `MAIL_FROM_NAME` — optional sender name
- `WA_UNOFFICIAL` — optional; set `true` only if using the Baileys WhatsApp connection

Do not put quotes around environment variable values. Do not commit secrets to GitHub.

## 2. Existing MongoDB data: one-time migration

If your old student data is still in MongoDB Atlas and you want to copy it to Turso, run this migration once from your Windows PC. It copies the collections `students`, `templates`, `users`, `otps`, `sessions`, `audit`, `attendance`, `marks`, and `wa_auth`.

1. Install Node.js 20 or newer.
2. Open Command Prompt in the `sms2/backend` folder.
3. Run:
   ```bash
   npm install
   ```
4. Set the old MongoDB connection string and your Turso credentials in the current Command Prompt:
   ```cmd
   set MONGODB_URI=mongodb+srv://YOUR_OLD_MONGODB_CONNECTION_STRING
   set DB_NAME=studentmanager
   set TURSO_DATABASE_URL=libsql://YOUR_DATABASE_URL
   set TURSO_AUTH_TOKEN=YOUR_NEW_TURSO_TOKEN
   ```
   Replace each example with your real value. Do not share these values.
5. Run:
   ```bash
   npm run migrate:mongo-to-turso
   ```

The script prints the number of rows copied from each collection. Run it only once for the initial copy, or understand that it overwrites matching record IDs in Turso.

**Important:** The migration script requires access to your old MongoDB database. If you no longer have MongoDB or do not need old records, skip this section.

## 3. Frontend

Before deploying the frontend, update the API base URL constant near the top of `sms2/frontend/index.html` to your Render backend URL. Deploy the `sms2/frontend` folder to Vercel.

## 4. Important notes

- The deployed backend does not need `MONGODB_URI`; it uses `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.
- The MongoDB package remains only to support the one-time migration script.
- The backend stores application records as JSON in a Turso `records` table. It preserves the existing API's Mongo-style data operations through a compatibility layer.
- Test login, student creation/editing, attendance, marks, reports, and WhatsApp after deployment.
- Back up your old database before migrating. Do not delete MongoDB until you have verified the Turso data and application.
- This package has been syntax-checked, but it has not been tested against your live Turso database or Render account.

See `SECURITY.md` for the security checklist.

Send file: admin page "Send file" sends one file (PDF, picture, Word, Excel, PowerPoint, text, MP4; up to 10 MB) to every parent of one standard through the linked WhatsApp. Needs WA_UNOFFICIAL=true and the QR code scanned on the Students page.
