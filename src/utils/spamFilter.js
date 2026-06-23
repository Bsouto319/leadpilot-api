// Domains known for disposable / throwaway email addresses
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com','guerrillamail.com','guerrillamail.net','guerrillamail.org',
  'guerrillamail.de','guerrillamail.biz','guerrillamail.info','guerrillamail.me',
  'sharklasers.com','guerrillamailblock.com','grr.la','guerrillamail.com',
  'spam4.me','trashmail.com','trashmail.net','trashmail.org','trashmail.me',
  'trashmail.at','trashmail.io','trashmail.xyz','trash-mail.at',
  'yopmail.com','yopmail.fr','cool.fr.nf','jetable.fr.nf','nospam.ze.tc',
  'nomail.xl.cx','mega.zik.dj','speed.1s.fr','courriel.fr.nf','moncourrier.fr.nf',
  'monemail.fr.nf','monmail.fr.nf','dispostable.com','mailnull.com',
  'spamgourmet.com','spamgourmet.net','spamgourmet.org','spamgourmet.me',
  'throwam.com','throwam.net','throwam.org','throwam.me',
  'temp-mail.org','temp-mail.com','tempmail.com','tempmail.net','tempmail.org',
  'fake-box.com','maildrop.cc','harakirimail.com','mailnesia.com',
  'mailexpire.com','spambox.us','spambox.info','spambox.eu',
  'spambox.org','spambox.com','spambox.ru','spambox.cc',
  'discard.email','discardmail.com','discardmail.de',
  'anonaddy.com','anonaddy.me','spamwc.de','inboxbear.com',
  'shieldemail.com','jetable.org','mvrht.com','getairmail.com',
  'binkmail.com','boxforspam.com','chacuo.net','sogetthis.com',
  'spamfree24.org','spam.la','kasmail.com','spamherelots.com',
  'magspam.net','meltmail.com','nowmymail.com','objectmail.com',
  'odaymail.com','omnievents.org','pookmail.com','proxymail.eu',
  'randomail.net','rtrtr.com','safe-mail.net','soodonims.com',
  'sspam.net','temporaryemail.net','temporaryemail.us','tempsky.com',
  'throw.me.uk','throwam.com','trash2009.com','trashdevil.com',
  'trashdevil.de','uggsrock.com','uglyemail.com','veryrealemail.com',
  'webm4il.info','wegwerfmail.de','wegwerfmail.net','wegwerfmail.org',
  'wetrainbayarea.com','whyspam.me','wilemail.com','xagloo.com',
  'xemaps.com','xents.com','xmaily.com','xoxy.net','xzzx.ru',
  'yapped.net','yep.it','yogamaven.com','yuurok.com','za.com',
  'zebins.com','zebins.eu','zeit.io','zippymail.info',
]);

// Phone number sanity check — blocks obviously fake numbers
function isValidPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return false;
  // All same digit (e.g. 1111111111, 0000000000)
  if (/^(\d)\1+$/.test(digits)) return false;
  // Sequential (1234567890 or 9876543210)
  if (digits === '1234567890' || digits === '0987654321') return false;
  return true;
}

// Email sanity check
function isValidEmail(email) {
  if (!email) return true; // email is optional
  if (!/.+@.+\..+/.test(email)) return false;
  const domain = email.split('@')[1].toLowerCase().trim();
  if (DISPOSABLE_DOMAINS.has(domain)) return false;
  return true;
}

// Honeypot check — bots fill hidden fields, humans don't
// Pass the entire raw body; returns true if a bot is detected
function isHoneypotTriggered(body) {
  const baitFields = ['website', 'url', 'homepage', '_gotcha', '_hp', 'bot_field', 'fax', 'company_url'];
  return baitFields.some(field => {
    const val = String(body[field] || '').trim();
    return val.length > 0;
  });
}

/**
 * Validate a lead submission.
 * Returns { ok: true } or { ok: false, reason: string }
 */
function validateLead({ body, phone, email }) {
  if (isHoneypotTriggered(body)) {
    return { ok: false, reason: 'honeypot' };
  }
  if (!isValidPhone(phone || '')) {
    return { ok: false, reason: 'invalid_phone' };
  }
  if (!isValidEmail(email || '')) {
    return { ok: false, reason: 'disposable_email' };
  }
  return { ok: true };
}

module.exports = { validateLead, isHoneypotTriggered, isValidPhone, isValidEmail };
