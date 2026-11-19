/** Bound user-configurable focus length before it reaches the timer or IPC. */
export function parseFocusMinutes(value: string): number | null {
  if (!/^[1-9][0-9]{0,2}$/.test(value)) return null;
  const minutes = Number(value);
  return minutes >= 1 && minutes <= 180 ? minutes : null;
}
