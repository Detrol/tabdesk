# TabDesk — release & hosting

TabDesk uses the same **pull-based** model as Moraine: a GitHub Release carries
the `.deb`, and the CDN host (cdn.thern.io) pulls it and republishes it into a
signed **reprepro** apt repo. Nothing pushes into the CDN — its firewall stays
closed and it reaches out to GitHub on a timer.

The release also carries a `.tar.gz`. It is *not* a package — reprepro never
sees it; `cdn-pull.sh` drops it in the repo root next to `install.sh`, so
`https://cdn.thern.io/tabdesk/tabdesk-<ver>.tar.gz` is a plain download for
machines without apt. Latest-only, like the pool: publishing a new one deletes
the previous. It carries no dependency metadata, so xterm, xdotool and
python3-gi have to be on the machine already, and it gets no apt updates.

    tag v0.1.1 ──▶ GitHub Actions builds .deb ──▶ GitHub Release
                                                      │  (host pulls)
                                                      ▼
                              reprepro @ cdn:/srv/cdn/tabdesk  ──▶  apt clients

TabDesk has its **own** reprepro base and signing key, separate from Moraine's
`/srv/cdn/deb`. Both the source repo and the apt repo are **public** as of
2026-07-30 — see "Going public" at the bottom for what that changed.

## Cut a release (from the dev machine)

    deploy/release.sh 0.1.1            # bump package.json, tag v0.1.1, push
    deploy/cdn-refresh.sh 0.1.1        # wait for CI, then publish to the CDN now

Or `deploy/release.sh 0.1.1 --refresh` to do both. Without `cdn-refresh`, the
host's timer picks the release up within ~10 min anyway.

## One-time host setup (on cdn.thern.io)

    # reprepro base + dedicated signing key + public key export
    ssh cdn 'bash -s' < deploy/host/apt-repo-setup.sh

    # the published installer (re-copy whenever deploy/host/install.sh changes)
    scp deploy/host/install.sh cdn:/srv/cdn/tabdesk/install.sh

    # the pull script + its systemd timer
    scp deploy/host/cdn-pull.sh cdn:/usr/local/bin/tabdesk-cdn-pull
    scp deploy/host/systemd/tabdesk-cdn-pull.* cdn:/etc/systemd/system/
    ssh cdn 'systemctl daemon-reload && systemctl enable --now tabdesk-cdn-pull.timer'

### The GitHub token — no longer needed

The repo is public, so `cdn-pull.sh` fetches release assets unauthenticated and
`/etc/tabdesk/pull.env` is gone. If the repo is ever made private again, the host
needs a **read-only** token back: create a fine-grained PAT (repo
`TheJonaz/tabdesk`, Contents: Read-only) and drop it on the host with

    ssh cdn 'mkdir -p /etc/tabdesk && install -m600 /dev/stdin /etc/tabdesk/pull.env' <<< 'TABDESK_GH_TOKEN=github_pat_xxx'

## Serving the repo

Everything under `https://cdn.thern.io/tabdesk/` is public (nginx,
`location ^~ /tabdesk/`). The reprepro internals `conf/` and `db/` are 404'd by a
nested location so the machinery is not browsable.

`^~` and not a plain prefix still matters. It keeps this block in charge of
everything under the prefix, so the nested `conf|db` 404 cannot be sidestepped by
the site's `\.(deb|rpm|…)$` regex location further down the file. It mattered more
when the block carried `auth_basic`: without `^~`, that regex location took
precedence for package files and served them with no password at all, leaving the
index protected and the payload wide open.

`/etc/nginx/tabdesk.htpasswd` is kept as-is; nothing reads it while the block has
no `auth_basic`. To close the repo again, put these two lines back in the block
and reload:

    auth_basic "TabDesk";
    auth_basic_user_file /etc/nginx/tabdesk.htpasswd;

Add or rotate a user (on the host):

    ssh cdn "printf '%s:%s\n' USER \"\$(openssl passwd -apr1 'PASSWORD')\" \
      >> /etc/nginx/tabdesk.htpasswd && nginx -t && systemctl reload nginx"

Publishing is unaffected either way: `cdn-pull.sh` runs on the host and writes
through reprepro, never through nginx.

## Install (on the laptop)

    curl -fsSL https://cdn.thern.io/tabdesk/install.sh | sudo bash

That's `deploy/host/install.sh`, which fetches the key, **checks its fingerprint
before writing the keyring**, then adds the source and installs. It still honours
`TABDESK_CDN_AUTH=user:password` for the case where the CDN is put back behind
Basic auth, and it removes a leftover `auth.conf.d/tabdesk.conf` from the private
days when run without it. By hand:

    curl -fsSL https://cdn.thern.io/tabdesk/tabdesk-archive-keyring.gpg -o /tmp/tabdesk.gpg
    gpg --show-keys /tmp/tabdesk.gpg     # must print B40E D009 54B3 B564 21F5  8C99 B9D4 4CBC 6F2B D93E
    sudo install -m644 /tmp/tabdesk.gpg /usr/share/keyrings/tabdesk.gpg
    echo "deb [signed-by=/usr/share/keyrings/tabdesk.gpg] https://cdn.thern.io/tabdesk stable main" \
      | sudo tee /etc/apt/sources.list.d/tabdesk.list
    sudo apt update && sudo apt install tabdesk

Update later: `sudo apt update && sudo apt upgrade tabdesk`, or the **⬆ chip** in
TabDesk's system bar. The in-app updater reads apt's own package list (world
readable, no root) and installs with `apt-get install --only-upgrade` through
pkexec — it deliberately never fetches from the CDN itself.

**Do not pipe the key straight into the keyring.** If the URL is reached through
anything but the CDN — a mail client's link wrapper (Gmail rewrites URLs to
`www.google.com/url?q=…`), a proxy, a captive portal — the fetch still returns
200, with an HTML page. `curl -f` accepts it, the markup lands in the keyring,
and the only symptom is a keyring parse error from `apt update` that points
nowhere near the actual mistake. Verify first, write second. When sending these
instructions by mail, send **plain text** and check the URLs in the received
copy are bare `cdn.thern.io` links.

## Signing key

Lives on the CDN host (`TabDesk APT repository`, created by `apt-repo-setup.sh`),
because reprepro signs there. Clients pin it, so **keep it** — a different key on
a later release breaks `apt update`. Back it up from the host:
`gpg --export-secret-keys --armor 'TabDesk APT repository' > tabdesk-repo-key.asc`.

## Going public — 2026-07-30

1. `gh repo edit TheJonaz/tabdesk --visibility public` — **done**.
2. `/etc/tabdesk/pull.env` removed; `cdn-pull.sh` fetches release assets
   unauthenticated — **done**, verified by a successful unauthenticated pull.
3. `install.sh` no longer requires `TABDESK_CDN_AUTH`; it removes a leftover
   `auth.conf.d/tabdesk.conf` when run without credentials, since that password
   no longer opens anything — **done**.
4. Install copy rewritten on the site (`site/index.html`, `site/llms.txt`, and the
   FAQ JSON-LD that mirrors the visible text) and on the host install pages —
   **written, not yet deployed**. It must not go live before step 5, or it
   advertises a one-liner that answers 401.
5. Drop `auth_basic` from `location ^~ /tabdesk/` in
   `/etc/nginx/sites-available/cdn` and reload — **still to do**. Leave the
   htpasswd file in place; nothing reads it once the directive is gone.

       ssh cdn 'cp /etc/nginx/sites-available/cdn /etc/nginx/sites-available/cdn.bak-tabdesk-public \
         && sed -i "/location \^~ \/tabdesk\/ {/,/^    }/{/auth_basic/d}" /etc/nginx/sites-available/cdn \
         && nginx -t && systemctl reload nginx && echo RELOADED'

   Then deploy step 4 and check an anonymous fetch returns 200:

       curl -fsSL https://cdn.thern.io/tabdesk/install.sh | head -3

Before flipping visibility, the whole history was scanned for the FTP password and
for `github_pat_*` / `ghp_*` / `sk-*` / `AKIA*` patterns — clean, and no `.env` or
key file was ever tracked. Worth repeating if history is ever rewritten.

Note that `deploy/repo/` (gitignored, from the old local-apt-repo experiment) holds
a **different** keyring, fingerprint `D259DC35…`. It is not the CDN signing key —
don't hand it to anyone as one.
