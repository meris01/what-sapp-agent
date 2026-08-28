# Compliance and risk

Read this before putting the agent on a number that matters, and before selling it
to anyone.

---

## The part that cannot be engineered away

**This tool connects to WhatsApp through an unofficial client and that breaks WhatsApp's
Terms of Service.**

It uses [Baileys](https://github.com/WhiskeySockets/Baileys), a reverse-engineered
implementation of the WhatsApp Web multi-device protocol. WhatsApp's Terms explicitly
prohibit accessing the service with anything other than their own official clients and
APIs. Automated sending on a personal or WhatsApp Business app account is against those
terms whatever the messages say.

No setting in this dashboard changes that. Everything below reduces the chance of a
complaint, a block, or a ban — none of it makes the tool compliant.

**What that means in practice:**

- The number can be banned, temporarily or permanently, with no warning, no appeal that
  reliably works, and no export of the chats on it.
- A ban can extend to other numbers registered to the same device or business.
- The linked session in `data/wa-auth/` is a logged-in WhatsApp account. Anyone who
  copies that folder can read and send messages as that number.
- WhatsApp changes the protocol without notice. A change can break the connection until
  the Baileys library catches up.

**Use a number the business can afford to lose.** Not the owner's personal number, not
the number printed on the van.

### The only genuinely compliant path

The official [WhatsApp Business Platform](https://business.whatsapp.com/products/business-platform)
(Cloud API). It is built for exactly this and comes with its own rules:

- Business verification through Meta.
- Messages outside a 24-hour window since the customer's last message must use
  pre-approved templates, and are charged per conversation.
- Opt-in requirements before you may message someone.
- Quality ratings, with messaging limits that drop if people block or report you.

Moving this agent to it would mean replacing `src/lib/whatsapp.js` — the reply logic,
memory, hand-off and timing all stay. It is a meaningful piece of work, not a setting.

---

## What the agent does to reduce risk

These are real and enforced in code, with tests.

### It never starts a conversation

The agent only ever replies to a one-to-one chat that messaged it first. It cannot send
to a list, import contacts, or message a number that has not written in. Group chats,
broadcasts, status updates and newsletters are ignored entirely.

### "Stop" is honoured immediately and permanently

A customer who writes `stop`, `unsubscribe`, `remove me`, `do not message me again`,
`leave me alone` and similar gets one short acknowledgement, and is then never messaged
again — no replies, no follow-ups, ever. The opt-out is stored, survives restarts, and
survives the retention sweep, because forgetting it would mean messaging them again.

The acknowledgement is fixed text written by you, not by the model, so it cannot be
argued out of stopping. Matching is deliberately cautious: a passing "stop" inside a long
sentence about a delivery is not treated as an opt-out.

### It tells people it is automated

On by default. The first reply a customer ever gets is preceded by a short line saying
they are talking to an automated assistant. Said once per customer.

This matters legally, not just ethically:

- **EU AI Act, Article 50** — transparency obligations for AI systems that interact with
  people have applied since 2 August 2026. People must be told they are dealing with an
  AI unless it is obvious.
- **California B.O.T. Act** — bots must disclose when used to incentivise a sale.
- Several other jurisdictions have similar rules, and more are arriving.

You can switch it off in Settings. If you do, the agent still will not *deny* being
automated when asked directly — that line is not configurable, because instructing
software to claim it is a named human is a different kind of problem from simply not
volunteering it.

### It is not online around the clock

The account announces availability only while it is dealing with a message, and goes
offline again shortly after. An always-online number whose last-seen never changes is
visible to every customer who opens the chat, and recipient suspicion is what turns into
the blocks and reports that drive bans.

### Limited, timed follow-ups with quiet hours

At most a handful of nudges, on delays you set, held back overnight, and stopped the
moment the customer replies or the model judges the conversation finished. Chasing people
who never engaged is the fastest route to blocks and reports.

### Data stays on your server

The only outbound connections are to WhatsApp and to OpenRouter. There is no analytics,
no telemetry, no third-party service. Conversations live in a SQLite file on the machine
you run it on.

---

## Data protection

If the business has customers in the UK, EU, or anywhere with comparable law, it is the
**data controller** for these conversations. Running this tool does not change that; it
just gives the controller another place where personal data sits.

### What is stored

| Data | Where | How long |
| --- | --- | --- |
| Customer phone number (as a WhatsApp id) | `data/app.db` | Until deleted |
| Message text, both directions | `data/app.db` | `MESSAGE_RETENTION_DAYS`, 30 by default |
| The customer's WhatsApp display name | `data/app.db` | Until deleted |
| Notes about the customer, written by the model | `data/app.db` | Until deleted |
| Opt-out and hand-off flags | `data/app.db` | Kept indefinitely, on purpose |
| A logged-in WhatsApp session | `data/wa-auth/` | Until you unlink |

Message text is also sent to OpenRouter, and on to whichever model provider you chose,
each time a reply is generated. **Their retention policy becomes part of yours.** Check
what your chosen model provider does with prompts, and configure OpenRouter's data
policy settings accordingly.

### Handling a deletion request

Stop the server, then:

```bash
npm run forget -- +919624694214
```

This erases their messages, their notes, and the conversation record. An existing
opt-out is kept as a bare record so they are not messaged again; `--purge` removes even
that.

### What the business still needs to do

This tool cannot do these for you:

- Have a privacy notice that says WhatsApp enquiries are handled with AI assistance,
  what is stored, for how long, and who the model provider is.
- Establish a lawful basis for the processing.
- Be able to answer access and deletion requests within the statutory window.
- Keep `data/` on an encrypted volume, and back it up somewhere equally protected.
  The app restricts these files to the account it runs as on every start, but that
  does not protect a backup copied somewhere less careful.
- Restrict who can reach the dashboard — it has no password, so anyone who can reach the
  port can read every conversation.

---

## Before going live: a short checklist

- [ ] A number the business can afford to lose
- [ ] Business instructions that never promise prices, refunds or dates it cannot honour
- [ ] Disclosure left on, or a documented decision to turn it off
- [ ] Follow-ups set to a small number with sane delays and quiet hours
- [ ] Dashboard reachable only over a tunnel, VPN, or authenticating proxy
- [ ] `data/` on an encrypted disk, with backups
- [ ] The privacy notice updated
- [ ] Somebody watching the number for blocks, reports, or a sudden drop in replies
- [ ] A plan for when the number is banned, not if

---

*This is engineering guidance, not legal advice. If the business operates at any scale,
or in a regulated sector, have a lawyer look at the WhatsApp terms question specifically.*
