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

const STATUS_PROMPT_VERB: Partial<Record<PipelineStatus, string>> = {
	success: "succeeded",
	failed: "failed",
	canceled: "was canceled",
	skipped: "was skipped",
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

// ── MR Monitor status ─────────────────────────────────────────────────────────

type MrMonitorStatus =
	| "monitoring"
	| "approved"
	| "new_comments"
	| "merged"
	| "closed"
	| "fetch_error";

const MR_STATUS_ICON: Record<MrMonitorStatus, string> = {
	monitoring: "🔍",
	approved: "✅",
	new_comments: "💬",
	merged: "🎉",
	closed: "🚫",
	fetch_error: "⚠️",
};

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
	autoPrompt: boolean;
	notifyOn: PipelineStatus[];
	includeFailedJobs: boolean;
}

/** State fetched from a single MR / PR poll */
interface MrState {
	approvals: number;
	requiredApprovals: number; // -1 = unknown
	fullyApproved: boolean;
	commentIds: string[]; // all source-code comment IDs currently on the MR
	merged: boolean;
	closed: boolean;
}

/** Persisted state for a single MR / PR monitor */
interface PersistedMrMonitor {
	key: string;
	label: string;
	url: string;
	provider: "gitlab" | "github";
	// GitLab
	gitlabHost?: string;
	projectEncoded?: string;
	mrIid?: number;
	// GitHub
	owner?: string;
	repo?: string;
	prNumber?: number;
	// State
	approvals: number;
	requiredApprovals: number; // -1 = unknown
	fullyApproved: boolean;
	seenCommentIds: string[];
	mrStatus: MrMonitorStatus;
	intervalSeconds: number;
	autoPrompt: boolean;
	autoPromptMerged: boolean;
}

interface PersistedState {
	context: Record<string, ContextEntry>;
	derived: Record<string, DerivedDir>;
	monitors: PersistedMonitor[];
	mrMonitors: PersistedMrMonitor[];
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

// ── MR URL parsing ────────────────────────────────────────────────────────────

interface ParsedMrUrl {
	provider: "gitlab" | "github";
	gitlabHost?: string;
	projectEncoded?: string;
	mrIid?: number;
	owner?: string;
	repo?: string;
	prNumber?: number;
}

function parseMrUrl(url: string): ParsedMrUrl | null {
	// GitLab MR:  https://<host>/group[/sub]/project/-/merge_requests/IID
	const gl = url.match(/^(https?:\/\/[^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/);
	if (gl) {
		const [, host, path, iid] = gl;
		return {
			provider: "gitlab",
			gitlabHost: host,
			projectEncoded: encodeURIComponent(path),
			mrIid: Number(iid),
		};
	}
	// GitHub PR:  https://github.com/owner/repo/pull/NUMBER
	const gh = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
	if (gh) {
		const [, owner, repo, number] = gh;
		return { provider: "github", owner, repo, prNumber: Number(number) };
	}
	return null;
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

/** Fetch the names of failed jobs for a pipeline monitor. Returns [] for job monitors or on error. */
async function fetchFailedJobs(monitor: PersistedMonitor): Promise<string[]> {
	try {
		const headers: Record<string, string> = {
			Accept: "application/json",
			"User-Agent": "pi-session-context/1.0",
		};
		if (monitor.provider === "gitlab") {
			const token = process.env.GITLAB_TOKEN;
			if (token) headers["PRIVATE-TOKEN"] = token;
			// Only pipeline monitors have a /jobs sub-resource
			if (!monitor.apiUrl.includes("/pipelines/")) return [];
			const res = await fetch(`${monitor.apiUrl}/jobs?scope[]=failed`, {
				headers,
			});
			if (!res.ok) return [];
			const jobs = (await res.json()) as Array<{ name: string }>;
			return jobs.map((j) => j.name);
		}
		const token = process.env.GITHUB_TOKEN;
		if (token) headers.Authorization = `Bearer ${token}`;
		const res = await fetch(`${monitor.apiUrl}/jobs?filter=latest`, {
			headers,
		});
		if (!res.ok) return [];
		const data = (await res.json()) as {
			jobs: Array<{ name: string; conclusion: string }>;
		};
		return data.jobs
			.filter((j) => j.conclusion === "failure")
			.map((j) => j.name);
	} catch {
		return [];
	}
}

// ── MR state fetching ─────────────────────────────────────────────────────────

async function fetchGitLabMrState(
	monitor: PersistedMrMonitor,
): Promise<MrState> {
	const base = `${monitor.gitlabHost}/api/v4/projects/${monitor.projectEncoded}/merge_requests/${monitor.mrIid}`;
	const headers: Record<string, string> = {
		Accept: "application/json",
		"User-Agent": "pi-session-context/1.0",
	};
	const token = process.env.GITLAB_TOKEN;
	if (token) headers["PRIVATE-TOKEN"] = token;

	const [mrRes, approvalsRes] = await Promise.all([
		fetch(base, { headers }),
		fetch(`${base}/approvals`, { headers }),
	]);

	if (!mrRes.ok) throw new Error(`MR fetch failed: ${mrRes.status}`);
	const mr = (await mrRes.json()) as { state: string };

	let approvalsCount = 0;
	let requiredApprovals = 0;
	if (approvalsRes.ok) {
		const appData = (await approvalsRes.json()) as {
			approved_by: unknown[];
			approvals_required: number;
		};
		approvalsCount = appData.approved_by.length;
		requiredApprovals = appData.approvals_required;
	}

	// Paginate through all discussions — GitLab caps at 100 per page
	const commentIds: string[] = [];
	let page = 1;
	while (true) {
		const res = await fetch(`${base}/discussions?per_page=100&page=${page}`, {
			headers,
		});
		if (!res.ok) break;
		const discussions = (await res.json()) as Array<{
			notes: Array<{
				id: number;
				type: string | null; // "DiffNote" for inline code comments
				system: boolean;
			}>;
		}>;
		for (const disc of discussions) {
			const first = disc.notes[0];
			// Only inline diff discussions — "DiffNote" is the reliable marker
			if (!first || first.system || first.type !== "DiffNote") continue;
			for (const note of disc.notes) {
				if (!note.system) commentIds.push(String(note.id));
			}
		}
		if (discussions.length < 100) break; // last page
		page++;
	}

	return {
		approvals: approvalsCount,
		requiredApprovals,
		fullyApproved:
			requiredApprovals === 0 || approvalsCount >= requiredApprovals,
		commentIds,
		merged: mr.state === "merged",
		closed: mr.state === "closed",
	};
}

async function fetchGitHubPrState(
	monitor: PersistedMrMonitor,
): Promise<MrState> {
	const base = `https://api.github.com/repos/${monitor.owner}/${monitor.repo}`;
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "pi-session-context/1.0",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	const token = process.env.GITHUB_TOKEN;
	if (token) headers.Authorization = `Bearer ${token}`;

	const [prRes, reviewsRes] = await Promise.all([
		fetch(`${base}/pulls/${monitor.prNumber}`, { headers }),
		fetch(`${base}/pulls/${monitor.prNumber}/reviews?per_page=100`, {
			headers,
		}),
	]);

	if (!prRes.ok) throw new Error(`PR fetch failed: ${prRes.status}`);
	const pr = (await prRes.json()) as {
		state: string;
		merged: boolean;
		base: { ref: string };
	};

	// Count unique approvers — last review state per user wins
	let approvalsCount = 0;
	if (reviewsRes.ok) {
		const reviews = (await reviewsRes.json()) as Array<{
			user: { id: number };
			state: string;
		}>;
		const latestByUser = new Map<number, string>();
		for (const r of reviews) {
			if (r.state !== "PENDING" && r.user?.id) {
				latestByUser.set(r.user.id, r.state);
			}
		}
		approvalsCount = [...latestByUser.values()].filter(
			(s) => s === "APPROVED",
		).length;
	}

	// Fetch required approvals from branch protection once (then cached on monitor)
	let requiredApprovals = monitor.requiredApprovals;
	if (requiredApprovals === -1 && pr.base?.ref) {
		try {
			const protRes = await fetch(
				`${base}/branches/${encodeURIComponent(pr.base.ref)}`,
				{ headers },
			);
			if (protRes.ok) {
				const branch = (await protRes.json()) as {
					protection?: {
						required_pull_request_reviews?: {
							required_approving_review_count?: number;
						};
					};
				};
				requiredApprovals =
					branch.protection?.required_pull_request_reviews
						?.required_approving_review_count ?? -1;
			}
		} catch {
			// keep -1
		}
	}

	const fullyApproved =
		requiredApprovals > 0
			? approvalsCount >= requiredApprovals
			: approvalsCount > 0;

	// Paginate through all review comments (inline diff comments only)
	const commentIds: string[] = [];
	let commentPage = 1;
	while (true) {
		const res = await fetch(
			`${base}/pulls/${monitor.prNumber}/comments?per_page=100&page=${commentPage}`,
			{ headers },
		);
		if (!res.ok) break;
		const comments = (await res.json()) as Array<{ id: number }>;
		for (const c of comments) commentIds.push(String(c.id));
		if (comments.length < 100) break;
		commentPage++;
	}

	return {
		approvals: approvalsCount,
		requiredApprovals,
		fullyApproved,
		commentIds,
		merged: pr.merged === true,
		closed: pr.state === "closed" && !pr.merged,
	};
}

async function fetchMrState(
	monitor: PersistedMrMonitor,
): Promise<MrState | null> {
	try {
		return monitor.provider === "gitlab"
			? await fetchGitLabMrState(monitor)
			: await fetchGitHubPrState(monitor);
	} catch {
		return null;
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
		mrMonitors: [],
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

	// Active MR pollers keyed by monitor.key
	const mrMonitorTimers = new Map<string, ReturnType<typeof setInterval>>();

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

	// ── MR Monitor polling ───────────────────────────────────────────────

	function stopMrPoller(key: string): void {
		const t = mrMonitorTimers.get(key);
		if (t !== undefined) {
			clearInterval(t);
			mrMonitorTimers.delete(key);
		}
	}

	function stopAllMrPollers(): void {
		for (const key of [...mrMonitorTimers.keys()]) stopMrPoller(key);
	}

	function buildApprovalLabel(monitor: PersistedMrMonitor): string {
		if (monitor.requiredApprovals === 0) return "";
		if (monitor.requiredApprovals < 0) return `${monitor.approvals}/?`;
		return `${monitor.approvals}/${monitor.requiredApprovals}`;
	}

	function startMrPoller(monitor: PersistedMrMonitor): void {
		stopMrPoller(monitor.key);

		const handle = setInterval(async () => {
			if (!savedCtx) return;

			const mrState = await fetchMrState(monitor);
			const entry = state.context[monitor.key];

			if (!mrState) {
				if (monitor.mrStatus !== "fetch_error") {
					monitor.mrStatus = "fetch_error";
					if (entry) entry.icon = MR_STATUS_ICON.fetch_error;
					persist();
					refreshStatus(savedCtx);
				}
				return;
			}

			// Stop polling when MR reaches a terminal state
			if (mrState.merged || mrState.closed) {
				const terminalStatus: MrMonitorStatus = mrState.merged
					? "merged"
					: "closed";
				stopMrPoller(monitor.key);
				monitor.mrStatus = terminalStatus;
				if (entry) {
					entry.icon = MR_STATUS_ICON[terminalStatus];
					entry.label = `${monitor.label}  ${terminalStatus}`;
				}
				persist();
				refreshStatus(savedCtx);
				if (savedCtx.hasUI) {
					savedCtx.ui.notify(
						`${MR_STATUS_ICON[terminalStatus]} ${monitor.label} — ${terminalStatus}`,
						"info",
					);
				}
				if (mrState.merged && monitor.autoPromptMerged && savedCtx.hasUI) {
					const prompt = `The \`${monitor.label}\` MR has been merged.\nMR: ${monitor.url}`;
					try {
						if (savedCtx.isIdle()) {
							pi.sendUserMessage(prompt);
						} else {
							pi.sendUserMessage(prompt, { deliverAs: "followUp" });
						}
					} catch {
						// ignore
					}
				}
				return;
			}

			let changed = false;

			// Detect new source-code comments
			const newIds = mrState.commentIds.filter(
				(id) => !monitor.seenCommentIds.includes(id),
			);
			if (newIds.length > 0) {
				monitor.seenCommentIds.push(...newIds);
				monitor.mrStatus = "new_comments";
				changed = true;
				if (entry) entry.icon = MR_STATUS_ICON.new_comments;
				if (savedCtx.hasUI) {
					savedCtx.ui.notify(
						`💬 ${monitor.label} — ${newIds.length} new code review comment(s)`,
						"info",
					);
				}
				if (monitor.autoPrompt && savedCtx.hasUI) {
					const prompt = `The \`${monitor.label}\` MR has ${newIds.length} new code review comment(s).\nMR: ${monitor.url}`;
					try {
						if (savedCtx.isIdle()) {
							pi.sendUserMessage(prompt);
						} else {
							pi.sendUserMessage(prompt, { deliverAs: "followUp" });
						}
					} catch {
						// ignore
					}
				}
			}

			// Detect approval changes
			const prevApprovals = monitor.approvals;
			const prevRequired = monitor.requiredApprovals;
			const wasApproved = monitor.fullyApproved;
			monitor.approvals = mrState.approvals;
			if (mrState.requiredApprovals !== -1)
				monitor.requiredApprovals = mrState.requiredApprovals;
			monitor.fullyApproved = mrState.fullyApproved;
			if (
				prevApprovals !== monitor.approvals ||
				prevRequired !== monitor.requiredApprovals
			)
				changed = true;

			// Update footer label with current approval ratio
			const approvalSuffix = buildApprovalLabel(monitor);
			if (entry) {
				const newLabel = `${monitor.label}${approvalSuffix ? `  ${approvalSuffix}` : ""}`;
				if (entry.label !== newLabel) {
					entry.label = newLabel;
					changed = true;
				}
			}

			// Notify + auto-prompt when fully approved for the first time
			if (!wasApproved && monitor.fullyApproved) {
				monitor.mrStatus = "approved";
				if (entry) entry.icon = MR_STATUS_ICON.approved;
				changed = true;
				const req =
					monitor.requiredApprovals >= 0
						? String(monitor.requiredApprovals)
						: "?";
				if (savedCtx.hasUI) {
					savedCtx.ui.notify(
						`✅ ${monitor.label} — approved (${monitor.approvals}/${req})`,
						"info",
					);
				}
				if (monitor.autoPrompt && savedCtx.hasUI) {
					const prompt = `The \`${monitor.label}\` MR has been approved (${monitor.approvals}/${req}).\nMR: ${monitor.url}`;
					try {
						if (savedCtx.isIdle()) {
							pi.sendUserMessage(prompt);
						} else {
							pi.sendUserMessage(prompt, { deliverAs: "followUp" });
						}
					} catch {
						// ignore
					}
				}
			}

			if (changed) {
				persist();
				refreshStatus(savedCtx);
			}
		}, monitor.intervalSeconds * 1000);

		mrMonitorTimers.set(monitor.key, handle);
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
				// Auto-inject a user message so the agent responds to the failure
				const notifyOn = monitor.notifyOn ?? ["failed"];
				if (
					notifyOn.includes(newStatus) &&
					savedCtx.hasUI &&
					monitor.autoPrompt
				) {
					let prompt = `The \`${monitor.label}\` pipeline ${STATUS_PROMPT_VERB[newStatus] ?? newStatus}.\nPipeline: ${monitor.url}`;
					if (newStatus === "failed" && (monitor.includeFailedJobs ?? true)) {
						const jobs = await fetchFailedJobs(monitor);
						if (jobs.length > 0) prompt += `\nFailed jobs: ${jobs.join(", ")}`;
					}
					try {
						if (savedCtx.isIdle()) {
							pi.sendUserMessage(prompt);
						} else {
							pi.sendUserMessage(prompt, { deliverAs: "followUp" });
						}
					} catch {
						// Ignore — agent may not be in a receptive state
					}
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
			stopAllMrPollers();
			state.context = {};
			state.derived = {};
			state.monitors = [];
			state.mrMonitors = [];
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
			state.mrMonitors = data.mrMonitors ?? [];
			state.monitorCounter = data.monitorCounter ?? 0;
		}

		// Restart pollers for non-terminal monitors
		for (const monitor of state.monitors) {
			if (!isTerminal(monitor.status)) {
				startPoller(monitor);
			}
		}

		// Restart MR pollers for active monitors
		for (const monitor of state.mrMonitors) {
			if (monitor.mrStatus !== "merged" && monitor.mrStatus !== "closed") {
				startMrPoller(monitor);
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
		stopAllMrPollers();
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
			"Required env vars: GITLAB_TOKEN (GitLab), GITHUB_TOKEN (GitHub)\n\n" +
			"Set auto_prompt: false to suppress all agent prompts. " +
			'Use notify_on to control which terminal statuses trigger a prompt (default: ["failed"]).',
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
			auto_prompt: Type.Optional(
				Type.Boolean({
					description:
						"When true (default), automatically sends a user message to the agent if the pipeline fails, " +
						"triggering a response. Set to false to suppress this behaviour.",
				}),
			),
			notify_on: Type.Optional(
				Type.Array(
					Type.Union([
						Type.Literal("success"),
						Type.Literal("failed"),
						Type.Literal("canceled"),
						Type.Literal("skipped"),
					]),
					{
						description:
							"Terminal statuses that trigger an agent prompt. " +
							'Default: ["failed"]. Pass ["failed", "success"] to also prompt on success.',
					},
				),
			),
			include_failed_jobs: Type.Optional(
				Type.Boolean({
					description:
						"When true (default), the failure prompt includes the names of failed jobs. " +
						"Only applies to pipeline monitors (not individual job monitors).",
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
				autoPrompt: params.auto_prompt ?? true,
				notifyOn: (params.notify_on as PipelineStatus[] | undefined) ?? [
					"failed",
				],
				includeFailedJobs: params.include_failed_jobs ?? true,
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
				const notifyOn = monitor.notifyOn ?? ["failed"];
				if (notifyOn.includes(monitor.status) && monitor.autoPrompt) {
					let prompt = `The \`${monitor.label}\` pipeline ${STATUS_PROMPT_VERB[monitor.status] ?? monitor.status}.\nPipeline: ${monitor.url}`;
					if (
						monitor.status === "failed" &&
						(monitor.includeFailedJobs ?? true)
					) {
						const jobs = await fetchFailedJobs(monitor);
						if (jobs.length > 0) prompt += `\nFailed jobs: ${jobs.join(", ")}`;
					}
					try {
						pi.sendUserMessage(prompt, { deliverAs: "followUp" });
					} catch {
						// Ignore — agent may not be in a receptive state
					}
				}
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
			const pipelineMonitor = state.monitors.find(
				(m) => m.label.toLowerCase() === params.label.toLowerCase(),
			);
			const mrMonitor = state.mrMonitors.find(
				(m) => m.label.toLowerCase() === params.label.toLowerCase(),
			);
			const monitor = pipelineMonitor ?? mrMonitor;

			if (!monitor) {
				const available =
					[
						...state.monitors.map((m) => m.label),
						...state.mrMonitors.map((m) => m.label),
					].join(", ") || "none";
				throw new Error(
					`No monitor found with label "${params.label}". Active monitors: ${available}`,
				);
			}

			if (pipelineMonitor) {
				stopPoller(monitor.key);
				state.monitors = state.monitors.filter((m) => m.key !== monitor.key);
			} else {
				stopMrPoller(monitor.key);
				state.mrMonitors = state.mrMonitors.filter(
					(m) => m.key !== monitor.key,
				);
			}
			delete state.context[monitor.key];
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

	// ── monitor_mr tool ───────────────────────────────────────────────

	pi.registerTool({
		name: "monitor_mr",
		label: "Monitor MR",
		description:
			"Monitor a GitLab MR or GitHub PR for new code review comments and approval status. " +
			"Adds a live entry to the footer showing current approvals (x/y). " +
			"Notifies and optionally auto-prompts when new source-code comments appear or " +
			"when all required approvals are met. Also detects merged/closed.\n\n" +
			"Supported URL formats:\n" +
			"  GitLab MR:  https://<host>/group/project/-/merge_requests/IID\n" +
			"  GitHub PR:  https://github.com/owner/repo/pull/NUMBER\n\n" +
			"Required env vars: GITLAB_TOKEN (GitLab), GITHUB_TOKEN (GitHub)\n\n" +
			"Set auto_prompt: false to suppress automatic agent prompts on activity.",
		promptSnippet:
			"Monitor a GitLab MR or GitHub PR for review comments and approvals",
		promptGuidelines: [
			"Call monitor_mr after opening or sharing a merge request to track review activity",
			"Use a short descriptive label matching the MR topic or ticket number",
			"Default poll interval is 1 minute — set lower (min 15s) for faster feedback",
			"Set auto_prompt: false if you only want footer updates without agent interruptions",
		],
		parameters: Type.Object({
			url: Type.String({
				description:
					"Full GitLab MR URL (…/-/merge_requests/IID) or GitHub PR URL (…/pull/NUMBER)",
			}),
			label: Type.String({
				description:
					"Short display name shown in the footer, e.g. 'my-feature' or 'SDK-1234'",
			}),
			interval_seconds: Type.Optional(
				Type.Number({
					description: "Poll interval in seconds (default: 60, min: 15)",
				}),
			),
			auto_prompt: Type.Optional(
				Type.Boolean({
					description:
						"When true (default), automatically sends a user message to the agent " +
						"when new code review comments appear or all required approvals are met. " +
						"Set to false for silent footer-only updates.",
				}),
			),
			auto_prompt_merged: Type.Optional(
				Type.Boolean({
					description:
						"When true (default), automatically sends a user message to the agent " +
						"when the MR is merged. Set to false to suppress this.",
				}),
			),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			savedCtx = ctx;

			const parsed = parseMrUrl(params.url);
			if (!parsed) {
				throw new Error(
					"Unrecognized URL format. Expected:\n" +
						"  GitLab MR:  https://<host>/group/project/-/merge_requests/IID\n" +
						"  GitHub PR:  https://github.com/owner/repo/pull/NUMBER",
				);
			}

			const key = `mr-${++state.monitorCounter}`;
			const intervalSeconds = Math.max(15, params.interval_seconds ?? 60);

			const monitor: PersistedMrMonitor = {
				key,
				label: params.label,
				url: params.url,
				provider: parsed.provider,
				gitlabHost: parsed.gitlabHost,
				projectEncoded: parsed.projectEncoded,
				mrIid: parsed.mrIid,
				owner: parsed.owner,
				repo: parsed.repo,
				prNumber: parsed.prNumber,
				approvals: 0,
				requiredApprovals: -1,
				fullyApproved: false,
				seenCommentIds: [],
				mrStatus: "monitoring",
				intervalSeconds,
				autoPrompt: params.auto_prompt ?? true,
				autoPromptMerged: params.auto_prompt_merged ?? true,
			};

			// Fetch initial state — all existing comments are marked as already seen
			const initial = await fetchMrState(monitor);
			if (initial) {
				monitor.approvals = initial.approvals;
				monitor.requiredApprovals = initial.requiredApprovals;
				monitor.fullyApproved = initial.fullyApproved;
				monitor.seenCommentIds = initial.commentIds;
				if (initial.merged) monitor.mrStatus = "merged";
				else if (initial.closed) monitor.mrStatus = "closed";
				else if (initial.fullyApproved) monitor.mrStatus = "approved";
			}

			const approvalSuffix = buildApprovalLabel(monitor);
			state.context[key] = {
				type: "link",
				value: params.url,
				icon: MR_STATUS_ICON[monitor.mrStatus],
				label: `${params.label}${approvalSuffix ? `  ${approvalSuffix}` : ""}`,
			};

			state.mrMonitors.push(monitor);
			persist();
			refreshStatus(ctx);

			const isTerminalMr =
				monitor.mrStatus === "merged" || monitor.mrStatus === "closed";
			if (!isTerminalMr) startMrPoller(monitor);

			const req =
				monitor.requiredApprovals >= 0
					? String(monitor.requiredApprovals)
					: "?";
			const statusMsg = isTerminalMr
				? `already ${monitor.mrStatus} — no polling needed`
				: `polling every ${intervalSeconds}s`;

			return {
				content: [
					{
						type: "text",
						text: `Monitoring ${monitor.label} (${monitor.approvals}/${req} approvals, ${monitor.seenCommentIds.length} existing comments, ${statusMsg}).`,
					},
				],
				details: {
					key,
					label: monitor.label,
					approvals: monitor.approvals,
					requiredApprovals: monitor.requiredApprovals,
					existingComments: monitor.seenCommentIds.length,
					url: monitor.url,
					provider: monitor.provider,
					intervalSeconds,
				},
			};
		},
	});

	// ── /mr-monitors command ────────────────────────────────────────────

	pi.registerCommand("mr-monitors", {
		description: "List active MR/PR monitors — select one to remove it",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			if (state.mrMonitors.length === 0) {
				ctx.ui.notify("No active MR monitors", "info");
				return;
			}

			const options = state.mrMonitors.map((m) => {
				const suffix = buildApprovalLabel(m);
				return `${MR_STATUS_ICON[m.mrStatus]} ${m.label}${suffix ? `  ${suffix}` : ""}  ${m.mrStatus}`;
			});

			const choice = await ctx.ui.select(
				"MR monitors — pick one to remove:",
				options,
			);
			if (!choice) return;

			const idx = options.indexOf(choice);
			const monitor = state.mrMonitors[idx];
			if (!monitor) return;

			const confirmed = await ctx.ui.confirm(
				"Remove monitor?",
				`Stop tracking ${monitor.label} and remove it from the footer.`,
			);
			if (!confirmed) return;

			stopMrPoller(monitor.key);
			delete state.context[monitor.key];
			state.mrMonitors = state.mrMonitors.filter((m) => m.key !== monitor.key);
			persist();
			refreshStatus(ctx);

			ctx.ui.notify(`Removed MR monitor: ${monitor.label}`, "info");
		},
	});
}
