#!/usr/bin/env node
/*
 * Agent local de pointage — GOOD ENGINEERS (Forage)
 * --------------------------------------------------
 * Tourne sur le poste KIOSQUE (le PC où est branché le lecteur d'empreinte USB).
 * Expose un petit serveur WebSocket sur 127.0.0.1 que la page de pointage du
 * navigateur pilote. L'agent ne parle qu'au lecteur ; c'est la PAGE (déjà
 * authentifiée) qui enregistre les pointages dans la plateforme. Aucune donnée
 * ne transite par un tiers.
 *
 * Protocole (messages JSON, un id de corrélation par requête) :
 *   → {id, cmd:'ping'}                              ← {id, ok:true, driver, device}
 *   → {id, cmd:'enroll'}                            ← {id, ok:true, template, finger, format, quality, deviceUserId}
 *   → {id, cmd:'identify', templates:[{employeeId, template, format}]}
 *                                                   ← {id, ok:true, employeeId, score} | {id, ok:false, reason}
 *
 * Choix du pilote : variable d'environnement GE_AGENT_DRIVER
 *   - simulator (défaut)  : aucun matériel, pour tester tout le flux.
 *   - zkteco-usb          : lecteur USB ZKTeco (ZK4500/SLK20R) via le SDK ZKFinger — à compléter avec le SDK du poste.
 *
 * Port : GE_AGENT_PORT (défaut 9955). Hôte : toujours 127.0.0.1 (jamais exposé au réseau).
 */
'use strict';

const http = require('http');
let WebSocketServer;
try {
    WebSocketServer = require('ws').WebSocketServer;
} catch (e) {
    console.error('\n[ge-pointage-agent] Dépendance manquante : « ws ». Lancez d\'abord :  npm install\n');
    process.exit(1);
}

const PORT = parseInt(process.env.GE_AGENT_PORT || '9955', 10);
const HOST = '127.0.0.1';
const DRIVER_NAME = process.env.GE_AGENT_DRIVER || 'simulator';

let driver;
try {
    driver = require('./drivers/' + DRIVER_NAME);
} catch (e) {
    console.error('[ge-pointage-agent] Pilote introuvable : ' + DRIVER_NAME + ' — ' + e.message);
    process.exit(1);
}

async function handle(msg) {
    const cmd = msg && msg.cmd;
    if (cmd === 'ping') {
        return { ok: true, driver: driver.name || DRIVER_NAME, device: driver.device || '' };
    }
    if (cmd === 'enroll') {
        const r = await driver.enroll();
        return Object.assign({ ok: true, format: driver.format || 'zk' }, r);
    }
    if (cmd === 'identify') {
        const candidates = Array.isArray(msg.templates) ? msg.templates : [];
        const r = await driver.identify(candidates);
        if (!r || r.employeeId == null) return { ok: false, reason: 'Empreinte non reconnue' };
        return { ok: true, employeeId: r.employeeId, score: r.score || 0 };
    }
    return { ok: false, reason: 'Commande inconnue : ' + cmd };
}

const server = http.createServer((req, res) => { res.writeHead(426); res.end('WebSocket only'); });
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    // Sécurité : on n'accepte que le loopback.
    const ip = req.socket.remoteAddress || '';
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') { ws.close(); return; }
    ws.send(JSON.stringify({ event: 'ready', driver: driver.name || DRIVER_NAME, device: driver.device || '' }));
    ws.on('message', async (data) => {
        let msg; try { msg = JSON.parse(data.toString()); } catch (e) { return; }
        const id = msg && msg.id;
        try {
            const out = await handle(msg);
            ws.send(JSON.stringify(Object.assign({ id }, out)));
        } catch (e) {
            ws.send(JSON.stringify({ id, ok: false, reason: (e && e.message) || 'Erreur du lecteur' }));
        }
    });
});

(async function main() {
    if (driver.init) { try { await driver.init(); } catch (e) { console.error('[ge-pointage-agent] init pilote KO :', e.message); } }
    server.listen(PORT, HOST, () => {
        console.log('[ge-pointage-agent] prêt sur ws://' + HOST + ':' + PORT + '  (pilote : ' + (driver.name || DRIVER_NAME) + ')');
        console.log('[ge-pointage-agent] Laissez cette fenêtre ouverte pendant les pointages.');
    });
})();
