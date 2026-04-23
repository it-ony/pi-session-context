/**
 * pi-session-context
 *
 * Tracks and displays what the agent is currently working on in the pi footer.
 * Each context entry carries its own display metadata — the extension just renders it.
 *
 * Examples:
 *   🌿 repo  branch       (type: "dir")
 *   📋 SDK-1234           (type: "link", Jira URL)
 *   🔀 #771               (type: "link", MR URL)
 *   · env  staging        (no type — plain text)
 *
 * Two ways context is set:
 *  1. Passive  — worktree paths auto-detected from any tool call input
 *  2. Explicit — agent calls set_context with a map of entries
 *
 * CWD behaviour:
 *   The entry with key "worktree" (type: "dir") controls the bash working directory.
 *   All subsequent bash commands run from that path — no cd prefix needed.
 *
 * State survives /reload and session restore via pi.appendEntry().
 *
 * Configuration (environment variables):
 *   PI_WORKTREE_BASE  Base directory for git worktrees.
 *                     Default: ~/Development/worktree
 */

import * as os from "node:os";
import * as nodePath from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { createBashTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ── Configuration ──────────────────────────────────────────────────────────────

const WORKTREE_BASE =
	process.env.PI_WORKTREE_BASE ??
	nodePath.join(os.homedir(), "Development", "worktree");

// ── Constants ──────────────────────────────────────────────────────────────────

const ENTRY_TYPE = "session-context";

// Rendered before any extra keys; also used to clear stale status slots
const WELL_KNOWN_KEYS = ["worktree", "ticket", "mr"] as const;

// Default icons for well-known keys — model can override via the icon field
const DEFAULT_ICONS: Record<string, string> = {
	worktree: "🌿",
	ticket: "📋",
	mr: "🔀",
};

// ── Types ──────────────────────────────────────────────────────────────────────

interface ContextEntry {
	value: string; // URL (link), filesystem path (dir), or plain text
	type?: "link" | "dir"; // rendering mode; omit for plain text
	icon?: string; // emoji / char shown before the value; falls back to DEFAULT_ICONS or "·"
}

interface DerivedDir {
	branch: string | null;
	repoUrl: string | null;
}

interface PersistedState {
	context: Record<string, ContextEntry>;
	derived: Record<string, DerivedDir>; // git-detected info per "dir" entry
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** OSC 8 terminal hyperlink */
function link(url: string, text: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** Extract a short human-readable label from a URL */
function friendlyLabel(key: string, url: string): string {
	// GitLab MR / GitHub PR
	const mr = url.match(/\/(?:merge_requests|pull)\/(\d+)/);
	if (mr) return `#${mr[1]}`;
	// Jira browse
	const jira = url.match(/\/browse\/([A-Z]+-\d+)/);
	if (jira) return jira[1];
	// Last non-empty path segment
	const seg = url.split("/").filter(Boolean).pop();
	return seg ?? key;
}

// ── Extension ──────────────────────────────────────────────────────────────────

export default function sessionContextExtension(pi: ExtensionAPI) {
	// ── State ────────────────────────────────────────────────────────────────

	const state: PersistedState = {
		context: {},
		derived: {},
	};

	// Tracks which status slots are currently occupied so we can clear removed keys
	const activeSlots = new Set<string>();

	// Cache: candidate path → resolved git root (null = outside WORKTREE_BASE)
	const gitRootCache = new Map<string, string | null>();
	// Cache: git root → web URL (null = no detectable remote)
	const repoUrlCache = new Map<string, string | null>();

	// ── Git helpers ──────────────────────────────────────────────────────────

	async function git(dir: string, ...args: string[]): Promise<string | null> {
		try {
			const r = await pi.exec("git", ["-C", dir, ...args], { timeout: 3000 });
			return r.code === 0 ? r.stdout.trim() : null;
		} catch {
			return null;
		}
	}

	async function resolveGitRoot(candidate: string): Promise<string | null> {
		const cachedRoot = gitRootCache.get(candidate);
		if (cachedRoot !== undefined) return cachedRoot;
		const root = await git(candidate, "rev-parse", "--show-toplevel");
		const resolved = root?.startsWith(`${WORKTREE_BASE}/`) ? root : null;
		gitRootCache.set(candidate, resolved);
		return resolved;
	}

	async function resolveRemoteUrl(root: string): Promise<string | null> {
		const cachedUrl = repoUrlCache.get(root);
		if (cachedUrl !== undefined) return cachedUrl;
		const remote = await git(root, "remote", "get-url", "origin");
		let url: string | null = null;
		if (remote) {
			const ssh = remote.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
			if (ssh) url = `https://${ssh[1]}/${ssh[2]}`;
			const https =
				!url && remote.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
			if (https) url = `https://${https[1]}/${https[2]}`;
		}
		repoUrlCache.set(root, url);
		return url;
	}

	async function detectDir(key: string, path: string): Promise<void> {
		const branch = await git(path, "rev-parse", "--abbrev-ref", "HEAD");
		const repoUrl = await resolveRemoteUrl(path);
		state.derived[key] = { branch, repoUrl };
	}

	// ── Bash CWD override ────────────────────────────────────────────────────

	const bashTool = createBashTool(process.cwd(), {
		spawnHook: ({ command, cwd, env }) => ({
			command,
			cwd: state.context.worktree?.value ?? cwd,
			env,
		}),
	});

	pi.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) =>
			bashTool.execute(id, params, signal, onUpdate),
	});

	// ── Persistence ──────────────────────────────────────────────────────────

	function persist() {
		pi.appendEntry(ENTRY_TYPE, { ...state });
	}

	// ── Footer rendering ──────────────────────────────────────────────────────

	function renderEntry(
		key: string,
		entry: ContextEntry,
		ctx: ExtensionContext,
	): string {
		const theme = ctx.ui.theme;
		const icon = entry.icon ?? DEFAULT_ICONS[key] ?? "·";

		if (entry.type === "dir") {
			const d = state.derived[key];
			const relative = nodePath.relative(WORKTREE_BASE, entry.value);
			const slash = relative.indexOf("/");
			const repo = slash >= 0 ? relative.slice(0, slash) : relative;
			const br = d?.branch ?? (slash >= 0 ? relative.slice(slash + 1) : "");
			const brText = theme.fg("dim", `  ${br}`);
			const brDisplay =
				br && d?.repoUrl ? link(`${d.repoUrl}/-/tree/${br}`, brText) : brText;
			return (
				theme.fg("success", `${icon} `) +
				theme.fg("accent", repo) +
				(br ? brDisplay : "")
			);
		}

		if (entry.type === "link") {
			const label = friendlyLabel(key, entry.value);
			return (
				theme.fg("dim", `${icon} `) +
				link(entry.value, theme.fg("accent", label))
			);
		}

		// Plain text: · key  value
		return `${
			theme.fg("dim", `${icon} `) + theme.fg("dim", key)
		}  ${theme.fg("accent", entry.value)}`;
	}

	function refreshStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		// Ordered: well-known keys first, then extras alphabetically
		const extras = Object.keys(state.context)
			.filter((k) => !(WELL_KNOWN_KEYS as readonly string[]).includes(k))
			.sort();
		const orderedKeys = [
			...WELL_KNOWN_KEYS.filter((k) => state.context[k]?.value),
			...extras.filter((k) => state.context[k]?.value),
		];

		const nextSlots = new Set(orderedKeys.map((k) => `ctx-${k}`));

		// Clear any slots that are no longer active
		for (const slot of activeSlots) {
			if (!nextSlots.has(slot)) {
				ctx.ui.setStatus(slot, undefined);
			}
		}
		activeSlots.clear();

		// Render active entries
		for (const key of orderedKeys) {
			const entry = state.context[key];
			if (!entry) continue;
			ctx.ui.setStatus(`ctx-${key}`, renderEntry(key, entry, ctx));
			activeSlots.add(`ctx-${key}`);
		}
	}

	// ── Passive worktree detection ────────────────────────────────────────────

	async function tryDetectWorktree(
		candidate: string,
		ctx: ExtensionContext,
	): Promise<void> {
		if (!candidate.startsWith(`${WORKTREE_BASE}/`)) return;

		const root = await resolveGitRoot(candidate);
		if (!root || root === state.context.worktree?.value) return;

		state.context.worktree = { value: root, type: "dir", icon: "🌿" };
		await detectDir("worktree", root);
		persist();
		refreshStatus(ctx);
	}

	function extractPaths(text: string): string[] {
		const home = os.homedir();
		const expanded = text.replace(/~/g, home);
		const base = WORKTREE_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const seen = new Set<string>();
		for (const m of expanded.matchAll(
			new RegExp(`(${base}/[^\\s"'\\\\]+)`, "g"),
		)) {
			seen.add(m[1]);
		}
		return [...seen];
	}

	// ── Session events ────────────────────────────────────────────────────────

	pi.on("session_start", async (event, ctx) => {
		if (
			event.reason === "new" ||
			event.reason === "resume" ||
			event.reason === "fork"
		) {
			state.context = {};
			state.derived = {};

			if (ctx.cwd.startsWith(`${WORKTREE_BASE}/`)) {
				await tryDetectWorktree(ctx.cwd, ctx);
			} else {
				refreshStatus(ctx);
			}
			return;
		}

		// startup / reload — restore last persisted state
		const entries = ctx.sessionManager.getEntries();
		const last = [...entries]
			.reverse()
			.find(
				(e) =>
					e.type === "custom" &&
					"customType" in e &&
					(e as unknown as Record<string, unknown>).customType === ENTRY_TYPE,
			);

		if (last && "data" in last) {
			Object.assign(state, (last as { data: PersistedState }).data);
		}

		if (!state.context.worktree && ctx.cwd.startsWith(`${WORKTREE_BASE}/`)) {
			await tryDetectWorktree(ctx.cwd, ctx);
		} else {
			refreshStatus(ctx);
		}
	});

	pi.on("tool_call", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const paths = extractPaths(JSON.stringify(_event.input));
		void Promise.all(paths.map((p) => tryDetectWorktree(p, ctx)));
	});

	// ── set_context tool ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "set_context",
		label: "Set Context",
		description:
			"Update the session context displayed in the pi UI footer. " +
			"Accepts a map of key → entry objects. Keys not mentioned are left unchanged. " +
			'Pass value: "" to clear a key.\n\n' +
			"Entry fields:\n" +
			'  value  The content. URL for type "link", filesystem path for type "dir", plain text otherwise.\n' +
			'  type   "link" → rendered as a clickable hyperlink (value must be a full URL).\n' +
			'         "dir"  → value is a worktree path; git root, branch, and remote are auto-detected.\n' +
			'                  The key named "worktree" also sets the bash working directory.\n' +
			"         omit   → plain text displayed as  icon  key  value.\n" +
			"  icon   Single emoji or character shown before the entry. Optional.\n\n" +
			"Default icons: worktree=🌿  ticket=📋  mr=🔀  others=·",
		promptSnippet:
			"Record active worktree, ticket, MR, or any custom key in the footer",
		promptGuidelines: [
			"Call set_context as soon as you know the ticket key, worktree path, or MR",
			'Use type "dir" for the worktree key — it sets the bash CWD and shows the branch',
			'Use type "link" with a full URL for ticket, MR, or any other clickable reference',
			"Omit type for plain text entries like environment name, target branch, or status",
			'Pass value: "" to clear a key',
			"Only mention the keys you want to change — others stay as-is",
		],
		parameters: Type.Object({
			context: Type.Record(
				Type.String(),
				Type.Object({
					value: Type.String({
						description: 'The entry value. Pass "" to clear this key.',
					}),
					type: Type.Optional(
						Type.Union([
							Type.Literal("link", {
								description:
									"Value is a URL. Rendered as a clickable hyperlink with a friendly label.",
							}),
							Type.Literal("dir", {
								description:
									"Value is a filesystem path. Git root, branch, and remote URL are auto-detected. " +
									'The "worktree" key additionally sets the bash working directory.',
							}),
						]),
					),
					icon: Type.Optional(
						Type.String({
							description:
								"Single emoji or character shown before the entry in the footer.",
						}),
					),
				}),
				{
					description:
						"Map of key → entry to merge into the current context. " +
						"Well-known keys: worktree (type: dir), ticket (type: link), mr (type: link). " +
						"Any other key is shown generically.",
				},
			),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const updated: string[] = [];

			for (const [key, entry] of Object.entries(params.context)) {
				if (entry.value === "") {
					if (state.context[key] !== undefined) {
						delete state.context[key];
						delete state.derived[key];
						updated.push(`${key} cleared`);
					}
				} else if (entry.type === "dir") {
					const expanded = entry.value.replace(/^~/, os.homedir());
					const root = (await resolveGitRoot(expanded)) ?? expanded;
					state.context[key] = { ...entry, value: root };
					await detectDir(key, root);
					updated.push(`${key} → ${nodePath.relative(WORKTREE_BASE, root)}`);
				} else {
					state.context[key] = entry;
					updated.push(`${key} → ${entry.value}`);
				}
			}

			persist();
			refreshStatus(ctx);

			const summary = updated.length ? updated.join(", ") : "nothing changed";
			return {
				content: [{ type: "text", text: `Context updated: ${summary}` }],
				details: { context: state.context },
			};
		},
	});
}
