import * as vscode from 'vscode';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Know Your Package
// Inline, in package.json, shows whether each "dependencies" entry is
// actually used in the project, and how many times. Scans both script files
// (JS/TS/JSX/TSX/Vue/Svelte) and style files (CSS/SCSS/SASS/LESS), since
// modern tools (e.g. Tailwind v4) are pulled in via a stylesheet `@import`
// rather than a JS import.
//
// Intentionally scoped to the "dependencies" field only — devDependencies,
// peerDependencies, and optionalDependencies are out of scope by design.
// ---------------------------------------------------------------------------

const SCRIPT_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte'];
const STYLE_EXTENSIONS = ['css', 'scss', 'sass', 'less'];
const ALL_SCAN_EXTENSIONS = [...SCRIPT_EXTENSIONS, ...STYLE_EXTENSIONS];
const EXCLUDE_GLOB = '**/{node_modules,dist,build,out,.git,coverage,.next,.nuxt}/**';
const PARSE_CONCURRENCY = 12;

// Only the "dependencies" field is scanned, by design — see file header.
const DEPENDENCY_FIELDS: readonly string[] = ['dependencies'];

interface FilePackageUsage {
  usageCount: number;
  firstLine: number;
}

interface FileCacheEntry {
  mtime: number;
  packages: Map<string, FilePackageUsage>; // normalized package name -> usage in this file
}

interface PackageUsage {
  totalCount: number;
  files: { filePath: string; relativePath: string; count: number; firstLine: number }[];
}

// fsPath -> parsed result + mtime it was parsed at. The single source of truth.
const fileCache = new Map<string, FileCacheEntry>();
// packageName -> set of fsPaths known to reference it. Lets us aggregate a
// single package's usage without touching every file in the project.
const packageIndex = new Map<string, Set<string>>();
// Cached directory listing so we don't re-glob the workspace on every keystroke.
let workspaceFiles: vscode.Uri[] = [];
let filesListedAt = 0;

let decorationType: vscode.TextEditorDecorationType;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  decorationType = vscode.window.createTextEditorDecorationType({});
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  context.subscriptions.push(statusBarItem);

  const refreshActiveEditor = () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && isPackageJson(editor.document)) {
      void updateDecorations(editor);
    }
  };

  vscode.window.onDidChangeActiveTextEditor(refreshActiveEditor, null, context.subscriptions);
  vscode.workspace.onDidSaveTextDocument(doc => {
    if (isPackageJson(doc)) {
      refreshActiveEditor();
    }
  }, null, context.subscriptions);

  // Targeted re-parsing: only the file that actually changed gets touched.
  // No project-wide rescan, no cache wipe.
  const watcher = vscode.workspace.createFileSystemWatcher(
    `**/*.{${ALL_SCAN_EXTENSIONS.join(',')}}`
  );
  watcher.onDidChange(uri => void handleFileChanged(uri));
  watcher.onDidCreate(uri => {
    workspaceFiles.push(uri);
    void handleFileChanged(uri);
  });
  watcher.onDidDelete(uri => {
    workspaceFiles = workspaceFiles.filter(f => f.fsPath !== uri.fsPath);
    removeFromCache(uri.fsPath);
    refreshActiveEditor();
  });
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.commands.registerCommand('pkgUsage.seeMore', async (packageName: string) => {
      await showSeeMorePopup(packageName);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('pkgUsage.searchWorkspace', async (packageName: string) => {
      await vscode.commands.executeCommand('workbench.action.findInFiles', {
        query: packageName,
        triggerSearch: true
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('pkgUsage.refresh', async () => {
      fileCache.clear();
      packageIndex.clear();
      filesListedAt = 0;
      refreshActiveEditor();
    })
  );

  refreshActiveEditor();
}

function isPackageJson(doc: vscode.TextDocument): boolean {
  return path.basename(doc.fileName) === 'package.json';
}

async function handleFileChanged(uri: vscode.Uri) {
  await parseAndCacheFile(uri);
  refreshIfPackageJsonActive();
}

function refreshIfPackageJsonActive() {
  const editor = vscode.window.activeTextEditor;
  if (editor && isPackageJson(editor.document)) {
    void updateDecorations(editor);
  }
}

function removeFromCache(fsPath: string) {
  const entry = fileCache.get(fsPath);
  if (entry) {
    for (const pkg of entry.packages.keys()) {
      packageIndex.get(pkg)?.delete(fsPath);
    }
  }
  fileCache.delete(fsPath);
}

// --- Decoration rendering -------------------------------------------------

async function updateDecorations(editor: vscode.TextEditor) {
  const text = editor.document.getText();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    // Invalid JSON mid-edit; clear decorations until it's valid again.
    editor.setDecorations(decorationType, []);
    return;
  }

  const packages: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    if (json[field] && typeof json[field] === 'object') {
      packages.push(...Object.keys(json[field]));
    }
  }
  if (packages.length === 0) {
    editor.setDecorations(decorationType, []);
    return;
  }

  await ensureWorkspaceScanned();

  const lines = text.split('\n');
  const decorations: vscode.DecorationOptions[] = [];

  for (const pkg of packages) {
    const lineIndex = findDependencyLine(lines, pkg);
    if (lineIndex === -1) {
      continue;
    }

    const usage = getUsageForPackage(pkg); // pure in-memory lookup, no I/O

    const lineLength = lines[lineIndex].length;
    const range = new vscode.Range(
      new vscode.Position(lineIndex, lineLength),
      new vscode.Position(lineIndex, lineLength)
    );

    const hover = new vscode.MarkdownString();
    hover.isTrusted = true;

    let contentText: string;
    const args = encodeURIComponent(JSON.stringify([pkg]));

    if (usage.totalCount > 0) {
      contentText = `  used, ${usage.totalCount} time${usage.totalCount === 1 ? '' : 's'}  see more`;
      hover.appendMarkdown(
        `**${pkg}** is used **${usage.totalCount}** time(s) across **${usage.files.length}** file(s).\n\n`
      );
      hover.appendMarkdown(`[See more](command:pkgUsage.seeMore?${args})`);
    } else {
      contentText = '  not used, 0 times (double-check before removing)  see more';
      hover.appendMarkdown(
        `**${pkg}** doesn't appear to be used in any scanned source or style file.\n\n`
      );
      hover.appendMarkdown(`[Search workspace for "${pkg}"](command:pkgUsage.searchWorkspace?${args})`);
    }

    decorations.push({
      range,
      renderOptions: {
        after: {
          contentText,
          color: usage.totalCount > 0
            ? new vscode.ThemeColor('editorCodeLens.foreground')
            : new vscode.ThemeColor('errorForeground'),
          fontStyle: 'italic',
          margin: '0 0 0 12px'
        }
      },
      hoverMessage: hover
    });
  }

  editor.setDecorations(decorationType, decorations);
}

function findDependencyLine(lines: string[], pkgName: string): number {
  const escaped = escapeRegex(pkgName);
  const re = new RegExp(`["']${escaped}["']\\s*:`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      return i;
    }
  }
  return -1;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Workspace scan: one pass over all files, results cached per-file ----

async function ensureWorkspaceScanned() {
  // Re-list files at most every 30s; file create/delete events keep the list
  // fresh in between, this just guards against drift (e.g. git checkout).
  const now = Date.now();
  if (workspaceFiles.length === 0 || now - filesListedAt > 30_000) {
    workspaceFiles = await vscode.workspace.findFiles(
      `**/*.{${ALL_SCAN_EXTENSIONS.join(',')}}`,
      EXCLUDE_GLOB
    );
    filesListedAt = now;
  }

  const stale: vscode.Uri[] = [];
  for (const uri of workspaceFiles) {
    const cached = fileCache.get(uri.fsPath);
    if (!cached) {
      stale.push(uri);
      continue;
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.mtime !== cached.mtime) {
        stale.push(uri);
      }
    } catch {
      // File vanished between listing and now; drop it.
      removeFromCache(uri.fsPath);
    }
  }

  if (stale.length === 0) {
    return;
  }

  if (stale.length > 20) {
    statusBarItem.text = `$(sync~spin) Know Your Package: scanning ${stale.length} changed file(s)…`;
    statusBarItem.show();
  }

  await mapWithConcurrency(stale, PARSE_CONCURRENCY, parseAndCacheFile);

  statusBarItem.hide();
}

async function parseAndCacheFile(uri: vscode.Uri): Promise<void> {
  let mtime: number;
  let content: string;
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    mtime = stat.mtime;
    const buf = await vscode.workspace.fs.readFile(uri);
    content = Buffer.from(buf).toString('utf8');
  } catch {
    removeFromCache(uri.fsPath);
    return;
  }

  // Skip obviously-huge generated/bundled files.
  if (content.length > 1_500_000) {
    removeFromCache(uri.fsPath);
    return;
  }

  const ext = path.extname(uri.fsPath).slice(1).toLowerCase();
  const parsed = STYLE_EXTENSIONS.includes(ext)
    ? parseStyleFileForPackages(content)
    : parseScriptFileForPackages(content);

  // Drop this file's old entries from the reverse index before re-adding,
  // in case a previously-imported package was removed on edit.
  removeFromCache(uri.fsPath);

  fileCache.set(uri.fsPath, { mtime, packages: parsed });
  for (const pkg of parsed.keys()) {
    let set = packageIndex.get(pkg);
    if (!set) {
      set = new Set();
      packageIndex.set(pkg, set);
    }
    set.add(uri.fsPath);
  }
}

// Single read-through of a JS/TS/JSX/TSX/Vue/Svelte file's content: finds
// every import/require statement regardless of which package it references,
// groups bound identifiers by (normalized) package name, then counts
// identifier occurrences once.
function parseScriptFileForPackages(content: string): Map<string, FilePackageUsage> {
  const bindings = new Map<string, { identifiers: Set<string>; presenceHits: number; firstIndex: number }>();

  const ensure = (pkg: string) => {
    let entry = bindings.get(pkg);
    if (!entry) {
      entry = { identifiers: new Set(), presenceHits: 0, firstIndex: -1 };
      bindings.set(pkg, entry);
    }
    return entry;
  };
  const noteFirstIndex = (entry: { firstIndex: number }, index: number) => {
    if (entry.firstIndex === -1 || index < entry.firstIndex) {
      entry.firstIndex = index;
    }
  };

  const patterns: { re: RegExp; identGroups: number[]; pathGroup: number }[] = [
    { re: /import\s+([\w$]+)\s*,?\s*(?:\{([^}]*)\})?\s*from\s+["']([^"']+)["']/g, identGroups: [1, 2], pathGroup: 3 },
    { re: /import\s*\*\s*as\s+([\w$]+)\s+from\s+["']([^"']+)["']/g, identGroups: [1], pathGroup: 2 },
    { re: /import\s*\{([^}]+)\}\s*from\s+["']([^"']+)["']/g, identGroups: [1], pathGroup: 2 },
    { re: /(?:const|let|var)\s+([\w$]+)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g, identGroups: [1], pathGroup: 2 },
    { re: /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g, identGroups: [1], pathGroup: 2 }
  ];
  const presenceOnlyPatterns: { re: RegExp; pathGroup: number }[] = [
    { re: /import\s*["']([^"']+)["']\s*;?(?!\s*from)/g, pathGroup: 1 },
    { re: /import\(\s*["']([^"']+)["']\s*\)/g, pathGroup: 1 }
  ];

  for (const { re, identGroups, pathGroup } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      const pkg = normalizePackagePath(m[pathGroup]);
      if (!pkg) continue;
      const entry = ensure(pkg);
      noteFirstIndex(entry, m.index);
      for (const g of identGroups) {
        addIdentifiersFromMatch(m[g], entry.identifiers);
      }
    }
  }

  for (const { re, pathGroup } of presenceOnlyPatterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      const pkg = normalizePackagePath(m[pathGroup]);
      if (!pkg) continue;
      const entry = ensure(pkg);
      noteFirstIndex(entry, m.index);
      entry.presenceHits++;
    }
  }

  return finalizeBindings(bindings, content);
}

// Style files (CSS/SCSS/SASS/LESS) don't have JS import bindings — they
// reference packages via @import / @use / @plugin rules, or (for legacy
// Tailwind v3) the bare `@tailwind base/components/utilities;` directives.
// This is exactly what makes Tailwind v4 ("@import 'tailwindcss';") show up
// as used even though it's never `import`ed in any JS/TS file.
function parseStyleFileForPackages(content: string): Map<string, FilePackageUsage> {
  const bindings = new Map<string, { identifiers: Set<string>; presenceHits: number; firstIndex: number }>();

  const ensure = (pkg: string) => {
    let entry = bindings.get(pkg);
    if (!entry) {
      entry = { identifiers: new Set(), presenceHits: 0, firstIndex: -1 };
      bindings.set(pkg, entry);
    }
    return entry;
  };
  const noteFirstIndex = (entry: { firstIndex: number }, index: number) => {
    if (entry.firstIndex === -1 || index < entry.firstIndex) {
      entry.firstIndex = index;
    }
  };

  const presencePatterns: RegExp[] = [
    /@import\s+["']([^"']+)["']/g,                      // @import "pkg";
    /@import\s+url\(\s*["']?([^"')]+)["']?\s*\)/g,       // @import url("pkg");
    /@use\s+["']([^"']+)["']/g,                          // Sass @use "pkg";
    /@plugin\s+["']([^"']+)["']/g                        // Tailwind v4 @plugin "pkg";
  ];

  for (const re of presencePatterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      const pkg = normalizePackagePath(m[1]);
      if (!pkg) continue;
      const entry = ensure(pkg);
      noteFirstIndex(entry, m.index);
      entry.presenceHits++;
    }
  }

  // Legacy Tailwind v3 directive: each occurrence implies tailwindcss usage.
  const tailwindDirective = /@tailwind\s+(base|components|utilities|variants)\b/g;
  let directiveMatch: RegExpExecArray | null;
  let directiveHits = 0;
  let firstDirectiveIndex = -1;
  while ((directiveMatch = tailwindDirective.exec(content))) {
    directiveHits++;
    if (firstDirectiveIndex === -1) {
      firstDirectiveIndex = directiveMatch.index;
    }
  }
  if (directiveHits > 0) {
    const entry = ensure('tailwindcss');
    entry.presenceHits += directiveHits;
    noteFirstIndex(entry, firstDirectiveIndex);
  }

  return finalizeBindings(bindings, content);
}

// Shared by both script and style parsers: turns the raw bindings collected
// during scanning into the final per-package usage counts for this file.
function finalizeBindings(
  bindings: Map<string, { identifiers: Set<string>; presenceHits: number; firstIndex: number }>,
  content: string
): Map<string, FilePackageUsage> {
  const result = new Map<string, FilePackageUsage>();
  for (const [pkg, entry] of bindings) {
    let usageCount = entry.presenceHits;
    for (const id of entry.identifiers) {
      if (!id) continue;
      const idEscaped = escapeRegex(id);
      const matches = content.match(new RegExp(`\\b${idEscaped}\\b`, 'g'));
      usageCount += matches ? matches.length : 0;
    }
    if (usageCount === 0) continue;

    const before = entry.firstIndex >= 0 ? content.slice(0, entry.firstIndex) : '';
    const firstLine = Math.max(before.split('\n').length - 1, 0);
    result.set(pkg, { usageCount, firstLine });
  }
  return result;
}

// Resolves a raw import/use path to a package name: drops relative/absolute
// paths, and collapses subpath references like "lodash/get" -> "lodash" or
// "tailwindcss/utilities" -> "tailwindcss" or "@scope/pkg/sub" -> "@scope/pkg".
function normalizePackagePath(raw: string): string | null {
  if (!raw || raw.startsWith('.') || raw.startsWith('/')) {
    return null;
  }
  if (raw.startsWith('@')) {
    const parts = raw.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : raw;
  }
  return raw.split('/')[0];
}

function addIdentifiersFromMatch(group: string | undefined, into: Set<string>) {
  if (!group) return;
  group.split(',').forEach(part => {
    const trimmed = part.trim();
    if (!trimmed) return;
    const local = trimmed.includes(' as ')
      ? trimmed.split(' as ').pop()!.trim()
      : trimmed.includes(':')
        ? trimmed.split(':').pop()!.trim()
        : trimmed;
    if (/^[\w$]+$/.test(local)) {
      into.add(local);
    }
  });
}

// --- Aggregation: pure in-memory, no file I/O. This is what makes repeated
// lookups (switching tabs, reopening package.json) instant. ---

function getUsageForPackage(pkgName: string): PackageUsage {
  const result: PackageUsage = { totalCount: 0, files: [] };
  const fsPaths = packageIndex.get(pkgName);
  if (!fsPaths) {
    return result;
  }
  for (const fsPath of fsPaths) {
    const cached = fileCache.get(fsPath);
    const usage = cached?.packages.get(pkgName);
    if (!usage) continue;
    result.files.push({
      filePath: fsPath,
      relativePath: vscode.workspace.asRelativePath(vscode.Uri.file(fsPath)),
      count: usage.usageCount,
      firstLine: usage.firstLine
    });
    result.totalCount += usage.usageCount;
  }
  result.files.sort((a, b) => b.count - a.count);
  return result;
}

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = items[index++];
      await fn(current);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
}

async function showSeeMorePopup(pkgName: string) {
  const usage = getUsageForPackage(pkgName);
  if (usage.files.length === 0) {
    vscode.window.showInformationMessage(`No usage found for "${pkgName}".`);
    return;
  }

  const items = usage.files.map(f => ({
    label: `$(file) ${f.relativePath}`,
    description: `${f.count} usage${f.count === 1 ? '' : 's'}`,
    fileUsage: f
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `${pkgName} — used in ${usage.files.length} file(s), ${usage.totalCount} time(s) total. Select a file to open it.`,
    matchOnDescription: true
  });

  if (picked) {
    const doc = await vscode.workspace.openTextDocument(picked.fileUsage.filePath);
    const editor = await vscode.window.showTextDocument(doc);
    const pos = new vscode.Position(picked.fileUsage.firstLine, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

export function deactivate() {
  decorationType?.dispose();
}

