const { getDb } = require('./db');

const db = getDb();

// Insérer des données de test pour consommables
const testData = [
  {
    date: '2024-05-01',
    machineId: 'FOR-2024-001',
    shift: '',
    consumableId: 1, // Supposons que l'inventaire a des articles
    quantityUsed: 50,
    unitPrice: 1.5,
    currency: 'XOF',
    notes: 'Carburant diesel'
  },
  {
    date: '2024-05-01',
    machineId: 'FOR-2024-001',
    shift: '',
    consumableId: 2,
    quantityUsed: 2,
    unitPrice: 5000,
    currency: 'XOF',
    notes: 'Huile hydraulique'
  },
  {
    date: '2024-05-02',
    machineId: 'FOR-2024-002',
    shift: '',
    consumableId: 1,
    quantityUsed: 45,
    unitPrice: 1.5,
    currency: 'XOF',
    notes: 'Carburant diesel'
  }
];

// Insérer dans dailyConsumables
testData.forEach(item => {
  const totalCost = item.quantityUsed * item.unitPrice;
  db.run(
    `INSERT OR IGNORE INTO dailyConsumables (date, machineId, shift, consumableId, quantityUsed, unitPrice, totalCost, currency, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [item.date, item.machineId, item.shift, item.consumableId, item.quantityUsed, item.unitPrice, totalCost, item.currency, item.notes],
    function(err) {
      if (err) console.error('Erreur insertion test:', err);
      else console.log('✅ Donnée test insérée:', item.machineId, item.date);
    }
  );
});

// Insérer des articles d'inventaire si nécessaire
db.run(`INSERT OR IGNORE INTO inventory (id, enterpriseId, name, category, quantity, unit, price) VALUES (1, 1, 'Diesel', 'Carburant', 1000, 'litres', 1.5)`);
db.run(`INSERT OR IGNORE INTO inventory (id, enterpriseId, name, category, quantity, unit, price) VALUES (2, 1, 'Huile Hydraulique', 'Lubrifiant', 100, 'litres', 5000)`);

console.log('Données de test insérées');