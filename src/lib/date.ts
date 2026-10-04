const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 指定時刻が属する JST の日の 00:00 を、UTC 基準の Date として返す */
export function jstDayStart(now: Date = new Date()): Date {
  const jstMs = now.getTime() + JST_OFFSET_MS;
  return new Date(Math.floor(jstMs / DAY_MS) * DAY_MS - JST_OFFSET_MS);
}
