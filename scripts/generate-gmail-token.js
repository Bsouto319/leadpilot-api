/**
 * Generates a Gmail OAuth refresh token for LeadPilot email sending.
 *
 * Setup in Google Cloud Console:
 *   - Application type: Desktop app
 *   - Redirect URI: http://localhost:3001
 *
 * Usage: node scripts/generate-gmail-token.js
 */
const { google } = require('googleapis');
const http = require('http');
const url  = require('url');

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\nERROR: Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env first.\n');
  process.exit(1);
}
const REDIRECT_URI  = 'http://localhost:3001';

const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = auth.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/gmail.send'],
});

console.log('\n Opening browser for Gmail authorization...\n');
console.log('If it does not open automatically, paste this URL:\n');
console.log(authUrl + '\n');

// Try to open browser automatically
const { exec } = require('child_process');
exec(`start "" "${authUrl}"`, () => {});

// Start local server to capture the redirect code
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const code   = parsed.query.code;
  const error  = parsed.query.error;

  if (error) {
    res.end('<h2>Authorization denied. Close this tab.</h2>');
    console.error('\nAuthorization denied:', error);
    server.close();
    return;
  }

  if (!code) {
    res.end('<h2>Waiting for authorization...</h2>');
    return;
  }

  res.end('<h2>✅ Authorization successful! You can close this tab.</h2><p>Check your terminal for the next step.</p>');

  try {
    const { tokens } = await auth.getToken(code);
    console.log('\n✅ Refresh token obtained!\n');
    console.log('Add this to Coolify env vars:\n');
    console.log(`NOTIFY_GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('\nDone! You can close this terminal.\n');
  } catch (err) {
    console.error('\nFailed to get token:', err.message);
  }

  server.close();
});

server.listen(3001, () => {
  console.log('Waiting for Google authorization on http://localhost:3001 ...\n');
});
