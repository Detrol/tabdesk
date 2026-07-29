/* The hero's rail replica.
 *
 * It runs the one sequence the whole product is about: several agents working,
 * one falling quiet, the flag turning green. The states and their names are the
 * app's own — idle, busy, done — so what the page shows is what the rail does.
 *
 * The loop only runs while the demo is on screen, and prefers-reduced-motion
 * gets the frame that carries the point instead of the animation leading to it. */

(function () {
  const rail = document.getElementById('demo-rail');
  const linesEl = document.getElementById('demo-lines');
  const caption = document.getElementById('demo-caption');
  if (!rail || !linesEl || !caption) return;

  const tabs = [...rail.querySelectorAll('.dtab')];
  const NAMES = tabs.map((t) => t.querySelector('.name').textContent);

  // A plausible minute in the first tab: a command, its chatter, and the line
  // that means it has stopped needing you to wait. Deliberately not an agent
  // session — the signal is about output going quiet, whatever produced it.
  const LINES = [
    { text: '$ make build && make test' },
    { text: '· compiling 214 targets' },
    { text: '· linking api-gateway' },
    { text: '· running 96 tests' },
    { text: '✓ done — 96 passed in 12.4s', cls: 'ok' },
    { text: 'api-gateway main $', cls: 'hash', prompt: true },
  ];

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  let timers = [];
  const at = (ms, fn) => timers.push(setTimeout(fn, ms));
  const clearAll = () => { timers.forEach(clearTimeout); timers = []; };

  function setState(i, state) {
    tabs[i].classList.toggle('is-busy', state === 'busy');
    tabs[i].classList.toggle('is-done', state === 'done');
  }

  function say(text, turn) {
    caption.textContent = text;
    caption.classList.toggle('is-turn', !!turn);
  }

  function addLine(line) {
    const el = document.createElement('div');
    if (line.cls) el.className = line.cls;
    el.textContent = line.text;
    // The cursor belongs after the shell prompt, not on a line of its own.
    if (line.prompt) el.appendChild(document.createElement('span')).className = 'term-caret';
    linesEl.appendChild(el);
  }

  function reset() {
    tabs.forEach((_, i) => setState(i, 'idle'));
    linesEl.replaceChildren();
  }

  // The end state, drawn in one go: what the loop exists to arrive at.
  function finalFrame() {
    reset();
    LINES.forEach(addLine);
    setState(0, 'done');
    setState(1, 'busy');
    setState(2, 'busy');
    say(NAMES[0] + ' is done — your turn', true);
  }

  function runLoop() {
    clearAll();
    reset();
    say('Four projects open.');

    at(300,  () => { setState(0, 'busy'); say('One terminal working.'); });
    at(650,  () => setState(1, 'busy'));
    at(1000, () => { setState(2, 'busy'); say('Three terminals working.'); });

    // The first project's output, arriving while the others keep working.
    LINES.forEach((line, i) => at(1200 + i * 550, () => addLine(line)));

    const quiet = 1200 + LINES.length * 550;   // the moment it stops writing
    at(quiet, () => {
      setState(0, 'done');
      say(NAMES[0] + ' is done — your turn', true);
    });
    at(quiet + 2200, () => {
      setState(2, 'done');
      say('Two tabs waiting for you', true);
    });
    at(quiet + 6000, runLoop);
  }

  function start() {
    if (reduced.matches) { clearAll(); finalFrame(); }
    else runLoop();
  }

  // Off screen, the loop has nobody to explain anything to.
  const demo = document.getElementById('demo');
  if ('IntersectionObserver' in window && demo) {
    new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) start();
        else { clearAll(); }
      }
    }, { threshold: .25 }).observe(demo);
  } else {
    start();
  }

  reduced.addEventListener('change', start);
})();
