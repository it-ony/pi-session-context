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
 *   🟡 deploy             (type: "link", pipeline URL — live-updating icon)
 *   · env  staging        (no type — plain text)
 *
 * Two ways context is set:
 *  1. Passive  — worktree paths auto-detected from any tool call input
 *  2. Explicit — agent calls set_context with a map of entries
 *  3. Monitor  — agent calls monitor_pipeline; icon updates automatically as status changes
 *
 * CWD behaviour:
 *   The entry with key "worktree" (type: "dir") controls the bash working directory.
 *   All subsequent bash commands run from that path — no cd prefix needed.
 *
 * State survives /reload and session restore via pi.appendEntry().
 * Active pipeline monitors are also persisted and pollers restart on reload/startup.
 *
 * Configuration (environment variables):
 *   PI_WORKTREE_BASE             Base directory for git worktrees. Default: ~/Development/worktree
 *   GITLAB_TOKEN                 GitLab personal access token (for monitor_pipeline)
 *   GITHUB_TOKEN                 GitHub personal access token (for monitor_pipeline)
 *   PI_MONITOR_DEFAULT_INTERVAL  Default pipeline poll interval in seconds (default: 10)
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

const PIPELINE_DEFAULT_INTERVAL = Math.max(
	5,
	Number(process.env.PI_MONITOR_DEFAULT_INTERVAL ?? "10"),
);

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

// ── Pipeline status ────────────────────────────────────────────────────────────

type PipelineStatus =
	| "pending"
	| "running"
	| "success"
	| "failed"
	| "canceled"
	| "skipped"
	| "unknown"
	| "fetch_error";

const STATUS_ICON: Record<PipelineStatus, string> = {
	pending: "⏳",
	running: "🟡",
	success: "✅",
	failed: "❌",
	canceled: "⊘",
	skipped: "⏭",
	unknown: "❓",
	fetch_error: "⚠️",
};

const TERMINAL_STATUSES: ReadonlySet<PipelineStatus> = new Set([
	"success",
	"failed",
	"canceled",
	"skipped",
]);

function isTerminal(s: PipelineStatus): boolean {
	return TERMINAL_STATUSES.has(s);
}

// ── Raw provider status types ──────────────────────────────────────────────────

type GitLabRawStatus =
	| "created"
	| "waiting_for_resource"
	| "preparing"
	| "scheduled"
	| "manual"
	| "pending"
	| "running"
	| "success"
	| "failed"
	| "canceled"
	| "skipped";

type GitHubRunStatus = "queued" | "in_progress" | "completed";
type GitHubConclusion =
	| "success"
	| "failure"
	| "cancelled"
	| "skipped"
	| "timed_out"
	| "action_required"
	| "neutral"
	| null;

// ── Types ──────────────────────────────────────────────────────────────────────

interface ContextEntry {
	value: string; // URL (link), filesystem path (dir), or plain text
	type?: "link" | "dir"; // rendering mode; omit for plain text
	icon?: string; // emoji shown before the entry; falls back to DEFAULT_ICONS or "·"
	label?: string; // display label override for link entries (used by monitor_pipeline)
}

interface DerivedDir {
	branch: string | null;
	repoUrl: string | null;
}

/** Subset of PipelineMonitor that is safe to persist */
interface PersistedMonitor {
	key: string;
	label: string;
	url: string;
	provider: "gitlab" | "github";
	apiUrl: string;
	status: PipelineStatus;
	intervalSeconds: number;
}

interface PersistedState {
	context: Record<string, ContextEntry>;
	derived: Record<string, DerivedDir>;
	monitors: PersistedMonitor[];
	monitorCounter: number;
}

// ── URL parsing ────────────────────────────────────────────────────────────────

interface ParsedPipelineUrl {
	provider: "gitlab" | "github";
	apiUrl: string;
}

function parseGitLabUrl(url: string): ParsedPipelineUrl | null {
	// Pipeline:  https://<host>/group[/sub]/project/-/pipelines/ID
	const pipeline = url.match(/^(https?:\/\/[^/]+)\/(.+?)\/-\/pipelines\/(\d+)/);
	if (pipeline) {
		const [, host, path, id] = pipeline;
		return {
			provider: "gitlab",
			apiUrl: `${host}/api/v4/projects/${encodeURIComponent(path)}/pipelines/${id}`,
		};
	}
	// Job:  https://<host>/group[/sub]/project/-/jobs/ID
	const job = url.match(/^(https?:\/\/[^/]+)\/(.+?)\/-\/jobs\/(\d+)/);
	if (job) {
		const [, host, path, id] = job;
		return {
			provider: "gitlab",
			apiUrl: `${host}/api/v4/projects/${encodeURIComponent(path)}/jobs/${id}`,
		};
	}
	return null;
}

function parseGitHubUrl(url: string): ParsedPipelineUrl | null {
	// Run:  https://github.com/owner/repo/actions/runs/ID
	const run = url.match(
		/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/,
	);
	if (run) {
		const [, owner, repo, id] = run;
		return {
			provider: "github",
			apiUrl: `https://api.github.com/repos/${owner}/${repo}/actions/runs/${id}`,
		};
	}
	return null;
}

function parsePipelineUrl(url: string): ParsedPipelineUrl | null {
	return parseGitLabUrl(url) ?? parseGitHubUrl(url);
}

// ── API status mapping ─────────────────────────────────────────────────────────

function mapGitLabStatus(raw: string): PipelineStatus {
	switch (raw as GitLabRawStatus) {
		case "created":
		case "waiting_for_resource":
		case "preparing":
		case "scheduled":
		case "manual":
		case "pending":
			return "pending";
		case "running":
			return "running";
		case "success":
			return "success";
		case "failed":
			return "failed";
		case "canceled":
			return "canceled";
		case "skipped":
			return "skipped";
		default:
			return "unknown";
	}
}

function mapGitHubStatus(
	status: GitHubRunStatus,
	conclusion: GitHubConclusion,
): PipelineStatus {
	if (status === "queued") return "pending";
	if (status === "in_progress") return "running";
	switch (conclusion) {
		case "success":
		case "neutral":
			return "success";
		case "failure":
		case "timed_out":
			return "failed";
		case "cancelled":
			return "canceled";
		case "skipped":
			return "skipped";
		case "action_required":
			return "pending";
		default:
			return "unknown";
	}
}

async function fetchPipelineStatus(
	monitor: PersistedMonitor,
): Promise<PipelineStatus> {
	try {
		const headers: Record<string, string> = {
			Accept: "application/json",
			"User-Agent": "pi-session-context/1.0",
		};
		if (monitor.provider === "gitlab") {
			const token = process.env.GITLAB_TOKEN;
			if (token) headers["PRIVATE-TOKEN"] = token;
		} else {
			const token = process.env.GITHUB_TOKEN;
			if (token) headers.Authorization = `Bearer ${token}`;
		}

		const res = await fetch(monitor.apiUrl, { headers });
		if (!res.ok) return "fetch_error";

		const data = (await res.json()) as Record<string, unknown>;
		return monitor.provider === "gitlab"
			? mapGitLabStatus(String(data.status ?? ""))
			: mapGitHubStatus(
					data.status as GitHubRunStatus,
					data.conclusion as GitHubConclusion,
				);
	} catch {
		return "fetch_error";
	}
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
	// GitLab pipeline or job
	const pipeline = url.match(/\/-\/(?:pipelines|jobs)\/(\d+)/);
	if (pipeline) return `!${pipeline[1]}`;
	// GitHub Actions run
	const ghRun = url.match(/\/actions\/runs\/(\d+)/);
	if (ghRun) return `#${ghRun[1]}`;
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
		monitors: [],
		monitorCounter: 0,
	};

	// Tracks which status slots are currently occupied so we can clear removed keys
	const activeSlots = new Set<string>();

	// Cache: candidate path → resolved git root (null = outside WORKTREE_BASE)
	const gitRootCache = new Map<string, string | null>();
	// Cache: git root → web URL (null = no detectable remote)
	const repoUrlCache = new Map<string, string | null>();

	// Active pipeline pollers keyed by monitor.key
	const pipelineTimers = new Map<string, ReturnType<typeof setInterval>>();

	// The most recently seen ctx — used by polling callbacks outside event handlers
	let savedCtx: ExtensionContext | null = null;

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
			// entry.label overrides auto-derived label (used by monitor_pipeline)
			const displayLabel = entry.label ?? friendlyLabel(key, entry.value);
			return (
				theme.fg("dim", `${icon} `) +
				link(entry.value, theme.fg("accent", displayLabel))
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

	// ── Pipeline polling ──────────────────────────────────────────────────────

	function stopPoller(key: string): void {
		const t = pipelineTimers.get(key);
		if (t !== undefined) {
			clearInterval(t);
			pipelineTimers.delete(key);
		}
	}

	function stopAllPollers(): void {
		for (const key of [...pipelineTimers.keys()]) stopPoller(key);
	}

	function startPoller(monitor: PersistedMonitor): void {
		stopPoller(monitor.key); // clear any existing timer for this key

		const handle = setInterval(async () => {
			if (!savedCtx) return;

			const newStatus = await fetchPipelineStatus(monitor);
			if (newStatus === monitor.status) return;

			monitor.status = newStatus;

			// Update the icon on the context entry in-place
			const entry = state.context[monitor.key];
			if (entry) entry.icon = STATUS_ICON[newStatus];

			// Sync persisted monitors array
			const stored = state.monitors.find((m) => m.key === monitor.key);
			if (stored) stored.status = newStatus;

			persist();
			refreshStatus(savedCtx);

			if (isTerminal(newStatus)) {
				stopPoller(monitor.key);
				if (savedCtx.hasUI) {
					savedCtx.ui.notify(
						`${STATUS_ICON[newStatus]} ${monitor.label} — ${newStatus}`,
						newStatus === "success" ? "info" : "error",
					);
				}
			}
		}, monitor.intervalSeconds * 1000);

		pipelineTimers.set(monitor.key, handle);
	}

	// ── Session events ────────────────────────────────────────────────────────

	pi.on("session_start", async (event, ctx) => {
		savedCtx = ctx;

		if (
			event.reason === "new" ||
			event.reason === "resume" ||
			event.reason === "fork"
		) {
			// Fresh context — stop pollers and wipe state
			stopAllPollers();
			state.context = {};
			state.derived = {};
			state.monitors = [];
			state.monitorCounter = 0;

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
			const data = (last as { data: Partial<PersistedState> }).data;
			state.context = data.context ?? {};
			state.derived = data.derived ?? {};
			state.monitors = data.monitors ?? [];
			state.monitorCounter = data.monitorCounter ?? 0;
		}

		// Restart pollers for non-terminal monitors
		for (const monitor of state.monitors) {
			if (!isTerminal(monitor.status)) {
				startPoller(monitor);
			}
		}

		if (!state.context.worktree && ctx.cwd.startsWith(`${WORKTREE_BASE}/`)) {
			await tryDetectWorktree(ctx.cwd, ctx);
		} else {
			refreshStatus(ctx);
		}
	});

	pi.on("session_shutdown", async () => {
		stopAllPollers();
		savedCtx = null;
	});

	pi.on("tool_call", (_event, ctx) => {
		savedCtx = ctx;
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
			"  icon   Single emoji or character shown before the entry. Optional.\n" +
			"  label  Display label override for link entries. Optional.\n\n" +
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
									"Value is a URL. Rendered as a clickable hyperlink.",
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
					label: Type.Optional(
						Type.String({
							description:
								"Display label override for link entries. Replaces the auto-derived label.",
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
						// Also stop any monitor using this key
						stopPoller(key);
						state.monitors = state.monitors.filter((m) => m.key !== key);
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

	// ── monitor_pipeline tool ─────────────────────────────────────────────────

	pi.registerTool({
		name: "monitor_pipeline",
		label: "Monitor Pipeline",
		description:
			"Monitor a GitLab or GitHub pipeline/job. Adds a live clickable entry to the footer " +
			"whose icon updates automatically as the status changes. Notifies via pi when done.\n\n" +
			"Supported URL formats:\n" +
			"  GitLab pipeline:  https://<host>/group/project/-/pipelines/ID\n" +
			"  GitLab job:       https://<host>/group/project/-/jobs/ID\n" +
			"  GitHub run:       https://github.com/owner/repo/actions/runs/ID\n\n" +
			"Self-hosted GitLab is supported — any host is accepted.\n\n" +
			"Required env vars: GITLAB_TOKEN (GitLab), GITHUB_TOKEN (GitHub)",
		promptSnippet:
			"Monitor a GitLab/GitHub pipeline or job — live icon in the footer",
		promptGuidelines: [
			"Call monitor_pipeline after triggering a CI pipeline so the user can track it passively",
			"Use a short descriptive label: deploy, tests, build, e2e",
			"Use the full pipeline/job URL from CI output or the web UI",
		],
		parameters: Type.Object({
			url: Type.String({
				description:
					"Full URL of the GitLab pipeline/job or GitHub Actions workflow run",
			}),
			label: Type.String({
				description:
					"Short display name shown in the footer, e.g. 'deploy', 'tests', 'build'",
			}),
			interval_seconds: Type.Optional(
				Type.Number({
					description: `Poll interval in seconds (default: ${PIPELINE_DEFAULT_INTERVAL}, min: 5)`,
				}),
			),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			savedCtx = ctx;

			const parsed = parsePipelineUrl(params.url);
			if (!parsed) {
				throw new Error(
					"Unrecognized URL format. Expected:\n" +
						"  GitLab pipeline:  https://<host>/group/project/-/pipelines/ID\n" +
						"  GitLab job:       https://<host>/group/project/-/jobs/ID\n" +
						"  GitHub run:       https://github.com/owner/repo/actions/runs/ID",
				);
			}

			const key = `ci-${++state.monitorCounter}`;
			const intervalSeconds = Math.max(
				5,
				params.interval_seconds ?? PIPELINE_DEFAULT_INTERVAL,
			);

			const monitor: PersistedMonitor = {
				key,
				label: params.label,
				url: params.url,
				provider: parsed.provider,
				apiUrl: parsed.apiUrl,
				status: "pending",
				intervalSeconds,
			};

			// Fetch initial status before showing in footer
			monitor.status = await fetchPipelineStatus(monitor);

			// Register in context (renders as a link entry with live icon)
			state.context[key] = {
				type: "link",
				value: params.url,
				icon: STATUS_ICON[monitor.status],
				label: params.label,
			};

			state.monitors.push(monitor);
			persist();
			refreshStatus(ctx);

			if (!isTerminal(monitor.status)) {
				startPoller(monitor);
			} else {
				// Already finished — notify immediately, no polling needed
				ctx.ui.notify(
					`${STATUS_ICON[monitor.status]} ${monitor.label} — ${monitor.status}`,
					monitor.status === "success" ? "info" : "error",
				);
			}

			const statusMsg = isTerminal(monitor.status)
				? `already ${monitor.status} — no polling needed`
				: `polling every ${intervalSeconds}s`;

			return {
				content: [
					{
						type: "text",
						text: `Monitoring ${monitor.label} (${monitor.status}, ${statusMsg}).`,
					},
				],
				details: {
					key,
					label: monitor.label,
					status: monitor.status,
					url: monitor.url,
					provider: monitor.provider,
					intervalSeconds,
				},
			};
		},
	});

	// ── stop_monitor tool ────────────────────────────────────────────────────

	pi.registerTool({
		name: "stop_monitor",
		label: "Stop Monitor",
		description:
			"Stop monitoring a pipeline and remove it from the footer. Identifies the monitor by label.",
		promptSnippet: "Remove a pipeline monitor from the footer by label",
		parameters: Type.Object({
			label: Type.String({
				description:
					"Label of the monitor to remove (as passed to monitor_pipeline)",
			}),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const monitor = state.monitors.find(
				(m) => m.label.toLowerCase() === params.label.toLowerCase(),
			);

			if (!monitor) {
				const available =
					state.monitors.map((m) => m.label).join(", ") || "none";
				throw new Error(
					`No monitor found with label "${params.label}". Active monitors: ${available}`,
				);
			}

			stopPoller(monitor.key);
			delete state.context[monitor.key];
			state.monitors = state.monitors.filter((m) => m.key !== monitor.key);
			persist();
			refreshStatus(ctx);

			return {
				content: [
					{ type: "text", text: `Stopped monitoring ${monitor.label}.` },
				],
				details: { label: monitor.label },
			};
		},
	});

	// ── /monitors command ─────────────────────────────────────────────────────

	pi.registerCommand("pipeline-monitors", {
		description: "List active pipeline monitors — select one to remove it",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			if (state.monitors.length === 0) {
				ctx.ui.notify("No active monitors", "info");
				return;
			}

			const options = state.monitors.map(
				(m) => `${STATUS_ICON[m.status]} ${m.label}  ${m.status}`,
			);

			const choice = await ctx.ui.select(
				"Pipeline monitors — pick one to remove:",
				options,
			);
			if (!choice) return;

			// Match choice back to monitor by index
			const idx = options.indexOf(choice);
			const monitor = state.monitors[idx];
			if (!monitor) return;

			const confirmed = await ctx.ui.confirm(
				"Remove monitor?",
				`Stop tracking ${monitor.label} and remove it from the footer.`,
			);
			if (!confirmed) return;

			stopPoller(monitor.key);
			delete state.context[monitor.key];
			state.monitors = state.monitors.filter((m) => m.key !== monitor.key);
			persist();
			refreshStatus(ctx);

			ctx.ui.notify(`Removed monitor: ${monitor.label}`, "info");
		},
	});
}
