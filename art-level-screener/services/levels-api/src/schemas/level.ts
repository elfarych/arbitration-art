/** TypeBox-схемы: модели уровней, параметры запросов и ответы API. */

import { Type, type Static } from '@sinclair/typebox';

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

export const LevelView = Type.Object(
  {
    price: Type.Number({ description: 'Цена уровня' }),
    time: Type.Integer({ description: 'Время начала уровня — свеча-экстремум (мс)' }),
    kind: Type.Union([Type.Literal('top'), Type.Literal('bottom')], {
      description: 'top — по максимумам, bottom — по минимумам',
    }),
    side: Type.Union([Type.Literal('resistance'), Type.Literal('support')], {
      description: 'Относительно текущей цены: выше — resistance, ниже — support',
    }),
    touches: Type.Integer({ description: 'Реальное число касаний ценой' }),
    distancePct: Type.Number({ description: 'Дистанция до текущей цены, %' }),
    distanceNatr: Type.Union([Type.Number(), Type.Null()], {
      description: 'Дистанция в единицах NATR (distancePct / natr)',
    }),
    breakoutDistance: Type.Union([Type.Number(), Type.Null()], {
      description: 'Дистанция пробоя, % — только для пробитых уровней',
    }),
  },
  { $id: 'LevelView', description: 'Уровень с временем начала и дистанцией до цены' },
);

export const ScreenerEntry = Type.Object(
  {
    symbol: Type.String(),
    price: Type.Number(),
    natr: Type.Number({ description: 'Волатильность, % от цены (Normalized ATR)' }),
    levels: Type.Array(Type.Ref(LevelView), {
      description: 'Все активные (непробитые) уровни, отсортированы по близости (NATR ↑)',
    }),
    nearest: Type.Union([Type.Ref(LevelView), Type.Null()], {
      description: 'Ближайший активный уровень (= levels[0])',
    }),
    activeCount: Type.Integer(),
    brokenCount: Type.Integer(),
    updatedAt: Type.Integer({ description: 'Время расчёта (мс, Unix)' }),
  },
  { $id: 'ScreenerEntry', description: 'Запись монеты в экране скринера' },
);

export const SymbolDetail = Type.Object(
  {
    symbol: Type.String(),
    timeframe: Type.String(),
    price: Type.Number(),
    natr: Type.Number(),
    nearest: Type.Union([Type.Ref(LevelView), Type.Null()]),
    active: Type.Array(Type.Ref(LevelView), { description: 'Активные (непробитые) уровни' }),
    broken: Type.Array(Type.Ref(LevelView), { description: 'Недавно пробитые уровни' }),
    updatedAt: Type.Integer(),
  },
  { $id: 'SymbolDetail', description: 'Полные уровни по монете и таймфрейму' },
);

export const ScreenerResponse = Type.Object(
  {
    timeframe: Type.String(),
    total: Type.Integer({ description: 'Число монет после фильтров (до пагинации)' }),
    count: Type.Integer({ description: 'Число монет в этом ответе' }),
    items: Type.Array(Type.Ref(ScreenerEntry)),
  },
  { $id: 'ScreenerResponse' },
);

export const TimeframesResponse = Type.Array(Type.String(), { $id: 'TimeframesResponse' });

export const HealthResponse = Type.Object(
  {
    status: Type.Literal('ok'),
    redis: Type.Union([Type.Literal('up'), Type.Literal('down')]),
  },
  { $id: 'HealthResponse' },
);

export const ErrorResponse = Type.Object(
  {
    error: Type.String(),
    message: Type.String(),
  },
  { $id: 'ErrorResponse' },
);

export const TimeframeParams = Type.Object({
  tf: Type.String({ description: 'Таймфрейм, напр. 1h' }),
});

export const SymbolParams = Type.Object({
  tf: Type.String({ description: 'Таймфрейм, напр. 1h' }),
  symbol: Type.String({ description: 'Торговая пара, напр. BTCUSDT' }),
});

export const ScreenerQuery = Type.Object({
  minVolume: Type.Optional(
    Type.Number({
      minimum: 0,
      description: 'Минимальный оборот в USDT (сумма volume·close по 24 свечам 1h); 0/нет — фильтр выключен',
    }),
  ),
  natrMultiplier: Type.Optional(
    Type.Number({
      minimum: 0,
      description: 'Погрешность зоны касания в долях NATR (ширина полосы = natr·natrMultiplier)',
    }),
  ),
  minGap: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: 'Минимальный разрыв в свечах между касаниями (ближе — считается одним касанием)',
    }),
  ),
  side: Type.Optional(
    Type.Union([Type.Literal('support'), Type.Literal('resistance')], {
      description: 'Фильтр по стороне ближайшего уровня',
    }),
  ),
  maxDistanceNatr: Type.Optional(
    Type.Number({ minimum: 0, description: 'Только монеты ближе этого числа NATR к уровню' }),
  ),
  minActive: Type.Optional(
    Type.Integer({ minimum: 0, description: 'Минимум активных уровней у монеты' }),
  ),
  search: Type.Optional(Type.String({ description: 'Подстрока символа (регистр игнорируется)' })),
  sort: Type.Optional(
    Type.Union([Type.Literal('distance'), Type.Literal('natr'), Type.Literal('symbol')], {
      default: 'distance',
      description: 'Поле сортировки',
    }),
  ),
  order: Type.Optional(
    Type.Union([Type.Literal('asc'), Type.Literal('desc')], { default: 'asc' }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT }),
  ),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
});

export type ScreenerEntryType = Static<typeof ScreenerEntry>;
export type SymbolDetailType = Static<typeof SymbolDetail>;
export type ScreenerQueryType = Static<typeof ScreenerQuery>;

/** Общие модели для регистрации в Fastify (по $id ссылаются схемы маршрутов). */
export const SHARED_MODELS = [
  LevelView,
  ScreenerEntry,
  SymbolDetail,
  ScreenerResponse,
  TimeframesResponse,
  HealthResponse,
  ErrorResponse,
];
