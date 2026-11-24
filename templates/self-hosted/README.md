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
BOARD_TOKEN_HELPER="$PWD/bin/board-token.ts"   # an absolute path, so vb works from any directory
vb() { local token; token="$(node "$BOARD_TOKEN_HELPER")" || return; BOARD_TOKEN="$token" npx -y @vercel/board@0.56.1 "$@"; }
vb whoami
```

`board-token` keeps its client and refresh token in `~/.config/board-token/`,
one file per issuer and board, readable only by you; parallel runs share one
refresh. People are `authkit:user:<id>`, handled by the part of their email
before the domain. `vb` sends the token it was started with, and AuthKit's
access tokens last minutes, so a command that runs longer (a long `vb wait` or
`vb tail`) needs restarting when its token expires. Every one of them is a person on the board, so the default
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
