const symbols = {
  kospi: "^KS11",
  kosdaq: "^KQ11",
  nasdaq: "^IXIC",
  sp500: "^GSPC",
  samsung: "005930.KS",
  skhynix: "000660.KS",
  nvda: "NVDA",
  msft: "MSFT",
} as const;

type YahooChart = {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        regularMarketTime?: number;
        currency?: string;
      };
    }>;
  };
};

async function fetchQuote(key: string, symbol: string) {
  const encoded = encodeURIComponent(symbol);
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  let lastError: unknown;

  for (const host of hosts) {
    try {
      const response = await fetch(
        `https://${host}/v8/finance/chart/${encoded}?interval=1d&range=5d`,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0 MarketCompass/1.0",
          },
        },
      );
      if (!response.ok) throw new Error(`Yahoo ${response.status}`);
      const payload = (await response.json()) as YahooChart;
      const meta = payload.chart?.result?.[0]?.meta;
      const price = Number(meta?.regularMarketPrice);
      const previousClose = Number(meta?.chartPreviousClose ?? meta?.previousClose);
      if (!Number.isFinite(price) || !Number.isFinite(previousClose) || previousClose <= 0) {
        throw new Error("Invalid quote payload");
      }
      return {
        key,
        symbol,
        price,
        previousClose,
        change: ((price - previousClose) / previousClose) * 100,
        currency: meta?.currency ?? (symbol.endsWith(".KS") ? "KRW" : "USD"),
        marketTime: meta?.regularMarketTime ?? null,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error(`Quote unavailable: ${symbol}`);
}

export async function GET() {
  const results = await Promise.allSettled(
    Object.entries(symbols).map(([key, symbol]) => fetchQuote(key, symbol)),
  );
  const quotes = Object.fromEntries(
    results
      .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof fetchQuote>>> => result.status === "fulfilled")
      .map((result) => [result.value.key, result.value]),
  );

  if (Object.keys(quotes).length < 4) {
    const failures = results.flatMap((result, index) =>
      result.status === "rejected"
        ? [{ symbol: Object.values(symbols)[index], reason: String(result.reason) }]
        : [],
    );
    return Response.json(
      { error: "Market data is temporarily unavailable", quotes, failures },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json(
    { quotes, updatedAt: new Date().toISOString(), source: "Yahoo Finance" },
    { headers: { "Cache-Control": "public, max-age=60, s-maxage=60" } },
  );
}
