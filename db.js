/**
 * Module de connexion à la base de données SQLite
 * Configuration robuste : WAL, clés étrangères, intégrité
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'database.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');

let db = null;

/**
 * Obtient une connexion à la base de données (singleton)
 */
function getDb() {
    if (db) return db;
    
    if (!fs.existsSync(DB_PATH)) {
        console.warn('⚠️ Base de données non trouvée. Exécutez: npm run init-db');
    }

    db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
        if (err) {
            console.error('❌ Erreur de connexion à la base de données:', err.message);
            throw err;
        }
        console.log('✅ Connecté à la base de données SQLite');
    });

    // Configuration pour une base de données robuste
    db.serialize(() => {
        // Activer les clés étrangères (désactivées par défaut dans SQLite)
        db.run('PRAGMA foreign_keys = ON');
        
        // Mode WAL : meilleure concurrence et récupération après crash
        db.run('PRAGMA journal_mode = WAL');
        
        // Synchronisation complète pour garantir la durabilité des écritures
        db.run('PRAGMA synchronous = FULL');
        
        // Vérifier l'intégrité au démarrage
        db.get('PRAGMA quick_check', (err, row) => {
            if (err) console.warn('⚠️ Vérification DB:', err.message);
            else if (row && Object.values(row)[0] !== 'ok') {
                console.warn('⚠️ Vérification DB:', row);
            }
        });
        
        // Activer le cache pour les requêtes fréquentes
        db.run('PRAGMA cache_size = -64000'); // 64 MB
    });

    return db;
}

/**
 * Exécute une requête avec gestion d'erreur et support des promesses
 */
function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        getDb().run(sql, params, function(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

/**
 * Récupère une seule ligne
 */
function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        getDb().get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

/**
 * Récupère toutes les lignes
 */
function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        getDb().all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

/**
 * Exécute plusieurs requêtes dans une transaction
 */
function transaction(queries) {
    return new Promise((resolve, reject) => {
        const database = getDb();
        database.serialize(() => {
            database.run('BEGIN TRANSACTION', (err) => {
                if (err) return reject(err);
                
                let completed = 0;
                const total = queries.length;
                
                if (total === 0) {
                    database.run('COMMIT', (err) => err ? reject(err) : resolve());
                    return;
                }
                
                queries.forEach(({ sql, params = [] }) => {
                    database.run(sql, params, function(err) {
                        if (err) {
                            database.run('ROLLBACK', () => reject(err));
                            return;
                        }
                        completed++;
                        if (completed === total) {
                            database.run('COMMIT', (err) => err ? reject(err) : resolve());
                        }
                    });
                });
            });
        });
    });
}

/**
 * Crée une sauvegarde de la base de données (copie du fichier après checkpoint WAL)
 * @param {string} [destPathAbs] - Chemin absolu du fichier .db de sortie. Si omis : backups/database_<horodatage>.db
 */
function backup(destPathAbs) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(BACKUP_DIR)) {
            fs.mkdirSync(BACKUP_DIR, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        let backupPath = destPathAbs;
        if (!backupPath) {
            backupPath = path.join(BACKUP_DIR, `database_${timestamp}.db`);
        } else {
            backupPath = path.resolve(backupPath);
            const parentDir = path.dirname(backupPath);
            if (!fs.existsSync(parentDir)) {
                fs.mkdirSync(parentDir, { recursive: true });
            }
        }

        try {
            const database = getDb();
            // Checkpoint WAL pour écrire les données en attente dans le fichier principal
            database.run('PRAGMA wal_checkpoint(PASSIVE)', (err) => {
                if (err) console.warn('Checkpoint WAL:', err.message);
                try {
                    fs.copyFileSync(DB_PATH, backupPath);
                    console.log('✅ Sauvegarde créée:', backupPath);
                    resolve(backupPath);
                } catch (copyErr) {
                    reject(copyErr);
                }
            });
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Ferme la connexion
 */
function close() {
    if (db) {
        db.close((err) => {
            if (err) console.error('Erreur fermeture DB:', err.message);
            else console.log('✅ Base de données fermée');
            db = null;
        });
    }
}

module.exports = {
    getDb,
    run,
    get,
    all,
    transaction,
    backup,
    close,
    DB_PATH,
    BACKUP_DIR
};
