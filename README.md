# pi-session-context

A [pi coding agent](https://github.com/mariozechner/pi-coding-agent) extension that tracks and displays what the agent is working on in the footer — worktree, Jira ticket, GitLab/GitHub MR, pipeline status, MR review activity, or any custom key.

```
🌿 my-repo  feat/SDK-1234-fix-auth   📋 SDK-1234   🔀 #771   🟡 deploy   🔍 deploy  1/2
```

Entries are clickable OSC 8 hyperlinks in supported terminals. Pipeline and MR monitor icons update automatically as status changes.

## How it works

Context entries are stored as a map. Each entry has a **value**, an optional **type** that controls rendering, and an optional **icon**:

| type | rendering | value |
|------|-----------|-------|
| `"dir"` | git root + branch (branch is a clickable link to the remote) | filesystem path |
| `"link"` | clickable hyperlink with a friendly label | full URL |
| _(omit)_ | `icon  key  value` plain text | anything |

The agent calls `set_context` with a map of entries to update. Keys not mentioned are left unchanged. Pass `value: ""` to clear a key. An optional `label` field overrides the auto-derived display text for `link` entries.

### Well-known keys

Three keys have default icons and extra behaviour:

| key | icon | extra behaviour |
|-----|------|-----------------|
| `worktree` | 🌿 | Sets the bash working directory — no `cd` needed |
| `ticket` | 📋 | — |
| `mr` | 🔀 | — |

Any other key is shown with `·` as the default icon.

### Passive detection

The extension scans every tool call for paths inside `PI_WORKTREE_BASE`. When a worktree path is found it automatically sets `worktree` and detects the branch — no explicit `set_context` call needed.

---

## Use cases

### Worktree

Use `type: "dir"` with the `worktree` key. The extension resolves the git root, detects the current branch, and reads the remote URL so the branch name becomes a clickable link.

The bash tool is automatically redirected to run from that directory for the rest of the session.

```json
{
  "context": {
    "worktree": {
      "value": "~/Development/worktree/my-repo/feat/SDK-1234-fix-auth",
      "type": "dir",
      "icon": "🌿"
    }
  }
}
```

Renders as: `🌿 my-repo  feat/SDK-1234-fix-auth` (branch links to `https://gitlab.example.com/…/-/tree/feat/SDK-1234-fix-auth`)

Clearing the worktree key also resets the bash CWD back to the session default:

```json
{ "context": { "worktree": { "value": "" } } }
```

---

### Jira ticket

Use `type: "link"` with the full Jira issue URL. The extension extracts the ticket key (`SDK-1234`) as the display label and renders it as a clickable hyperlink.

```json
{
  "context": {
    "ticket": {
      "value": "https://myorg.atlassian.net/browse/SDK-1234",
      "type": "link",
      "icon": "📋"
    }
  }
}
```

Renders as: `📋 SDK-1234` (clickable, opens the issue in the browser)

---

### GitLab / GitHub MR or PR

Use `type: "link"` with the full MR or PR URL. The extension extracts the number and displays it as `#771`.

```json
{
  "context": {
    "mr": {
      "value": "https://gitlab.example.com/myorg/my-repo/-/merge_requests/771",
      "type": "link",
      "icon": "🔀"
    }
  }
}
```

Renders as: `🔀 #771` (clickable, opens the MR in the browser)

Works identically for GitHub pull requests (`/pull/42` → `#42`).

---

### Custom entries (plain text)

Any key without a type is displayed as `icon  key  value`. Useful for tracking things like environment, target branch, or task status.

```json
{
  "context": {
    "env":    { "value": "staging", "icon": "🌐" },
    "target": { "value": "develop", "icon": "🎯" }
  }
}
```

Renders as: `🌐 env  staging   🎯 target  develop`

---

### Pipeline monitoring

Use `monitor_pipeline` after triggering a CI/CD pipeline. The extension fetches the status immediately, shows a live clickable badge in the footer, and polls until the pipeline finishes. A pi notification fires on completion.

When the pipeline **fails**, the extension automatically injects a user message so the agent responds without manual intervention. Set `auto_prompt: false` to suppress this.

```json
{
  "url":              "https://gitlab.com/org/repo/-/pipelines/12345",
  "label":            "deploy",
  "interval_seconds": 30,
  "auto_prompt":      true
}
```

**Supported URL formats:**

| Platform | Pattern |
|----------|---------|
| GitLab pipeline | `https://<host>/group/project/-/pipelines/ID` |
| GitLab job | `https://<host>/group/project/-/jobs/ID` |
| GitHub Actions run | `https://github.com/owner/repo/actions/runs/ID` |

Self-hosted GitLab is supported — any host is accepted.

**Status icons** — update automatically in the footer:

| Icon | Status |
|------|--------|
| ⏳ | pending / queued |
| 🟡 | running |
| ✅ | success |
| ❌ | failed |
| ⊘ | canceled |
| ⏭ | skipped |
| ⚠️ | fetch error (bad token / network) |

---

### MR / PR monitoring

Use `monitor_mr` after opening a merge request to track review activity without polling manually. The extension polls every 5 minutes (configurable) and updates the footer with the live approval ratio.

```json
{
  "url":              "https://gitlab.example.com/myorg/my-repo/-/merge_requests/771",
  "label":            "deploy",
  "interval_seconds": 300,
  "auto_prompt":      true
}
```

**Supported URL formats:**

| Platform | Pattern |
|----------|---------|
| GitLab MR | `https://<host>/group/project/-/merge_requests/IID` |
| GitHub PR | `https://github.com/owner/repo/pull/NUMBER` |

**What is tracked:**

| Event | Footer | Notification | Auto-prompt |
|-------|--------|--------------|-------------|
| New source-code (diff) comments | `💬 deploy  1/2` | ✅ | ✅ (if `auto_prompt: true`) |
| All required approvals met | `✅ deploy  2/2` | ✅ | ✅ (if `auto_prompt: true`) |
| Approval count changes | `🔍 deploy  1/2 → 2/2` | — | — |
| MR merged | `🎉 deploy  merged` | ✅ | — |
| MR closed | `🚫 deploy  closed` | ✅ | — |

**Approval ratio** — displayed as `x/y` in the footer label:
- GitLab: sourced from the `/approvals` endpoint (`approved_by` / `approvals_required`)
- GitHub: unique approvers from `/reviews`; required count from branch protection (cached after first fetch, shown as `x/?` if unavailable)

**Comment tracking:** only source-code / diff comments count (inline review threads). General MR description comments are ignored. All comments present at registration are marked as already seen — only comments added after `monitor_mr` is called trigger notifications.

**Status icons:**

| Icon | Status |
|------|--------|
| 🔍 | monitoring |
| 💬 | new comments detected |
| ✅ | fully approved |
| 🎉 | merged |
| 🚫 | closed |
| ⚠️ | fetch error |

---

### Removing monitors

`stop_monitor` works for **both** pipeline and MR monitors — identify by label:

```json
{ "label": "deploy" }
```

Interactive removal via slash commands:

| Command | Covers |
|---------|--------|
| `/pipeline-monitors` | Pipeline monitors |
| `/mr-monitors` | MR / PR monitors |

---

### Putting it all together

A typical full workflow — start work, open MR, monitor pipeline and reviews:

```json
// set_context — starting work
{
  "context": {
    "worktree": { "value": "~/Development/worktree/my-repo/feat/SDK-1234-fix-auth", "type": "dir" },
    "ticket":   { "value": "https://myorg.atlassian.net/browse/SDK-1234", "type": "link" }
  }
}
```

```json
// set_context — after MR is opened
{
  "context": {
    "mr": { "value": "https://gitlab.example.com/myorg/my-repo/-/merge_requests/771", "type": "link" }
  }
}
```

```json
// monitor_pipeline — after push
{ "url": "https://gitlab.example.com/myorg/my-repo/-/pipelines/12345", "label": "deploy" }
```

```json
// monitor_mr — track review activity
{
  "url":   "https://gitlab.example.com/myorg/my-repo/-/merge_requests/771",
  "label": "deploy"
}
```

Footer: `🌿 my-repo  feat/…   📋 SDK-1234   🔀 #771   🟡 deploy   🔍 deploy  0/2`

When the task is done, clear everything:

```json
{
  "context": {
    "worktree": { "value": "" },
    "ticket":   { "value": "" },
    "mr":       { "value": "" }
  }
}
```

```json
// stop_monitor — removes both pipeline and MR monitors by label
{ "label": "deploy" }
```

---

## Installation

```bash
pi install npm:pi-session-context
# or directly from GitHub:
pi install git:github.com/it-ony/pi-session-context
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_WORKTREE_BASE` | `~/Development/worktree` | Base directory scanned for git worktrees |
| `GITLAB_TOKEN` | — | GitLab personal access token (`read_api` scope). Required for private projects. |
| `GITHUB_TOKEN` | — | GitHub personal access token. Required for private repos. |
| `PI_MONITOR_DEFAULT_INTERVAL` | `10` | Default pipeline poll interval in seconds (min 5). |

Set in your shell config (e.g. `~/.config/fish/config.fish` or `~/.zshrc`):

```sh
export PI_WORKTREE_BASE="$HOME/code/worktrees"
```

## License

MIT
