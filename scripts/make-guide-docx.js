'use strict';

/**
 * Builds the client setup guide as a Word document.
 *
 *   node scripts/make-guide-docx.js
 *
 * Produces docs/WhatsApp-Assistant-Setup-Guide.docx, which imports cleanly
 * into Google Docs (File - Open - Upload). Written for someone who has never
 * used a terminal, so the language stays plainer than the HTML version.
 */

const fs = require('fs');
const path = require('path');
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
  LevelFormat,
  PageBreak,
  ExternalHyperlink,
} = require('docx');

/* A4 portrait, 1 inch margins, so the usable width is 9026 DXA. */
const CONTENT_WIDTH = 9026;

const INK = '1A1A1A';
const SOFT = '5A5A5A';
const GREEN = '0F6E52';
const GREEN_BG = 'E8F2EE';
const AMBER_BG = 'FBF0DD';
const RED_BG = 'FBE6E3';
const CODE_BG = 'F0F2F1';

/* ------------------------------- helpers -------------------------------- */

const h1 = (text) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 460, after: 200 },
    children: [new TextRun({ text, bold: true, size: 34, color: INK, font: 'Calibri' })],
  });

const h2 = (text) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 320, after: 140 },
    children: [new TextRun({ text, bold: true, size: 26, color: INK, font: 'Calibri' })],
  });

/** Body text. `runs` may be a plain string or an array of TextRun. */
const p = (runs, opts = {}) =>
  new Paragraph({
    spacing: { after: opts.after ?? 160, line: 300 },
    children: typeof runs === 'string'
      ? [new TextRun({ text: runs, size: 22, color: INK, font: 'Calibri' })]
      : runs,
  });

const t = (text, opts = {}) =>
  new TextRun({ text, size: 22, color: opts.color ?? INK, font: 'Calibri', ...opts });

const bold = (text) => t(text, { bold: true });

/** Monospace, for anything the reader types or sees on screen. */
const code = (text) =>
  new TextRun({ text, size: 20, font: 'Consolas', color: '0B3D2E', shading: { type: ShadingType.CLEAR, fill: CODE_BG } });

/** A command to copy, on its own shaded line. */
const command = (text) =>
  new Paragraph({
    spacing: { before: 120, after: 200 },
    shading: { type: ShadingType.CLEAR, fill: '11201B' },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: GREEN } },
    indent: { left: 160, right: 160 },
    children: [new TextRun({ text, size: 19, font: 'Consolas', color: 'D6E4DD' })],
  });

/** A coloured callout box. */
function callout(label, lines, fill, accent) {
  const rows = [
    new Paragraph({
      spacing: { after: 60 },
      children: [new TextRun({ text: label.toUpperCase(), bold: true, size: 17, color: accent, font: 'Calibri' })],
    }),
    ...lines.map(
      (line, i) =>
        new Paragraph({
          spacing: { after: i === lines.length - 1 ? 0 : 100, line: 290 },
          children: typeof line === 'string' ? [t(line)] : line,
        })
    ),
  ];

  return new Table({
    columnWidths: [CONTENT_WIDTH],
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
      right: { style: BorderStyle.NONE }, insideHorizontal: { style: BorderStyle.NONE },
      insideVertical: { style: BorderStyle.NONE },
      left: { style: BorderStyle.SINGLE, size: 18, color: accent },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: CONTENT_WIDTH, type: WidthType.DXA },
            shading: { type: ShadingType.CLEAR, fill },
            margins: { top: 160, bottom: 160, left: 200, right: 200 },
            children: rows,
          }),
        ],
      }),
    ],
  });
}

const spacer = (after = 200) => new Paragraph({ spacing: { after }, children: [] });

/** Two-column reference table. */
function table(headers, rows) {
  const widths = [Math.round(CONTENT_WIDTH * 0.34), Math.round(CONTENT_WIDTH * 0.66)];

  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((text, i) =>
      new TableCell({
        width: { size: widths[i], type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: GREEN_BG },
        margins: { top: 100, bottom: 100, left: 140, right: 140 },
        children: [
          new Paragraph({
            children: [new TextRun({ text, bold: true, size: 20, color: GREEN, font: 'Calibri' })],
          }),
        ],
      })
    ),
  });

  const bodyRows = rows.map((cells) =>
    new TableRow({
      children: cells.map((cell, i) =>
        new TableCell({
          width: { size: widths[i], type: WidthType.DXA },
          margins: { top: 100, bottom: 100, left: 140, right: 140 },
          children: [
            new Paragraph({
              spacing: { line: 280 },
              children: typeof cell === 'string' ? [t(cell)] : cell,
            }),
          ],
        })
      ),
    })
  );

  return new Table({
    columnWidths: widths,
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'D8DEDB' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D8DEDB' },
      left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'E4E8E6' },
      insideVertical: { style: BorderStyle.NONE },
    },
    rows: [headerRow, ...bodyRows],
  });
}

const bullet = (runs) =>
  new Paragraph({
    numbering: { reference: 'dots', level: 0 },
    spacing: { after: 100, line: 290 },
    children: typeof runs === 'string' ? [t(runs)] : runs,
  });

const rule = () =>
  new Paragraph({
    spacing: { before: 240, after: 240 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'DDE3DF' } },
    children: [],
  });

/* -------------------------------- content -------------------------------- */

const children = [];

/* Cover */
children.push(
  new Paragraph({
    spacing: { before: 1600, after: 120 },
    children: [new TextRun({ text: 'SETUP GUIDE', bold: true, size: 20, color: GREEN, font: 'Calibri' })],
  }),
  new Paragraph({
    spacing: { after: 240 },
    children: [new TextRun({ text: 'Your WhatsApp Assistant', bold: true, size: 56, color: INK, font: 'Calibri' })],
  }),
  new Paragraph({
    spacing: { after: 600, line: 320 },
    children: [
      new TextRun({
        text: 'Everything you need to get your assistant answering customers. Seven steps, about twenty minutes. No coding.',
        size: 26, color: SOFT, font: 'Calibri',
      }),
    ],
  }),
  callout('Before you begin', [
    'You will need four things. Gather them first and the rest is quick:',
    [t('1.  A spare phone number with WhatsApp on it. '), bold('Not your personal number.')],
    [t('2.  A small server (a "VPS") from Hostinger, DigitalOcean or similar.')],
    [t('3.  A web address you own, so you can use something like '), code('chat.yourbusiness.com')],
    [t('4.  An OpenRouter account with a few pounds of credit, from openrouter.ai')],
  ], GREEN_BG, GREEN),
  new Paragraph({ children: [new PageBreak()] })
);

/* What it does */
children.push(
  h1('What this does'),
  p('A customer messages your WhatsApp number. The assistant reads the message, answers using the information you have given it, and sounds like a real person on your team.'),
  p('It writes short replies in lower case, waits a few seconds before answering so it does not feel robotic, and remembers what each customer has told you before.'),
  spacer(100),
  p([bold('A real example:')], { after: 100 }),
  callout('The customer sees', [
    [t('Customer:  ', { color: SOFT }), t('hi, are you open today?')],
    [t('You:       ', { color: SOFT }), t('yep, till 5 today', { color: GREEN })],
    [t('Customer:  ', { color: SOFT }), t('do you deliver to clifton?')],
    [t('You:       ', { color: SOFT }), t("we do, it's £5 anywhere in town", { color: GREEN })],
  ], 'F7F9F8', 'C8D4CF'),
  spacer(),
  p([
    t('If '), bold('you'),
    t(' reply to a customer yourself from your phone, the assistant stops talking in that chat straight away and never speaks there again. It will never talk over you.'),
  ]),
  rule()
);

/* Steps */
const steps = [
  {
    n: 1,
    title: 'Point your web address at your server',
    time: 'About 3 minutes, then a short wait',
    body: [
      p('Sign in to wherever you bought your web address. Find the page called DNS or DNS Records. Add one new record:'),
      table(['Field', 'What to put'], [
        ['Type', [code('A')]],
        ['Name', [code('chat')]],
        ['Points to', 'Your server\'s IP address (your server provider shows this)'],
      ]),
      spacer(),
      callout('The mistake almost everyone makes', [
        [
          t('In the Name box, type only '), code('chat'), t('. Do '), bold('not'),
          t(' type the full address. Your provider adds the rest automatically. Typing the whole thing creates an address that will never work.'),
        ],
      ], AMBER_BG, 'A8630B'),
      spacer(),
      p('Save it, then wait two or three minutes before moving on.'),
    ],
  },
  {
    n: 2,
    title: 'Install the assistant',
    time: 'About 3 minutes',
    body: [
      p('Open your server\'s terminal. Every hosting company has a button for this. Hostinger calls it "Browser terminal". Others call it "Console" or "Shell".'),
      p([t('Copy the line below, change '), code('chat.yourbusiness.com'), t(' to your own address, paste it in, and press Enter.')]),
      command('curl -fsSL https://raw.githubusercontent.com/meris01/what-sapp-agent/main/scripts/bootstrap.sh | bash -s chat.yourbusiness.com'),
      p('It works on its own for a couple of minutes. When it finishes it shows you something like this:'),
      command('Live at https://chat.yourbusiness.com'),
      command('username   admin          password   K7mQp2xRvT9w'),
      callout('Write these down', [
        'That username and password are how you get in. They are also saved on your server, so they are not lost if you forget them.',
      ], GREEN_BG, GREEN),
    ],
  },
  {
    n: 3,
    title: 'Sign in',
    time: 'Under a minute',
    body: [
      p('Open your web address in any browser. You will see a sign-in box. Enter the username and password from the last step.'),
      p([t('The username is '), code('admin'), t('. It is easy to mistype, so check it carefully if it says the password is wrong.')]),
    ],
  },
  {
    n: 4,
    title: 'Connect your WhatsApp',
    time: 'About 2 minutes',
    body: [
      p('After signing in you will see a square QR code on the screen. Now pick up the phone whose WhatsApp number you are using, and:'),
      bullet('Open WhatsApp'),
      bullet('Tap Settings (iPhone) or the three dots menu (Android)'),
      bullet('Tap Linked Devices'),
      bullet('Tap Link a Device'),
      bullet('Point the camera at the QR code on your screen'),
      spacer(),
      p('Within a few seconds the QR code disappears and the label changes to "Connected". That is the hardest part finished.'),
    ],
  },
  {
    n: 5,
    title: 'Add your OpenRouter key',
    time: 'About 2 minutes',
    body: [
      p('This is what writes the replies. Go to openrouter.ai, sign in, and create a key. Copy it.'),
      p('Back in your dashboard, click Settings. Paste the key into the OpenRouter API key box and click Save API key. Then click Test connection and wait for the green tick.'),
      p([t('A model is already chosen for you ('), code('openai/gpt-5.6-luna'), t('). Leave it as it is unless you have a reason to change it.')]),
      callout('What this costs', [
        'You pay OpenRouter directly for each reply. For a small business answering a few dozen messages a day, this is usually well under a pound a week. Top up your balance on their website, not here.',
      ], GREEN_BG, GREEN),
    ],
  },
  {
    n: 6,
    title: 'Tell it about your business',
    time: 'About 10 minutes, and worth taking your time',
    body: [
      p('Click Instructions. This is the only part that is really yours to write, and it decides how good your assistant is.'),
      p('There is an "Insert a starting template" button if you would rather fill in the blanks. Here is a real example:'),
      callout('Example instructions', [
        "you are the assistant for Rossi's Pizzeria in Bristol.",
        '',
        'what we offer',
        '- pizzas from £9 to £14, menu at rossis.co.uk/menu',
        '- gluten free bases, £2 extra',
        '',
        'practical details',
        '- open tuesday to sunday, 5pm to 10pm. closed mondays.',
        '- 12 park street, bristol',
        '- delivery within 3 miles, £3, usually 40 minutes',
        '',
        'how to handle customers',
        '- answer questions about the list above. anything else, say you will check with the team.',
        '- never promise a discount or a delivery time that is not written here.',
        '- to take an order, collect the items, name and address, then say someone will ring to confirm.',
        '- if someone is unhappy, apologise briefly and say a colleague will reply shortly.',
      ], 'F7F9F8', 'C8D4CF'),
      spacer(),
      p('Click Save instructions. Then click Test instructions to see a sample reply. Nothing is sent to WhatsApp when you test.'),
      callout('Already done for you', [
        'You do not need to write anything about tone, style or timing. The short lower-case texting style, the natural pause before replying, matching the customer\'s language, and refusing to invent prices are all built in. Just give it the facts about your business.',
      ], GREEN_BG, GREEN),
    ],
  },
  {
    n: 7,
    title: 'Send a test message',
    time: 'About a minute',
    body: [
      p('Using a different phone, send a message to your business number and watch what happens.'),
      table(['When', 'What you should see'], [
        ['Straight away', 'Two grey ticks. The message has not been opened yet.'],
        ['3 to 60 seconds', 'Your number comes online and the ticks turn blue.'],
        ['A moment later', '"typing..." appears, then the reply arrives.'],
        ['About half a minute after', 'Your number quietly goes offline again.'],
      ]),
      spacer(),
      callout('Use a different phone', [
        'Do not test by messaging yourself from the same phone. A message sent from the linked phone counts as you taking over the conversation, which switches the assistant off for that chat permanently.',
      ], AMBER_BG, 'A8630B'),
      spacer(),
      p('That is everything. It now runs on its own, day and night, and starts again by itself if the server restarts.'),
    ],
  },
];

for (const step of steps) {
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 420, after: 60 },
      children: [
        new TextRun({ text: `Step ${step.n}   `, bold: true, size: 34, color: GREEN, font: 'Calibri' }),
        new TextRun({ text: step.title, bold: true, size: 34, color: INK, font: 'Calibri' }),
      ],
    }),
    new Paragraph({
      spacing: { after: 200 },
      children: [new TextRun({ text: step.time, size: 19, color: SOFT, italics: true, font: 'Calibri' })],
    }),
    ...step.body
  );
}

/* Everyday use */
children.push(
  new Paragraph({ children: [new PageBreak()] }),
  h1('Using it day to day'),

  h2('Taking over a conversation yourself'),
  p('Just reply from your phone as you normally would. The assistant stops in that chat immediately and permanently, even if it was halfway through writing something. There is nothing to switch off.'),

  h2('Pausing everything'),
  p('Go to Settings and turn off Automation. Messages still arrive and are saved, but nothing is answered and nothing is marked as read.'),

  h2('When a customer asks you to stop'),
  p('This is handled automatically. If someone replies "stop", "unsubscribe" or similar, they get one short acknowledgement and are never messaged again. This is a legal requirement in most countries, so it cannot be turned off.'),

  h2('Follow-up messages'),
  p('If a customer goes quiet after the assistant has replied, it sends a gentle reminder after three hours, then one more the next day, and then stops. Reminders are never sent overnight. You can change the number and the timing under Settings.'),

  h2('Adding your staff'),
  p('Go to Team and click Invite a member. You get a link to send them, and they choose their own password. There is no open sign-up, on purpose: anyone with an account can read every customer conversation.'),

  h2('It remembers your customers'),
  p('Names, what they wanted, their address, what was agreed. A customer who messages again next month will not be asked the same questions twice.'),

  rule()
);

/* Troubleshooting */
children.push(
  h1('If something is not working'),
  spacer(80),
  table(['What you see', 'What to do'], [
    ['The page will not open at all', 'Your web address has not updated yet. Wait five minutes and try again. If it still fails, check the Name box in your DNS record says only "chat".'],
    ['"Incorrect username or password"', 'The username is admin. Check the spelling carefully. Your password is in a file called .env on your server.'],
    ['The QR code will not scan', 'Click Refresh connection to get a fresh one. QR codes expire after about a minute.'],
    ['It stopped replying to one person', 'Almost always because you replied to them yourself, or they asked you to stop. Both are permanent, by design.'],
    ['It stopped replying to everyone', 'Check Settings. Usually Automation was paused, or your OpenRouter balance has run out.'],
    ['It says "Disconnected"', 'WhatsApp dropped the connection. It reconnects by itself. If it does not, scan the QR code again.'],
  ]),
  spacer(),
  p('To restart it, open your server terminal and type:'),
  command('systemctl restart whatsapp-agent'),
  rule()
);

/* The warning */
children.push(
  h1('Please read this before using an important number'),
  spacer(80),
  callout('Use a spare number', [
    'This connects to WhatsApp in a way that WhatsApp\'s own rules do not officially allow. In practice, quietly answering incoming messages like this rarely causes trouble.',
    [
      t('But your number '), bold('can'),
      t(' be restricted or banned, without warning, and there is no reliable way to appeal. No setting changes this.'),
    ],
    [bold('Use a number your business could carry on without. Not your personal number, and not the one printed on your van.')],
  ], RED_BG, '9D2B22'),
  spacer(),
  h2('Two other things worth knowing'),
  p('Replies are written by an AI. It follows your instructions closely, but check your conversations now and then. You are responsible for what your business says to customers.'),
  p('Customer conversations are stored on your own server. That means nobody else can read them, but it also means keeping that server secure is your responsibility. You should also tell customers that enquiries are handled with AI assistance.'),
  spacer(300),
  p([t('If you would prefer none of that risk, there is an official paid WhatsApp Business service this can be moved onto. Ask whoever supplied this to you.', { color: SOFT, italics: true })])
);

/* -------------------------------- build ---------------------------------- */

const doc = new Document({
  creator: 'WhatsApp Assistant',
  title: 'WhatsApp Assistant Setup Guide',
  description: 'Step-by-step setup guide for the WhatsApp AI assistant.',
  numbering: {
    config: [
      {
        reference: 'dots',
        levels: [
          {
            level: 0,
            format: LevelFormat.BULLET,
            text: '•',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 460, hanging: 240 } } },
          },
        ],
      },
    ],
  },
  sections: [
    {
      properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      children,
    },
  ],
});

const out = path.join(__dirname, '..', 'docs', 'WhatsApp-Assistant-Setup-Guide.docx');
fs.mkdirSync(path.dirname(out), { recursive: true });

Packer.toBuffer(doc).then((buffer) => {
  fs.writeFileSync(out, buffer);
  process.stdout.write(`wrote ${path.relative(path.join(__dirname, '..'), out)} (${(buffer.length / 1024).toFixed(0)} KB)\n`);
});
