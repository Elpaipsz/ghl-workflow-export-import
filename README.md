# GHL Workflow Import/Export

A Chrome extension to export and import **Workflows** in GoHighLevel (GHL) between
sub-accounts, using your own browser session — no API keys, no backend of its own, and your
data never passes through any third-party server.

> ⚠️ **Not an official GoHighLevel / HighLevel Inc. product.** It uses undocumented internal
> app endpoints (`backend.leadconnectorhq.com`) by reading the traffic your own browser
> already generates. GHL can change those endpoints at any time and break this tool without
> notice. Use it at your own risk and check your account's Terms of Service before
> automating bulk changes.

## What it solves

GHL has no native way to copy a full Workflow (steps, triggers, email templates) from one
sub-account to another. This extension:

- Exports a Workflow (or all of them) to a `.json` file.
- Imports that `.json` into another sub-account as a **draft**, so you can review it before
  publishing.
- Includes the content of emails that use the Email Builder (not just the broken reference to
  the template ID).
- Exports/imports WhatsApp Business templates (Meta puts them back into review in the
  destination account — that part can't be avoided).

## Installation

This extension isn't published on the Chrome Web Store. Install it in developer mode:

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on **"Developer mode"** (toggle in the top right).
4. Click **"Load unpacked"** and select the repository folder.

## Usage

GoHighLevel is a **whitelabel** platform: each agency opens it from its own domain
(`crm.youragency.com`, `app.youragency.com`, etc.), not always `app.gohighlevel.com`. Because
of that, the extension doesn't activate itself when the page loads — you turn it on with a
click:

1. Log into your GHL account (whatever the domain is) and open the Workflow you want to
   export.
2. Click the extension's icon in the Chrome toolbar. That injects the panel **only into that
   tab**.
3. In the **source** account: click **"Export"** in the panel (or "Export ALL" for several at
   once).
4. In the **destination** account: open GHL, click the icon again to activate the panel there,
   and use **"Import"** with the downloaded `.json`. The Workflow is created as a draft —
   review and publish it manually.

If you reload the tab, the panel disappears (it's a temporary injection) — just click the icon
again.

## How it works (under the hood)

- The extension never injects itself anywhere: `background.js` waits for you to click its
  icon and only then injects the scripts into the active tab (`activeTab` permission). That
  way it works on any whitelabel domain without needing to request access to "all sites".
- `inject.js` runs in the page's own context (`world: "MAIN"`) and watches the calls GHL's
  own app makes via `fetch`/`XMLHttpRequest`, to capture the session token, the
  `locationId`, and a network log — without modifying or intercepting anything, read-only.
- `content.js` runs in an isolated context, draws the extension's panel, and makes the
  export/import calls reusing those credentials.
- Everything happens locally in your browser. The extension has no backend of its own; it
  only calls `leadconnectorhq.com`/`msgsndr.com`/`firebasestorage.googleapis.com`, the same
  domains GHL's own app already uses.

## Known limitations

- **Triggers** are exported, but it isn't confirmed whether GHL reactivates them
  automatically on import; you may need to recreate them by hand in the visual editor.
- Email Builder emails created **from scratch in "code/HTML" mode**: the exact format for
  saving them isn't 100% confirmed (see the comments in `content.js`,
  `createEmailTemplate()`). If one of these comes out empty on import, open an issue with a
  capture from the panel's network log (the "Live network capture" section) while editing
  that type of email.

## Contributing

Pull requests welcome. If you're touching the export/import logic, test it against a
sandbox sub-account before a real Workflow — a bug in the import step can create corrupted or
duplicate Workflows (though always as drafts, they never publish themselves).

## License

MIT — see [LICENSE](LICENSE).
