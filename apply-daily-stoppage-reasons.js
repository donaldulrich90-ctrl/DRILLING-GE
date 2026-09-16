const fs = require('fs');
const path = require('path');

const rows = [
  ['Major Component Changeout', 'BDN', 'Breakdown'],
  ['No work area scheduled', 'STB', 'Standby'],
  ['Engine power', 'BDN', 'Breakdown'],
  ['GET Delay', 'GSA', 'General Service Activity - Delay'],
  ['GET Stop', 'STB', 'Standby'],
  ['Shift change', 'STB', 'Standby'],
  ['Chop', 'STB', 'Standby'],
  ['Toilet break', 'STB', 'Standby'],
  ['Scheduled Service', 'BDN', 'Breakdown'],
  ['Wait associated equipment', 'GSA', 'General Service Activity - Delay'],
  ['Task preparation', 'GSA', 'General Service Activity - Delay'],
  ['Transport from Wona to Mouala', 'STB', 'Standby'],
  ['Operator swap', 'STB', 'Standby'],
  ['Client Delay', 'GSA', 'General Service Activity - Delay'],
  ['Client Stop', 'STB', 'Standby'],
  ['WGO Survey Delay', 'GSA', 'General Service Activity - Delay'],
  ['Ground Engaging Tools', 'STB', 'Standby'],
  ['Lubrication', 'BDN', 'Breakdown'],
  ['Wait on Water', 'STB', 'Standby'],
  ['Blast', 'STB', 'Standby'],
  ['Tracks & Undercarriage', 'BDN', 'Breakdown'],
  ['Drilling - Redrill', 'GSA', 'General Service Activity - Delay'],
  ['Ancillary Drilling', 'GSA', 'General Service Activity - Delay'],
  ['Safety', 'STB', 'Standby'],
  ['Electrical power', 'BDN', 'Breakdown'],
  ['Air Conditioning', 'BDN', 'Breakdown'],
  ['No Access', 'STB', 'Standby'],
  ['Steering articulation & suspension', 'BDN', 'Breakdown'],
  ['Daily Service', 'BDN', 'Breakdown'],
  ['Brakes', 'BDN', 'Breakdown'],
  ['Out of fuel/refueling', 'BDN', 'Breakdown'],
  ['Visibility', 'STB', 'Standby'],
  ['Wash For Service', 'BDN', 'Breakdown'],
  ['Planned Maintenance', 'BDN', 'Breakdown'],
  ['Unplanned Maintenance', 'BDN', 'Breakdown'],
  ['Planned Production', 'PRD', 'Production'],
  ['Unplanned Production', 'PRD', 'Production'],
  ['Rain', 'STB', 'Standby'],
  ['Idle Time', 'GSA', 'General Service Activity - Delay'],
  ['Dayworks', 'GSA', 'General Service Activity - Delay'],
  ['Standby for mark up', 'STB', 'Standby'],
  ['Transmission', 'BDN', 'Breakdown'],
  ['Pre Start Check', 'STB', 'Standby'],
  ['Hot Sitting', 'PRD', 'Production'],
  ['Relocate for Service', 'GSA', 'General Service Activity - Delay'],
  ['Relocate to Pattern', 'GSA', 'General Service Activity - Delay'],
  ['Relocate on Pattern', 'GSA', 'General Service Activity - Delay'],
  ['PSI Meeting', 'STB', 'Standby'],
  ['Geology Delay', 'GSA', 'General Service Activity - Delay'],
  ['600Hrs (8) Hours', 'BDN', 'Breakdown'],
  ['Relocate for Blast', 'GSA', 'General Service Activity - Delay'],
  ['Jaw Travel Motor- Rod Handler', 'BDN', 'Breakdown'],
  ['1200Hrs (12) Hours', 'BDN', 'Breakdown'],
  ['300Hrs (6) Hours', 'BDN', 'Breakdown'],
  ['Track Assembly / Chain', 'BDN', 'Breakdown'],
  ['Wait Lighting Plant', 'STB', 'Standby'],
  ['Accident Assistance', 'GSA', 'General Service Activity - Delay'],
  ['No Operator', 'STB', 'Standby'],
  ['Opportune Fuelling', 'STB', 'Standby'],
  ['Standby for lack of fuel', 'STB', 'Standby'],
  ['Opportune Maintenance', 'STB', 'Standby'],
  ['Wind', 'STB', 'Standby'],
  ['Lightening', 'STB', 'Standby'],
  ['Assisting another Equipment', 'GSA', 'General Service Activity - Delay'],
  ['End of Shift', 'STB', 'Standby'],
  ['Flushing', 'GSA', 'General Service Activity - Delay'],
  ['Access to Operations', 'STB', 'Standby'],
  ['Waiting on PVC', 'STB', 'Standby'],
  ['Compressor', 'BDN', 'Breakdown'],
  ['Windscreen Repair', 'BDN', 'Breakdown'],
  ['Rod Handler', 'BDN', 'Breakdown'],
  ['Hoses', 'BDN', 'Breakdown'],
  ['Levers', 'BDN', 'Breakdown'],
  ['Cable', 'BDN', 'Breakdown'],
  ['Machine Testing', 'GSA', 'General Service Activity - Delay'],
  ['Rig on Lowbed', 'STB', 'Standby'],
  ['Commissionning', 'STB', 'Standby']
];
function slug(cat) {
  return cat
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/-+/g, '-');
}
const used = new Map();
function val(cat, t) {
  let base = slug(cat) + '-' + t.toLowerCase();
  let v = base;
  let n = used.get(base) || 0;
  used.set(base, n + 1);
  if (n > 0) v = base + '-' + (n + 1);
  return v;
}
const lines = [];
for (const [cat, t, desc] of rows) {
  const label = cat.replace(/\s+/g, ' ').trim() + ' (' + t + ' - ' + desc + ')';
  lines.push("            { value: '" + val(cat, t) + "', label: " + JSON.stringify(label) + ' }');
}
const legacy = [
  "            { value: 'blast', label: 'Blast / tir (ancien code)' }",
  "            { value: 'deplacement', label: 'Déplacement (ancien code)' }",
  "            { value: 'manque-trou', label: 'Manque de trou (ancien code)' }",
  "            { value: 'meteo', label: 'Météo (ancien code)' }",
  "            { value: 'panne', label: 'Panne / maintenance (ancien code)' }",
  "            { value: 'attente', label: 'Attente client / autre (ancien code)' }",
  "            { value: 'securite', label: 'Sécurité / inspection (ancien code)' }",
  "            { value: 'logistique', label: 'Logistique / ravitaillement (ancien code)' }",
  "            { value: 'autre', label: 'Autre' }"
];
const block =
  '        var DAILY_STOPPAGE_REASONS = [\n' + [...lines, ...legacy].join(',\n') + '\n        ];';
const htmlPath = path.join(__dirname, 'plateforme-forage.html');
let html = fs.readFileSync(htmlPath, 'utf8');
const replaced = html.replace(
  /        var DAILY_STOPPAGE_REASONS = \[[\s\S]*?\n        \];/,
  block
);
if (replaced === html) {
  console.error('DAILY_STOPPAGE_REASONS block not found');
  process.exit(1);
}
fs.writeFileSync(htmlPath, replaced, 'utf8');
console.log('plateforme-forage.html updated');
