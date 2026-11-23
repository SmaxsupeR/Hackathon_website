// Opens the on-device database and brings its schema up to date.
import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';
import { setIdGenerator } from '../core/id';
import { migrate, type Db } from './schema';

let opening: Promise<Db> | null = null;

export function getDb(): Promise<Db> {
  if (!opening) {
    opening = (async () => {
      setIdGenerator(() => Crypto.randomUUID());
      const db = await SQLite.openDatabaseAsync('namu.db');
      await db.execAsync('PRAGMA journal_mode = WAL;');
      await migrate(db);
      return db;
    })();
    opening.catch(() => {
      opening = null;
    });
  }
  return opening;
}
