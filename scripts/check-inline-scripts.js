'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const htmlPath = path.resolve(__dirname, '..', 'plateforme-forage.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const scriptPattern = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
let match;
let count = 0;

while ((match = scriptPattern.exec(html))) {
    count += 1;
    if (match[1].trim()) {
        new vm.Script(match[1], { filename: `plateforme-forage:inline-${count}` });
    }
}

console.log(`✅ ${count} bloc(s) script HTML analysé(s)`);
