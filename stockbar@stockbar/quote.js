// Plain functions. Cinnamon's applet loader exports each top-level name.
// No imports: the unit test evaluates this file outside Cinnamon.

const MAX_SYMBOLS = 6;
const SYMBOL_PATTERN = /^[A-Z0-9.^=-]{1,24}$/;
const FLAT_BAND = 0.005;
const EXCHANGES = {
    usa: { timeZone: "America/New_York", sessions: [[9 * 60 + 30, 16 * 60]] },
    london: { timeZone: "Europe/London", sessions: [[8 * 60, 16 * 60 + 30]] },
    paris: { timeZone: "Europe/Paris", sessions: [[9 * 60, 17 * 60 + 30]] },
    frankfurt: { timeZone: "Europe/Berlin", sessions: [[9 * 60, 17 * 60 + 30]] },
    tokyo: { timeZone: "Asia/Tokyo", sessions: [[9 * 60, 11 * 60 + 30], [12 * 60 + 30, 15 * 60]] },
    hongkong: { timeZone: "Asia/Hong_Kong", sessions: [[9 * 60 + 30, 12 * 60], [13 * 60, 16 * 60]] },
    toronto: { timeZone: "America/Toronto", sessions: [[9 * 60 + 30, 16 * 60]] }
};

function finiteNumber(value) {
    return typeof value === "number" && isFinite(value) ? value : null;
}

function normalizedTickers(text) {
    if (typeof text !== "string")
        return [];
    const seen = {};
    const tickers = [];
    const parts = text.split(/[\s,]+/);
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part)
            continue;
        const at = part.lastIndexOf("@");
        let symbol;
        let exchange = "usa";
        if (at >= 0) {
            symbol = part.slice(0, at).toUpperCase();
            exchange = part.slice(at + 1).toLowerCase();
            if (!EXCHANGES[exchange])
                continue;
        } else {
            symbol = part.toUpperCase();
        }
        if (!symbol || seen[symbol] || !SYMBOL_PATTERN.test(symbol))
            continue;
        seen[symbol] = true;
        tickers.push({ symbol: symbol, exchange: exchange });
    }
    return tickers;
}

function parseTickerList(text) {
    return normalizedTickers(text).slice(0, MAX_SYMBOLS);
}

function parseSymbolList(text) {
    const tickers = parseTickerList(text);
    const symbols = [];
    for (let i = 0; i < tickers.length; i++)
        symbols.push(tickers[i].symbol);
    return symbols;
}

function extraSymbolCount(text) {
    return Math.max(0, normalizedTickers(text).length - MAX_SYMBOLS);
}

function exchangeTimeZone(exchangeId) {
    const exchange = EXCHANGES[exchangeId];
    return exchange ? exchange.timeZone : null;
}

function isExchangeOpen(exchangeId, local) {
    const exchange = EXCHANGES[exchangeId];
    if (!exchange || !local)
        return false;
    const weekday = local.weekday;
    const minute = local.minutes;
    if (typeof weekday !== "number" || weekday < 1 || weekday > 5)
        return false;
    if (typeof minute !== "number" || !isFinite(minute))
        return false;
    const sessions = exchange.sessions;
    for (let i = 0; i < sessions.length; i++) {
        if (minute >= sessions[i][0] && minute < sessions[i][1])
            return true;
    }
    return false;
}

function symbolsToRequest(tickers, localFor, fetchWhileClosed) {
    const symbols = [];
    if (!tickers)
        return symbols;
    for (let i = 0; i < tickers.length; i++) {
        const ticker = tickers[i];
        if (!ticker || !ticker.symbol)
            continue;
        if (fetchWhileClosed) {
            symbols.push(ticker.symbol);
            continue;
        }
        const local = localFor ? localFor(ticker.exchange) : null;
        if (isExchangeOpen(ticker.exchange, local))
            symbols.push(ticker.symbol);
    }
    return symbols;
}

function retryWhileClosed(attemptedWhileClosed, statuses) {
    if (attemptedWhileClosed !== true || !statuses)
        return false;
    for (let i = 0; i < statuses.length; i++) {
        const status = statuses[i];
        if (typeof status !== "number" || !isFinite(status) || status <= 0)
            return true;
    }
    return false;
}

function refreshDelaySeconds(intervalMinutes, rateLimited, waitingForResponse, networkBecameAvailable) {
    const interval = Math.max(1, Number(intervalMinutes) || 5) * 60;
    if (rateLimited)
        return Math.max(interval, 10 * 60);
    if (waitingForResponse && networkBecameAvailable === true)
        return 1;
    if (waitingForResponse)
        return 30;
    return interval;
}

function rateLimitNotice(keptStale) {
    return keptStale
        ? "Yahoo rate-limited the request. Showing the last update."
        : "Yahoo rate-limited the request.";
}

function splitCurlStatus(stdout) {
    const text = typeof stdout === "string" ? stdout : "";
    const marker = "HTTP_CODE=";
    const at = text.lastIndexOf(marker);
    if (at < 0)
        return { body: text, status: 0 };
    const status = parseInt(text.slice(at + marker.length), 10);
    return {
        body: text.slice(0, at),
        status: isFinite(status) ? status : 0
    };
}

function hasSessionCookie(jarText) {
    return cookieValue(jarText, "A1") !== null || cookieValue(jarText, "A3") !== null;
}

function cookieValue(jarText, name) {
    if (typeof jarText !== "string")
        return null;
    const lines = jarText.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.indexOf("\t") < 0)
            continue;
        const parts = line.split("\t");
        if (parts.length >= 7 && parts[5] === name && parts[6])
            return parts[6];
    }
    return null;
}

function normalizeCrumb(body) {
    if (typeof body !== "string")
        return null;
    const crumb = body.trim();
    if (!crumb || crumb.length > 128 || /\s/.test(crumb))
        return null;
    if (crumb.charAt(0) === "<" || crumb.charAt(0) === "{")
        return null;
    return crumb;
}

function consentFields(html) {
    if (typeof html !== "string" || !/<form method="post"[\s\S]*action="">/.test(html))
        return null;
    const pattern = /<input type="hidden" name="(.*?)" value="(.*?)">/g;
    const fields = [];
    let match;
    while (fields.length < 20 && (match = pattern.exec(html)) !== null)
        fields.push(encodeURIComponent(match[1]) + "=" + encodeURIComponent(match[2]));
    if (fields.length === 0)
        return null;
    fields.push("reject=reject");
    return fields.join("&");
}

function chartUrl(symbol, crumb) {
    return "https://query1.finance.yahoo.com/v8/finance/chart/" +
        encodeURIComponent(symbol) +
        "?interval=1d&range=5d&crumb=" + encodeURIComponent(crumb);
}

function regularSessionChange(meta) {
    const price = finiteNumber(meta.regularMarketPrice);
    const percent = finiteNumber(meta.regularMarketChangePercent);
    if (price !== null && percent !== null) {
        const ratio = percent / 100;
        if (ratio !== -1)
            return price * ratio / (1 + ratio);
    }
    const previous = finiteNumber(meta.previousClose);
    if (price !== null && previous !== null)
        return price - previous;
    return null;
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
        change: regularSessionChange(meta),
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
