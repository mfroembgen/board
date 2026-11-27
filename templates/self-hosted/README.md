# self-hosted

A board you run yourself: `@vercel/board` with the `local()` backend, SQLite on
one disk, in one long-running Node process. People sign in with
[WorkOS AuthKit](https://workos.com/docs/authkit); CI jobs and workloads get in
through [grants](../../packages/board/docs/01-board/09-access.md#grants) on
their OIDC issuer. It needs no Vercel project.

| Path | What it is |
| --- | --- |
| `src/app.ts` | `board()` on `local()`, with `url` set and both verifiers |
| `src/people.ts` | AuthKit access tokens minted for the board's URL as their resource, then the person's verified email from userinfo |
| `src/sync.ts` | GitLab and Google Chat sync, each on when its secrets are set, and the triage watcher |
| `bin/board-token.ts` | Signs a person in through the browser (PKCE, dynamic client registration) and prints a token for `vb` |
| `chart/` | A Helm chart: one replica, `Recreate`, a kept volume |

## Run it

```bash
pnpm install
BOARD_PUBLIC_URL=http://127.0.0.1:4100/api/board AUTHKIT_ISSUER=https://<tenant>.authkit.app TEAM_DOMAIN=example.com PORT=4100 pnpm start
pnpm typecheck && pnpm test
```

| Variable | What it is |
| --- | --- |
| `BOARD_PUBLIC_URL` | The board's public URL, which every token's audience must equal |
| `AUTHKIT_ISSUER` | The AuthKit origin, `https://<tenant>.authkit.app` |
| `TEAM_DOMAIN` | The email domain people must have verified |
| `BOARD_DIR` | Where the log and attachments live. Default `.board`; `/data` in the image |
| `PORT`, `HOST` | Where it listens. Default `4100` on `0.0.0.0`; `8080` in the image |

In AuthKit, register `BOARD_PUBLIC_URL` as a resource indicator, and keep
dynamic client registration on for `board-token`.

## Sign in

```bash
export BOARD_URL=https://board.example.com/api/board AUTHKIT_ISSUER=https://<tenant>.authkit.app
export BOARD_TOKEN_HELPER="$PWD/bin/board-token.ts"   # an absolute path, so vb works from any directory
export BOARD_TOKEN_COMMAND='exec node "$BOARD_TOKEN_HELPER"'
vb() { npx -y https://github.com/mfroembgen/board/releases/download/%40vercel/board%400.56.1/vercel-board-0.56.1.tgz "$@"; }
vb whoami
```

`board-token` keeps its client and refresh token in `~/.config/board-token/`,
one file per issuer and board, readable only by you; parallel runs share one
refresh. `vb` is this fork's CLI, which runs `board-token` again before each
token expires, so `vb tail`, `vb wait`, and `vb inspect` keep going. Keep the
`exec`: it makes `board-token` the process `vb` stops when a sign-in runs past 6
minutes, where a compound command would leave it running. npx keeps
the tarball it first fetched from that URL: when the fork republishes it, find
its key with `npm cache npx ls | grep vercel-board` and drop it with
`npm cache npx rm <key>`. People are
`authkit:user:<id>`, handled by the part of their email before the domain.
Every one of them is a person on the board, so the default
grant `g1` gives each of them everything, `manage` included: any of them can
let a machine in. Narrow it with grants if that's more than you want. A
schedule sends as its creator until someone cancels it: when a person leaves,
list theirs with `vb schedules --by <handle>` and cancel each with
`vb schedule cancel <id>`, since disabling them in AuthKit alone doesn't stop it.

## Let machines in

A GitLab CI job requests an ID token for the board's URL (`id_tokens`, `aud`
set to it) and passes it as `BOARD_TOKEN`. A person grants its project:

```bash
vb grants create --oidc https://gitlab.example.com --claim 'sub=project_path:acme/web:*' --can 'deploys/=post'
```

A pod does the same with a projected service account token whose audience is
the board's URL, and a grant on its cluster's OIDC issuer.

## Use it in a browser

Open `https://<host>/` and sign in. The board's own UI, the
[inspector](../../packages/board/docs/03-guides/02-inspector.md), then reads
and writes as you: the same `authkit:user:<id>` the CLI signs in as, held to
the team domain and the board's grants. People install nothing.

| Variable | What it is |
| --- | --- |
| `AUTHKIT_CLIENT_ID` | Optional. A public AuthKit OAuth client whose redirect URI is `<origin>/sign-in/callback`. The board sends no client secret, and WorkOS dashboard clients are confidential by default, so make it public or leave this unset. Unset, the first sign-in registers a public client by dynamic client registration and keeps its ID in `BOARD_DIR/authkit-client.json` |
| `SIGN_IN_LABEL` | Optional. The sign-in button's text. Default `Sign in`; set `Sign in with Google` if that's how AuthKit signs your people in |

The browser holds only a random session ID, in an `HttpOnly` cookie. The
server keeps the session in memory, with the AuthKit refresh token it uses
to renew the person's access token. A restart signs everyone out, and signing
in again takes one click while AuthKit still knows them. `/sign-out` ends the
board's session but not the AuthKit one.

If AuthKit rejects the board's client (deleted or rotated), sign-in shows an
error for the operator, and AuthKit's own page shows one at authorize. Then
fix `AUTHKIT_CLIENT_ID`, or, for a registered client, delete
`BOARD_DIR/authkit-client.json` and restart the board so it registers a new
one.

## Sync GitLab and Google Chat

Each entry runs when its secret variables are set, and stays off otherwise.
Some but not all of an entry's variables fail the start, so a typo shows at
once. Each platform's webhook is `https://<host>/api/board/webhooks/<entry>`.
The board checks every request before it stores anything, and stores each event
without the platform's payload, so pipeline variables and Chat's credentials
never reach the inbox.

| Variable | What it is |
| --- | --- |
| `GITLAB_TOKEN` | A group or project access token with the `api` scope and the Reporter role. Its bot writes the board's replies as comments |
| `GITLAB_WEBHOOK_SECRET` | The secret token of the GitLab webhook. GitLab sends it in `X-Gitlab-Token` |
| `GITLAB_API_URL` | Required with them: `https://gitlab.example.com/api/v4` |
| `GITLAB_BOT_USER_ID` | Optional. The token's bot user ID. The board asks `GET /user` without it |
| `GITLAB_EXCLUDE` | Optional. Comma-separated namespace paths, such as `acme/hiring`, compared case-insensitively. An event that names a project in one, as its project, a merge request's source or target, or a pipeline's merge request, is answered and never stored, and the board never posts to their merge requests or issues |
| `GOOGLE_CHAT_CREDENTIALS` | The Chat app's service account key, as JSON |
| `GOOGLE_CHAT_PROJECT_NUMBER` | Required with it: the number of the Chat app's Google Cloud project |
| `GOOGLE_CHAT_BOT_USER_ID` | Optional. The app's own `users/<id>` name. Without it, every bot's message counts as its own and is skipped |
| `GOOGLE_CHAT_SPACES` | `spaces/<id>=<channel>` pairs, comma-separated: the spaces the board syncs, and their channels. A space it doesn't name stays off the board and out of the inbox |
| `BOARD_TRIAGE_CHANNEL` | Optional. Where the triage watcher announces each new thread from GitLab |

**GitLab.** Point a group or project webhook at `/webhooks/gitlab` with the
secret token and the **Comments**, **Emoji events**, **Merge request events**,
**Issues events** and **Pipeline events** triggers; push events stay off. Each
merge request or issue is one board thread in `gitlab/<subgroup>`: the
namespace under the top group (`acme/platform/web` lands in
`gitlab/platform`), or `gitlab/<group>` for the group's own projects. Every
comment and discussion on it is a reply, and replies on the board go back as
comments by the token's bot. A thread's whole life comes along, as the GitHub
sync's does:

| GitLab event | What the board does |
| --- | --- |
| Merge request opened | A root `MR !<iid>: <title>` with its link, labelled `mr=<project path>!<iid>`, `head=<sha>` and `state=open` or `state=draft` |
| New commits | Sets `head` and unsets the merge request's `ci.<project ID>-<iid>.*`, with no reply |
| Marked ready or draft | Sets `state` |
| Title changed | Edits the root to say the new title |
| Approved by someone | A reply ("approved by ada"). The approval that completes it also sets `review=approved`, and losing an approval unsets it |
| Merged, closed | A reply ("merged by julian", "closed by ada") and `state=merged` or `state=closed` |
| Reopened | A reply ("reopened by ada") and `state=open` or `state=draft` |
| Pipeline failed or canceled | A reply from GitLab CI ("pipeline failed on acme/platform/web!7 at a1b2c3d4: <link>") and `ci.<project ID>-<iid>.pipeline=failed` or `canceled` |
| Pipeline succeeded | Unsets `ci.<project ID>-<iid>.pipeline`, with no reply |
| Issue opened | A root `Issue #<iid>: <title>` with its link, labelled `issue=<project path>#<iid>` and `state=open` |
| Issue closed, reopened | A reply ("closed by ada", "reopened by ada") and `state` |

GitLab delivers webhooks out of order and again on failure, so for each of
these events the board reads the merge request or issue from the API and sets
`state` and `head` as GitLab has them now: a close that arrives after the
reopen still replies, but leaves the state open. A pipeline counts only while
it is the merge request's head pipeline with the status the event names, so a
run a newer push superseded, or a failure GitLab has since retried to
success, stays off the thread. A fork's pipeline lands on the target project's
merge request. Only merge request pipelines carry their merge request; a
branch pipeline reaches no thread. An event or comment on a merge request or
issue the board hasn't seen creates its root from the API first, with the same
text and labels; one from an event is shown as by whoever caused it, or GitLab
CI for a pipeline. The mirror owns `state`, `head`, `review` and `ci.*` on
those roots. The adapter passes
only new public comments and their emoji: comment edits and deletes, system
notes, and internal and confidential notes stay on GitLab. Point the webhook
at no confidential issue events: an issue made confidential after the board
mirrored it then stays on the board as it was.

**Google Chat.** The adapter reads Google Workspace add-on events, so build the
Chat app as an add-on with the HTTP endpoint
`https://<host>/api/board/webhooks/gchat`. Before the adapter reads a request,
the board checks its token itself: Google must have signed it for exactly that
URL, as exactly the app's own add-on identity,
`service-<project number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`, with a
verified email. It refuses Chat's shared identity, other add-ons, tokens for
the project number and Pub/Sub pushes, and logs only why, never the token.
Each Chat thread in a space `GOOGLE_CHAT_SPACES` names is a board thread in
that space's channel, and replies on the board go back to it. Direct messages
to the app are answered and never stored. The board takes only what reaches
the add-on endpoint: messages that mention the app, and interactions with it.
It takes no Workspace Events and needs no domain-wide delegation.

**Triage.** The `triage` watcher labels every new root from GitLab
`status=triage`, never a reply or a label change, and posts a line about it in `BOARD_TRIAGE_CHANNEL` when that
is set. Labels never sync out, and the triage channel starts no platform
threads, so nothing reaches GitLab. Find the queue with
`vb read gitlab/ --label status=triage`, and take a thread off it with
`vb label <id> status=triaged`.

In the chart, `sync.gitlab.secretName` and `sync.gchat.secretName` name the
Secrets whose keys become those variables, and each is optional, so the board
starts before they exist. If an ExternalSecret in an earlier Argo CD sync wave
makes one, the Deployment waits for it, so create its source parameters before
you deploy. `webhookIngress` adds a second Ingress that matches
only `/api/board/webhooks/<entry>` exactly, for a controller that faces the
platform when the rest of the board stays private.

## Deploy it

```bash
helm install board oci://ghcr.io/mfroembgen/charts/board --version 0.56.1 \
  --set host=board.example.com,authkitIssuer=https://<tenant>.authkit.app,teamDomain=example.com
```

The board runs its scheduler in the process, so a restart (an upgrade, a node
drain) drops a pending scheduled send, as on any `local()` board. The chart's volume survives an uninstall (`helm.sh/resource-policy: keep`, and
Argo CD's `Prune=false,Delete=false`). The image runs as `node` on a read-only
root and writes only to `/data` and `/tmp`. The Ingress has no `tls` block:
terminate TLS for `host` in the controller or the load balancer, since
`https://<host>/api/board` is every token's audience.

GHCR makes a newly published package private, also from a public repository.
After the first release, set both `board` and `charts/board` to public in the
packages' settings, and check an anonymous `docker pull` and `helm pull` before
you deploy.
