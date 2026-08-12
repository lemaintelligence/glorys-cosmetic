/**
 * Kelostop — Worker Cloudflare.
 *
 * Rôle : servir le site, et enregistrer chaque commande dans la base KV
 * avant que le visiteur ne parte sur WhatsApp.
 *
 * Trois adresses sont gérées :
 *   POST /api/commande   → enregistre une commande.
 *   GET  /api/commandes  → renvoie la liste, protégée par une clé.
 *   tout le reste        → le site normal.
 */

const LIMITE_TAILLE = 8000;      // Une commande ne dépasse jamais cette taille.
const CHAMPS_ATTENDUS = [
  'nom', 'prenom', 'pays', 'indicatif', 'contact', 'ville', 'localisation',
  'zone', 'zone_autre', 'anciennete',
  'livraison_date', 'livraison_heure', 'livraison_autre'
];

function reponseJson(donnees, statut = 200) {
  return new Response(JSON.stringify(donnees), {
    status: statut,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

/* Un identifiant qui se trie tout seul du plus récent au plus ancien. */
function identifiant() {
  const maintenant = Date.now();
  const hasard = Math.random().toString(36).slice(2, 8);
  return 'cmd:' + String(9999999999999 - maintenant).padStart(13, '0') + ':' + hasard;
}

function nettoie(valeur) {
  if (valeur === null || valeur === undefined) return '';
  return String(valeur).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 300);
}

async function enregistrer(requete, env) {
  if (!env.COMMANDES) {
    return reponseJson({ ok: false, erreur: 'base_absente' }, 500);
  }

  let brut;
  try {
    brut = await requete.text();
  } catch (e) {
    return reponseJson({ ok: false, erreur: 'lecture' }, 400);
  }
  if (brut.length > LIMITE_TAILLE) {
    return reponseJson({ ok: false, erreur: 'trop_long' }, 413);
  }

  const params = new URLSearchParams(brut);

  /* Piège à robots : ce champ doit rester vide. On répond normalement pour ne rien révéler. */
  if (nettoie(params.get('champ-cache'))) {
    return reponseJson({ ok: true });
  }

  const commande = {};
  for (const champ of CHAMPS_ATTENDUS) {
    const v = nettoie(params.get(champ));
    if (v) commande[champ] = v;
  }

  /* Une commande sans moyen de rappeler le client ne sert à rien. */
  if (!commande.contact && !commande.prenom) {
    return reponseJson({ ok: false, erreur: 'vide' }, 400);
  }

  commande.recu_le = new Date().toISOString();
  commande.pays_visiteur = requete.headers.get('cf-ipcountry') || '';
  commande.provenance = nettoie(requete.headers.get('referer'));

  try {
    await env.COMMANDES.put(identifiant(), JSON.stringify(commande));
  } catch (e) {
    return reponseJson({ ok: false, erreur: 'ecriture' }, 500);
  }

  return reponseJson({ ok: true });
}

async function lister(url, env) {
  if (!env.COMMANDES) {
    return reponseJson({ ok: false, erreur: 'base_absente' }, 500);
  }
  /* Sans clé configurée, la liste reste fermée. */
  if (!env.CLE_ADMIN || url.searchParams.get('cle') !== env.CLE_ADMIN) {
    return reponseJson({ ok: false, erreur: 'acces_refuse' }, 401);
  }

  const limite = Math.min(parseInt(url.searchParams.get('n') || '200', 10) || 200, 1000);
  const liste = await env.COMMANDES.list({ prefix: 'cmd:', limit: limite });

  const commandes = [];
  for (const cle of liste.keys) {
    const valeur = await env.COMMANDES.get(cle.name);
    if (valeur) {
      try {
        commandes.push(Object.assign({ cle: cle.name }, JSON.parse(valeur)));
      } catch (e) { /* une entrée abîmée ne doit pas bloquer les autres */ }
    }
  }

  return reponseJson({ ok: true, total: commandes.length, commandes: commandes });
}

export default {
  async fetch(requete, env) {
    const url = new URL(requete.url);

    if (url.pathname === '/api/commande') {
      if (requete.method !== 'POST') {
        return reponseJson({ ok: false, erreur: 'methode' }, 405);
      }
      return enregistrer(requete, env);
    }

    if (url.pathname === '/api/commandes') {
      if (requete.method !== 'GET') {
        return reponseJson({ ok: false, erreur: 'methode' }, 405);
      }
      return lister(url, env);
    }

    /* Tout le reste : le site tel quel. */
    return env.ASSETS.fetch(requete);
  }
};
