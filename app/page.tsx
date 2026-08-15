"use client";

import { useEffect, useMemo, useState } from "react";

type MarketKey = "KR" | "US" | "CRYPTO";
type LiquidityAsset = "BTC" | "ETH" | "SOL";

type LiveQuote = {
  key: string;
  symbol: string;
  price: number;
  previousClose: number;
  change: number;
  currency: string;
  marketTime: number | null;
};

type MarketFeed = {
  quotes: Record<string, LiveQuote>;
  updatedAt: string;
  source: string;
};

type DashboardMarket = {
  label: string;
  name: string;
  value: string;
  change: string;
  score: number;
  state: string;
  stance: string;
  summary: string;
  breadth: [number, number];
  breadthLabel?: string;
  stats: Array<[string, string, string]>;
  sectors: Array<[string, number]>;
  points: string[];
};

type LiquidityWall = {
  id: string;
  side: "ask" | "bid";
  price: string;
  distance: string;
  amount: string;
  notional: string;
  strength: number;
  age: string;
  change: string;
  filled: string;
  reliability: number;
};

type LiquiditySnapshot = {
  name: string;
  pair: string;
  current: string;
  imbalance: string;
  balance: number;
  buyWall: string;
  sellWall: string;
  highlight: string;
  summary: string;
  walls: LiquidityWall[];
  change24h?: string;
};

type BinanceDepth = {
  bids: [string, string][];
  asks: [string, string][];
};

type BinanceTicker = {
  lastPrice: string;
  priceChangePercent: string;
};

const cryptoConfig: Record<LiquidityAsset, { name: string; symbol: string; range: number }> = {
  BTC: { name: "비트코인", symbol: "BTCUSDT", range: 0.1 },
  ETH: { name: "이더리움", symbol: "ETHUSDT", range: 0.1 },
  SOL: { name: "솔라나", symbol: "SOLUSDT", range: 0.12 },
};

function bucketSize(asset: LiquidityAsset, price: number) {
  if (asset === "BTC") return price >= 100000 ? 500 : price >= 50000 ? 250 : 100;
  if (asset === "ETH") return price >= 5000 ? 50 : price >= 2000 ? 25 : 10;
  return price >= 300 ? 5 : price >= 100 ? 2 : 1;
}

function formatPrice(value: number, asset: LiquidityAsset) {
  const decimals = asset === "SOL" && value < 1000 ? 2 : 0;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function formatAmount(value: number, asset: LiquidityAsset) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M ${asset}`;
  if (value >= 100_000) return `${Math.round(value / 1000)}K ${asset}`;
  if (value >= 1000) return `${Math.round(value).toLocaleString("en-US")} ${asset}`;
  return `${value.toLocaleString("en-US", { maximumFractionDigits: asset === "BTC" ? 2 : 0 })} ${asset}`;
}

function formatNotional(value: number) {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  return `$${(value / 1000).toFixed(1)}K`;
}

async function binanceJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const bases = ["https://data-api.binance.vision", "https://api.binance.com"];
  let lastError: unknown;
  for (const base of bases) {
    try {
      const response = await fetch(`${base}${path}`, { cache: "no-store", signal });
      if (!response.ok) throw new Error(`Binance ${response.status}`);
      return (await response.json()) as T;
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error("Binance market data unavailable");
}

async function fetchLiquidity(asset: LiquidityAsset, signal: AbortSignal): Promise<LiquiditySnapshot> {
  const config = cryptoConfig[asset];
  const query = `symbol=${config.symbol}`;
  const [depth, ticker] = await Promise.all([
    binanceJson<BinanceDepth>(`/api/v3/depth?${query}&limit=5000`, signal),
    binanceJson<BinanceTicker>(`/api/v3/ticker/24hr?${query}`, signal),
  ]);
  const current = Number(ticker.lastPrice);
  if (!Number.isFinite(current) || !depth.asks?.length || !depth.bids?.length) {
    throw new Error("Invalid crypto market data");
  }

  const bucket = bucketSize(asset, current);
  const groupSide = (rows: [string, string][], side: "ask" | "bid") => {
    const grouped = new Map<number, { amount: number; notional: number }>();
    for (const [rawPrice, rawAmount] of rows) {
      const price = Number(rawPrice);
      const amount = Number(rawAmount);
      if (!Number.isFinite(price) || !Number.isFinite(amount) || amount <= 0) continue;
      const inRange = side === "ask"
        ? price > current && price <= current * (1 + config.range)
        : price < current && price >= current * (1 - config.range);
      if (!inRange) continue;
      const level = side === "ask" ? Math.ceil(price / bucket) * bucket : Math.floor(price / bucket) * bucket;
      const previous = grouped.get(level) ?? { amount: 0, notional: 0 };
      previous.amount += amount;
      previous.notional += price * amount;
      grouped.set(level, previous);
    }
    return [...grouped.entries()]
      .map(([price, totals]) => ({ price, ...totals, side }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 3)
      .sort((a, b) => b.price - a.price);
  };

  const asks = groupSide(depth.asks, "ask");
  const bids = groupSide(depth.bids, "bid");
  if (!asks.length || !bids.length) throw new Error("Not enough depth levels");

  const maxAmount = Math.max(...asks.map((row) => row.amount), ...bids.map((row) => row.amount));
  const toWall = (row: (typeof asks)[number]): LiquidityWall => {
    const strength = Math.max(1, Math.round((row.amount / maxAmount) * 100));
    const distance = ((row.price - current) / current) * 100;
    return {
      id: `${asset.toLowerCase()}-${row.side}-${row.price}`,
      side: row.side,
      price: formatPrice(row.price, asset),
      distance: `${distance >= 0 ? "+" : ""}${distance.toFixed(2)}%`,
      amount: formatAmount(row.amount, asset),
      notional: formatNotional(row.notional),
      strength,
      age: `±${formatPrice(bucket / 2, asset)}`,
      change: "실시간",
      filled: "—",
      reliability: Math.min(98, 45 + Math.round(strength * 0.5)),
    };
  };

  const askWalls = asks.map(toWall);
  const bidWalls = bids.map(toWall);
  const strongestAsk = askWalls.reduce((best, wall) => wall.strength > best.strength ? wall : best);
  const strongestBid = bidWalls.reduce((best, wall) => wall.strength > best.strength ? wall : best);
  const askTotal = asks.reduce((sum, row) => sum + row.amount, 0);
  const bidTotal = bids.reduce((sum, row) => sum + row.amount, 0);
  const balance = Math.round((bidTotal / (bidTotal + askTotal)) * 100);

  return {
    name: config.name,
    pair: `${asset} / USDT`,
    current: formatPrice(current, asset),
    imbalance: `${(bidTotal / askTotal).toFixed(2)}x`,
    balance,
    buyWall: strongestBid.price,
    sellWall: strongestAsk.price,
    highlight: strongestBid.id,
    summary: `현재가 ${formatPrice(current, asset)} 기준 아래쪽 ${strongestBid.price}에 ${strongestBid.amount}, 위쪽 ${strongestAsk.price}에 ${strongestAsk.amount}가 가장 큰 대기 매물대입니다. Binance 현물 오더북 5,000호가를 가격 구간별로 합산했습니다.`,
    walls: [...askWalls, ...bidWalls],
    change24h: `${Number(ticker.priceChangePercent) >= 0 ? "+" : ""}${Number(ticker.priceChangePercent).toFixed(2)}%`,
  };
}

function formatPercent(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatQuoteValue(quote: LiveQuote, index = false) {
  if (index) return quote.price.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (quote.currency === "KRW") return `${Math.round(quote.price).toLocaleString("ko-KR")}원`;
  return `$${quote.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function scoreFromChange(change: number) {
  return Math.max(20, Math.min(90, Math.round(50 + change * 14)));
}

function strengthFromChange(change: number) {
  return Math.max(18, Math.min(96, Math.round(52 + change * 14)));
}

function toneFromChange(change: number) {
  return change > 0.05 ? "positive" : change < -0.05 ? "negative" : "neutral";
}

function buildLiveMarket(
  base: DashboardMarket,
  primary: LiveQuote,
  secondary: LiveQuote,
  leaderA: LiveQuote,
  leaderB: LiveQuote,
): DashboardMarket {
  const average = (primary.change + secondary.change + leaderA.change + leaderB.change) / 4;
  const rising = [primary, secondary, leaderA, leaderB].filter((quote) => quote.change >= 0).length;
  const state = primary.change >= 1
    ? "강세 마감"
    : primary.change >= 0.2
      ? "상승 우위"
      : primary.change > -0.2
        ? "보합권"
        : primary.change > -1
          ? "약세 우위"
          : "변동성 확대";
  const stance = primary.change >= 0.2
    ? "눌림 지지 확인"
    : primary.change > -0.2
      ? "방향 확인 우선"
      : "반등 확인 전 관망";
  const relation = primary.change >= secondary.change ? `${base.name} 상대 우위` : `${secondary.symbol} 상대 우위`;

  return {
    ...base,
    value: formatQuoteValue(primary, true),
    change: formatPercent(primary.change),
    score: scoreFromChange(average),
    state,
    stance,
    summary: `${base.name}은 ${formatPercent(primary.change)}, 비교 지수는 ${formatPercent(secondary.change)}로 마감했습니다. 추적 중인 대표 종목은 ${leaderA.symbol} ${formatPercent(leaderA.change)}, ${leaderB.symbol} ${formatPercent(leaderB.change)}입니다. ${stance} 대응이 유리합니다.`,
    breadth: [rising, 4 - rising],
    breadthLabel: "추적 자산",
    stats: [
      [base.name, formatPercent(primary.change), toneFromChange(primary.change)],
      [secondary.symbol, formatPercent(secondary.change), toneFromChange(secondary.change)],
      [leaderA.symbol, formatPercent(leaderA.change), toneFromChange(leaderA.change)],
      [leaderB.symbol, formatPercent(leaderB.change), toneFromChange(leaderB.change)],
    ],
    sectors: [
      [base.name, strengthFromChange(primary.change)],
      [secondary.symbol, strengthFromChange(secondary.change)],
      [leaderA.symbol, strengthFromChange(leaderA.change)],
      [leaderB.symbol, strengthFromChange(leaderB.change)],
    ].sort((a, b) => Number(b[1]) - Number(a[1])) as Array<[string, number]>,
    points: [
      `${base.name} ${formatPercent(primary.change)} · ${secondary.symbol} ${formatPercent(secondary.change)}`,
      `${relation}, 대표 종목 확산은 ${rising}/4개`,
      `${leaderA.symbol}와 ${leaderB.symbol}의 상대강도를 다음 거래일 첫 30분에 재확인`,
    ],
  };
}

const markets: Record<MarketKey, DashboardMarket> = {
  KR: {
    label: "국장",
    name: "KOSPI",
    value: "3,251.44",
    change: "+0.82%",
    score: 62,
    state: "선별적 강세",
    stance: "반도체 눌림 선별",
    summary:
      "지수는 상승했지만 매수세가 반도체 대형주에 집중됐습니다. 코스닥보다 코스피가 강하고, 추격보다 거래대금이 유지되는 종목의 눌림 확인이 유리합니다.",
    breadth: [614, 287],
    stats: [
      ["외국인", "+1.12조", "positive"],
      ["기관", "-0.22조", "negative"],
      ["상승 종목", "614", "positive"],
      ["종가 위치", "고가 대비 0.4%", "neutral"],
    ],
    sectors: [
      ["반도체", 86],
      ["조선", 71],
      ["금융", 64],
      ["2차전지", 38],
    ],
    points: [
      "외국인 순매수의 67%가 반도체 대형주에 집중",
      "코스피는 장중 고점 부근 마감, 매수세 이탈 신호는 제한적",
      "코스닥 거래대금 감소로 중소형주 추격은 불리한 환경",
    ],
  },
  US: {
    label: "미장",
    name: "NASDAQ",
    value: "23,218.12",
    change: "+0.48%",
    score: 68,
    state: "상승 추세 · 폭 약화",
    stance: "대형 기술주 중심",
    summary:
      "나스닥 상승 추세는 유지됐지만 지수 상승 대비 종목 확산은 약했습니다. 반도체와 빅테크는 견조하나 러셀2000 약세로 시장 전체의 위험선호는 보통 수준입니다.",
    breadth: [3228, 2841],
    stats: [
      ["S&P 500", "+0.31%", "positive"],
      ["VIX", "16.8", "neutral"],
      ["미 10년물", "4.13%", "neutral"],
      ["러셀 2000", "-0.36%", "negative"],
    ],
    sectors: [
      ["반도체", 82],
      ["커뮤니케이션", 69],
      ["금융", 53],
      ["경기소비재", 42],
    ],
    points: [
      "엔비디아·브로드컴이 나스닥 상승 기여도의 41% 차지",
      "상승 종목 비율 53%로 지수 등락 대비 시장 폭은 보통",
      "장 후반 국채금리 반등에도 빅테크 매수세 유지",
    ],
  },
  CRYPTO: {
    label: "크립토",
    name: "BTC / USDT",
    value: "$62,400",
    change: "+1.84%",
    score: 58,
    state: "BTC 우위 · 알트 혼조",
    stance: "레버리지 축소",
    summary:
      "비트코인은 단기 추세를 회복했지만 도미넌스 상승으로 알트코인 확산은 제한적입니다. 미결제약정 증가 속도가 가격 상승보다 빨라 변동성 확대에 대비해야 합니다.",
    breadth: [61, 39],
    stats: [
      ["BTC 도미넌스", "59.2%", "neutral"],
      ["김치프리미엄", "+1.3%", "neutral"],
      ["펀딩비", "+0.011%", "negative"],
      ["24H 청산", "$286M", "negative"],
    ],
    sectors: [
      ["비트코인", 78],
      ["메이저 알트", 57],
      ["디파이", 46],
      ["밈코인", 31],
    ],
    points: [
      "BTC 현물 거래량이 20일 평균 대비 1.4배 증가",
      "가격 상승과 함께 미결제약정이 빠르게 늘어 롱 청산 주의",
      "알트/BTC 상대강도 하락으로 무차별 순환매 가능성은 낮음",
    ],
  },
};

const candidates = [
  {
    id: "005930",
    market: "KR" as MarketKey,
    ticker: "005930",
    name: "삼성전자",
    signal: "거래대금 돌파",
    strength: 84,
    price: "92,400원",
    change: "+2.21%",
    volume: "2.4배",
    reason: "외국인 연속 순매수와 함께 전일 고점을 돌파했고, 종가가 장중 고점 부근에서 형성됐습니다.",
    caution: "단기 이격이 커져 시가 추격보다 돌파 가격 지지 확인이 필요합니다.",
    trigger: "91,600원 지지 또는 93,200원 거래량 돌파",
  },
  {
    id: "000660",
    market: "KR" as MarketKey,
    ticker: "000660",
    name: "SK하이닉스",
    signal: "지수 대비 강세",
    strength: 89,
    price: "318,500원",
    change: "+3.07%",
    volume: "1.8배",
    reason: "코스피 대비 상대강도가 높고 반도체 업종 내 거래대금 1위를 유지했습니다.",
    caution: "15분봉 과열 구간으로 VWAP 이탈 시 단기 매수 우위가 약해질 수 있습니다.",
    trigger: "VWAP 313,800원 재지지",
  },
  {
    id: "NVDA",
    market: "US" as MarketKey,
    ticker: "NVDA",
    name: "엔비디아",
    signal: "눌림 후 재돌파",
    strength: 91,
    price: "$189.24",
    change: "+2.44%",
    volume: "1.6배",
    reason: "반도체 지수보다 강한 흐름을 보이며 장중 VWAP 재돌파 후 거래량이 재유입됐습니다.",
    caution: "전고점과 가까워 거래량 없는 돌파는 실패 가능성이 있습니다.",
    trigger: "$187.80 지지 또는 $190.10 돌파",
  },
  {
    id: "MSFT",
    market: "US" as MarketKey,
    ticker: "MSFT",
    name: "마이크로소프트",
    signal: "추세 지속",
    strength: 73,
    price: "$548.72",
    change: "+0.91%",
    volume: "1.2배",
    reason: "20일 이동평균선 위에서 저점이 높아지고 있으며 장 후반 기관성 매수 흐름이 관찰됐습니다.",
    caution: "거래량 증가가 크지 않아 급등보다는 완만한 추세형 후보입니다.",
    trigger: "$544.50 지지 확인",
  },
  {
    id: "BTC",
    market: "CRYPTO" as MarketKey,
    ticker: "BTC",
    name: "비트코인",
    signal: "4시간 추세 회복",
    strength: 76,
    price: "$62,400",
    change: "+1.84%",
    volume: "1.4배",
    reason: "4시간 기준 전고점 회복과 현물 거래량 증가가 함께 나타났습니다.",
    caution: "미결제약정이 가격보다 빠르게 증가해 레버리지 쏠림을 확인해야 합니다.",
    trigger: "$61K 지지 또는 $64K 돌파",
  },
  {
    id: "ETH",
    market: "CRYPTO" as MarketKey,
    ticker: "ETH",
    name: "이더리움",
    signal: "상대강도 회복 대기",
    strength: 55,
    price: "$3,420",
    change: "+0.72%",
    volume: "0.9배",
    reason: "가격은 반등했지만 ETH/BTC 상대강도와 거래량이 아직 확인되지 않았습니다.",
    caution: "BTC 조정 시 낙폭이 확대될 수 있어 선행 진입보다 확인이 우선입니다.",
    trigger: "ETH/BTC 전일 고점 회복",
  },
];

const liquidityData: Record<LiquidityAsset, LiquiditySnapshot> = {
  BTC: {
    name: "비트코인",
    pair: "BTC / USDT",
    current: "$62,400",
    imbalance: "1.31x",
    balance: 57,
    buyWall: "$60,000",
    sellWall: "$65,000",
    highlight: "btc-bid-60000",
    summary: "현재가 $62.4K를 기준으로 아래쪽에서는 $60K에 18,500 BTC, 위쪽에서는 $65K에 14,600 BTC가 가장 큰 매물대로 집계됩니다. $64K를 넘으면 $65K 대형 매물대의 소화 여부가 핵심입니다.",
    walls: [
      { id: "btc-ask-68000", side: "ask", price: "$68,000", distance: "+8.97%", amount: "9,820 BTC", notional: "$667.8M", strength: 67, age: "±$500", change: "-4%", filled: "12%", reliability: 71 },
      { id: "btc-ask-65000", side: "ask", price: "$65,000", distance: "+4.17%", amount: "14,600 BTC", notional: "$949.0M", strength: 96, age: "±$500", change: "+7%", filled: "19%", reliability: 91 },
      { id: "btc-ask-64000", side: "ask", price: "$64,000", distance: "+2.56%", amount: "7,300 BTC", notional: "$467.2M", strength: 54, age: "±$250", change: "+2%", filled: "27%", reliability: 68 },
      { id: "btc-bid-61000", side: "bid", price: "$61,000", distance: "-2.24%", amount: "8,900 BTC", notional: "$542.9M", strength: 62, age: "±$250", change: "+5%", filled: "23%", reliability: 74 },
      { id: "btc-bid-60000", side: "bid", price: "$60,000", distance: "-3.85%", amount: "18,500 BTC", notional: "$1.11B", strength: 100, age: "±$500", change: "+3%", filled: "31%", reliability: 94 },
      { id: "btc-bid-58000", side: "bid", price: "$58,000", distance: "-7.05%", amount: "12,400 BTC", notional: "$719.2M", strength: 79, age: "±$500", change: "-6%", filled: "16%", reliability: 82 },
    ],
  },
  ETH: {
    name: "이더리움",
    pair: "ETH / USDT",
    current: "$3,420",
    imbalance: "1.08x",
    balance: 52,
    buyWall: "$3,200",
    sellWall: "$3,600",
    highlight: "eth-bid-3200",
    summary: "현재가 $3,420 아래에서는 $3,200의 104,000 ETH 매물대가 가장 크고, 위쪽에서는 $3,600의 88,000 ETH가 핵심 저항 후보입니다.",
    walls: [
      { id: "eth-ask-3800", side: "ask", price: "$3,800", distance: "+11.11%", amount: "62,000 ETH", notional: "$235.6M", strength: 68, age: "±$50", change: "+3%", filled: "14%", reliability: 72 },
      { id: "eth-ask-3600", side: "ask", price: "$3,600", distance: "+5.26%", amount: "88,000 ETH", notional: "$316.8M", strength: 93, age: "±$50", change: "+6%", filled: "21%", reliability: 88 },
      { id: "eth-ask-3500", side: "ask", price: "$3,500", distance: "+2.34%", amount: "54,000 ETH", notional: "$189.0M", strength: 59, age: "±$25", change: "-2%", filled: "25%", reliability: 65 },
      { id: "eth-bid-3300", side: "bid", price: "$3,300", distance: "-3.51%", amount: "48,000 ETH", notional: "$158.4M", strength: 53, age: "±$25", change: "+4%", filled: "20%", reliability: 67 },
      { id: "eth-bid-3200", side: "bid", price: "$3,200", distance: "-6.43%", amount: "104,000 ETH", notional: "$332.8M", strength: 100, age: "±$50", change: "+2%", filled: "34%", reliability: 92 },
      { id: "eth-bid-3000", side: "bid", price: "$3,000", distance: "-12.28%", amount: "79,000 ETH", notional: "$237.0M", strength: 81, age: "±$50", change: "-5%", filled: "17%", reliability: 79 },
    ],
  },
  SOL: {
    name: "솔라나",
    pair: "SOL / USDT",
    current: "$164.20",
    imbalance: "1.36x",
    balance: 58,
    buyWall: "$150",
    sellWall: "$180",
    highlight: "sol-bid-150",
    summary: "현재가 $164.20 아래에서는 $150에 2.6M SOL, 위쪽에서는 $180에 2.1M SOL가 가장 큰 매물대로 집계됩니다.",
    walls: [
      { id: "sol-ask-190", side: "ask", price: "$190", distance: "+15.71%", amount: "1.4M SOL", notional: "$266.0M", strength: 66, age: "±$2.50", change: "+1%", filled: "12%", reliability: 69 },
      { id: "sol-ask-180", side: "ask", price: "$180", distance: "+9.62%", amount: "2.1M SOL", notional: "$378.0M", strength: 92, age: "±$2.50", change: "+5%", filled: "18%", reliability: 86 },
      { id: "sol-ask-170", side: "ask", price: "$170", distance: "+3.53%", amount: "880K SOL", notional: "$149.6M", strength: 48, age: "±$1", change: "-3%", filled: "24%", reliability: 61 },
      { id: "sol-bid-158", side: "bid", price: "$158", distance: "-3.78%", amount: "760K SOL", notional: "$120.1M", strength: 44, age: "±$1", change: "+4%", filled: "20%", reliability: 63 },
      { id: "sol-bid-150", side: "bid", price: "$150", distance: "-8.65%", amount: "2.6M SOL", notional: "$390.0M", strength: 100, age: "±$2.50", change: "+6%", filled: "29%", reliability: 90 },
      { id: "sol-bid-140", side: "bid", price: "$140", distance: "-14.74%", amount: "1.9M SOL", notional: "$266.0M", strength: 76, age: "±$2.50", change: "-4%", filled: "16%", reliability: 77 },
    ],
  },
};

function MiniBars({ values }: { values: number[] }) {
  return (
    <div className="mini-bars" aria-hidden="true">
      {values.map((value, index) => (
        <i key={index} style={{ height: `${value}%` }} />
      ))}
    </div>
  );
}

export default function Home() {
  const [activeMarket, setActiveMarket] = useState<MarketKey>("KR");
  const [filter, setFilter] = useState<"ALL" | MarketKey>("ALL");
  const [selectedId, setSelectedId] = useState("005930");
  const [watchlist, setWatchlist] = useState<string[]>(["005930", "NVDA", "BTC"]);
  const [updatedAt, setUpdatedAt] = useState("14:25");
  const [toast, setToast] = useState(false);
  const [liquidityAsset, setLiquidityAsset] = useState<LiquidityAsset>("BTC");
  const [selectedWallId, setSelectedWallId] = useState("btc-bid-60000");
  const [liveLiquidity, setLiveLiquidity] = useState<Partial<Record<LiquidityAsset, LiquiditySnapshot>>>({});
  const [liquidityStatus, setLiquidityStatus] = useState<"loading" | "live" | "error">("loading");
  const [liquidityUpdatedAt, setLiquidityUpdatedAt] = useState("");
  const [marketFeed, setMarketFeed] = useState<MarketFeed | null>(null);
  const [marketStatus, setMarketStatus] = useState<"loading" | "live" | "error">("loading");
  const [refreshNonce, setRefreshNonce] = useState(0);

  const selected = candidates.find((item) => item.id === selectedId) ?? candidates[0];
  const filtered = useMemo(
    () => candidates.filter((item) => filter === "ALL" || item.market === filter),
    [filter],
  );
  const liquidity = liveLiquidity[liquidityAsset] ?? liquidityData[liquidityAsset];
  const selectedWall = liquidity.walls.find((wall) => wall.id === selectedWallId) ?? liquidity.walls[0];
  const selectedLive = selected.id === "BTC" || selected.id === "ETH"
    ? liveLiquidity[selected.id]
    : undefined;
  const displayMarkets = useMemo<Record<MarketKey, DashboardMarket>>(() => {
    const quotes = marketFeed?.quotes;
    const next = { ...markets };
    if (quotes?.kospi && quotes.kosdaq && quotes.samsung && quotes.skhynix) {
      next.KR = buildLiveMarket(markets.KR, quotes.kospi, quotes.kosdaq, quotes.samsung, quotes.skhynix);
    }
    if (quotes?.nasdaq && quotes.sp500 && quotes.nvda && quotes.msft) {
      next.US = buildLiveMarket(markets.US, quotes.nasdaq, quotes.sp500, quotes.nvda, quotes.msft);
    }
    const btc = liveLiquidity.BTC;
    const btcChange = Number(btc?.change24h?.replace("%", ""));
    if (btc && Number.isFinite(btcChange)) {
      const rising = btcChange >= 0 ? 1 : 0;
      next.CRYPTO = {
        ...markets.CRYPTO,
        value: btc.current,
        change: btc.change24h ?? markets.CRYPTO.change,
        score: scoreFromChange(btcChange),
        state: btcChange >= 1 ? "상승 우위" : btcChange > -1 ? "중립 구간" : "하락 변동성",
        stance: btcChange >= 0 ? "아래 매물대 지지 확인" : "위쪽 매물대 회복 확인",
        summary: btc.summary,
        breadth: [rising, 1 - rising],
        breadthLabel: "BTC 24시간",
        stats: [
          ["BTC 24H", formatPercent(btcChange), toneFromChange(btcChange)],
          ["매수 호가 비중", `${btc.balance}%`, btc.balance >= 50 ? "positive" : "negative"],
          ["아래/위 물량", btc.imbalance, btc.balance >= 50 ? "positive" : "negative"],
          ["데이터", "Binance 현물", "neutral"],
        ],
        sectors: [
          ["매수 유동성", btc.balance],
          ["매도 유동성", 100 - btc.balance],
          ["위쪽 매물대", 65],
          ["아래쪽 매물대", 65],
        ],
        points: [
          `BTC 현재가 ${btc.current} · 24시간 ${formatPercent(btcChange)}`,
          `아래쪽 최대 매물대 ${btc.buyWall} · 위쪽 최대 매물대 ${btc.sellWall}`,
          "호가 주문은 체결 전에 취소될 수 있어 실제 체결 흐름과 함께 확인",
        ],
      };
    }
    return next;
  }, [liveLiquidity.BTC, marketFeed]);
  const active = displayMarkets[activeMarket];
  const stockQuoteKeys: Record<string, string> = {
    "005930": "samsung",
    "000660": "skhynix",
    NVDA: "nvda",
    MSFT: "msft",
  };
  const selectedStockQuote = marketFeed?.quotes[stockQuoteKeys[selected.id]];
  const selectedPrice = selectedStockQuote ? formatQuoteValue(selectedStockQuote) : selectedLive?.current ?? selected.price;
  const selectedChange = selectedStockQuote ? formatPercent(selectedStockQuote.change) : selectedLive?.change24h ?? selected.change;
  const candidateDisplay = (id: string, price: string, change: string) => {
    const quote = marketFeed?.quotes[stockQuoteKeys[id]];
    if (quote) return { price: formatQuoteValue(quote), change: formatPercent(quote.change) };
    const crypto = id === "BTC" || id === "ETH" ? liveLiquidity[id] : undefined;
    return { price: crypto?.current ?? price, change: crypto?.change24h ?? change };
  };
  const compositeScore = useMemo(() => {
    const changes = [marketFeed?.quotes.kospi?.change, marketFeed?.quotes.nasdaq?.change];
    const btcChange = Number(liveLiquidity.BTC?.change24h?.replace("%", ""));
    if (Number.isFinite(btcChange)) changes.push(btcChange);
    const valid = changes.filter((value): value is number => Number.isFinite(value));
    return valid.length ? scoreFromChange(valid.reduce((sum, value) => sum + value, 0) / valid.length) : 50;
  }, [liveLiquidity.BTC?.change24h, marketFeed]);
  const marketsReady = marketStatus === "live" && liquidityStatus === "live";
  const heroHeadline = compositeScore >= 65
    ? "위험선호가 우세한 장"
    : compositeScore >= 48
      ? "선별매매가 필요한 장"
      : "방어적으로 확인할 장";
  const positionSize = compositeScore >= 65 ? "평소의 80%" : compositeScore >= 48 ? "평소의 60%" : "평소의 35%";

  useEffect(() => {
    const controller = new AbortController();
    const loadMarkets = async () => {
      setMarketStatus("loading");
      try {
        const response = await fetch("/api/markets", { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          const detail = await response.text();
          throw new Error(`Market feed ${response.status}: ${detail.slice(0, 800)}`);
        }
        const payload = (await response.json()) as MarketFeed;
        if (!payload.quotes?.kospi || !payload.quotes?.nasdaq) throw new Error("Incomplete market feed");
        setMarketFeed(payload);
        setMarketStatus("live");
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error("Stock market refresh failed", error);
          setMarketStatus("error");
        }
      }
    };
    void loadMarkets();
    const interval = window.setInterval(loadMarkets, 300_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refreshNonce]);

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      setLiquidityStatus("loading");
      try {
        const snapshot = await fetchLiquidity(liquidityAsset, controller.signal);
        if (controller.signal.aborted) return;
        const time = new Date().toLocaleTimeString("ko-KR", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        });
        setLiveLiquidity((current) => ({ ...current, [liquidityAsset]: snapshot }));
        setSelectedWallId(snapshot.highlight);
        setLiquidityUpdatedAt(time);
        setUpdatedAt(time.slice(0, 5));
        setLiquidityStatus("live");
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error("Crypto liquidity refresh failed", error);
          setLiquidityStatus("error");
        }
      }
    };

    void load();
    const interval = window.setInterval(load, 60_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [liquidityAsset, refreshNonce]);

  const selectLiquidityAsset = (asset: LiquidityAsset) => {
    setLiquidityAsset(asset);
    setSelectedWallId((liveLiquidity[asset] ?? liquidityData[asset]).highlight);
  };

  const refresh = () => {
    setUpdatedAt(new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }));
    setRefreshNonce((current) => current + 1);
    setToast(true);
    window.setTimeout(() => setToast(false), 2200);
  };

  const toggleWatch = (id: string) => {
    setWatchlist((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Market Compass 홈">
          <span className="brand-mark"><i /><i /><i /></span>
          <span>MARKET <b>COMPASS</b></span>
          <em>LAB</em>
        </a>
        <nav className="desktop-nav" aria-label="주요 메뉴">
          <a className="active" href="#top">오늘의 시장</a>
          <a href="#close-brief">마감 브리핑</a>
          <a href="#scanner">조건 탐지</a>
          <a href="#liquidity">주요 매물대</a>
          <a href="#scenario">내일 시나리오</a>
        </nav>
        <div className="top-actions">
          <span className={`demo-chip ${marketsReady ? "live-chip" : ""}`}><i /> {marketsReady ? "MARKETS LIVE · 모델 분석" : marketStatus === "error" || liquidityStatus === "error" ? "일부 데이터 연결 실패" : "데이터 연결 중"}</span>
          <button className="refresh-button" onClick={refresh} aria-label="분석 새로고침">
            <span>↻</span> {updatedAt}
          </button>
        </div>
      </header>

      <div className="app-shell" id="top">
        <section className="hero-grid">
          <article className="hero-panel">
            <div className="eyebrow"><span>국장·미장·크립토 실시간</span><i />등락 기반 모델 분석</div>
            <div className="hero-copy">
              <p>오늘의 시장 대응</p>
              <h1>실시간 흐름 기준,<br /><strong>{heroHeadline}</strong></h1>
              <p className="hero-summary">
                KOSPI <b>{displayMarkets.KR.change}</b>, NASDAQ <b>{displayMarkets.US.change}</b>, BTC <b>{displayMarkets.CRYPTO.change}</b>를 함께 반영했습니다. 현재 지수와 대표 종목의 상대강도를 비교해 <b>추격보다 확인 매매</b>를 우선합니다.
              </p>
            </div>
            <div className="action-row">
              <div><span>추천 대응</span><b>{compositeScore >= 55 ? "강한 자산 눌림 확인" : "첫 반등 확인 후 진입"}</b></div>
              <div><span>피해야 할 매매</span><b>{compositeScore >= 65 ? "거래량 없는 돌파 추격" : "약세 자산 물타기"}</b></div>
              <div><span>포지션 강도</span><b>{positionSize}</b></div>
            </div>
          </article>

          <aside className="risk-panel">
            <div className="panel-heading">
              <div><span>COMPOSITE SCORE</span><h2>종합 시장 온도</h2></div>
              <button aria-label="시장 온도 설명">?</button>
            </div>
            <div className="gauge-wrap">
              <div className="gauge"><span><b>{compositeScore}</b><small>/ 100</small></span></div>
              <div className="gauge-labels"><span>위험회피</span><b>{heroHeadline}</b><span>과열</span></div>
            </div>
            <div className="score-list">
              {[["국장", displayMarkets.KR.score], ["미장", displayMarkets.US.score], ["크립토", displayMarkets.CRYPTO.score], ["종합", compositeScore]].map(([label, value]) => (
                <div key={String(label)}><span>{label}</span><i><b style={{ width: `${value}%` }} /></i><em>{value}</em></div>
              ))}
            </div>
          </aside>
        </section>

        <section className="market-overview" aria-label="시장별 상태">
          {(Object.keys(markets) as MarketKey[]).map((key) => {
            const item = displayMarkets[key];
            const displayValue = item.value;
            const displayChange = item.change;
            const bars = key === "KR" ? [35, 48, 44, 61, 57, 68, 66, 79, 74, 86, 82, 91] : key === "US" ? [28, 35, 46, 43, 52, 57, 69, 63, 76, 72, 83, 88] : [46, 68, 52, 61, 43, 54, 72, 65, 58, 79, 68, 84];
            return (
              <button
                key={key}
                className={`market-card ${activeMarket === key ? "selected" : ""}`}
                onClick={() => setActiveMarket(key)}
                aria-pressed={activeMarket === key}
              >
                <div className="card-top"><span>{item.label}<small>{key === "CRYPTO" ? "24H" : "CLOSE"}</small></span><em>{item.score}점</em></div>
                <div className="market-quote"><div><b>{item.name}</b><strong>{displayValue}</strong></div><span className={displayChange.startsWith("+") ? "positive" : "negative"}>{displayChange}</span></div>
                <MiniBars values={bars} />
                <div className="card-bottom"><span><i />{item.state}</span><b>{item.stance} →</b></div>
              </button>
            );
          })}
        </section>

        <section className="section-block" id="close-brief">
          <div className="section-title-row">
            <div><span className="section-index">01</span><div><p>MARKET CLOSE BRIEF</p><h2>장 마감 브리핑</h2></div></div>
            <div className="segmented" role="tablist" aria-label="시장 선택">
              {(Object.keys(markets) as MarketKey[]).map((key) => (
                <button key={key} className={activeMarket === key ? "active" : ""} onClick={() => setActiveMarket(key)}>{markets[key].label}</button>
              ))}
            </div>
          </div>

          <div className="brief-grid">
            <article className="brief-main">
              <div className="brief-kicker"><span>{active.label} 마감 판단</span><em>신뢰도 {active.score}%</em></div>
              <h3>{active.state}</h3>
              <p>{active.summary}</p>
              <div className="stat-grid">
                {active.stats.map(([label, value, tone]) => (
                  <div key={label}><span>{label}</span><b className={tone}>{value}</b></div>
                ))}
              </div>
              <div className="breadth">
                <div><span>{active.breadthLabel ?? "시장 폭"}</span><em>상승 {active.breadth[0]} · 하락 {active.breadth[1]}</em></div>
                <i><b style={{ width: `${(active.breadth[0] / (active.breadth[0] + active.breadth[1])) * 100}%` }} /></i>
              </div>
            </article>

            <article className="sector-panel">
              <div className="small-heading"><span>추적 자산 상대강도</span><b>강도</b></div>
              <div className="sector-list">
                {active.sectors.map(([sector, strength], index) => (
                  <div key={sector}><span><i>{index + 1}</i>{sector}</span><b><i style={{ width: `${strength}%` }} /></b><em>{strength}</em></div>
                ))}
              </div>
            </article>

            <article className="keypoints-panel">
              <div className="small-heading"><span>오늘 확인된 핵심</span><b>{active.label}</b></div>
              <ol>{active.points.map((point, index) => <li key={point}><i>{String(index + 1).padStart(2, "0")}</i><span>{point}</span></li>)}</ol>
            </article>
          </div>
        </section>

        <section className="section-block" id="scanner">
          <div className="section-title-row scanner-heading">
            <div><span className="section-index">02</span><div><p>SETUP DETECTOR</p><h2>매매 조건 탐지</h2></div></div>
            <p>급등 순위가 아니라 <b>거래량·상대강도·가격 위치</b>가 함께 확인된 후보입니다.</p>
          </div>
          <div className="scanner-grid">
            <article className="scanner-table-wrap">
              <div className="scanner-toolbar">
                <div className="segmented compact">
                  {(["ALL", "KR", "US", "CRYPTO"] as const).map((key) => (
                    <button key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>{key === "ALL" ? "전체" : markets[key].label}</button>
                  ))}
                </div>
                <span>{filtered.length}개 후보 감지</span>
              </div>
              <div className="scanner-table">
                <div className="table-row table-head"><span>종목</span><span>탐지 조건</span><span>강도</span><span>거래량</span><span>등락</span><span /></div>
                {filtered.map((item) => {
                  const live = candidateDisplay(item.id, item.price, item.change);
                  return (
                  <button className={`table-row ${selected.id === item.id ? "selected" : ""}`} key={item.id} onClick={() => setSelectedId(item.id)}>
                    <span className="asset-cell"><i>{item.market === "KR" ? "K" : item.market === "US" ? "U" : "C"}</i><b>{item.name}<small>{item.ticker}</small></b></span>
                    <span><em className="signal-chip">{item.signal}</em></span>
                    <span className="strength-cell"><i><b style={{ width: `${item.strength}%` }} /></i><em>{item.strength}</em></span>
                    <span>{item.volume}</span><span className={live.change.startsWith("+") ? "positive" : "negative"}>{live.change}</span><span>›</span>
                  </button>
                  );
                })}
              </div>
            </article>

            <aside className="candidate-detail">
              <div className="detail-top"><span className="market-tag">{markets[selected.market].label}</span><button onClick={() => toggleWatch(selected.id)} aria-label="관심종목 토글">{watchlist.includes(selected.id) ? "★" : "☆"}</button></div>
              <div className="asset-title"><div><p>{selected.ticker}</p><h3>{selected.name}</h3></div><div><b>{selectedPrice}</b><span>{selectedChange}</span></div></div>
              <div className="setup-score"><div><span>SETUP SCORE</span><b>{selected.strength}</b></div><i><b style={{ width: `${selected.strength}%` }} /></i></div>
              <dl>
                <div><dt>관찰 이유</dt><dd>{selected.reason}</dd></div>
                <div><dt>주의 요소</dt><dd>{selected.caution}</dd></div>
                <div className="trigger"><dt>다음 확인 조건</dt><dd>{selected.trigger}</dd></div>
              </dl>
              <p className="detail-note">매수 신호가 아닌 조건 충족 여부를 확인하기 위한 관찰 후보입니다.</p>
            </aside>
          </div>
        </section>

        <section className="section-block" id="liquidity">
          <div className="section-title-row scanner-heading">
            <div><span className="section-index">03</span><div><p>PRICE LEVEL DEPTH MAP</p><h2>주요 매물대 지도</h2></div></div>
            <p>현재가를 가운데 두고 위아래의 <b>주요 가격 구간별 누적 대기 물량</b>을 비교합니다.</p>
          </div>

          <div className="liquidity-shell">
            <div className="liquidity-toolbar">
              <div className="segmented compact" role="tablist" aria-label="코인 선택">
                {(["BTC", "ETH", "SOL"] as const).map((asset) => (
                  <button key={asset} className={liquidityAsset === asset ? "active" : ""} onClick={() => selectLiquidityAsset(asset)}>{asset}</button>
                ))}
              </div>
              <div className="exchange-source"><i />Binance 현물 오더북 <span>5,000호가 · 60초 갱신</span></div>
              <span className={`sample-time ${liquidityStatus}`}>
                {liquidityStatus === "live" ? `LIVE · ${liquidityUpdatedAt}` : liquidityStatus === "loading" ? "연결 중…" : "연결 실패 · 샘플 표시"}
              </span>
            </div>

            <div className="liquidity-grid">
              <article className="orderbook-panel">
                <div className="orderbook-head">
                  <div><span>{liquidity.pair}</span><h3>{liquidity.name} 주요 가격대별 대기 물량</h3></div>
                  <div className="current-quote"><span>현재가</span><b>{liquidity.current}</b></div>
                </div>

                <div className="imbalance-row">
                  <div><span>현재가 아래 물량 우위</span><b>{liquidity.imbalance}</b></div>
                  <div className="balance-track"><i style={{ width: `${liquidity.balance}%` }} /><b style={{ width: `${100 - liquidity.balance}%` }} /></div>
                  <div className="balance-labels"><span>매수 {liquidity.balance}%</span><span>매도 {100 - liquidity.balance}%</span></div>
                </div>

                <div className="orderbook-columns"><span>주요 가격대</span><span>현재가 거리</span><span>누적 대기 물량</span><span>달러 규모</span><span>상대 강도</span></div>
                <div className="wall-ladder">
                  {liquidity.walls.filter((wall) => wall.side === "ask").map((wall) => (
                    <button key={wall.id} className={`wall-row ask ${selectedWall.id === wall.id ? "selected" : ""}`} onClick={() => setSelectedWallId(wall.id)}>
                      <i className="wall-heat" style={{ width: `${wall.strength}%` }} />
                      <span className="wall-price">{wall.price}</span><span>{wall.distance}</span><b>{wall.amount}</b><span>{wall.notional}</span><em>{wall.strength}</em>
                    </button>
                  ))}
                  <div className="live-price-row"><span>현재가</span><b>{liquidity.current}</b><i>LIVE</i></div>
                  {liquidity.walls.filter((wall) => wall.side === "bid").map((wall) => (
                    <button key={wall.id} className={`wall-row bid ${selectedWall.id === wall.id ? "selected" : ""}`} onClick={() => setSelectedWallId(wall.id)}>
                      <i className="wall-heat" style={{ width: `${wall.strength}%` }} />
                      <span className="wall-price">{wall.price}</span><span>{wall.distance}</span><b>{wall.amount}</b><span>{wall.notional}</span><em>{wall.strength}</em>
                    </button>
                  ))}
                </div>
              </article>

              <aside className="wall-analysis">
                <div className="wall-summary-card">
                  <div className="small-heading"><span>매물대 해석</span><b>{liquidityAsset}</b></div>
                  <p>{liquidity.summary}</p>
                  <div className="nearest-walls">
                    <div><span>위쪽 최대 매물대</span><b className="negative">{liquidity.sellWall}</b></div>
                    <div><span>아래쪽 최대 매물대</span><b className="positive">{liquidity.buyWall}</b></div>
                  </div>
                </div>

                <div className={`wall-detail-card ${selectedWall.side}`}>
                  <div className="wall-detail-title"><span>{selectedWall.side === "bid" ? "아래쪽" : "위쪽"} 매물대 상세</span><b>{selectedWall.price}</b></div>
                  <div className="reliability-score"><span>매물대 중요도</span><b>{selectedWall.reliability}<small>/100</small></b></div>
                  <div className="reliability-track"><i style={{ width: `${selectedWall.reliability}%` }} /></div>
                  <dl>
                    <div><dt>집계 가격 범위</dt><dd>{selectedWall.age}</dd></div>
                    <div><dt>현재가와 거리</dt><dd>{selectedWall.distance}</dd></div>
                    <div><dt>달러 규모</dt><dd>{selectedWall.notional}</dd></div>
                    <div><dt>누적 대기 물량</dt><dd>{selectedWall.amount}</dd></div>
                  </dl>
                  <div className="spoof-note">
                    <i>!</i><p><b>표시 기준</b><span>현재 1차 실시간 버전은 Binance 현물 기준입니다. 각 가격 주변 주문을 구간별로 합산하며, 접근 시 취소될 수 있어 실제 체결 흐름도 함께 확인해야 합니다.</span></p>
                  </div>
                </div>
              </aside>
            </div>
          </div>
        </section>

        <section className="section-block" id="scenario">
          <div className="section-title-row">
            <div><span className="section-index">04</span><div><p>NEXT SESSION PLAN</p><h2>다음 거래일 시나리오</h2></div></div>
            <span className="saved-count">★ 관심종목 {watchlist.length}개</span>
          </div>
          <div className="scenario-grid">
            <article><span className="scenario-label green">A · 강세 지속</span><h3>지수보다 주도주 확인</h3><p>반도체 대장주가 시가 이후 VWAP 위를 지키면 눌림 구간을 우선 관찰합니다.</p><b>가능성 45%</b></article>
            <article><span className="scenario-label amber">B · 횡보 소화</span><h3>첫 30분 방향 대기</h3><p>지수는 보합권, 거래대금이 감소하면 돌파보다 박스 상·하단 반응을 확인합니다.</p><b>가능성 35%</b></article>
            <article><span className="scenario-label red">C · 돌파 실패</span><h3>포지션 빠르게 축소</h3><p>전일 저점과 주도주 VWAP가 함께 이탈하면 신규 진입을 멈추고 관망합니다.</p><b>가능성 20%</b></article>
          </div>
        </section>

        <footer>
          <div className="brand footer-brand"><span className="brand-mark"><i /><i /><i /></span><span>MARKET <b>COMPASS</b></span></div>
          <p>국장·미장 가격은 Yahoo Finance, 크립토 가격·매물대는 Binance 현물 데이터를 사용하며 분석 문구는 등락 기반 모델이 자동 생성합니다.</p>
          <span>V0.5 · LIVE DATA, MODEL ANALYSIS</span>
        </footer>
      </div>

      <nav className="mobile-nav" aria-label="모바일 메뉴">
        <a href="#top"><i>⌂</i><span>시장</span></a><a href="#close-brief"><i>◫</i><span>마감</span></a><a href="#scanner"><i>⌁</i><span>탐지</span></a><a href="#liquidity"><i>≋</i><span>매물대</span></a><a href="#scenario"><i>◇</i><span>시나리오</span></a>
      </nav>
      {toast && <div className="toast">✓ 전체 시장 데이터 새로고침 요청</div>}
    </main>
  );
}
