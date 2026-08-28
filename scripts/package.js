'use strict';

/**
 * Builds a distributable release: the app, its built assets, an installer and
 * the documents a customer needs. Never includes node_modules, the database,
 * a WhatsApp session, or anyone's .env.
 *
 *   npm run package
 *
 * Produces dist/whatsapp-agent-<version>.tar.gz plus an unpacked copy beside
 * it, so you can inspect exactly what a client receives.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NAME = `whatsapp-agent-${pkg.version}`;
const STAGE = path.join(DIST, NAME);

// Everything a client needs to run it, and nothing else.
const INCLUDE_DIRS = ['src', 'public', 'scripts'];
const INCLUDE_FILES = [
  'package.json',
  'package-lock.json',
  '.env.example',
  'README.md',
  'COMPLIANCE.md',
  'Dockerfile',
  'docker-compose.yml',
  '.dockerignore',
];

// Guards against ever shipping a secret or someone's data.
const FORBIDDEN = [/(^|[\\/])\.env$/, /(^|[\\/])data([\\/]|$)/, /node_modules/, /\.db(-wal|-shm)?$/];

function assertSafe(relativePath) {
  for (const pattern of FORBIDDEN) {
    if (pattern.test(relativePath)) {
      throw new Error(`Refusing to package ${relativePath}: it may contain secrets or customer data.`);
    }
  }
}

function copyInto(source, destination) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyInto(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  assertSafe(path.relative(ROOT, source));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function build() {
  // The dashboard is served from pre-built files; a client never runs a build.
  process.stdout.write('building the dashboard...\n');
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'pipe', shell: true });

  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  for (const dir of INCLUDE_DIRS) copyInto(path.join(ROOT, dir), path.join(STAGE, dir));
  for (const file of INCLUDE_FILES) {
    const source = path.join(ROOT, file);
    if (fs.existsSync(source)) copyInto(source, path.join(STAGE, file));
  }

  // Tests and the packaging script itself are not part of a client install.
  fs.rmSync(path.join(STAGE, 'scripts', 'package.js'), { force: true });

  // A release marker, so support can ask "what version are you on?".
  fs.writeFileSync(
    path.join(STAGE, 'VERSION'),
    `${pkg.version}\nbuilt ${new Date().toISOString()}\n`
  );

  const staged = countFiles(STAGE);
  process.stdout.write(`staged ${staged} files in dist/${NAME}\n`);

  const archive = path.join(DIST, `${NAME}.tar.gz`);
  fs.rmSync(archive, { force: true });
  try {
    // Relative paths, run from dist: some tar builds read "C:\..." as a
    // remote host because of the colon.
    execFileSync('tar', ['-czf', `${NAME}.tar.gz`, NAME], { cwd: DIST, stdio: 'pipe' });
    const size = (fs.statSync(archive).size / 1024).toFixed(0);
    process.stdout.write(`created dist/${NAME}.tar.gz (${size} KB)\n`);
  } catch (err) {
    process.stdout.write(`could not create the archive (${err.message}).\n`);
    process.stdout.write(`the unpacked release is still in dist/${NAME}\n`);
  }

  verify();
}

function countFiles(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return total;
}

/** Belt and braces: walk the staged tree and fail loudly on anything unsafe. */
function verify() {
  const problems = [];

  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(STAGE, full);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      for (const pattern of FORBIDDEN) {
        if (pattern.test(relative)) problems.push(relative);
      }
      // A stray secret pasted into a file would be worse than a stray file.
      if (/\.(js|json|md|example|yml|sh)$/.test(entry.name)) {
        const contents = fs.readFileSync(full, 'utf8');
        if (/sk-or-v1-[A-Za-z0-9]{20,}/.test(contents)) problems.push(`${relative} (contains an API key)`);
        if (/ENCRYPTION_KEY=[0-9a-f]{64}/.test(contents)) problems.push(`${relative} (contains an encryption key)`);
      }
    }
  })(STAGE);

  if (problems.length) {
    process.stderr.write(`\nREFUSING TO SHIP. Found in the release:\n${problems.map((p) => `  ${p}\n`).join('')}`);
    process.exit(1);
  }

  process.stdout.write('checked: no secrets, no database, no WhatsApp session, no node_modules\n');
}

build();
