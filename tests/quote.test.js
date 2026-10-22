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
    const load = new Function(src + "\nreturn { parseChart, sparklinePoints, formatPercent, formatPrice, parseSymbolList, extraSymbolCount, percentDirection, seriesDirection, fiveDayPercent, rateLimitNotice };");
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

if (failures.length) {
    print(failures.length + " failed");
    imports.system.exit(1);
}
print("all passed");
