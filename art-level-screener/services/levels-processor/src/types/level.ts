/** Типы горизонтальных уровней и выходных структур для скринера. */

export type LevelKind = 'top' | 'bottom';
export type LevelSide = 'resistance' | 'support';

/** Параметры расчёта уровней. */
export interface LevelParams {
  period: number;
  extremaWindow: number;
  maxBrokenAge: number;
  minTouches: number;
  minGap: number;
  natrMultiplier: number;
  /**
   * Touch-zone tolerance as a direct % of price (band half-width). When set and
   * > 0 it overrides the adaptive `natr · natrMultiplier`. The processor never
   * sets it (env-only params) — present to keep the shape in sync with levels-api.
   */
  tolerancePct?: number;
  atrPeriod: number;
}

/** Внутренний результат расчёта уровня (до обогащения дистанцией). */
export interface HorizontalLevel {
  time: number;
  index: number;
  price: number;
  kind: LevelKind;
  touches: number;
  breakoutDistance: number | null;
}

export interface LevelsResult {
  active: HorizontalLevel[];
  broken: HorizontalLevel[];
  price: number;
  natr: number;
}

/** Уровень для вывода: цена, время начала и дистанция до текущей цены. */
export interface LevelView {
  /** Цена уровня. */
  price: number;
  /** Время начала уровня — открытие свечи-экстремума (мс). */
  time: number;
  kind: LevelKind;
  /** Сторона относительно текущей цены: выше — resistance, ниже — support. */
  side: LevelSide;
  /** Реальное число касаний ценой. */
  touches: number;
  /** Дистанция до текущей цены, % от цены. */
  distancePct: number;
  /** Дистанция в единицах NATR (distancePct / NATR); null если NATR = 0. */
  distanceNatr: number | null;
  /** Дистанция пробоя, % — только для пробитых уровней, иначе null. */
  breakoutDistance: number | null;
}

/** Компактная запись для индекса скринера (`screener:<tf>`). */
export interface ScreenerEntry {
  symbol: string;
  price: number;
  natr: number;
  /** Все активные (непробитые) уровни, отсортированы по близости (NATR ↑). */
  levels: LevelView[];
  /** Ближайший активный уровень (= levels[0]); null, если активных нет. */
  nearest: LevelView | null;
  activeCount: number;
  brokenCount: number;
  updatedAt: number;
}

/** Полные данные по символу+ТФ (`detail:<tf>:<symbol>`). */
export interface SymbolDetail {
  symbol: string;
  timeframe: string;
  price: number;
  natr: number;
  nearest: LevelView | null;
  active: LevelView[];
  broken: LevelView[];
  updatedAt: number;
}
