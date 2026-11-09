/// <reference types="node" />
// In-memory database for tests, backed by Node's built-in SQLite.
import { DatabaseSync } from 'node:sqlite';
import type { Db } from './schema';

export function openTestDb(): Db {
  const raw = new DatabaseSync(':memory:');
  return {
    async execAsync(sql) {
      raw.exec(sql);
    },
    async runAsync(sql, params) {
      return raw.prepare(sql).run(...params);
    },
    async getAllAsync<T>(sql: string, params: (string | number | null)[]) {
      return raw.prepare(sql).all(...params) as T[];
    },
    async getFirstAsync<T>(sql: string, params: (string | number | null)[]) {
      return (raw.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async withTransactionAsync(task) {
      raw.exec('BEGIN');
      try {
        await task();
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
