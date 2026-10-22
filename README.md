# Stock Bar

A Cinnamon panel applet. Each ticker shows the symbol, today's percent change, and a small line of the last five daily closes. Click a ticker for the price, day range, five-day move, and a link to Yahoo Finance.

Quotes come from Yahoo's public chart endpoint (`/v8/finance/chart`). There is no API key. That endpoint is unofficial and can change or rate-limit. The applet keeps the last good quote when a request fails.

## Settings

Right-click the applet and choose Configure.

- **Ticker symbols.** Comma or whitespace separated, up to six. The default is `AAPL, MSFT`. Dots and dashes are fine (`MC.PA`, `BRK-B`).
- **Refresh interval.** 1 to 60 minutes. The default is 5. A rate limit waits at least 10 minutes before the next try.

## Install

The applet directory is `stockbar@stockbar`. Link it into Cinnamon's user applet folder:

```bash
mkdir -p ~/.local/share/cinnamon/applets
ln -sfn "$PWD/stockbar@stockbar" ~/.local/share/cinnamon/applets/stockbar@stockbar
```

Then add **Stock Bar** from System Settings → Applets, or restart Cinnamon.

Tested on Linux Mint 22.2 with Cinnamon 6.4.

## Tests

```bash
cjs tests/quote.test.js
```
