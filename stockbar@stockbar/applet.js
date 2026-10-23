const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Tooltips = imports.ui.tooltips;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const Quote = require("./quote");

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
const CURL = "/usr/bin/curl";
const SPARK_WIDTH = 52;
const RATE_LIMIT_SECONDS = 10 * 60;
const CURL_CIPHERS = "TLS_AES_128_GCM_SHA256,TLS_AES_256_GCM_SHA384,TLS_CHACHA20_POLY1305_SHA256," +
    "TLS_AES_128_CCM_SHA256,TLS_AES_128_CCM_8_SHA256,ECDHE-ECDSA-AES128-GCM-SHA256," +
    "ECDHE-RSA-AES128-GCM-SHA256,ECDHE-ECDSA-AES256-GCM-SHA384,ECDHE-RSA-AES256-GCM-SHA384," +
    "ECDHE-ECDSA-CHACHA20-POLY1305,ECDHE-RSA-CHACHA20-POLY1305,ECDHE-ECDSA-AES128-SHA256," +
    "ECDHE-RSA-AES128-SHA256,ECDHE-ECDSA-AES128-SHA,ECDHE-RSA-AES128-SHA," +
    "ECDHE-ECDSA-AES256-SHA384,ECDHE-RSA-AES256-SHA384,ECDHE-ECDSA-AES256-SHA," +
    "ECDHE-RSA-AES256-SHA,AES128-GCM-SHA256,AES256-GCM-SHA384";
const COOKIE_PAGE = "https://finance.yahoo.com/quote/%5EGSPC/options";
const SEED_URL = "https://fc.yahoo.com";
const CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const CONSENT_URL = "https://consent.yahoo.com/v2/collectConsent";

function formatSigned(value, priceHint) {
    const number = Quote.formatPrice(value === null ? null : Math.abs(value), priceHint);
    if (number === "—")
        return "";
    if (value > 0)
        return "+" + number;
    if (value < 0)
        return "-" + number;
    return number;
}

class StockBarApplet extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.actor.add_style_class_name("stockbar-row");

        this._panelHeightHint = panelHeight;
        this._removed = false;
        this._timer = 0;
        this._cancellable = null;
        this._pending = 0;
        this._rateLimited = false;
        this._rowKey = null;
        this._rows = [];
        this._rowsBySymbol = {};
        this._quotes = {};
        this._placeholder = null;
        this._lastNote = "";
        this._generation = 0;
        this._authRetried = false;
        this._active = [];
        this._crumb = "";
        this._prepareCache();

        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menuManager.addMenu(this.menu);

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.settings.bind("symbols", "symbols", this._onSettingsChanged.bind(this));
        this.settings.bind("refresh-interval", "refresh_interval", this._onSettingsChanged.bind(this));

        this._refresh(true);
    }

    on_applet_clicked() {
        this._openMenu();
    }

    on_orientation_changed() {
        this._syncLayout();
    }

    on_panel_height_changed() {
        this._syncLayout();
    }

    on_applet_removed_from_panel() {
        this._removed = true;
        this._clearTimer();
        this._stopActive();
        this._clearRows();
        this.settings.finalize();
    }

    _onSettingsChanged() {
        if (!this._removed)
            this._refresh(true);
    }

    _isHorizontal() {
        return this.orientation == St.Side.TOP || this.orientation == St.Side.BOTTOM ||
            this._orientation == St.Side.TOP || this._orientation == St.Side.BOTTOM;
    }

    _sparkHeight() {
        let height = this._panelHeightHint || 40;
        if (this.panel && this.panel.height)
            height = this.panel.height;
        return Math.max(14, height - 18);
    }

    _prepareCache() {
        this._cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), "stockbar@stockbar"]);
        GLib.mkdir_with_parents(this._cacheDir, 0o700);
        this._cookieJar = GLib.build_filenamev([this._cacheDir, "cookies.txt"]);
        this._crumbPath = GLib.build_filenamev([this._cacheDir, "crumb"]);
        const saved = Quote.normalizeCrumb(this._readText(this._crumbPath));
        if (saved && Quote.hasSessionCookie(this._readText(this._cookieJar)))
            this._crumb = saved;
    }

    _readText(path) {
        try {
            const file = Gio.File.new_for_path(path);
            if (!file.query_exists(null))
                return "";
            const [, contents] = file.load_contents(null);
            if (contents instanceof Uint8Array)
                return new TextDecoder("utf-8").decode(contents);
            return imports.byteArray.toString(contents);
        } catch (e) {
            return "";
        }
    }

    _writeText(path, text) {
        try {
            GLib.file_set_contents(path, text);
        } catch (e) {
            global.log("stockbar@stockbar: could not write " + path);
        }
    }

    _stopActive() {
        this._generation += 1;
        if (this._cancellable)
            this._cancellable.cancel();
        for (let i = 0; i < this._active.length; i++) {
            try {
                this._active[i].force_exit();
            } catch (e) {
                // The process may already have exited.
            }
        }
        this._active = [];
        this._cancellable = new Gio.Cancellable();
    }

    _exchangeLocal(exchangeId) {
        const zone = Quote.exchangeTimeZone(exchangeId);
        if (!zone)
            return null;
        try {
            const now = GLib.DateTime.new_now(GLib.TimeZone.new(zone));
            if (!now)
                return null;
            return {
                weekday: now.get_day_of_week(),
                minutes: now.get_hour() * 60 + now.get_minute()
            };
        } catch (e) {
            return null;
        }
    }

    _refresh(fetchWhileClosed) {
        if (this._removed)
            return;
        this._clearTimer();
        this._stopActive();
        const generation = this._generation;
        const tickers = Quote.parseTickerList(this.symbols || "");
        const symbols = [];
        for (let i = 0; i < tickers.length; i++)
            symbols.push(tickers[i].symbol);
        this._ensureRows(symbols);
        this._rateLimited = false;
        this._authRetried = false;
        this._pending = 0;
        const requested = Quote.symbolsToRequest(
            tickers,
            (exchangeId) => this._exchangeLocal(exchangeId),
            fetchWhileClosed === true);
        this._requested = requested;
        if (requested.length === 0) {
            this._finishRefresh();
            return;
        }
        if (!GLib.file_test(CURL, GLib.FileTest.IS_EXECUTABLE)) {
            this._failAll("curl is not installed");
            return;
        }
        this._ensureAuth(generation, (ok, error) => {
            if (this._removed || generation !== this._generation)
                return;
            if (!ok) {
                this._failAll(error || "Could not sign in to Yahoo");
                return;
            }
            this._pending = requested.length;
            for (let i = 0; i < requested.length; i++)
                this._fetchChart(requested[i], generation);
        });
    }

    _ensureAuth(generation, done) {
        if (this._crumb && Quote.hasSessionCookie(this._readText(this._cookieJar))) {
            done(true);
            return;
        }
        this._crumb = "";
        this._runCurl(generation, [SEED_URL], () => {
            if (this._removed || generation !== this._generation)
                return;
            this._runCurl(generation, [
                "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                COOKIE_PAGE
            ], (status, body) => {
                if (this._removed || generation !== this._generation)
                    return;
                if (Quote.hasSessionCookie(this._readText(this._cookieJar))) {
                    this._fetchCrumb(generation, done);
                    return;
                }
                const fields = Quote.consentFields(body);
                if (!fields) {
                    done(false, status ? "Yahoo did not send a session cookie (HTTP " + status + ")" : "Yahoo did not send a session cookie");
                    return;
                }
                this._runCurl(generation, [
                    "-X", "POST",
                    "--data", fields,
                    "-H", "Content-Type: application/x-www-form-urlencoded",
                    "-H", "Accept: text/html,application/xhtml+xml",
                    CONSENT_URL
                ], () => {
                    if (this._removed || generation !== this._generation)
                        return;
                    if (!Quote.hasSessionCookie(this._readText(this._cookieJar))) {
                        done(false, "Yahoo consent did not return a session cookie");
                        return;
                    }
                    this._fetchCrumb(generation, done);
                });
            });
        });
    }

    _fetchCrumb(generation, done) {
        this._runCurl(generation, ["-H", "Accept: */*", CRUMB_URL], (status, body) => {
            if (this._removed || generation !== this._generation)
                return;
            const crumb = status === 200 ? Quote.normalizeCrumb(body) : null;
            if (!crumb) {
                done(false, "Could not get a Yahoo crumb" + (status ? " (HTTP " + status + ")" : ""));
                return;
            }
            this._crumb = crumb;
            this._writeText(this._crumbPath, crumb);
            done(true);
        });
    }

    _fetchChart(symbol, generation) {
        this._runCurl(generation, [
            "-H", "Accept: application/json",
            Quote.chartUrl(symbol, this._crumb)
        ], (status, body) => {
            if (this._removed || generation !== this._generation)
                return;
            if ((status === 401 || status === 403) && !this._authRetried) {
                this._authRetried = true;
                this._crumb = "";
                this._writeText(this._crumbPath, "");
                const next = ++this._generation;
                const again = (this._requested || []).slice();
                this._ensureAuth(next, (ok, error) => {
                    if (this._removed || next !== this._generation)
                        return;
                    if (!ok) {
                        this._failAll(error || "Could not sign in to Yahoo");
                        return;
                    }
                    this._pending = again.length;
                    for (let i = 0; i < again.length; i++)
                        this._fetchChart(again[i], next);
                });
                return;
            }
            if (status === 429) {
                this._rateLimited = true;
                this._storeFailure(symbol, "Yahoo rate-limited the request", true);
            } else if (status !== 200) {
                this._storeFailure(symbol, status ? "HTTP " + status : "Quote request failed", false);
            } else {
                try {
                    const parsed = Quote.parseChart(JSON.parse(body));
                    if (!parsed.ok)
                        this._storeFailure(symbol, parsed.error || "No quote", false);
                    else {
                        this._quotes[symbol] = { parsed: parsed, error: null, rateLimited: false };
                        this._paintRow(symbol);
                    }
                } catch (e) {
                    this._storeFailure(symbol, "Quote response was not valid", false);
                }
            }
            this._fetchDone();
        });
    }

    _runCurl(generation, extraArgs, callback) {
        const argv = [
            CURL, "-sSL",
            "--connect-timeout", "5",
            "-m", "15",
            "-w", "HTTP_CODE=%{http_code}",
            "--ciphers", CURL_CIPHERS,
            "-A", USER_AGENT,
            "-b", this._cookieJar,
            "-c", this._cookieJar
        ].concat(extraArgs);
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            callback(0, "");
            return;
        }
        this._active.push(proc);
        const cancellable = this._cancellable;
        proc.communicate_utf8_async(null, cancellable, (source, result) => {
            const index = this._active.indexOf(proc);
            if (index >= 0)
                this._active.splice(index, 1);
            if (this._removed || generation !== this._generation || cancellable !== this._cancellable)
                return;
            try {
                const [, stdout] = source.communicate_utf8_finish(result);
                const split = Quote.splitCurlStatus(stdout || "");
                callback(split.status, split.body);
            } catch (e) {
                if (e.matches && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                callback(0, "");
            }
        });
    }

    _failAll(message) {
        const symbols = this._requested || [];
        for (let i = 0; i < symbols.length; i++)
            this._storeFailure(symbols[i], message, false);
        this._pending = 0;
        this._finishRefresh();
    }

    _storeFailure(symbol, message, rateLimited) {
        const previous = this._quotes[symbol];
        const keep = previous && previous.parsed && previous.parsed.ok ? previous.parsed : null;
        this._quotes[symbol] = {
            parsed: keep,
            error: message,
            rateLimited: rateLimited
        };
        this._note(symbol, message);
        this._paintRow(symbol);
    }

    _fetchDone() {
        this._pending -= 1;
        if (this._pending <= 0)
            this._finishRefresh();
    }

    _finishRefresh() {
        this._updateAppletTooltip();
        const interval = Math.max(1, Number(this.refresh_interval) || 5) * 60;
        const delay = this._rateLimited ? Math.max(interval, RATE_LIMIT_SECONDS) : interval;
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timer = 0;
            this._refresh(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearTimer() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
    }

    _note(symbol, message) {
        const line = symbol + ": " + message;
        if (this._lastNote === line)
            return;
        this._lastNote = line;
        global.log("stockbar@stockbar: " + line);
    }

    _ensureRows(symbols) {
        const key = symbols.join(",");
        if (key === this._rowKey)
            return;
        this._rowKey = key;
        this._clearRows();
        if (symbols.length === 0) {
            this._placeholder = new St.Label({ text: "Stocks", style_class: "stockbar-symbol" });
            this.actor.add(this._placeholder, { y_align: St.Align.MIDDLE });
            return;
        }
        for (let i = 0; i < symbols.length; i++)
            this._addRow(symbols[i]);
    }

    _addRow(symbol) {
        const box = new St.BoxLayout({
            style_class: "stockbar-ticker",
            reactive: true,
            track_hover: true
        });
        const symbolLabel = new St.Label({ text: symbol, style_class: "stockbar-symbol" });
        const priceLabel = new St.Label({ text: "—", style_class: "stockbar-price" });
        const changeLabel = new St.Label({ text: "—", style_class: "stockbar-change stockbar-flat" });
        const percentLabel = new St.Label({ text: "—", style_class: "stockbar-percent stockbar-flat" });
        const spark = new St.DrawingArea({
            style_class: "stockbar-spark stockbar-spark-flat",
            reactive: false
        });
        const nameCol = new St.BoxLayout({ vertical: true, style_class: "stockbar-col" });
        const moveCol = new St.BoxLayout({ vertical: true, style_class: "stockbar-col" });
        nameCol.add(symbolLabel, { x_align: St.Align.START, x_fill: false });
        nameCol.add(priceLabel, { x_align: St.Align.START, x_fill: false });
        moveCol.add(changeLabel, { x_align: St.Align.END, x_fill: false, x_expand: true });
        moveCol.add(percentLabel, { x_align: St.Align.END, x_fill: false, x_expand: true });
        box.add(nameCol, { y_align: St.Align.MIDDLE, y_fill: false });
        box.add(moveCol, { y_align: St.Align.MIDDLE, y_fill: false });
        box.add(spark, { y_align: St.Align.MIDDLE, y_fill: false, x_fill: false });
        this.actor.add(box, { y_align: St.Align.MIDDLE });

        const row = {
            symbol: symbol,
            box: box,
            symbolLabel: symbolLabel,
            priceLabel: priceLabel,
            changeLabel: changeLabel,
            percentLabel: percentLabel,
            spark: spark,
            tooltip: new Tooltips.PanelItemTooltip({ actor: box, _applet: this }, symbol, this._orientation),
            closes: [],
            sparkDirection: "flat"
        };
        spark.connect("repaint", (area) => this._onRepaint(row, area));
        box.connect("button-press-event", (actor, event) => {
            if (event.get_button() === 1) {
                this._openMenu();
                return true;
            }
            return false;
        });

        this._rows.push(row);
        this._rowsBySymbol[symbol] = row;
        this._paintRow(symbol);
    }

    _clearRows() {
        for (let i = 0; i < this._rows.length; i++) {
            this._rows[i].tooltip.destroy();
            this._rows[i].box.destroy();
        }
        this._rows = [];
        this._rowsBySymbol = {};
        if (this._placeholder) {
            this._placeholder.destroy();
            this._placeholder = null;
        }
    }

    _paintRow(symbol) {
        const row = this._rowsBySymbol[symbol];
        if (!row)
            return;
        const state = this._quotes[symbol];
        const quote = state && state.parsed && state.parsed.ok ? state.parsed : null;
        row.symbolLabel.set_text(symbol);
        if (!quote) {
            row.priceLabel.set_text("—");
            row.changeLabel.set_text("—");
            row.percentLabel.set_text("—");
            this._setDirectionClass(row.changeLabel, "stockbar-", "flat");
            this._setDirectionClass(row.percentLabel, "stockbar-", "flat");
            row.closes = [];
            row.sparkDirection = "flat";
        } else {
            const direction = Quote.percentDirection(quote.changePercent);
            const signed = formatSigned(quote.change, quote.priceHint);
            row.priceLabel.set_text(Quote.formatPrice(quote.price, quote.priceHint));
            row.changeLabel.set_text(signed || "—");
            row.percentLabel.set_text(Quote.formatPercent(quote.changePercent));
            this._setDirectionClass(row.changeLabel, "stockbar-", direction);
            this._setDirectionClass(row.percentLabel, "stockbar-", direction);
            row.closes = quote.closes;
            row.sparkDirection = Quote.seriesDirection(quote.closes);
        }
        this._setDirectionClass(row.spark, "stockbar-spark-", row.sparkDirection);
        row.tooltip.set_text(this._tooltipFor(symbol));
        this._layoutSpark(row);
    }

    _tooltipFor(symbol) {
        const state = this._quotes[symbol];
        const quote = state && state.parsed && state.parsed.ok ? state.parsed : null;
        let text = symbol;
        if (quote) {
            text = quote.name + " · " + Quote.formatPrice(quote.price, quote.priceHint);
            if (quote.currency)
                text += " " + quote.currency;
        }
        if (state && state.rateLimited) {
            text += quote
                ? "\nYahoo rate-limited the request. Showing the last update."
                : "\nYahoo rate-limited the request.";
        } else if (state && state.error) {
            text += quote
                ? "\nUpdate failed. Showing the last quote."
                : "\n" + state.error;
        }
        return text;
    }

    _setDirectionClass(actor, prefix, direction) {
        actor.remove_style_class_name(prefix + "up");
        actor.remove_style_class_name(prefix + "down");
        actor.remove_style_class_name(prefix + "flat");
        actor.add_style_class_name(prefix + direction);
    }

    _layoutSpark(row) {
        const show = this._isHorizontal() && row.closes && row.closes.length > 0;
        row.box.set_vertical(!this._isHorizontal());
        if (!show) {
            row.spark.hide();
            return;
        }
        row.spark.show();
        row.spark.set_size(SPARK_WIDTH, this._sparkHeight());
        row.spark.queue_repaint();
    }

    _syncLayout() {
        for (let i = 0; i < this._rows.length; i++)
            this._layoutSpark(this._rows[i]);
    }

    _onRepaint(row, area) {
        const cr = area.get_context();
        try {
            const width = area.get_width() || SPARK_WIDTH;
            const height = area.get_height() || this._sparkHeight();
            const points = Quote.sparklinePoints(row.closes, width, height);
            if (points.length === 0)
                return;
            Clutter.cairo_set_source_color(cr, this._sparkColor(area, row.sparkDirection));
            cr.setLineWidth(1.5);
            cr.setLineCap(imports.cairo.LineCap.ROUND);
            cr.setLineJoin(imports.cairo.LineJoin.ROUND);
            if (points.length === 1) {
                cr.moveTo(points[0].x - 3, points[0].y);
                cr.lineTo(points[0].x + 3, points[0].y);
            } else {
                cr.moveTo(points[0].x, points[0].y);
                for (let i = 1; i < points.length; i++)
                    cr.lineTo(points[i].x, points[i].y);
            }
            cr.stroke();
        } finally {
            cr.$dispose();
        }
    }

    _sparkColor(area, direction) {
        const node = area.get_theme_node();
        if (direction !== "flat") {
            const [ok, color] = node.lookup_color("-spark-color", false);
            if (ok)
                return color;
            const hex = direction === "down" ? "#FF6B81" : "#3DDC97";
            return Clutter.color_from_string(hex)[1];
        }
        return node.get_foreground_color();
    }

    _updateAppletTooltip() {
        const parts = [];
        const symbols = Quote.parseSymbolList(this.symbols || "");
        let keptStale = false;
        for (let i = 0; i < symbols.length; i++) {
            const state = this._quotes[symbols[i]];
            if (state && state.rateLimited && state.parsed && state.parsed.ok)
                keptStale = true;
        }
        if (this._rateLimited)
            parts.push(Quote.rateLimitNotice(keptStale));
        if (Quote.extraSymbolCount(this.symbols || "") > 0)
            parts.push("Only the first 6 symbols are shown.");
        this.set_applet_tooltip(parts.join(" "));
    }

    _openMenu() {
        this._buildMenu();
        this.menu.toggle();
    }

    _buildMenu() {
        this.menu.removeAll();
        const symbols = Quote.parseSymbolList(this.symbols || "");
        if (Quote.extraSymbolCount(this.symbols || "") > 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem("Only the first 6 symbols are shown.", { reactive: false }));
        }
        if (symbols.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem("No symbols configured. Right-click and choose Configure.", { reactive: false }));
            return;
        }
        for (let i = 0; i < symbols.length; i++) {
            if (i > 0 || Quote.extraSymbolCount(this.symbols || "") > 0)
                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._addSymbolMenu(symbols[i]);
        }
    }

    _addSymbolMenu(symbol) {
        const state = this._quotes[symbol];
        const quote = state && state.parsed && state.parsed.ok ? state.parsed : null;
        if (!quote) {
            const why = state && state.rateLimited
                ? "Yahoo rate-limited the request"
                : (state && state.error) || "No quote yet";
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(symbol + " — " + why, { reactive: false }));
            return;
        }

        const price = Quote.formatPrice(quote.price, quote.priceHint) + (quote.currency ? " " + quote.currency : "");
        const signed = formatSigned(quote.change, quote.priceHint);
        const move = signed ? signed + " (" + Quote.formatPercent(quote.changePercent) + ")" : Quote.formatPercent(quote.changePercent);

        this.menu.addMenuItem(new PopupMenu.PopupMenuItem(quote.name, { reactive: false }));
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem(price + "   " + move, { reactive: false }));
        if (quote.dayLow !== null && quote.dayHigh !== null) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                "Day " + Quote.formatPrice(quote.dayLow, quote.priceHint) + " – " + Quote.formatPrice(quote.dayHigh, quote.priceHint),
                { reactive: false }));
        }
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
            "5-day " + Quote.formatPercent(Quote.fiveDayPercent(quote.closes)),
            { reactive: false }));
        this.menu.addAction("Open " + symbol + " on Yahoo", () => {
            Gio.app_info_launch_default_for_uri(
                "https://finance.yahoo.com/quote/" + encodeURIComponent(symbol),
                null);
        });
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new StockBarApplet(metadata, orientation, panelHeight, instanceId);
}
