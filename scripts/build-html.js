'use strict';

/**
 * Composes the static dashboard pages from the shared layout and the per-page
 * fragments in src/views. Run with `npm run build:html` after editing a view.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VIEWS = path.join(ROOT, 'src', 'views');
const OUT = path.join(ROOT, 'public');

const PAGES = [
  { view: 'connect.html', out: 'connect.html', title: 'Connect WhatsApp · WhatsApp Agent', nav: 'connect', script: 'connect.js' },
  { view: 'outbound.html', out: 'outbound.html', title: 'Outbound · WhatsApp Agent', nav: 'outbound', script: 'outbound.js' },
  { view: 'settings.html', out: 'settings.html', title: 'AI Configuration · WhatsApp Agent', nav: 'settings', script: 'settings.js' },
  { view: 'team.html', out: 'team.html', title: 'Team · WhatsApp Agent', nav: 'team', script: 'team.js' },
  {
    view: 'instructions.html',
    out: 'instructions.html',
    title: 'Business Instructions · WhatsApp Agent',
    nav: 'instructions',
    script: 'instructions.js',
  },
];

const ACTIVE_CLASSES = 'bg-surface-container text-on-surface font-medium';

const read = (file) => fs.readFileSync(path.join(VIEWS, file), 'utf8');

/** Adds the active styling to the nav links pointing at the current page. */
function markActiveNav(html, nav) {
  return html.replace(
    new RegExp(`(<a[^>]*data-nav="${nav}"[^>]*class=")([^"]*)(")`, 'g'),
    (_match, before, classes, after) => `${before}${classes} ${ACTIVE_CLASSES}${after}`
  );
}

function build() {
  fs.mkdirSync(OUT, { recursive: true });

  const layout = read('layout.html');
  const sprite = read(path.join('partials', 'sprite.html')).trim();

  for (const page of PAGES) {
    const content = read(page.view);
    let html = layout
      .replace('{{TITLE}}', page.title)
      .replace('{{SPRITE}}', sprite)
      .replace('{{CONTENT}}', content)
      .replace('{{SCRIPT}}', page.script);
    html = markActiveNav(html, page.nav);
    fs.writeFileSync(path.join(OUT, page.out), html);
    process.stdout.write(`built public/${page.out}\n`);
  }

  // These stand alone: no sidebar, no header. Signing in, joining from an
  // invite, and reading the terms all happen before there is a session.
  for (const name of ['login', 'signup', 'terms']) {
    const html = read(`${name}.full.html`).replace('{{SPRITE}}', sprite);
    fs.writeFileSync(path.join(OUT, `${name}.html`), html);
    process.stdout.write(`built public/${name}.html\n`);
  }
}

build();
