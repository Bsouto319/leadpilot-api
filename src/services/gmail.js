const { google } = require('googleapis');
const logger = require('../utils/logger');

function getAuthClient(refreshToken) {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

// Decode base64url email body
function decodeBody(data) {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function extractBodyText(payload) {
  if (!payload) return '';
  if (payload.body && payload.body.data) return decodeBody(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        return decodeBody(part.body.data);
      }
    }
    // fallback: html part
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        return decodeBody(part.body.data).replace(/<[^>]+>/g, ' ');
      }
    }
  }
  return '';
}

// Parse Thumbtack lead notification email body
// Returns { leadName, leadPhone, serviceNote } or null if not a lead email
function parseThumbtackEmail(subject, body) {
  // Thumbtack subject patterns:
  // "New lead: John Smith wants tile installation"
  // "You have a new lead from John Smith"
  // "New request from John Smith"
  const isLeadEmail =
    /new\s+(lead|request)|wants\s+(to\s+hire|a\s+quote|an\s+estimate)|sent\s+you\s+a\s+(message|request)/i.test(subject + ' ' + body);

  if (!isLeadEmail) return null;

  // Extract name from subject
  let leadName = 'Customer';
  const nameMatch = (subject || '').match(/from\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)|lead:\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  if (nameMatch) leadName = (nameMatch[1] || nameMatch[2] || 'Customer').trim();

  // Extract phone — Thumbtack virtual numbers appear as (XXX) XXX-XXXX or +1XXXXXXXXXX
  let leadPhone = null;
  const phonePatterns = [
    /call\s+them\s+at[:\s]+(\+?1?\s*[\(\-]?\d{3}[\)\-\s]?\s*\d{3}[\-\s]?\d{4})/i,
    /phone[:\s]+(\+?1?\s*[\(\-]?\d{3}[\)\-\s]?\s*\d{3}[\-\s]?\d{4})/i,
    /(\+1\d{10})/,
    /\((\d{3})\)\s*(\d{3})-(\d{4})/,
  ];
  for (const pattern of phonePatterns) {
    const m = body.match(pattern);
    if (m) {
      // flatten and strip non-digits
      leadPhone = (m[1] || `${m[1]}${m[2]}${m[3]}`).replace(/\D/g, '');
      if (leadPhone.length === 10) leadPhone = '1' + leadPhone;
      if (leadPhone.length === 11) break;
      leadPhone = null;
    }
  }

  // Extract service description from body
  const servicePatterns = [
    /project\s+details?[:\s]+([^\n]{10,120})/i,
    /looking\s+for[:\s]+([^\n]{10,120})/i,
    /wants[:\s]+([^\n]{10,120})/i,
    /request[:\s]+([^\n]{10,120})/i,
    /details?[:\s]+([^\n]{10,120})/i,
  ];
  let serviceNote = '';
  for (const pattern of servicePatterns) {
    const m = body.match(pattern);
    if (m) { serviceNote = m[1].trim(); break; }
  }
  if (!serviceNote && subject) serviceNote = subject;

  return { leadName, leadPhone, serviceNote };
}

// Poll Gmail for unread Thumbtack lead emails for a given client
async function fetchThumbtackLeads(refreshToken) {
  const auth = getAuthClient(refreshToken);
  const gmail = google.gmail({ version: 'v1', auth });

  // Search for unread Thumbtack lead notification emails
  const query = 'from:noreply@thumbtack.com OR from:@thumbtack.com subject:(lead OR request OR hire) is:unread';

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 20,
  });

  const messages = listRes.data.messages || [];
  if (messages.length === 0) return [];

  const leads = [];
  for (const msg of messages) {
    try {
      const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const headers = full.data.payload.headers || [];
      const subject = (headers.find(h => h.name === 'Subject') || {}).value || '';
      const body = extractBodyText(full.data.payload);

      const parsed = parseThumbtackEmail(subject, body);
      if (parsed) {
        leads.push({ ...parsed, gmailMessageId: msg.id });
        // Mark as read so we don't process again
        await gmail.users.messages.modify({
          userId: 'me',
          id: msg.id,
          requestBody: { removeLabelIds: ['UNREAD'] },
        });
        logger.info('gmail', `thumbtack lead email parsed: ${parsed.leadName} phone=${parsed.leadPhone}`);
      } else {
        // Not a lead email — mark as read anyway to avoid re-processing
        await gmail.users.messages.modify({
          userId: 'me',
          id: msg.id,
          requestBody: { removeLabelIds: ['UNREAD'] },
        });
      }
    } catch (err) {
      logger.error('gmail', `failed to process message ${msg.id}: ${err.message}`);
    }
  }

  return leads;
}

module.exports = { fetchThumbtackLeads };
