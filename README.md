<div align="center">

# 📦 Know Your Package

**Instantly see which dependencies in your `package.json` are actually used — right on the line, without leaving the file.**

[![Version](https://img.shields.io/visual-studio-marketplace/v/YOUR-PUBLISHER-ID.know-your-package?color=blue&label=VS%20Code%20Marketplace&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=YOUR-PUBLISHER-ID.know-your-package)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/YOUR-PUBLISHER-ID.know-your-package?color=brightgreen)](https://marketplace.visualstudio.com/items?itemName=YOUR-PUBLISHER-ID.know-your-package)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/YOUR-PUBLISHER-ID.know-your-package)](https://marketplace.visualstudio.com/items?itemName=YOUR-PUBLISHER-ID.know-your-package)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

## ✨ What it does

Open any `package.json` and every dependency shows its usage status **inline on the same line** — no sidebar, no separate panel, no commands to run.

```jsonc
"dependencies": {
  "@tailwindcss/vite": "^4.2.1",   used, 3 times  see more
  "axios": "^1.13.5",              used, 45 times  see more
  "lucide-react": "^0.575.0",      used, 73 times  see more
  "react": "^19.2.0",              used, 169 times  see more
  "react-dom": "^19.2.0",          used, 2 times  see more
  "react-router-dom": "^7.13.1",   used, 64 times  see more
  "recharts": "^3.7.0",            used, 16 times  see more
  "tailwindcss": "^4.2.1"          not used, 0 times (double-check before removing)  see more
}
```

**Hover** over any annotation → a popup opens:

- **Used package** → searchable file list showing every file that imports it, with usage counts. Click any file to jump straight to the first usage line.
- **Unused package** → a link to search the entire workspace for it, so you can verify before removing.

---

## 🚀 Features

### Inline Usage Counts
No extra UI. The count appears at the end of each dependency line, in a subtle italic style that matches your theme. Green-tinted for used packages, red-tinted for packages that look unused.

### Hover to See Files
Hover over the annotation and a Quick Pick popup opens showing every file that imports the package, sorted by how many times it's used in each file. Click any file to jump straight to the first usage on that line.

### CSS / Style File Support
Modern tools like **Tailwind CSS v4** are imported via a stylesheet (`@import "tailwindcss"`) rather than a JS file. Know Your Package scans `.css`, `.scss`, `.sass`, and `.less` files too, so these won't incorrectly show as unused.

Supported style directives:
- `@import "tailwindcss"` — Tailwind v4
- `@tailwind base/components/utilities` — Tailwind v3 legacy
- `@use "sass:math"` — Sass modules
- `@plugin "..."` — Tailwind plugins

### Broad Framework Coverage
Scans all common source file types used in modern JS/TS projects:

| File types | Examples |
|---|---|
| JavaScript | `.js` `.mjs` `.cjs` |
| TypeScript | `.ts` `.tsx` |
| React | `.jsx` `.tsx` |
| Vue | `.vue` |
| Svelte | `.svelte` |
| Stylesheets | `.css` `.scss` `.sass` `.less` |

### Import Style Detection
Recognises every common way a package can be imported:

```js
import axios from 'axios'                    // ✅ default import
import { get, post } from 'axios'            // ✅ named imports
import * as Router from 'react-router-dom'   // ✅ namespace import
import 'some-polyfill'                       // ✅ side-effect import
const express = require('express')           // ✅ CommonJS require
const { Router } = require('express')        // ✅ destructured require
const mod = await import('module')           // ✅ dynamic import
```

### Built for Speed
- **One read per file, total** — a single pass extracts every import and groups results by package name. Adding more dependencies does not make it slower.
- **mtime-based cache** — a file is only re-read if it actually changed. Switching tabs or reopening `package.json` is instant after the first scan.
- **Targeted re-parsing** — when you save a file, only that file is re-parsed, not the whole project.
- **Parallel reads** — the first scan reads up to 12 files at once.

---

## ⚙️ How It Works

```
Open package.json
       │
       ▼
Read all .js/.ts/.jsx/.tsx/.vue/.svelte/.css/.scss/.sass/.less files
       │
       ▼
Single-pass parse: find every import/require/@import statement
       │
       ▼
Build reverse index:  package name  →  set of files that use it
       │
       ▼
For each dependency in package.json:
  Look up in index (no file I/O)  →  total count + file list
       │
       ▼
Render inline annotation on the dependency line
```

---

## 💡 Usage

**No setup required.** Install the extension, open any project that has a `package.json` with a `dependencies` field, and open `package.json`. Annotations appear automatically within a few seconds on the first load (the scan), and instantly on every subsequent view.

### Hover interaction

```
"axios": "^1.13.5",   used, 45 times  see more
                       ↑
                 Hover over this text
                       │
                       ▼
         ┌─────────────────────────────────────────┐
         │  axios — used in 6 file(s), 45 times    │
         │                                          │
         │  📄 src/api/client.ts           12 uses  │
         │  📄 src/hooks/useData.ts        10 uses  │
         │  📄 src/services/auth.ts         9 uses  │
         │  📄 src/pages/Dashboard.tsx      8 uses  │
         │  📄 src/utils/request.ts         4 uses  │
         │  📄 src/tests/api.test.ts        2 uses  │
         └─────────────────────────────────────────┘
                  Click any file to jump to it
```

---

## 🔧 Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and search **"Know Your Package"**:

| Command | What it does |
|---|---|
| `Know Your Package: Refresh scan` | Clears all caches and rescans the project from scratch |
| `Know Your Package: See more for this dependency` | Opens the file-list popup for the dependency under your cursor |

---

## ⚠️ Limitations

This extension uses **regex-based static analysis**, not a full AST parser. It is fast and accurate for the vast majority of real-world projects, but has a few known edge cases:

- **Dynamic package names** — `require(someVariable)` won't be detected since the package name isn't a literal string.
- **Path aliases** — if your bundler or `tsconfig` maps `@utils` to a package via `paths`, that alias won't resolve to the package name.
- **Count includes the import line** — "used, 1 time" usually means the package is imported but never actually called in the file body.
- **Minified `package.json`** — the annotation lookup assumes standard one-dependency-per-line formatting.

If any of these affect your project, use the **"Search workspace"** link in the unused-package hover as a fallback — it searches every file for the literal package name.

---

## 🤝 Contributing

Found a bug or want to support a new import style? Contributions are welcome.

1. Fork the repo
2. `npm install && npm run watch`
3. Press **F5** to open the Extension Development Host
4. Make your changes and open a PR

---

## 📄 License

MIT — see [LICENSE](LICENSE) for details.

---

<div align="center">

Made for developers who care about keeping their dependencies clean.

**[Install from Marketplace](https://marketplace.visualstudio.com/items?itemName=YOUR-PUBLISHER-ID.know-your-package)** · **[Report an Issue](https://github.com/YOUR-USERNAME/know-your-package/issues)** · **[View Source](https://github.com/YOUR-USERNAME/know-your-package)**

</div>
