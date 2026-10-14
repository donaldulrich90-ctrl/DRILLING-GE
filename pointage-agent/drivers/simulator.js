/*
 * Pilote SIMULATEUR — aucun matériel requis.
 * Sert à valider tout le flux (enrôlement, pointage, présence) sans lecteur.
 *  - enroll()   : génère un gabarit factice unique (base64).
 *  - identify() : reconnaît un employé enrôlé au hasard (démo), score 90-99.
 * Remplacez par le pilote « zkteco-usb » en production.
 */
'use strict';
const crypto = require('crypto');

module.exports = {
    name: 'simulator',
    device: 'SIM-0',
    format: 'sim',
    async enroll() {
        // Petite pause pour imiter la capture.
        await new Promise((r) => setTimeout(r, 600));
        return {
            template: crypto.randomBytes(48).toString('base64'),
            finger: 'right-index',
            quality: 80 + Math.floor(Math.random() * 20),
            deviceUserId: ''
        };
    },
    async identify(candidates) {
        await new Promise((r) => setTimeout(r, 700));
        if (!candidates || !candidates.length) return null;
        // Démo : on « reconnaît » un employé enrôlé au hasard.
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        return { employeeId: pick.employeeId, score: 90 + Math.floor(Math.random() * 10) };
    }
};
