# Stock Bar

A Cinnamon panel applet. Each ticker shows the symbol with the last price underneath, the day's change above today's percent, and a small line of the last five daily closes. Click a ticker for the company name, day range, five-day move, and a link to Yahoo Finance.

Quotes come from Yahoo's chart endpoint, the same numbers that draw the sparkline. The request goes out through `curl`, with a browser TLS fingerprint, a Firefox User-Agent, and the cookie plus crumb used by the Yahoo Finance Quotes desklet. There is no API key. The cookie jar and crumb are cached in `~/.cache/stockbar@stockbar/`. Yahoo can still change or rate-limit the endpoint. The applet keeps the last good quote when a request fails. `/usr/bin/curl` is required.

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
