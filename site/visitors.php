<?php
declare(strict_types=1);

/**
 * visitors.php — anonym besöksräkning för conky-kortet VISITORS.
 *
 * En och samma fil har två lägen, eftersom sidan i övrigt är helt statisk och
 * inte har någon annan PHP att haka i:
 *
 *   GET /visitors.php            → registrerar besöket, svarar 204 (inget innehåll).
 *                                  Anropas av beacon-scriptet i index.html.
 *   GET /visitors.php?t=<token>  → skriver ut summorna i samma pipe-format som
 *                                  node1/cdn/camping/chili, och registrerar inget:
 *
 *                                      # updated <ISO-tid>
 *                                      tabdesk.thern.io|<totalt unika>|<unika idag>
 *
 * Bara antal lämnar servern. Det som lagras är en trunkerad SHA-256 av
 * IP-adressen, saltad med ett slumptal som bara finns i databasen — ingen IP,
 * ingen PII, inga cookies. Token-skyddet finns för att hålla siffrorna utanför
 * sökmotorer, inte för att skydda något känsligt.
 *
 * Räkningen börjar den dag filen deployas; totalen är unika besökare sedan dess.
 */

const SITE_HOST = 'tabdesk.thern.io';
const DB_PATH   = __DIR__ . '/data/visitors.sqlite';

/**
 * Token för läsläget. Den är gemensam för alla thern.io-sajternas
 * statistik-endpoints och hör därför inte hemma i ett publikt repo — den bor i
 * stats-token.php, som är gitignorerad men laddas upp av deploy/site-publish.sh.
 * Saknas filen svarar läsläget 403; räkningen fortsätter oberört.
 */
$tokenFile   = __DIR__ . '/stats-token.php';
$STATS_TOKEN = is_file($tokenFile) ? trim((string) require $tokenFile) : '';

header('X-Robots-Tag: noindex');
header('Cache-Control: no-store');

/* ───────────────────────── Databas ───────────────────────── */

function db(): PDO {
    static $pdo = null;
    if ($pdo instanceof PDO) return $pdo;

    $dir = dirname(DB_PATH);
    if (!is_dir($dir)) {
        @mkdir($dir, 0700, true);
    }
    $pdo = new PDO('sqlite:' . DB_PATH, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    ]);
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA busy_timeout = 3000');
    $pdo->exec('CREATE TABLE IF NOT EXISTS visitors (
                    ip_hash    TEXT PRIMARY KEY,
                    first_seen TEXT NOT NULL
                )');
    $pdo->exec('CREATE TABLE IF NOT EXISTS visitor_days (
                    ip_hash TEXT NOT NULL,
                    day     TEXT NOT NULL,
                    PRIMARY KEY (ip_hash, day)
                )');
    $pdo->exec('CREATE TABLE IF NOT EXISTS meta (
                    k TEXT PRIMARY KEY,
                    v TEXT NOT NULL
                )');
    return $pdo;
}

/** Slumpat salt, skapas en gång och lever i meta. */
function visitor_salt(): string {
    static $salt = null;
    if ($salt !== null) return $salt;
    $st = db()->prepare('SELECT v FROM meta WHERE k = ?');
    $st->execute(['visitor_salt']);
    $salt = (string)($st->fetchColumn() ?: '');
    if ($salt === '') {
        $new = bin2hex(random_bytes(16));
        db()->prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)')
            ->execute(['visitor_salt', $new]);
        $st->execute(['visitor_salt']);   // läs tillbaka ifall någon annan hann först
        $salt = (string)($st->fetchColumn() ?: $new);
    }
    return $salt;
}

/* ───────────────────────── Registrering ───────────────────────── */

/** Klientens IP bakom proxy, eller '' om okänd. */
function client_ip(): string {
    foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_REAL_IP', 'HTTP_X_FORWARDED_FOR'] as $h) {
        if (!empty($_SERVER[$h])) {
            $ip = trim(explode(',', (string)$_SERVER[$h])[0]);
            if (filter_var($ip, FILTER_VALIDATE_IP)) return $ip;
        }
    }
    return (string)($_SERVER['REMOTE_ADDR'] ?? '');
}

/**
 * Ser anropet ut som en riktig sidladdning? Beaconen skickas av JS på vår egen
 * sida — skannrar och crawlers kör ingen JS och saknar därför både vettig
 * User-Agent och Referer härifrån.
 */
function looks_like_a_visitor(): bool {
    $ua = (string)($_SERVER['HTTP_USER_AGENT'] ?? '');
    if ($ua === '') return false;
    if (preg_match('/bot|crawl|spider|slurp|facebookexternalhit|preview|headless|monitor|curl|wget|python-requests|scan|probe|http-client|java\/|libwww|okhttp|go-http-client/i', $ua)) {
        return false;
    }
    if (!preg_match('#mozilla/5\.0#i', $ua)
        || !preg_match('/chrome|chromium|firefox|safari|edg|opera|opr|gecko|crios|fxios/i', $ua)) {
        return false;
    }
    $host = strtolower((string)(parse_url((string)($_SERVER['HTTP_REFERER'] ?? ''), PHP_URL_HOST) ?? ''));
    return $host === SITE_HOST || $host === 'www.' . SITE_HOST;
}

/** Registrera ett besök. Får aldrig kasta vidare — statistik är aldrig kritiskt. */
function record_visit(): void {
    try {
        if (!looks_like_a_visitor()) return;
        $ip = client_ip();
        if ($ip === '') return;
        $hash = substr(hash('sha256', $ip . '|' . visitor_salt()), 0, 16);
        db()->prepare('INSERT OR IGNORE INTO visitors (ip_hash, first_seen) VALUES (?, ?)')
            ->execute([$hash, gmdate('Y-m-d\TH:i:s\Z')]);
        db()->prepare('INSERT OR IGNORE INTO visitor_days (ip_hash, day) VALUES (?, ?)')
            ->execute([$hash, date('Y-m-d')]);
    } catch (Throwable $e) {
        // Tyst.
    }
}

/* ───────────────────────── Två lägen ───────────────────────── */

$token = (string)($_GET['t'] ?? '');

if ($token === '') {
    record_visit();
    http_response_code(204);
    exit;
}

header('Content-Type: text/plain; charset=utf-8');

if ($STATS_TOKEN === '' || !hash_equals($STATS_TOKEN, $token)) {
    http_response_code(403);
    exit("forbidden\n");
}

echo '# updated ' . gmdate('Y-m-d\TH:i:s\Z') . "\n";
try {
    $total = (int) db()->query('SELECT COUNT(*) FROM visitors')->fetchColumn();
    $st = db()->prepare('SELECT COUNT(*) FROM visitor_days WHERE day = ?');
    $st->execute([date('Y-m-d')]);
    printf("%s|%d|%d\n", SITE_HOST, $total, (int)$st->fetchColumn());
} catch (Throwable $e) {
    http_response_code(500);
    echo "# db error\n";
}
