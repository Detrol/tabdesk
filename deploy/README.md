# TabDesk — release & hosting

TabDesk uses the same **pull-based** model as Moraine: a GitHub Release carries
the `.deb`, and the CDN host (cdn.thern.io) pulls it and republishes it into a
signed **reprepro** apt repo. Nothing pushes into the CDN — its firewall stays
closed and it reaches out to GitHub on a timer.

    tag v0.1.1 ──▶ GitHub Actions builds .deb ──▶ GitHub Release
                                                      │  (host pulls)
                                                      ▼
                              reprepro @ cdn:/srv/cdn/tabdesk  ──▶  apt clients

TabDesk has its **own** reprepro base and signing key, separate from Moraine's
`/srv/cdn/deb`. The repo is unlisted for now ("secret" = obscure URL, the source
repo is private); flip both to public when ready.

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

### The GitHub token (private repo)

While the source repo is private the host needs a **read-only** token to fetch
release assets. Create a fine-grained PAT (repo `TheJonaz/tabdesk`, Contents:
Read-only) and drop it on the host:

    ssh cdn 'mkdir -p /etc/tabdesk && install -m600 /dev/stdin /etc/tabdesk/pull.env' <<< 'TABDESK_GH_TOKEN=github_pat_xxx'

When the repo goes public, delete that file — the pull works unauthenticated.

## Install (on the laptop)

    curl -fsSL https://cdn.thern.io/tabdesk/install.sh | sudo bash

That's `deploy/host/install.sh`, which fetches the key, **checks its fingerprint
before writing the keyring**, then adds the source and installs. By hand:

    curl -fsSL https://cdn.thern.io/tabdesk/tabdesk-archive-keyring.gpg -o /tmp/tabdesk.gpg
    gpg --show-keys /tmp/tabdesk.gpg     # must print B40E D009 54B3 B564 21F5  8C99 B9D4 4CBC 6F2B D93E
    sudo install -m644 /tmp/tabdesk.gpg /usr/share/keyrings/tabdesk.gpg
    echo "deb [signed-by=/usr/share/keyrings/tabdesk.gpg] https://cdn.thern.io/tabdesk stable main" \
      | sudo tee /etc/apt/sources.list.d/tabdesk.list
    sudo apt update && sudo apt install tabdesk

Update later: `sudo apt update && sudo apt upgrade tabdesk`.

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

## Going public

1. `gh repo edit TheJonaz/tabdesk --visibility public`
2. `ssh cdn 'rm /etc/tabdesk/pull.env'` (token no longer needed)
3. Advertise the install snippet above / link the repo from a storefront page.
