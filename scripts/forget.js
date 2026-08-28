'use strict';

/**
 * Erases everything held about one customer.
 *
 * For a deletion request ("delete my data"), which most privacy law gives
 * people a right to. Stop the server first so the database is not in use:
 *
 *   npm run forget -- +919624694214
 *   npm run forget -- +919624694214 --keep-optout
 *
 * By default an existing opt-out is preserved as a bare record, because
 * forgetting that someone asked not to be contacted would mean messaging them
 * again the next time they appear. Pass --purge to remove even that.
 */

require('../src/lib/env').loadEnvFile();

const db = require('../src/lib/db');

function usage(message) {
  if (message) process.stderr.write(`\n  ${message}\n`);
  process.stderr.write(
    '\n  Usage: npm run forget -- <phone number> [--purge]\n\n' +
      '    <phone number>  in any format, e.g. +919624694214 or 919624694214\n' +
      '    --purge         also forget that they opted out (rarely what you want)\n\n'
  );
  process.exit(message ? 1 : 0);
}

const args = process.argv.slice(2);
if (!args.length || args.includes('--help') || args.includes('-h')) usage();

const purge = args.includes('--purge');
const rawNumber = args.find((arg) => !arg.startsWith('-'));
if (!rawNumber) usage('No phone number given.');

const digits = String(rawNumber).replace(/\D/g, '');
if (digits.length < 6) usage(`"${rawNumber}" does not look like a phone number.`);

// Match however the number was stored: as a normal contact or as a LID.
const candidates = [`${digits}@s.whatsapp.net`, `${digits}@lid`];
const found = candidates.map((jid) => db.getConversation(jid)).filter(Boolean);

if (!found.length) {
  process.stdout.write(`\n  Nothing stored for +${digits}. Nothing to delete.\n\n`);
  process.exit(0);
}

let totalMessages = 0;
let optOutKept = false;

for (const conversation of found) {
  const wasOptedOut = Boolean(conversation.opted_out_at);
  const { messages } = db.forgetCustomer(conversation.jid);
  totalMessages += messages;

  if (wasOptedOut && !purge) {
    // Re-create a bare record carrying only the standing "do not contact".
    db.upsertConversation(conversation.jid);
    db.markOptedOut(conversation.jid);
    optOutKept = true;
  }
}

process.stdout.write(
  `\n  Deleted everything held about +${digits}:\n` +
    `    ${totalMessages} message${totalMessages === 1 ? '' : 's'}\n` +
    `    ${found.length} conversation record${found.length === 1 ? '' : 's'}, including any notes\n` +
    (optOutKept
      ? '\n  Their opt-out has been kept, so they will not be messaged again.\n  Use --purge to remove that too.\n'
      : '') +
    '\n'
);
