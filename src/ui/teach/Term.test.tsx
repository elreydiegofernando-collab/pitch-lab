// @vitest-environment happy-dom
/**
 * Term: a music word you can tap. It opens a small sheet with the plain explanation and an example; "Got it", Esc and a tap
 * outside close it, focus goes back to the word, and a tap on the word never also taps what holds it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { TERM_IDS, TERMS } from '../../teach/glossary';
import { GLOSSARY } from '../../teach/glossary-content';
import { Sheet } from '../components/Sheet';
import { Term } from './Term';

let container: HTMLElement | null = null;

async function show(node: preact.ComponentChild): Promise<HTMLElement> {
  const c = document.createElement('div');
  container = c;
  document.body.appendChild(c);
  await act(() => {
    render(node, c);
  });
  return c;
}

afterEach(async () => {
  const c = container;
  if (!c) return;
  await act(() => {
    render(null, c);
  });
  c.remove();
  container = null;
});

const word = (root: HTMLElement, id = 'in-tune'): HTMLButtonElement => root.querySelector<HTMLButtonElement>(`button[data-term="${id}"]`)!;
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]');

describe('Term: the word', () => {
  it('shows the term’s own word by default, as a button, and the words it is given inside a sentence', async () => {
    const root = await show(
      <p>
        <Term id="drift" /> and <Term id="in-tune">staying in tune</Term>
      </p>,
    );
    expect(word(root, 'drift').textContent).toBe('drifting');
    expect(word(root, 'drift').type).toBe('button');
    expect(word(root, 'in-tune').textContent).toBe('staying in tune');
    expect(root.textContent).toBe('drifting and staying in tune');
    expect(word(root).getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('opens nothing until it is tapped', async () => {
    await show(<Term id="octave" />);
    expect(dialog()).toBeNull();
  });
});

describe('Term: the sheet', () => {
  it('opens with the word as its title, the plain explanation and the example, and closes with Got it', async () => {
    const root = await show(<Term id="in-tune-zone" />);
    await act(() => {
      word(root, 'in-tune-zone').click();
    });
    const sheet = dialog()!;
    expect(sheet).not.toBeNull();
    expect(sheet.getAttribute('aria-label')).toBe('In-tune zone');
    expect(sheet.querySelector('[data-testid="term-plain"]')!.textContent).toBe(GLOSSARY['in-tune-zone'].plain);
    expect(sheet.querySelector('[data-testid="term-example"]')!.textContent).toBe(GLOSSARY['in-tune-zone'].example);
    const gotIt = [...sheet.querySelectorAll('button')].find((b) => b.textContent === 'Got it')!;
    expect(gotIt).toBeDefined();
    await act(() => {
      gotIt.click();
    });
    expect(dialog()).toBeNull();
  });

  it('closes with the close button, with Esc, and with a tap on the scrim', async () => {
    const root = await show(<Term id="octave" />);
    const open = async (): Promise<void> => {
      await act(() => {
        word(root, 'octave').click();
      });
      expect(dialog()).not.toBeNull();
    };
    await open();
    await act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
    });
    expect(dialog()).toBeNull();

    await open();
    await act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(dialog()).toBeNull();

    await open();
    await act(() => {
      document.querySelector<HTMLElement>('.pl-sheet-scrim')!.click();
    });
    expect(dialog()).toBeNull();
  });

  it('draws the sheet on the page itself, not inside whatever holds the word, and clears it away with the word', async () => {
    const root = await show(
      <div style={{ transform: 'translateY(0)' }}>
        <Term id="scale" />
      </div>,
    );
    await act(() => {
      word(root, 'scale').click();
    });
    expect(dialog()!.closest('div[style]')).toBeNull();
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    await act(() => {
      render(null, root);
    });
    expect(dialog()).toBeNull();
  });

  it('opens from inside another sheet, and closing it leaves the first one open', async () => {
    const root = await show(
      <Sheet open title="More" onClose={() => {}}>
        <Term id="range" />
      </Sheet>,
    );
    await act(() => {
      word(root, 'range').click();
    });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    await act(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Got it')!.click();
    });
    const left = document.querySelectorAll('[role="dialog"]');
    expect(left).toHaveLength(1);
    expect(left[0].getAttribute('aria-label')).toBe('More');
  });

  it('keeps the word working after it was closed: it opens again', async () => {
    const root = await show(<Term id="beat" />);
    for (let i = 0; i < 2; i++) {
      await act(() => {
        word(root, 'beat').click();
      });
      expect(dialog()!.getAttribute('aria-label')).toBe('Beat');
      await act(() => {
        document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
      });
      expect(dialog()).toBeNull();
    }
  });

  it('explains every term the contract lists, in the words of its entry', async () => {
    const root = await show(
      <ul>
        {TERM_IDS.map((id) => (
          <li key={id}>
            <Term id={id} />
          </li>
        ))}
      </ul>,
    );
    for (const id of TERM_IDS) {
      expect(word(root, id).textContent).toBe(TERMS[id]);
      await act(() => {
        word(root, id).click();
      });
      expect(document.querySelector('[data-testid="term-plain"]')!.textContent, id).toBe(GLOSSARY[id].plain);
      await act(() => {
        document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
      });
    }
    expect(dialog()).toBeNull();
  });
});

describe('Term: keyboard and focus', () => {
  it('is reached and opened from the keyboard, and gives focus back to the word on close', async () => {
    const root = await show(<Term id="siren" />);
    const button = word(root, 'siren');
    button.focus();
    expect(document.activeElement).toBe(button);
    await act(() => {
      button.click(); // what Enter and Space on a focused button do
    });
    const sheet = dialog()!;
    expect(sheet.contains(document.activeElement)).toBe(true);
    await act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('does not tap what holds it', async () => {
    const outer = vi.fn();
    const root = await show(
      <div onClick={outer}>
        <Term id="step" />
      </div>,
    );
    await act(() => {
      word(root, 'step').click();
    });
    expect(dialog()).not.toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });
});

describe('Term: an id the glossary does not know', () => {
  it('is just its words: no button, nothing to open', async () => {
    const root = await show(<Term id={'no-such-word' as never}>mystery</Term>);
    expect(root.querySelector('button')).toBeNull();
    expect(root.textContent).toBe('mystery');
  });
});

describe('Term: the 48 px target', () => {
  it('is the button’s own box, with the line left exactly as tall as without it', async () => {
    // Vitest hands a stylesheet import over as an empty string, so the file is read from disk (as styles.test.ts does; the
    // module names are built at run time because the app's tsconfig has no Node types, and under happy-dom `new URL` is
    // not a Node URL, so the path is made from import.meta.url as a string).
    const node = (name: string): Promise<unknown> => import(/* @vite-ignore */ `node:${name}`);
    const { readFileSync } = (await node('fs')) as { readFileSync(path: string, encoding: 'utf8'): string };
    const { fileURLToPath } = (await node('url')) as { fileURLToPath(url: string): string };
    const { dirname, resolve } = (await node('path')) as { dirname(path: string): string; resolve(...parts: string[]): string };
    const file = resolve(dirname(fileURLToPath(import.meta.url)), '../../styles/teach.css');
    const css = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const at = css.indexOf('.pl-term {');
    expect(at).toBeGreaterThanOrEqual(0);
    const rule = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
    expect(rule).toContain('min-width: 48px');
    expect(rule).toContain('min-height: 48px');
    expect(rule).toContain('display: inline-block');
    expect(rule).toContain('text-decoration: underline dotted');
    // Padding and negative margins that cancel: the box is 48 px tall, the line is not.
    expect(rule).toContain('padding: 12px 6px');
    expect(rule).toContain('margin: -12px -6px');
    expect(css).toContain('margin-block: calc((1lh - 48px) / 2)');
    expect(css).toContain('padding-block: max(0px, calc((48px - 1lh) / 2))');
  });
});
