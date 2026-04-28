# pi-session-context

A [pi coding agent](https://github.com/mariozechner/pi-coding-agent) extension that tracks and displays what the agent is working on in the footer — worktree, Jira ticket, GitLab/GitHub MR, or any custom key.

```
🌿 my-repo  feat/SDK-1234-fix-auth   📋 SDK-1234   🔀 #771   · env  staging
```

Ticket and MR numbers are clickable OSC 8 hyperlinks in supported terminals.

## How it works

Context entries are stored as a map. Each entry has a **value**, an optional **type** that controls rendering, and an optional **icon**:

| type | rendering | value |
|------|-----------|-------|
| `"dir"` | git root + branch (branch is a clickable link to the remote) | filesystem path |
| `"link"` | clickable hyperlink with a friendly label | full URL |
| _(omit)_ | `icon  key  value` plain text | anything |

The agent calls `set_context` with a map of entries to update. Keys not mentioned are left unchanged. Pass `value: ""` to clear a key.

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

### Putting it all together

A typical agent call when starting work on a ticket:

```json
{
  "context": {
    "worktree": {
      "value": "~/Development/worktree/my-repo/feat/SDK-1234-fix-auth",
      "type": "dir",
      "icon": "🌿"
    },
    "ticket": {
      "value": "https://myorg.atlassian.net/browse/SDK-1234",
      "type": "link",
      "icon": "📋"
    }
  }
}
```

After pushing and opening the MR, add it:

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

Set in your shell config (e.g. `~/.config/fish/config.fish` or `~/.zshrc`):

```sh
export PI_WORKTREE_BASE="$HOME/code/worktrees"
```

## License

MIT
