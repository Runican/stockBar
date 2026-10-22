// Plain functions. Cinnamon's applet loader exports each top-level name.
// No imports: the unit test evaluates this file outside Cinnamon.

const MAX_SYMBOLS = 6;
const SYMBOL_PATTERN = /^[A-Z0-9.^=-]{1,24}$/;
const FLAT_BAND = 0.005;

function finiteNumber(value) {
    return typeof value === "number" && isFinite(value) ? value : null;
}

function normalizedSymbols(text) {
    if (typeof text !== "string")
        return [];
    const seen = {};
    const symbols = [];
    const parts = text.toUpperCase().split(/[\s,]+/);
    for (let i = 0; i < parts.length; i++) {
        const symbol = parts[i];
        if (!symbol || seen[symbol] || !SYMBOL_PATTERN.test(symbol))
            continue;
        seen[symbol] = true;
        symbols.push(symbol);
    }
    return symbols;
}

function parseSymbolList(text) {
    return normalizedSymbols(text).slice(0, MAX_SYMBOLS);
}

function extraSymbolCount(text) {
    return Math.max(0, normalizedSymbols(text).length - MAX_SYMBOLS);
}

function rateLimitNotice(keptStale) {
    return keptStale
        ? "Yahoo rate-limited the request. Showing the last update."
        : "Yahoo rate-limited the request.";
}

function parseChart(json) {
    const chart = json && json.chart;
    const result = chart && chart.result && chart.result[0];
    if (!result) {
        const error = chart && chart.error;
        const description = error && (error.description || error.code);
        return { ok: false, error: description || "empty response" };
    }

    const meta = result.meta || {};
    const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
    const rawCloses = quote && Array.isArray(quote.close) ? quote.close : [];
    const closes = [];
    for (let i = 0; i < rawCloses.length; i++) {
        const close = finiteNumber(rawCloses[i]);
        if (close !== null)
            closes.push(close);
    }

    const priceHint = Number.isInteger(meta.priceHint) ? meta.priceHint : null;
    return {
        ok: true,
        symbol: meta.symbol || "",
        name: meta.longName || meta.shortName || meta.symbol || "",
        currency: meta.currency || "",
        price: finiteNumber(meta.regularMarketPrice),
        priceHint: priceHint,
        changePercent: finiteNumber(meta.regularMarketChangePercent),
        change: finiteNumber(meta.fulldayChange),
        dayHigh: finiteNumber(meta.regularMarketDayHigh),
        dayLow: finiteNumber(meta.regularMarketDayLow),
        closes: closes
    };
}

function formatPercent(percentPoints) {
    if (finiteNumber(percentPoints) === null)
        return "—";
    const sign = percentPoints > 0 ? "+" : "";
    return sign + percentPoints.toFixed(2) + "%";
}

function formatPrice(price, priceHint) {
    if (finiteNumber(price) === null)
        return "—";
    const digits = Number.isInteger(priceHint) && priceHint >= 0 && priceHint <= 8 ? priceHint : 2;
    return price.toFixed(digits);
}

function percentDirection(percentPoints) {
    if (finiteNumber(percentPoints) === null)
        return "flat";
    if (percentPoints > FLAT_BAND)
        return "up";
    if (percentPoints < -FLAT_BAND)
        return "down";
    return "flat";
}

function seriesDirection(closes) {
    if (!closes || closes.length < 2)
        return "flat";
    const first = closes[0];
    const last = closes[closes.length - 1];
    if (last > first)
        return "up";
    if (last < first)
        return "down";
    return "flat";
}

function fiveDayPercent(closes) {
    if (!closes || closes.length < 2 || !closes[0])
        return null;
    return (closes[closes.length - 1] - closes[0]) / closes[0] * 100;
}

function sparklinePoints(closes, width, height) {
    if (!closes || closes.length === 0)
        return [];

    const pad = 1;
    const innerW = Math.max(1, width - pad * 2);
    const innerH = Math.max(1, height - pad * 2);
    let min = closes[0];
    let max = closes[0];
    for (let i = 1; i < closes.length; i++) {
        if (closes[i] < min)
            min = closes[i];
        if (closes[i] > max)
            max = closes[i];
    }
    const span = max - min;

    const points = [];
    for (let i = 0; i < closes.length; i++) {
        const x = closes.length === 1 ? pad + innerW / 2 : pad + (i / (closes.length - 1)) * innerW;
        const y = span === 0 ? pad + innerH / 2 : pad + (1 - (closes[i] - min) / span) * innerH;
        points.push({ x: x, y: y });
    }
    return points;
}
