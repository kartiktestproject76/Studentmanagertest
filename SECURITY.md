# Security checklist

Built into the app
- Email code login, roles enforced on the server, automatic logout after 6 hours.
- Wrong-code lockouts, request limits, only 5 devices per person.
- All inputs checked on the server (blocks database injection and script injection).
- CORS only for your own frontend (FRONTEND_URL), security headers, no stack traces in errors.
- Activity log (Users page) for logins, user changes, student changes, reports.
- Libraries and fonts are served from your own site (no third-party scripts). Vercel headers in frontend/vercel.json.

You must do (outside the code)
1. Turn on 2-step verification: GitHub, Render, Vercel, MongoDB Atlas, Brevo and the Gmail used as admin/sender.
2. In Atlas create a database user with readWrite on the studentmanager database only. Put it in MONGODB_URI. Delete any admin-level database user.
3. Set FRONTEND_URL on Render to your exact Vercel address (https://..., no slash at the end).
4. Never put passwords, API keys or .env files on GitHub. Keep the GitHub repository private.
5. Export your data (Students page > Reports, or Atlas > Collections > Export) once a month. The free Atlas plan has no backups.
6. Keep admins few. If a phone or email is lost: Users page > Remove the person (they are logged out immediately), or change the email on the student record.
