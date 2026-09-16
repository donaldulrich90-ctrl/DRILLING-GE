/**
 * Schéma attendu pour dailyDataRecords (aligné sur init-db.js) :
 * shift, createdAt, UNIQUE(date, machineId, shift).
 * Sans colonne shift, les INSERT du serveur échouent — les saisies semblent « perdues ».
 */

function getIndexUniqueUserCols(database, tableName, cb) {
    database.all('PRAGMA table_info(' + tableName + ')', (e1, cols) => {
        if (e1 || !cols || !cols.length) return cb(e1 || new Error('no columns'));
        const byCid = {};
        cols.forEach((c) => {
            byCid[c.cid] = c.name;
        });
        database.all('PRAGMA index_list(' + tableName + ')', (e2, list) => {
            if (e2) return cb(e2);
            const userUnique = (list || []).filter((i) => i.unique && i.origin === 'u');
            if (userUnique.length === 0) return cb(null, []);
            const first = userUnique[0];
            database.all('PRAGMA index_info(' + first.name + ')', (e3, icols) => {
                if (e3) return cb(e3);
                const names = (icols || []).map((ic) => byCid[ic.cid]).filter(Boolean);
                cb(null, names);
            });
        });
    });
}

function needsFix(database, cb) {
    database.all('PRAGMA table_info(dailyDataRecords)', (err, cols) => {
        if (err) return cb(err);
        if (!cols || cols.length === 0) return cb(null, false);
        const names = cols.map((c) => c.name);
        getIndexUniqueUserCols(database, 'dailyDataRecords', (e2, uniqNames) => {
            if (e2) return cb(e2);
            const hasShiftInUnique = uniqNames.indexOf('shift') >= 0;
            const ok =
                names.indexOf('shift') >= 0 &&
                names.indexOf('createdAt') >= 0 &&
                uniqNames.indexOf('date') >= 0 &&
                uniqNames.indexOf('machineId') >= 0 &&
                hasShiftInUnique;
            cb(null, !ok);
        });
    });
}

/**
 * @param {import('sqlite3').Database} database
 * @param {(err?: Error) => void} done
 */
function ensureDailyDataRecordsSchema(database, done) {
    needsFix(database, (err, fix) => {
        if (err) return done(err);
        if (!fix) {
            database.run('DROP TABLE IF EXISTS dailyDataRecords_new', () => done());
            return;
        }

        database.all('PRAGMA table_info(dailyDataRecords)', (e1, cols) => {
            if (e1) return done(e1);
            if (!cols || !cols.length) return done();

            const names = cols.map((c) => c.name);
            const hasShiftCol = names.indexOf('shift') >= 0;
            const hasCreatedAt = names.indexOf('createdAt') >= 0;

            const shiftExpr = hasShiftCol
                ? "COALESCE(NULLIF(TRIM(COALESCE(shift, '')), ''), NULLIF(TRIM(json_extract(data, '$.shift')), ''), '')"
                : "COALESCE(NULLIF(TRIM(json_extract(data, '$.shift')), ''), '')";

            const createdAtExpr = hasCreatedAt ? 'COALESCE(createdAt, CURRENT_TIMESTAMP)' : 'CURRENT_TIMESTAMP';

            function col(name, fallbackSql) {
                if (names.indexOf(name) >= 0) return name;
                return fallbackSql;
            }

            const sel = [
                'id',
                'date',
                'machineId',
                shiftExpr + ' AS shift',
                'COALESCE(data, \'{}\') AS data',
                'COALESCE(notes, \'\') AS notes',
                createdAtExpr + ' AS createdAt',
                'COALESCE(' + col('enteredByUsername', "''") + ", '') AS enteredByUsername",
                'COALESCE(' + col('enteredByName', "''") + ", '') AS enteredByName",
                col('enteredAt', 'NULL') + ' AS enteredAt',
                'COALESCE(' + col('lastModifiedByUsername', "''") + ", '') AS lastModifiedByUsername",
                'COALESCE(' + col('lastModifiedByName', "''") + ", '') AS lastModifiedByName",
                col('lastModifiedAt', 'NULL') + ' AS lastModifiedAt'
            ].join(', ');

            const createSql = `
                CREATE TABLE dailyDataRecords__mig (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    date TEXT NOT NULL,
                    machineId TEXT NOT NULL,
                    shift TEXT DEFAULT '',
                    data TEXT DEFAULT '{}',
                    notes TEXT DEFAULT '',
                    createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                    enteredByUsername TEXT DEFAULT '',
                    enteredByName TEXT DEFAULT '',
                    enteredAt TEXT DEFAULT NULL,
                    lastModifiedByUsername TEXT DEFAULT '',
                    lastModifiedByName TEXT DEFAULT '',
                    lastModifiedAt TEXT DEFAULT NULL,
                    UNIQUE(date, machineId, shift)
                )
            `;

            database.serialize(() => {
                database.run('BEGIN IMMEDIATE');
                database.run(createSql, (ce) => {
                    if (ce) {
                        return database.run('ROLLBACK', () => done(ce));
                    }
                    const insertSql =
                        'INSERT INTO dailyDataRecords__mig (id, date, machineId, shift, data, notes, createdAt, enteredByUsername, enteredByName, enteredAt, lastModifiedByUsername, lastModifiedByName, lastModifiedAt) SELECT ' +
                        sel +
                        ' FROM dailyDataRecords';
                    database.run(insertSql, (ie) => {
                        if (ie) {
                            return database.run('ROLLBACK', () => done(ie));
                        }
                        database.run('DROP TABLE dailyDataRecords', (de) => {
                            if (de) {
                                return database.run('ROLLBACK', () => done(de));
                            }
                            database.run(
                                'ALTER TABLE dailyDataRecords__mig RENAME TO dailyDataRecords',
                                (re) => {
                                    if (re) {
                                        return database.run('ROLLBACK', () => done(re));
                                    }
                                    database.run('DROP TABLE IF EXISTS dailyDataRecords_new', () => {
                                        database.get('SELECT MAX(id) AS m FROM dailyDataRecords', (se, maxRow) => {
                                            const seqVal = maxRow && maxRow.m != null ? maxRow.m : 0;
                                            database.run(
                                                'UPDATE sqlite_sequence SET seq = ? WHERE name = \'dailyDataRecords\'',
                                                [seqVal],
                                                function () {
                                                    if (this.changes === 0) {
                                                        database.run(
                                                            'INSERT INTO sqlite_sequence (name, seq) VALUES (\'dailyDataRecords\', ?)',
                                                            [seqVal],
                                                            () => database.run('COMMIT', (ce2) => done(ce2 || undefined))
                                                        );
                                                    } else {
                                                        database.run('COMMIT', (ce2) => done(ce2 || undefined));
                                                    }
                                                }
                                            );
                                        });
                                    });
                                }
                            );
                        });
                    });
                });
            });
        });
    });
}

module.exports = { ensureDailyDataRecordsSchema, needsFix };
