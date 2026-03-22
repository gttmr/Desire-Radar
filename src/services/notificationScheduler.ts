import { computeNextOccurrence } from './reportSchedule.js';

export class NotificationScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly timeZone: string;
  private readonly timeOfDay: string;
  private readonly now: () => Date;

  constructor(
    timeZone = 'Asia/Seoul',
    timeOfDay = '08:00',
    now: () => Date = () => new Date()
  ) {
    this.timeZone = timeZone;
    this.timeOfDay = timeOfDay;
    this.now = now;
  }

  setSchedule(guildId: string, runner: (guildId: string) => Promise<void>): void {
    this.clearSchedule(guildId);
    this.scheduleNext(guildId, runner);
  }

  clearSchedule(guildId: string): void {
    const timer = this.timers.get(guildId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(guildId);
    }
  }

  clearAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  activeSchedules(): number {
    return this.timers.size;
  }

  private scheduleNext(guildId: string, runner: (guildId: string) => Promise<void>): void {
    const next = computeNextOccurrence({
      now: this.now(),
      timeZone: this.timeZone,
      timeOfDay: this.timeOfDay
    });
    const delayMs = Math.max(1_000, next.getTime() - this.now().getTime());
    const timer = setTimeout(async () => {
      try {
        await runner(guildId);
      } finally {
        this.scheduleNext(guildId, runner);
      }
    }, delayMs);
    timer.unref();
    this.timers.set(guildId, timer);
  }
}
