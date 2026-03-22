export type NextOccurrenceInput = {
  now: Date;
  timeZone: string;
  timeOfDay: string;
  weekdays?: number[];
};

function parseTime(timeOfDay: string): { hour: number; minute: number } {
  const [hourText, minuteText] = timeOfDay.split(':');
  return {
    hour: Number(hourText),
    minute: Number(minuteText)
  };
}

function zonedParts(date: Date, timeZone: string): { year: number; month: number; day: number; weekday: number; hour: number; minute: number; second: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const weekdayValue = values.get('weekday');
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };

  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    weekday: weekdayMap[weekdayValue ?? 'Sun'],
    hour: Number(values.get('hour')),
    minute: Number(values.get('minute')),
    second: Number(values.get('second'))
  };
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  const utcMillis = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return utcMillis - date.getTime();
}

function zonedDateToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const approx = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offset = timeZoneOffsetMs(approx, timeZone);
  return new Date(approx.getTime() - offset);
}

export function computeNextOccurrence(input: NextOccurrenceInput): Date {
  const weekdays = input.weekdays ?? [1, 2, 3, 4, 5];
  const { hour, minute } = parseTime(input.timeOfDay);
  const current = zonedParts(input.now, input.timeZone);

  for (let offsetDays = 0; offsetDays < 14; offsetDays += 1) {
    const candidateBase = new Date(Date.UTC(current.year, current.month - 1, current.day + offsetDays, 12, 0, 0));
    const candidateParts = zonedParts(candidateBase, input.timeZone);
    if (!weekdays.includes(candidateParts.weekday)) {
      continue;
    }

    const candidate = zonedDateToUtc(
      candidateParts.year,
      candidateParts.month,
      candidateParts.day,
      hour,
      minute,
      input.timeZone
    );

    if (candidate.getTime() > input.now.getTime()) {
      return candidate;
    }
  }

  throw new Error('다음 실행 시각을 계산할 수 없습니다.');
}
