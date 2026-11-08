/**
 * Connexion par mot de passe, pour un usage sur serveur (NAS, Docker).
 *
 * Inactive tant que `LDR_PASSWORD` n'est pas défini : l'application locale
 * habituelle ne change pas. Une fois active :
 *  - toute page renvoie vers `/connexion` sans session valide, et l'API répond 401 ;
 *  - la session est un cookie HttpOnly signé (HMAC-SHA256), sans état côté
 *    serveur : elle survit au redémarrage du conteneur. Changer le mot de
 *    passe (ou `LDR_SESSION_SECRET`) invalide toutes les sessions ;
 *  - après 5 échecs, la connexion est bloquée 15 minutes.
 *
 * Variables : `LDR_USER` (défaut « livre »), `LDR_PASSWORD`,
 * `LDR_SESSION_DAYS` (défaut 30), `LDR_SESSION_SECRET` (optionnel).
 */

import crypto from 'node:crypto';

const IDENTIFIANT = process.env.LDR_USER || 'livre';
const MOT_DE_PASSE = process.env.LDR_PASSWORD || '';
const DUREE_JOURS = Number(process.env.LDR_SESSION_DAYS) || 30;
const NOM_COOKIE = 'ldr_session';
const ECHECS_MAX = 5;
const BLOCAGE_MS = 15 * 60 * 1000;

export const authentificationActive = Boolean(MOT_DE_PASSE);

const CLE = crypto
  .createHash('sha256')
  .update(`ldr-session\0${IDENTIFIANT}\0${MOT_DE_PASSE}\0${process.env.LDR_SESSION_SECRET ?? ''}`)
  .digest();

/** Ce qui reste accessible sans être connecté : la page de connexion et son habillage. */
const LIBRES = [/^\/connexion\/?$/, /^\/api\/connexion$/, /^\/css\/theme\.css$/, /^\/polices\//];

function empreinte(texte) {
  return crypto.createHash('sha256').update(String(texte)).digest();
}

function egal(a, b) {
  return crypto.timingSafeEqual(empreinte(a), empreinte(b));
}

function signer(expiration) {
  return crypto.createHmac('sha256', CLE).update(String(expiration)).digest('base64url');
}

function creerJeton() {
  const expiration = Date.now() + DUREE_JOURS * 24 * 3600 * 1000;
  return `${expiration}.${signer(expiration)}`;
}

function jetonValide(jeton) {
  const [expiration, signature] = String(jeton ?? '').split('.');
  if (!expiration || !signature || Number(expiration) < Date.now()) return false;
  const attendue = signer(expiration);
  return signature.length === attendue.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(attendue));
}

function lireCookie(req, nom) {
  for (const morceau of String(req.get('Cookie') ?? '').split(';')) {
    const [cle, ...reste] = morceau.trim().split('=');
    if (cle === nom) return decodeURIComponent(reste.join('='));
  }
  return null;
}

function poserCookie(res, valeur, maxAgeSecondes) {
  res.append('Set-Cookie',
    `${NOM_COOKIE}=${valeur}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSecondes}`);
}

/** Échecs de connexion par adresse IP. */
const echecs = new Map();

function estBloque(ip) {
  const etat = echecs.get(ip);
  if (!etat) return false;
  if (etat.jusqua && etat.jusqua > Date.now()) return true;
  if (etat.jusqua) echecs.delete(ip);
  return false;
}

function noterEchec(ip) {
  const etat = echecs.get(ip) ?? { nombre: 0, jusqua: 0 };
  etat.nombre += 1;
  if (etat.nombre >= ECHECS_MAX) etat.jusqua = Date.now() + BLOCAGE_MS;
  echecs.set(ip, etat);
}

/** Redirection interne uniquement (pas d'URL externe dans `suite`). */
function suiteSure(valeur) {
  const chemin = String(valeur ?? '/');
  return chemin.startsWith('/') && !chemin.startsWith('//') ? chemin : '/';
}

/**
 * Installe les routes de connexion et le contrôle d'accès. À appeler après
 * `express.json()` et avant toutes les autres routes.
 */
export function installerAuthentification(app) {
  if (!authentificationActive) {
    app.get('/api/connexion/etat', (req, res) => res.json({ active: false, connecte: true }));
    return;
  }

  app.get('/api/connexion/etat', (req, res) => {
    res.json({ active: true, connecte: jetonValide(lireCookie(req, NOM_COOKIE)) });
  });

  app.get('/connexion', (req, res) => {
    if (jetonValide(lireCookie(req, NOM_COOKIE))) return res.redirect(suiteSure(req.query.suite));
    res.set('Cache-Control', 'no-store').type('html').send(PAGE_CONNEXION);
  });

  app.post('/api/connexion', async (req, res) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? '?';
    if (estBloque(ip)) {
      return res.status(429).json({ erreur: 'Trop de tentatives. Réessayez dans 15 minutes.' });
    }
    const { identifiant, motDePasse } = req.body ?? {};
    const okIdentifiant = egal(identifiant ?? '', IDENTIFIANT);
    const okMotDePasse = egal(motDePasse ?? '', MOT_DE_PASSE);
    if (!(okIdentifiant && okMotDePasse)) {
      noterEchec(ip);
      await new Promise((r) => setTimeout(r, 600));
      return res.status(401).json({ erreur: 'Identifiant ou mot de passe incorrect.' });
    }
    echecs.delete(ip);
    poserCookie(res, creerJeton(), DUREE_JOURS * 24 * 3600);
    res.json({ connecte: true });
  });

  app.post('/api/deconnexion', (req, res) => {
    poserCookie(res, '', 0);
    res.status(204).end();
  });

  app.use((req, res, suite) => {
    if (LIBRES.some((motif) => motif.test(req.path))) return suite();
    if (jetonValide(lireCookie(req, NOM_COOKIE))) return suite();
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ erreur: 'Session expirée : reconnectez-vous.' });
    }
    if (req.method === 'GET' && (req.path === '/' || req.path.endsWith('.html'))) {
      return res.redirect(`/connexion?suite=${encodeURIComponent(req.originalUrl)}`);
    }
    res.status(401).end();
  });
}

const PAGE_CONNEXION = `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Connexion · Livre des recettes</title>
  <meta name="theme-color" content="#f6f4ef" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#121314" media="(prefers-color-scheme: dark)">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%232563eb' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 5v16'/%3E%3Cpath d='M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z'/%3E%3C/svg%3E">
  <link rel="stylesheet" href="/css/theme.css">
  <script>
    (function () {
      var choix = null;
      try { choix = localStorage.getItem('ldr-theme'); } catch (e) {}
      var sombre = choix ? choix === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.dataset.theme = sombre ? 'dark' : 'light';
    })();
  </script>
  <style>
    body { min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; }
    .carte-connexion {
      width: 100%; max-width: 380px; background: var(--carte); border: 1px solid var(--bordure);
      border-radius: 14px; box-shadow: var(--ombre-haute); padding: 32px 28px;
    }
    .logo { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
    .logo svg { color: var(--logo, var(--accent)); flex: none; }
    .logo span { font-weight: 700; font-size: 1.1rem; letter-spacing: -0.01em; }
    h1 { font-size: 1.45rem; margin: 0 0 4px; letter-spacing: -0.02em; }
    .sous-titre { color: var(--texte-2); margin: 0 0 24px; font-size: 0.95rem; }
    label { display: block; font-weight: 600; font-size: 0.9rem; margin-bottom: 6px; }
    .champ { margin-bottom: 16px; }
    input {
      width: 100%; font: inherit; color: var(--texte); background: var(--champ);
      border: 1px solid var(--bordure-controle); border-radius: 8px; padding: 10px 12px;
      transition: border-color .15s, box-shadow .15s;
    }
    input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--anneau); }
    button {
      width: 100%; font: inherit; font-weight: 600; color: var(--sur-accent); background: var(--accent);
      border: 0; border-radius: 8px; padding: 11px 14px; cursor: pointer; margin-top: 6px;
      transition: background .15s;
    }
    button:hover { background: var(--accent-survol); }
    button:disabled { opacity: .65; cursor: progress; }
    .erreur {
      background: var(--danger-doux); color: var(--danger-texte, var(--danger));
      border-radius: 8px; padding: 10px 12px; font-size: 0.9rem; margin-bottom: 16px;
    }
  </style>
</head>
<body>
  <main class="carte-connexion">
    <div class="logo">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v16"/><path d="M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z"/></svg>
      <span>Livre des recettes</span>
    </div>
    <h1>Connexion</h1>
    <p class="sous-titre">Entrez vos identifiants pour ouvrir votre livre.</p>
    <div class="erreur" id="erreur" role="alert" hidden></div>
    <form id="formulaire" novalidate>
      <div class="champ">
        <label for="identifiant">Identifiant</label>
        <input id="identifiant" name="identifiant" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
      </div>
      <div class="champ">
        <label for="mot-de-passe">Mot de passe</label>
        <input id="mot-de-passe" name="motDePasse" type="password" autocomplete="current-password" required>
      </div>
      <button type="submit" id="valider">Se connecter</button>
    </form>
  </main>
  <script>
    (function () {
      var formulaire = document.getElementById('formulaire');
      var erreur = document.getElementById('erreur');
      var bouton = document.getElementById('valider');
      var suite = new URLSearchParams(location.search).get('suite') || '/';
      if (suite.charAt(0) !== '/' || suite.charAt(1) === '/') suite = '/';
      formulaire.addEventListener('submit', function (e) {
        e.preventDefault();
        erreur.hidden = true;
        bouton.disabled = true;
        bouton.textContent = 'Connexion…';
        fetch('/api/connexion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifiant: formulaire.identifiant.value.trim(),
            motDePasse: formulaire.motDePasse.value
          })
        }).then(function (r) {
          if (r.ok) { location.replace(suite); return; }
          return r.json().catch(function () { return {}; }).then(function (c) {
            throw new Error(c.erreur || 'Connexion impossible.');
          });
        }).catch(function (err) {
          erreur.textContent = err.message;
          erreur.hidden = false;
          bouton.disabled = false;
          bouton.textContent = 'Se connecter';
          formulaire.motDePasse.value = '';
          formulaire.motDePasse.focus();
        });
      });
    })();
  </script>
</body>
</html>`;
