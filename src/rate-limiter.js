import { DurableObject } from "cloudflare:workers";

const MINUTE = 60_000;
const HOUR = 3_600_000;

/**
 * One instance per visitor IP. Keeps a sliding window of document timestamps in
 * SQLite-backed storage and answers "can this visitor process one more document?".
 */
export class RateLimiter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS hits (ts INTEGER NOT NULL)");
  }

  /** Reads the current window without consuming a slot. */
  status(limits) {
    const now = Date.now();
    this.sql.exec("DELETE FROM hits WHERE ts < ?", now - HOUR);

    const minuteRows = this.sql.exec("SELECT ts FROM hits WHERE ts >= ? ORDER BY ts", now - MINUTE).toArray();
    const hourRows = this.sql.exec("SELECT ts FROM hits ORDER BY ts").toArray();

    const minuteRemaining = Math.max(0, limits.perMinute - minuteRows.length);
    const hourRemaining = Math.max(0, limits.perHour - hourRows.length);

    let retryAfterMs = 0;
    if (minuteRemaining === 0) retryAfterMs = Math.max(retryAfterMs, minuteRows[0].ts + MINUTE - now);
    if (hourRemaining === 0) retryAfterMs = Math.max(retryAfterMs, hourRows[0].ts + HOUR - now);

    return {
      allowed: retryAfterMs === 0,
      minuteRemaining,
      hourRemaining,
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
    };
  }

  /** Consumes one document slot when the window allows it. */
  consume(limits) {
    const current = this.status(limits);
    if (!current.allowed) return current;

    this.sql.exec("INSERT INTO hits (ts) VALUES (?)", Date.now());

    return {
      ...current,
      minuteRemaining: current.minuteRemaining - 1,
      hourRemaining: current.hourRemaining - 1,
    };
  }
}
