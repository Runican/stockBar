const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Tooltips = imports.ui.tooltips;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

imports.gi.versions.Soup = "3.0";
const Soup = imports.gi.Soup;

const Quote = require("./quote");

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const SPARK_WIDTH = 52;
const RATE_LIMIT_SECONDS = 10 * 60;

function bytesToString(bytes) {
    let data = bytes.get_data();
    if (Array.isArray(data))
        data = data[0];
    return new TextDecoder("utf-8").decode(data);
}

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

        this._session = new Soup.Session();
        this._session.timeout = 15;
        this._session.user_agent = USER_AGENT;

        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menuManager.addMenu(this.menu);

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.settings.bind("symbols", "symbols", this._onSettingsChanged.bind(this));
        this.settings.bind("refresh-interval", "refresh_interval", this._onSettingsChanged.bind(this));

        this._refresh();
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
        if (this._cancellable)
            this._cancellable.cancel();
        this._clearRows();
        this.settings.finalize();
    }

    _onSettingsChanged() {
        if (!this._removed)
            this._refresh();
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

    _refresh() {
        if (this._removed)
            return;
        this._clearTimer();
        if (this._cancellable)
            this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();

        const symbols = Quote.parseSymbolList(this.symbols || "");
        this._ensureRows(symbols);
        this._rateLimited = false;
        this._pending = symbols.length;
        if (symbols.length === 0) {
            this._finishRefresh();
            return;
        }
        for (let i = 0; i < symbols.length; i++)
            this._fetch(symbols[i]);
    }

    _fetch(symbol) {
        const uri = "https://query1.finance.yahoo.com/v8/finance/chart/" +
            encodeURIComponent(symbol) + "?interval=1d&range=5d";
        let message;
        try {
            message = Soup.Message.new("GET", uri);
        } catch (e) {
            this._storeFailure(symbol, String(e), false);
            this._fetchDone();
            return;
        }
        message.request_headers.replace("User-Agent", USER_AGENT);
        message.request_headers.append("Accept", "application/json");

        const cancellable = this._cancellable;
        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
            if (this._removed || cancellable !== this._cancellable)
                return;
            try {
                const bytes = session.send_and_read_finish(result);
                // status_code, not get_status(): 429 is outside Soup.Status and get_status() throws.
                const code = message.status_code;
                if (code === 429) {
                    this._rateLimited = true;
                    this._storeFailure(symbol, "Yahoo rate-limited the request", true);
                } else if (code !== 200) {
                    this._storeFailure(symbol, "HTTP " + code, false);
                } else {
                    const parsed = Quote.parseChart(JSON.parse(bytesToString(bytes)));
                    if (!parsed.ok) {
                        this._storeFailure(symbol, parsed.error || "No quote", false);
                    } else {
                        this._quotes[symbol] = { parsed: parsed, error: null, rateLimited: false };
                        this._paintRow(symbol);
                    }
                }
            } catch (e) {
                if (e.matches && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                this._storeFailure(symbol, String(e), false);
            }
            this._fetchDone();
        });
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
            this._refresh();
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
        const percentLabel = new St.Label({ text: "—", style_class: "stockbar-flat" });
        const spark = new St.DrawingArea({
            style_class: "stockbar-spark stockbar-spark-flat",
            reactive: false
        });
        box.add(symbolLabel, { y_align: St.Align.MIDDLE, y_fill: false });
        box.add(percentLabel, { y_align: St.Align.MIDDLE, y_fill: false });
        box.add(spark, { y_align: St.Align.MIDDLE, y_fill: false, x_fill: false });
        this.actor.add(box, { y_align: St.Align.MIDDLE });

        const row = {
            symbol: symbol,
            box: box,
            symbolLabel: symbolLabel,
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
            row.percentLabel.set_text("—");
            this._setDirectionClass(row.percentLabel, "stockbar-", "flat");
            row.closes = [];
            row.sparkDirection = "flat";
        } else {
            row.percentLabel.set_text(Quote.formatPercent(quote.changePercent));
            this._setDirectionClass(row.percentLabel, "stockbar-", Quote.percentDirection(quote.changePercent));
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
