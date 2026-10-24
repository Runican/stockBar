// Run from anywhere: cjs tests/quote.test.js
// Loads quote.js as plain functions. Cinnamon auto-exports those same names.

imports.gi.versions.Gio = "2.0";
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const failures = [];

function check(name, condition) {
    if (!condition) {
        failures.push(name);
        print("FAIL " + name);
    } else {
        print("ok   " + name);
    }
}

function near(actual, expected, epsilon) {
    return typeof actual === "number" && Math.abs(actual - expected) <= epsilon;
}

function readText(path) {
    const file = Gio.File.new_for_path(path);
    const [, contents] = file.load_contents(null);
    if (contents instanceof Uint8Array)
        return new TextDecoder().decode(contents);
    return imports.byteArray.toString(contents);
}

function findRoot() {
    let dir = GLib.get_current_dir();
    while (true) {
        const probe = GLib.build_filenamev([dir, "tests", "quote.test.js"]);
        if (Gio.File.new_for_path(probe).query_exists(null))
            return dir;
        const parent = GLib.path_get_dirname(dir);
        if (!parent || parent === dir)
            break;
        dir = parent;
    }
    throw new Error("Cannot find stockBar tests");
}

function loadQuote(root) {
    const path = GLib.build_filenamev([root, "stockbar@stockbar", "quote.js"]);
    const src = readText(path);
    const load = new Function(src + "\nreturn { parseChart, sparklinePoints, formatPercent, formatPrice, parseSymbolList, extraSymbolCount, percentDirection, seriesDirection, fiveDayPercent, rateLimitNotice, splitCurlStatus, cookieValue, hasSessionCookie, normalizeCrumb, consentFields, chartUrl, parseTickerList: typeof parseTickerList === \"function\" ? parseTickerList : null, isExchangeOpen: typeof isExchangeOpen === \"function\" ? isExchangeOpen : null, symbolsToRequest: typeof symbolsToRequest === \"function\" ? symbolsToRequest : null, exchangeTimeZone: typeof exchangeTimeZone === \"function\" ? exchangeTimeZone : null, retryWhileClosed: typeof retryWhileClosed === \"function\" ? retryWhileClosed : null, refreshDelaySeconds: typeof refreshDelaySeconds === \"function\" ? refreshDelaySeconds : null };");
    return load();
}

const root = findRoot();
const quote = loadQuote(root);
const okChart = JSON.parse(readText(GLib.build_filenamev([root, "tests", "fixtures", "chart-ok.json"])));
const errorChart = JSON.parse(readText(GLib.build_filenamev([root, "tests", "fixtures", "chart-error.json"])));
const nullChart = JSON.parse(readText(GLib.build_filenamev([root, "tests", "fixtures", "chart-null-closes.json"])));

const parsed = quote.parseChart(okChart);
check("success fixture parses", parsed.ok === true);
check("uses the long name", parsed.name === "Apple Inc.");
check("keeps today's percent from the payload", parsed.changePercent === 0.5);
check("does not derive today's move from chartPreviousClose", parsed.changePercent !== ((345.71 - 100) / 100) * 100);
check("dollar change is the regular move implied by the regular percent", near(parsed.change, 345.71 * 0.005 / 1.005, 0.0001));

const postMarket = {
    chart: {
        result: [{
            meta: {
                symbol: "SPCX",
                regularMarketPrice: 144.75,
                regularMarketChange: 3.3,
                regularMarketChangePercent: -9.139,
                previousClose: 141.45,
                chartPreviousClose: 100,
                fulldayPrice: 147.96,
                fulldayChange: 3.3,
                fulldayChangePercent: 2.22,
                priceHint: 2
            },
            indicators: { quote: [{ close: [159.31, 144.75] }] }
        }],
        error: null
    }
};
const postParsed = quote.parseChart(postMarket);
check("post-market price stays the regular close", postParsed.price === 144.75);
check("post-market percent stays the regular session percent", postParsed.changePercent === -9.139);
check("post-market dollar change matches the regular percent", near(postParsed.change, 144.75 * (-9.139 / 100) / (1 - 9.139 / 100), 0.001));
check("post-market dollar change is not the extended-hours move", Math.abs(postParsed.change - 3.3) > 1);

delete postMarket.chart.result[0].meta.regularMarketChangePercent;
postMarket.chart.result[0].meta.previousClose = 159.31;
const fromPrevious = quote.parseChart(postMarket);
check("without a regular percent the dollar change uses the previous close", near(fromPrevious.change, 144.75 - 159.31, 0.001));
check("without a regular percent the extended-hours change is still ignored", Math.abs(fromPrevious.change - 3.3) > 1);
check("drops null closes and keeps order", JSON.stringify(parsed.closes) === JSON.stringify([343.46, 339.5, 343.99, 345.71]));
check("formats today's percent with a sign", quote.formatPercent(parsed.changePercent) === "+0.50%");
check("formats the price with priceHint digits", quote.formatPrice(parsed.price, parsed.priceHint) === "345.71");
check("five-day percent uses the first and last finite close", near(quote.fiveDayPercent(parsed.closes), (345.71 - 343.46) / 343.46 * 100, 0.001));

const broken = quote.parseChart(errorChart);
check("error payload is not ok", broken.ok === false);
check("error payload keeps the description", broken.error === "No data found, symbol may be delisted");

const emptyCloses = quote.parseChart(nullChart);
check("all-null closes become an empty series", emptyCloses.ok === true && emptyCloses.closes.length === 0);
check("missing longName falls back to shortName", emptyCloses.name === "No Closes");

check("negative percent keeps the minus", quote.formatPercent(-0.193) === "-0.19%");
check("zero percent has no plus", quote.formatPercent(0) === "0.00%");
check("missing percent is an em dash", quote.formatPercent(null) === "—");
check("missing price is an em dash", quote.formatPrice(null, 2) === "—");
check("missing price hint uses two digits", quote.formatPrice(1.5, null) === "1.50");

check("up is above half a hundredth of a percent", quote.percentDirection(0.006) === "up");
check("down is below half a hundredth of a percent", quote.percentDirection(-0.006) === "down");
check("a tiny move is flat", quote.percentDirection(0.004) === "flat");
check("series color follows the last close against the first", quote.seriesDirection([10, 1, 11]) === "up");
check("a falling series is down", quote.seriesDirection([11, 20, 9]) === "down");
check("one close has no slope", quote.seriesDirection([4]) === "flat");
check("one close has no five-day percent", quote.fiveDayPercent([4]) === null);

const points = quote.sparklinePoints([1, 3, 2], 48, 16);
check("sparkline has one point per close", points.length === 3);
check("first point sits on the left padding", near(points[0].x, 1, 0.01));
check("last point sits on the right padding", near(points[2].x, 47, 0.01));
check("the highest close is the top of the box", near(points[1].y, 1, 0.01) && points[1].y < points[0].y && points[1].y < points[2].y);

const flat = quote.sparklinePoints([5, 5, 5], 48, 16);
check("a flat series is a mid line", flat.every(point => near(point.y, 8, 0.01)));

const single = quote.sparklinePoints([5], 48, 16);
check("a single close is one centered point", single.length === 1 && near(single[0].x, 24, 0.01) && near(single[0].y, 8, 0.01));
check("no closes draw nothing", quote.sparklinePoints([], 48, 16).length === 0);

const symbols = quote.parseSymbolList(" aapl, msft  MC.PA\nbrk-b ");
check("symbols split on commas and whitespace and upper-case", JSON.stringify(symbols) === JSON.stringify(["AAPL", "MSFT", "MC.PA", "BRK-B"]));
check("duplicate symbols collapse", JSON.stringify(quote.parseSymbolList("AAPL, aapl, MSFT")) === JSON.stringify(["AAPL", "MSFT"]));
check("unsafe tokens are skipped", JSON.stringify(quote.parseSymbolList("AAPL, ../x, MSFT")) === JSON.stringify(["AAPL", "MSFT"]));
const eight = "A,B,C,D,E,F,G,H";
check("only the first six symbols are kept", JSON.stringify(quote.parseSymbolList(eight)) === JSON.stringify(["A", "B", "C", "D", "E", "F"]));
check("extras are counted", quote.extraSymbolCount(eight) === 2);
check("an empty list has no extras", quote.extraSymbolCount(" , ") === 0 && quote.parseSymbolList("").length === 0);
check("a kept quote says the last update is still showing", quote.rateLimitNotice(true) === "Yahoo rate-limited the request. Showing the last update.");
check("a rate limit with no quote does not claim an update is showing", quote.rateLimitNotice(false) === "Yahoo rate-limited the request.");

const curled = quote.splitCurlStatus('{"ok":true}HTTP_CODE=200');
check("curl status splits the body from the trailing code", curled.body === '{"ok":true}' && curled.status === 200);
check("a missing curl status is zero", quote.splitCurlStatus("no marker").status === 0);

const jar = "# Netscape HTTP Cookie File\n#HttpOnly_.yahoo.com\tTRUE\t/\tTRUE\t0\tA1\tsession-token\n.yahoo.com\tTRUE\t/\tFALSE\t0\tGUCS\tyes\n";
check("an HttpOnly cookie is readable", quote.cookieValue(jar, "A1") === "session-token");
check("a normal cookie is readable", quote.cookieValue(jar, "GUCS") === "yes");
check("a missing cookie is null", quote.cookieValue(jar, "B") === null);
check("A1 counts as a Yahoo session", quote.hasSessionCookie(jar) === true);
check("A3 counts as a Yahoo session", quote.hasSessionCookie(".yahoo.com\tTRUE\t/\tTRUE\t0\tA3\tok\n") === true);
check("an empty jar has no session", quote.hasSessionCookie("") === false);

check("a crumb token is kept", quote.normalizeCrumb("  ab.cd12 \n") === "ab.cd12");
check("a json error is not a crumb", quote.normalizeCrumb('{"error":"unauthorized"}') === null);
check("whitespace is not a crumb", quote.normalizeCrumb("not a crumb") === null);

const consentHtml = '<form method="post" action=""><input type="hidden" name="sessionId" value="abc"><input type="hidden" name="csrf" value="z"></form>';
check("consent fields are encoded and rejected", quote.consentFields(consentHtml) === "sessionId=abc&csrf=z&reject=reject");
check("a page without a consent form has no fields", quote.consentFields("<html></html>") === null);

check("the chart url carries the symbol and crumb", quote.chartUrl("BRK-B", "a/b") === "https://query1.finance.yahoo.com/v8/finance/chart/BRK-B?interval=1d&range=5d&crumb=a%2Fb");

function clock(weekday, hour, minute) {
    return { weekday: weekday, minutes: hour * 60 + minute };
}

function listed(text) {
    if (typeof quote.parseTickerList !== "function")
        return null;
    return JSON.stringify(quote.parseTickerList(text));
}

function openAt(exchangeId, weekday, hour, minute) {
    if (typeof quote.isExchangeOpen !== "function")
        return null;
    return quote.isExchangeOpen(exchangeId, clock(weekday, hour, minute));
}

check("a bare ticker uses the USA exchange", listed(" aapl ") === JSON.stringify([{ symbol: "AAPL", exchange: "usa" }]));
check("an exchange suffix is kept separate from the Yahoo symbol", listed("hsba.l@london") === JSON.stringify([{ symbol: "HSBA.L", exchange: "london" }]));
check("the exchange suffix is case-insensitive", listed("7203.T@TOKYO") === JSON.stringify([{ symbol: "7203.T", exchange: "tokyo" }]));
check("an unknown exchange is skipped", listed("AAPL, AAPL@nasdaq, MSFT") === JSON.stringify([{ symbol: "AAPL", exchange: "usa" }, { symbol: "MSFT", exchange: "usa" }]));
check("a suffix with no exchange is skipped", listed("AAPL@, @london, MSFT") === JSON.stringify([{ symbol: "MSFT", exchange: "usa" }]));
check("the first listing of a symbol keeps its exchange", listed("AAPL@london, AAPL") === JSON.stringify([{ symbol: "AAPL", exchange: "london" }]));
check("the symbol list drops the exchange suffix", JSON.stringify(quote.parseSymbolList("AAPL, HSBA.L@london")) === JSON.stringify(["AAPL", "HSBA.L"]));
check("suffixed tickers count toward the six-symbol limit", quote.extraSymbolCount("A@usa,B@london,C,D,E,F,G@tokyo") === 1);
check("only the first six suffixed tickers are kept", listed("A@usa,B@london,C@paris,D@frankfurt,E@tokyo,F@hongkong,G@toronto") === JSON.stringify([
    { symbol: "A", exchange: "usa" },
    { symbol: "B", exchange: "london" },
    { symbol: "C", exchange: "paris" },
    { symbol: "D", exchange: "frankfurt" },
    { symbol: "E", exchange: "tokyo" },
    { symbol: "F", exchange: "hongkong" }
]));

check("USA is open at the opening minute", openAt("usa", 1, 9, 30) === true);
check("USA is closed one minute before the open", openAt("usa", 1, 9, 29) === false);
check("USA is open one minute before the close", openAt("usa", 1, 15, 59) === true);
check("USA is closed at the closing minute", openAt("usa", 1, 16, 0) === false);
check("USA is closed on Saturday", openAt("usa", 6, 12, 0) === false);
check("USA is closed on Sunday", openAt("usa", 7, 12, 0) === false);
check("London is open from 08:00 through 16:29", openAt("london", 2, 8, 0) === true && openAt("london", 2, 16, 29) === true && openAt("london", 2, 16, 30) === false);
check("Paris and Frankfurt share 09:00–17:30", openAt("paris", 3, 9, 0) === true && openAt("paris", 3, 17, 30) === false && openAt("frankfurt", 3, 17, 29) === true);
check("Toronto matches the USA clock", openAt("toronto", 4, 9, 30) === true && openAt("toronto", 4, 16, 0) === false);
check("Tokyo is closed for the lunch break", openAt("tokyo", 5, 11, 29) === true && openAt("tokyo", 5, 11, 30) === false && openAt("tokyo", 5, 12, 29) === false && openAt("tokyo", 5, 12, 30) === true && openAt("tokyo", 5, 15, 0) === false);
check("Hong Kong is closed for the lunch break", openAt("hongkong", 1, 11, 59) === true && openAt("hongkong", 1, 12, 0) === false && openAt("hongkong", 1, 12, 59) === false && openAt("hongkong", 1, 13, 0) === true && openAt("hongkong", 1, 16, 0) === false);
check("an unknown exchange is never open", openAt("nasdaq", 1, 12, 0) === false);
check("a missing local time is closed", typeof quote.isExchangeOpen === "function" && quote.isExchangeOpen("usa", null) === false);

const mixed = [
    { symbol: "AAPL", exchange: "usa" },
    { symbol: "HSBA.L", exchange: "london" }
];
function mixedClock(exchangeId) {
    if (exchangeId === "usa")
        return clock(6, 12, 0);
    if (exchangeId === "london")
        return clock(1, 9, 0);
    return null;
}
function requested(tickers, localFor, fetchWhileClosed) {
    if (typeof quote.symbolsToRequest !== "function")
        return null;
    return JSON.stringify(quote.symbolsToRequest(tickers, localFor, fetchWhileClosed));
}

check("a scheduled refresh requests only open exchanges", requested(mixed, mixedClock, false) === JSON.stringify(["HSBA.L"]));
check("startup requests every ticker while the exchanges are closed", requested(mixed, mixedClock, true) === JSON.stringify(["AAPL", "HSBA.L"]));
check("a ticker with no local time is skipped unless this is startup", requested([{ symbol: "AAPL", exchange: "usa" }], () => null, false) === JSON.stringify([]) && requested([{ symbol: "AAPL", exchange: "usa" }], () => null, true) === JSON.stringify(["AAPL"]));

check("each exchange names its timezone", typeof quote.exchangeTimeZone === "function" && quote.exchangeTimeZone("usa") === "America/New_York" && quote.exchangeTimeZone("london") === "Europe/London" && quote.exchangeTimeZone("paris") === "Europe/Paris" && quote.exchangeTimeZone("frankfurt") === "Europe/Berlin" && quote.exchangeTimeZone("tokyo") === "Asia/Tokyo" && quote.exchangeTimeZone("hongkong") === "Asia/Hong_Kong" && quote.exchangeTimeZone("toronto") === "America/Toronto" && quote.exchangeTimeZone("nasdaq") === null);

function closedRetry(attemptedWhileClosed, statuses) {
    if (typeof quote.retryWhileClosed !== "function")
        return null;
    return quote.retryWhileClosed(attemptedWhileClosed, statuses);
}

function delaySeconds(intervalMinutes, rateLimited, waitingForResponse, networkBecameAvailable) {
    if (typeof quote.refreshDelaySeconds !== "function")
        return null;
    return quote.refreshDelaySeconds(intervalMinutes, rateLimited, waitingForResponse, networkBecameAvailable);
}

const noResponse = quote.splitCurlStatus("HTTP_CODE=000");
check("curl reports no HTTP response as status zero", noResponse.status === 0 && noResponse.body === "");
check("a closed-market attempt with no HTTP response is retried", closedRetry(true, [noResponse.status]) === true);
check("one unanswered ticker keeps the closed-market retry", closedRetry(true, [200, 0]) === true);
check("a closed-market attempt that got HTTP statuses is not retried", closedRetry(true, [200, 429, 404]) === false);
check("an open-session failure does not start closed-market retries", closedRetry(false, [0]) === false);
check("a closed-market attempt that sent nothing is not retried", closedRetry(true, []) === false && closedRetry(true, null) === false);
check("an unanswered retry waits 30 seconds", delaySeconds(5, false, true, false) === 30);
check("a network that just became available retries in 1 second", delaySeconds(5, false, true, true) === 1);
check("a network signal does not shorten an ordinary refresh", delaySeconds(5, false, false, true) === 300);
check("a rate limit still waits at least 10 minutes while a response is missing", delaySeconds(5, true, true, true) === 600);
check("a rate limit above 10 minutes keeps the configured interval", delaySeconds(60, true, false, false) === 3600);
check("an ordinary refresh waits the configured interval", delaySeconds(5, false, false, false) === 300);
check("a missing interval waits 5 minutes", delaySeconds(undefined, false, false, false) === 300);

if (failures.length) {
    print(failures.length + " failed");
    imports.system.exit(1);
}
print("all passed");
