# Deploying

## Why Vercel, Netlify and Lambda do not work

Not a configuration problem, and not something a setting fixes. Those platforms run
**serverless functions**: your code is invoked when a request arrives and killed when the
response is sent. This agent needs the opposite in three ways.

| It needs | Serverless gives you |
| --- | --- |
| A process that stays alive, holding the WhatsApp socket open | A function that dies after each request |
| A disk that survives, for the database and the linked session | A read-only filesystem, except `/tmp`, which is wiped |
| A clock ticking between requests, to send follow-ups | Nothing running between requests |

Deploying there produces `FUNCTION_INVOCATION_FAILED` — the QR would never survive long
enough to scan, and every request would look like a brand-new install. The app now
detects those platforms at startup and says so plainly rather than crashing obscurely.

**What you need is any host that runs a normal, always-on process with a real disk.**
Three good options below.

---

## A small VPS — recommended

Cheapest, simplest, and the same thing your clients will run. Hetzner, DigitalOcean,
Vultr and similar all do this for a few pounds a month. Any distribution with Node 20+.

```bash
git clone https://github.com/meris01/what-sapp-agent.git
cd what-sapp-agent
sudo ./scripts/install.sh
```

That creates a service account, installs dependencies, locks the data directory to that
account, writes a hardened systemd unit, and starts it on loopback.

Read the password it prints, then reach the dashboard over an SSH tunnel from your own
machine — no need to expose the port at all:

```bash
ssh -N -L 3000:127.0.0.1:3000 you@your-server
```

Then open <http://127.0.0.1:3000>.

### Giving it a public HTTPS URL

Only if you need one — the tunnel above is safer and costs nothing. You need a domain
with an A record pointing at the server; a certificate cannot be issued for a bare IP.

```bash
sudo ./scripts/setup-https.sh dashboard.yourdomain.com
```

That installs Caddy, gets a Let's Encrypt certificate, forwards to the agent on
loopback, and switches on `TRUST_PROXY` and `COOKIE_SECURE` so the session cookie is
marked secure. The agent itself never listens on a public interface.

**Do not serve the dashboard over plain HTTP.** The password would cross the network in
the clear, and it protects every customer conversation plus a live WhatsApp session.

Day to day:

```bash
systemctl status whatsapp-agent
journalctl -u whatsapp-agent -f
systemctl restart whatsapp-agent
```

To update, pull and re-run the installer. It replaces the code and restarts without
touching `data/` or `.env`.

---

## Render

Closest to the Vercel experience: connect the repo, it builds and deploys. `render.yaml`
is already in the repo, so Render configures itself.

1. New → Blueprint, point it at this repository.
2. Set **`ADMIN_PASSWORD`** in the dashboard before the first deploy.
3. Deploy.

The blueprint attaches a 1 GB disk at `/data`. **Do not remove it** — the database, the
WhatsApp session and the generated keys all live there, and without it every deploy
starts from nothing.

---

## Fly.io

```bash
fly launch --no-deploy          # uses the fly.toml in the repo
fly volumes create data --size 1
fly secrets set ADMIN_PASSWORD=your-password
fly deploy
```

`auto_stop_machines` is off on purpose: a sleeping machine drops the WhatsApp
connection. Keep it to **one machine** — two would both try to hold the same session and
fight over it.

---

## Whatever you choose

**One instance per WhatsApp number.** The session cannot be shared. Two processes on the
same credentials will knock each other offline.

**The volume is the product.** `data/` holds every conversation, the customer notes, the
generated encryption key and the logged-in WhatsApp session. Losing it means re-scanning
the QR and starting the memory from scratch. Back it up, and keep the backup somewhere as
private as the server.

**Exposing it publicly changes the security picture.** On a VPS behind an SSH tunnel,
nothing is reachable from outside. On Render or Fly the dashboard is on the internet
behind one password — so set a strong one, and note that `TRUST_PROXY` and
`COOKIE_SECURE` are already switched on in those configs because TLS terminates at the
platform.

**Read [COMPLIANCE.md](COMPLIANCE.md)** before connecting a number that matters. Where
you host it does not change the WhatsApp terms-of-service risk.
