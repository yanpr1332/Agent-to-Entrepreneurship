/** Dates in the personal calendar are local civil dates, not UTC timestamps. */
export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface CalendarCell {
  key: string;
  day: number;
  currentMonth: boolean;
}

export function monthCells(year: number, monthIndex: number): CalendarCell[] {
  const first = new Date(year, monthIndex, 1, 12);
  const offset = (first.getDay() + 6) % 7; // Monday first
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(year, monthIndex, 1 - offset + index, 12);
    return {
      key: localDateKey(date),
      day: date.getDate(),
      currentMonth: date.getMonth() === monthIndex,
    };
  });
}

export function formatDueDate(key: string | null): string {
  if (!key) return "未安排日期";
  const [year, month, day] = key.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

/** Explicitly label the selected civil day; today is a separate marker. */
export function formatCalendarSelection(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key) ||
      date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error("Invalid calendar selection");
  }
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][date.getDay()];
  return `${year}年${month}月${day}日 · 星期${weekday}`;
}
