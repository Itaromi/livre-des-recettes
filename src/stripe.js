/**
 * Synchronisation des paiements Stripe vers le livre des recettes.
 *
 * Inactive tant que `LDR_STRIPE_KEY` n'est pas défini. Utiliser une clé
 * restreinte en LECTURE SEULE (« rk_live_… », droit « Charges : lecture »).
 *
 * Chaque paiement réussi devient une recette :
 *  - montant BRUT payé par le client (frais Stripe inclus), moins les
 *    remboursements déjà faits : c'est ce que l'URSSAF prend en compte ;
 *  - date du paiement par le client (fuseau `TZ`, Europe/Paris par défaut) ;
 *  - client : nom de facturation, sinon e-mail ; libellé : description Stripe ;
 *  - référence : identifiant du paiement (`pi_…`), qui sert aussi à ne
 *    jamais importer deux fois le même paiement (y compris saisi à la main).
 *
 * Variables : `LDR_STRIPE_KEY`, `LDR_STRIPE_INTERVAL` (minutes, défaut 60),
 * `LDR_STRIPE_SINCE` (date AAAA-MM-JJ : paiements ignorés avant).
 */

import { validerRecette, validerClient } from './validation.js';
import { categorieImposee } from './partage/seuils.js';

const API = 'https://api.stripe.com/v1/charges';
const FUSEAU = process.env.TZ || 'Europe/Paris';

const normaliser = (texte) => String(texte ?? '').trim().toLowerCase();

/** Date locale AAAA-MM-JJ d'un horodatage Unix (secondes). */
function dateLocale(secondes) {
  return new Date(secondes * 1000).toLocaleDateString('sv-SE', { timeZone: FUSEAU });
}

async function listerPaiements(cle, depuis) {
  const paiements = [];
  let apres = null;
  for (let page = 0; page < 100; page += 1) {
    const params = new URLSearchParams({ limit: '100' });
    if (depuis) params.set('created[gte]', String(depuis));
    if (apres) params.set('starting_after', apres);
    const reponse = await fetch(`${API}?${params}`, { headers: { Authorization: `Bearer ${cle}` } });
    const corps = await reponse.json().catch(() => ({}));
    if (!reponse.ok) throw new Error(corps?.error?.message ?? `Stripe a répondu ${reponse.status}`);
    paiements.push(...corps.data);
    if (!corps.has_more || corps.data.length === 0) break;
    apres = corps.data.at(-1).id;
  }
  return paiements;
}

export function creerSyncStripe(stockage) {
  const cle = process.env.LDR_STRIPE_KEY || '';
  const intervalle = (Number(process.env.LDR_STRIPE_INTERVAL) || 60) * 60 * 1000;
  const depuisDate = process.env.LDR_STRIPE_SINCE;
  const depuis = depuisDate ? Math.floor(new Date(`${depuisDate}T00:00:00Z`).getTime() / 1000) : null;

  const etat = {
    active: Boolean(cle),
    derniereSynchro: null,
    dernierAjout: 0,
    erreur: null,
    enCours: false
  };

  async function synchroniser() {
    if (!cle || etat.enCours) return { ...etat };
    etat.enCours = true;
    try {
      const paiements = await listerPaiements(cle, depuis);
      const { modesPersonnalises, typeActivite } = stockage.obtenirParametres();
      const imposee = categorieImposee(typeActivite);
      const references = new Set(stockage.listerRecettes().map((r) => r.numeroFacture).filter(Boolean));
      const clientsConnus = new Set(stockage.listerClients().map((c) => normaliser(c.nom)));

      const lot = [];
      const nouveauxClients = [];
      for (const p of paiements) {
        const reference = p.payment_intent || p.id;
        if (references.has(reference) || references.has(p.id)) continue;
        if (p.status !== 'succeeded' || !p.paid || p.currency !== 'eur') continue;
        const centimes = p.amount - (p.amount_refunded ?? 0);
        if (centimes <= 0) continue;

        const client = (p.billing_details?.name || p.receipt_email || p.billing_details?.email || 'Client Stripe')
          .trim().slice(0, 200);
        const { erreurs, valeurs } = validerRecette({
          dateEncaissement: dateLocale(p.created),
          client,
          libelle: (p.description || 'Paiement Stripe').slice(0, 500),
          numeroFacture: reference,
          montant: centimes / 100,
          modeReglement: 'stripe'
        }, modesPersonnalises);
        if (erreurs) {
          console.warn(`Stripe : paiement ${reference} ignoré`, erreurs);
          continue;
        }
        if (imposee) valeurs.categorie = imposee;
        lot.push(valeurs);
        references.add(reference);

        if (!clientsConnus.has(normaliser(client))) {
          const c = validerClient({ nom: client });
          if (c.valeurs) nouveauxClients.push(c.valeurs);
          clientsConnus.add(normaliser(client));
        }
      }

      // Plus ancien d'abord : le registre reste chronologique.
      lot.sort((a, b) => a.dateEncaissement.localeCompare(b.dateEncaissement));
      for (const client of nouveauxClients) stockage.ajouterClient(client);
      if (lot.length) stockage.ajouterRecettes(lot);

      etat.dernierAjout = lot.length;
      etat.derniereSynchro = new Date().toISOString();
      etat.erreur = null;
      if (lot.length) console.log(`  Stripe : ${lot.length} paiement(s) ajouté(s) au livre.`);
    } catch (erreur) {
      etat.erreur = erreur.message;
      console.error(`  Stripe : synchronisation impossible (${erreur.message}).`);
    } finally {
      etat.enCours = false;
    }
    return { ...etat };
  }

  function demarrer() {
    if (!cle) return;
    setTimeout(synchroniser, 5000).unref();
    setInterval(synchroniser, intervalle).unref();
  }

  return { synchroniser, demarrer, etat: () => ({ ...etat }) };
}
