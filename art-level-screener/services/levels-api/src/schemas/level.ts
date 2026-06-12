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

export const AnalysisBreakout = Type.Object(
  {
    price: Type.Number({ description: 'Цена уровня' }),
    levelTime: Type.Integer({ description: 'Формирование уровня — открытие свечи-экстремума (мс)' }),
    kind: Type.Union([Type.Literal('top'), Type.Literal('bottom')], {
      description: 'top — пробой сопротивления вверх, bottom — пробой поддержки вниз',
    }),
    direction: Type.Union([Type.Literal('up'), Type.Literal('down')], {
      description: 'Направление пробоя',
    }),
    touches: Type.Integer({ description: 'Число касаний уровня до пробоя' }),
    breakoutCandleTime: Type.Integer({ description: 'Открытие свечи первого пробоя (мс)' }),
    crossTime: Type.Union([Type.Integer(), Type.Null()], {
      description: 'Трейд, первым вышедший за уровень (мс); null — за свечу трейда за уровнем не было',
    }),
    reachTime: Type.Union([Type.Integer(), Type.Null()], {
      description: 'Трейд, на котором достигнуто мин. движение (мс); null — не достигнуто',
    }),
    elapsedMs: Type.Union([Type.Integer(), Type.Null()], {
      description: 'Время от пересечения уровня до пикового движения (мс)',
    }),
    movePct: Type.Union([Type.Number(), Type.Null()], {
      description: 'Пиковый ход за уровень в окне [cross, +maxBreakoutSeconds], %',
    }),
    matched: Type.Boolean({ description: 'Пробой соответствует параметрам' }),
    reason: Type.String({
      description: 'ok | no_trades | no_cross | min_move_not_reached | too_slow',
    }),
  },
  { $id: 'AnalysisBreakout', description: 'Один пробой уровня и его проверка по трейдам' },
);

export const AnalysisResponse = Type.Object(
  {
    symbol: Type.String(),
    timeframe: Type.String(),
    params: Type.Object(
      {
        natrMultiplier: Type.Number(),
        minGap: Type.Integer(),
        direction: Type.Union([
          Type.Literal('up'),
          Type.Literal('down'),
          Type.Literal('both'),
        ]),
        maxBreakoutSeconds: Type.Integer(),
        minMovePct: Type.Number(),
        candles: Type.Integer(),
      },
      { description: 'Эффективные параметры анализа (после дефолтов и кэпов)' },
    ),
    candlesAnalyzed: Type.Integer({ description: 'Сколько свечей реально загружено' }),
    range: Type.Object(
      {
        from: Type.Integer({ description: 'Открытие первой свечи окна (мс)' }),
        to: Type.Integer({ description: 'Открытие последней свечи окна (мс)' }),
      },
      { description: 'Временной диапазон проанализированных свечей' },
    ),
    summary: Type.Object(
      {
        breakoutsFound: Type.Integer({ description: 'Всего найдено пробоев в окне' }),
        evaluated: Type.Integer({
          description: 'Проверено по трейдам (исключая пробои без трейдов в окне)',
        }),
        matched: Type.Integer(),
        unmatched: Type.Integer({ description: 'evaluated − matched' }),
        matchRate: Type.Number({ description: 'matched / evaluated, 0..1' }),
        byDirection: Type.Object({
          up: Type.Object({ found: Type.Integer(), matched: Type.Integer() }),
          down: Type.Object({ found: Type.Integer(), matched: Type.Integer() }),
        }),
      },
      { description: 'Агрегированная статистика пробоев' },
    ),
    breakouts: Type.Array(Type.Ref(AnalysisBreakout), {
      description: 'Все найденные пробои (слева направо по breakoutCandleTime)',
    }),
  },
  { $id: 'AnalysisResponse', description: 'Результат анализа пробоев уровней по монете' },
);

export const AnalysisQuery = Type.Object({
  natrMultiplier: Type.Optional(
    Type.Number({
      minimum: 0,
      description: 'Погрешность зоны касания/пробоя в долях NATR (полоса = natr·natrMultiplier); нет — env-дефолт',
    }),
  ),
  tolerancePct: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        'Погрешность зоны касания/пробоя напрямую в % от цены (±tolerancePct). При >0 переопределяет natrMultiplier; 0/нет — расчёт от NATR',
    }),
  ),
  minGap: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: 'Минимальный разрыв в свечах между касаниями уровня; нет — env-дефолт',
    }),
  ),
  direction: Type.Optional(
    Type.Union([Type.Literal('up'), Type.Literal('down'), Type.Literal('both')], {
      default: 'both',
      description: 'Какие пробои анализировать',
    }),
  ),
  maxBreakoutSeconds: Type.Optional(
    Type.Integer({
      minimum: 1,
      default: 300,
      description: 'Макс. время пробоя по трейдам, сек (от пересечения зоны до мин. движения)',
    }),
  ),
  minMovePct: Type.Optional(
    Type.Number({ minimum: 0, default: 0.5, description: 'Минимальное движение за уровень, %' }),
  ),
  candles: Type.Optional(
    Type.Integer({
      minimum: 61,
      description: 'Сколько свечей анализировать; нет — env-дефолт, сверху ограничено ANALYSIS_MAX_CANDLES',
    }),
  ),
});

export const ConfigResponse = Type.Object(
  {
    levels: Type.Object(
      {
        period: Type.Integer(),
        extremaWindow: Type.Integer(),
        maxBrokenAge: Type.Integer(),
        minTouches: Type.Integer(),
        minGap: Type.Integer(),
        natrMultiplier: Type.Number(),
        atrPeriod: Type.Integer(),
      },
      { description: 'Env-дефолты детекции уровней (как в скринере)' },
    ),
    analysis: Type.Object(
      {
        defaultCandles: Type.Integer(),
        maxCandles: Type.Integer(),
        aggTradesLimit: Type.Integer(),
        maxTradePages: Type.Integer(),
      },
      { description: 'Дефолты и кэпы анализа пробоев' },
    ),
    binance: Type.Object(
      {
        restUrl: Type.String(),
        weightLimitPerMin: Type.Integer(),
      },
      { description: 'Binance Futures REST: база и weight-лимит (для клиентского лимитера)' },
    ),
  },
  {
    $id: 'ConfigResponse',
    description:
      'Параметры расчёта для клиентского анализа: фронт считает анализ сам и должен использовать те же параметры, что и скринер',
  },
);

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
  tolerancePct: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        'Погрешность зоны касания напрямую в % от цены (±tolerancePct). При >0 переопределяет natrMultiplier; 0/нет — расчёт от NATR',
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
export type AnalysisBreakoutType = Static<typeof AnalysisBreakout>;
export type AnalysisResponseType = Static<typeof AnalysisResponse>;
export type AnalysisQueryType = Static<typeof AnalysisQuery>;
export type ConfigResponseType = Static<typeof ConfigResponse>;

/** Общие модели для регистрации в Fastify (по $id ссылаются схемы маршрутов). */
export const SHARED_MODELS = [
  LevelView,
  ScreenerEntry,
  SymbolDetail,
  ScreenerResponse,
  TimeframesResponse,
  HealthResponse,
  ErrorResponse,
  AnalysisBreakout,
  AnalysisResponse,
  ConfigResponse,
];
