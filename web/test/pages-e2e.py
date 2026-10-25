"""Opt-in browser regression: python3 web/test/pages-e2e.py STATIC_WEB_URL EVIDENCE_DIR.

Serve the repository with a static server first. Requires chrome-devtools-axi.
Uses a separate browser session and never touches a running backend.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

base = sys.argv[1].rstrip('/') + '/'
evidence = Path(sys.argv[2])
evidence.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, CHROME_DEVTOOLS_AXI_SESSION='bizos-pages-fixes')


def browser(*args):
    result = subprocess.run(['chrome-devtools-axi', *args], env=env,
                            capture_output=True, text=True, check=True)
    assert not result.stdout.startswith('error:'), result.stdout
    with (evidence / 'browser-regression.log').open('a') as log:
        log.write(f'{args[0]}: {result.stdout}\n')
    return result.stdout


def evaluate(js):
    output = browser('eval', js)
    line = next(line for line in output.splitlines() if line.startswith('result: '))
    value = json.loads(line.removeprefix('result: '))
    return json.loads(value) if isinstance(value, str) else value


def expect(js):
    assert evaluate(js) is True, js


for width, height in [(390, 844), (1440, 756)]:
    browser('emulate', '--viewport', f'{width}x{height}x1,mobile,touch' if width == 390 else f'{width}x{height}x1')
    for page in ['', 'widget.html?name=Dana&email=dana@example.com', 'demo.html']:
        browser('open', base + page)
        time.sleep(.3)
        expect('''() => {
          const docs = [document, ...[...document.querySelectorAll('iframe')].map(f => f.contentDocument)];
          return docs.every(d => d.documentElement.scrollWidth <= d.defaultView.innerWidth &&
            [...d.querySelectorAll('button,input,textarea,.case-badges,.chat')].every(e => {
              const r = e.getBoundingClientRect();
              return r.right <= d.defaultView.innerWidth + 1 && r.left >= -1;
            }));
        }''')
        name = page.split('.')[0] or 'desk'
        browser('screenshot', str(evidence / f'checked-{width}-{name}.png'))

desk = 'document.querySelector("iframe[title=\\"Owner desk\\"]").contentDocument'
widget = 'document.querySelector("iframe[title=\\"Customer widget\\"]").contentDocument'
evaluate(f'() => {{ const d={desk}; d.querySelector("#empty-demo").click(); return true; }}')
evaluate(f'''() => {{ const d={widget}; d.querySelector('#text').value='E2E shared widget submission';
  d.querySelector('#form').requestSubmit(); return true; }}''')
time.sleep(2.2)
expect(f'{desk}.body.innerText.includes("Dana")')
evaluate(f'() => {{ const d={desk}; d.querySelector(".row").click(); return true; }}')
expect(f'{desk}.body.innerText.includes("E2E shared widget submission")')
expect(f'{desk}.body.innerText.includes("No AI ran and nothing was sent")')
browser('screenshot', str(evidence / 'checked-shared-widget.png'))

evaluate(f'() => {{ {desk}.querySelector("[data-inject=unsafe]").click(); return true; }}')
time.sleep(.1)
expect(f'{desk}.body.innerText.includes("Maximum permitted: $200")')
evaluate(f'() => {{ {desk}.querySelector("[data-open-rules]").click(); return true; }}')
time.sleep(.1)
evaluate(f'''() => {{ const d={desk}, t=d.querySelector('#rules-text');
  t.value=t.value.replace('max_amount_cents: 20000','max_amount_cents: 60000').replace('more than $200','more than $600');
  t.dispatchEvent(new Event('input',{{bubbles:true}})); d.querySelector('#rules-form').requestSubmit(); return true; }}''')
time.sleep(.1)
expect(f'{desk}.querySelector("#rules-error").innerText === ""')
expect(f'{desk}.querySelector("#rules-text").value.includes("version: 5")')
browser('screenshot', str(evidence / 'checked-saved-v5.png'))
evaluate(f'() => {{ {desk}.querySelector("#close-rules").click(); return true; }}')
evaluate(f'() => {{ {desk}.querySelector("[data-rerun]").click(); return true; }}')
time.sleep(.1)
expect(f'{desk}.body.innerText.includes("GATE HOLD") && {desk}.body.innerText.includes("REVIEW")')
browser('screenshot', str(evidence / 'checked-rerun-review.png'))
print('PASS: 390px and 1440x756 layouts, shared widget intake, $500 BLOCK, v4 to v5 save, REVIEW rerun')
