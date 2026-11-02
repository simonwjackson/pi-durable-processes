// Also unset these in the unit: systemd creates some after manager-env inheritance.
export const managedProcessControlEnvKeys: readonly string[] = ["INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID", "NOTIFY_SOCKET", "MEMORY_PRESSURE_WATCH", "MEMORY_PRESSURE_WRITE"];

export function managedProcessEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const values: Record<string, string> = { PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", GFORTRAN_UNBUFFERED_ALL: "y", NSUnbufferedIO: "YES", NO_COLOR: "1" };
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && isManagedProcessEnvKey(key)) values[key] = value;
  }
  return values;
}
function isManagedProcessEnvKey(key: string): boolean {
  return !key.startsWith("PC_") && !key.startsWith("MEMORY_PRESSURE_") && !managedProcessControlEnvKeys.includes(key);
}
