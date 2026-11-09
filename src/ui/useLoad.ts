import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getDb } from '../db';
import type { Db } from '../db/schema';
import { useApp } from '../state/store';

/** Loads data from the database, and reloads when the screen regains focus or data changes. */
export function useLoad<T>(loader: (db: Db) => Promise<T>, deps: unknown[] = []): { data: T | undefined; error: string | null; reload: () => void } {
  const version = useApp((s) => s.dataVersion);
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const ref = useRef(loader);
  ref.current = loader;
  const focused = useRef(false);

  const run = useCallback(() => {
    let alive = true;
    getDb()
      .then((db) => ref.current(db))
      .then((value) => {
        if (alive) {
          setData(value);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      const cancel = run();
      return () => {
        focused.current = false;
        cancel();
      };
    }, [run]),
  );

  const mounted = useRef(false);
  useEffect(() => {
    // The focus effect already loaded the data on mount.
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (!focused.current) return;
    return run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, tick, run, ...deps]);

  return { data, error, reload: () => setTick((n) => n + 1) };
}
