/*
 * Pilote LECTEUR USB ZKTeco (ZK4500 / SLK20R…) — à finaliser avec le SDK du poste.
 * ------------------------------------------------------------------------------
 * Un lecteur d'empreinte USB fait sa capture et sa comparaison via le SDK du
 * fabricant (ZKFinger / ZKFinger10). Ce SDK est une bibliothèque native (DLL
 * Windows + addon Node, ou petit service HTTP fourni par ZKTeco). On ne peut pas
 * la redistribuer ici : installez-la sur le poste, puis branchez-la ci-dessous.
 *
 * Trois crochets à remplir : init(), captureTemplate(), matchScore(a, b).
 * Le reste (enroll/identify) est déjà écrit au-dessus de ces crochets.
 *
 * Deux façons courantes de relier le SDK :
 *   A) Addon Node natif du SDK → require(...) puis appeler ses fonctions.
 *   B) Le petit service local ZKFinger (écoute en HTTP/WS sur le poste) → faire
 *      des appels fetch() vers lui depuis captureTemplate().
 *
 * Seuil de reconnaissance : score ZK typiquement 0..~100+, on valide au-dessus
 * de MATCH_THRESHOLD. Ajustez selon vos essais.
 */
'use strict';

const MATCH_THRESHOLD = 50;

// let sdk; // ex: const sdk = require('zkfinger-node'); ou un client du service local.

async function init() {
    // TODO: initialiser le SDK / ouvrir le lecteur.
    // Exemple (addon) :  sdk = require('zkfinger-node'); sdk.open(0);
    // Exemple (service local) : vérifier que http://127.0.0.1:XXXX répond.
    if (!process.env.GE_ZK_READY) {
        console.warn('[zkteco-usb] Pilote non configuré : renseignez le SDK dans drivers/zkteco-usb.js. ' +
            'En attendant, utilisez GE_AGENT_DRIVER=simulator pour tester le flux.');
    }
}

// Capture une empreinte et renvoie son gabarit en base64.
async function captureTemplate() {
    // TODO (A, addon) :  const buf = await sdk.acquire(); return buf.toString('base64');
    // TODO (B, service):  const r = await fetch('http://127.0.0.1:XXXX/capture'); const j = await r.json(); return j.templateBase64;
    throw new Error('Pilote zkteco-usb non configuré (voir drivers/zkteco-usb.js)');
}

// Score de similarité entre deux gabarits base64 (via le SDK). Plus haut = plus proche.
async function matchScore(templateA_b64, templateB_b64) {
    // TODO (A) :  return sdk.match(Buffer.from(templateA_b64,'base64'), Buffer.from(templateB_b64,'base64'));
    // TODO (B) :  const r = await fetch('http://127.0.0.1:XXXX/match',{method:'POST',body:JSON.stringify({a:templateA_b64,b:templateB_b64})}); return (await r.json()).score;
    throw new Error('Pilote zkteco-usb non configuré (voir drivers/zkteco-usb.js)');
}

module.exports = {
    name: 'zkteco-usb',
    device: process.env.GE_ZK_DEVICE || 'ZK-USB',
    format: 'zk',
    init,
    async enroll() {
        // Beaucoup de SDK demandent 3 captures du même doigt ; adaptez si besoin.
        const template = await captureTemplate();
        return { template, finger: 'right-index', quality: 0, deviceUserId: '' };
    },
    async identify(candidates) {
        const live = await captureTemplate();
        let best = null;
        for (const c of (candidates || [])) {
            if (!c || !c.template) continue;
            let score = 0;
            try { score = await matchScore(live, c.template); } catch (e) { score = 0; }
            if (score >= MATCH_THRESHOLD && (!best || score > best.score)) best = { employeeId: c.employeeId, score };
        }
        return best;
    }
};
