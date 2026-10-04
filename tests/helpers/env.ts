type Env = Record<string, string | undefined>;

const processEnv: Env = (globalThis as unknown as { process?: { env?: Env } }).process?.env ?? {};

/** Set env vars for the duration of a test, restoring previous values after. */
export function withEnv(env: Env, fn: () => void | Promise<void>): Promise<void> {
  const prev = { ...processEnv };
  Object.assign(processEnv, env);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of Object.keys(processEnv)) delete processEnv[k];
      Object.assign(processEnv, prev);
    });
}

/** Set a single env var, or delete it when value is undefined. */
export function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete processEnv[key];
  else processEnv[key] = value;
}
