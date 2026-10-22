// @vitest-environment happy-dom
/**
 * The Live screen's BottomBar and the song player's SongBar take Space and L exactly like PracticeBar: Space is the
 * primary action, but never over a focused control (which Space activates), typing, an open sheet or a modified key,
 * and a held key's repeats never toggle the mic on and off.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Mic } from 'lucide-preact';
import { SongBar } from '../song/SongBar';
import { BottomBar } from './BottomBar';

let container: HTMLElement;

afterEach(async () => {
  await act(() => {
    render(null, container);
  });
  container.remove();
});

async function show(node: preact.ComponentChild): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(node, container);
  });
}

function key(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

/** Space and L must leave these alone; each bar is mounted by `mount`, which returns its primary and Listen spies. */
function keyboardContract(name: string, mount: () => Promise<{ primary: ReturnType<typeof vi.fn>; listen: ReturnType<typeof vi.fn> }>): void {
  describe(`${name}: Space and L`, () => {
    it('Space is the primary action (the page does not scroll), and L is Listen', async () => {
      const { primary, listen } = await mount();
      const e = key({ code: 'Space', key: ' ' });
      expect(primary).toHaveBeenCalledTimes(1);
      expect(e.defaultPrevented).toBe(true);
      key({ key: 'l', code: 'KeyL' });
      expect(listen).toHaveBeenCalledTimes(1);
    });

    it('ignores a held key: no repeat toggles the mic', async () => {
      const { primary, listen } = await mount();
      for (let i = 0; i < 7; i++) key({ code: 'Space', key: ' ', repeat: true });
      key({ key: 'l', code: 'KeyL', repeat: true });
      expect(primary).not.toHaveBeenCalled();
      expect(listen).not.toHaveBeenCalled();
    });

    it('leaves Space to a focused button, link, radio or switch, which activate on it', async () => {
      const { primary } = await mount();
      const more = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'More options')!;
      const e = key({ code: 'Space', key: ' ' }, more);
      expect(e.defaultPrevented).toBe(false);
      const link = document.createElement('a');
      link.setAttribute('href', '#x');
      container.appendChild(link);
      key({ code: 'Space', key: ' ' }, link);
      for (const role of ['radio', 'switch', 'button']) {
        const el = document.createElement('div');
        el.setAttribute('role', role);
        container.appendChild(el);
        key({ code: 'Space', key: ' ' }, el);
      }
      expect(primary).not.toHaveBeenCalled();
    });

    it('stays out of typing, an open sheet and modified keys', async () => {
      const { primary, listen } = await mount();
      const input = document.createElement('input');
      container.appendChild(input);
      key({ code: 'Space', key: ' ' }, input);
      key({ key: 'l', code: 'KeyL' }, input);
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      const pill = document.createElement('span');
      dialog.appendChild(pill);
      container.appendChild(dialog);
      key({ code: 'Space', key: ' ' }, pill);
      key({ code: 'Space', key: ' ', ctrlKey: true });
      key({ key: 'l', code: 'KeyL', metaKey: true });
      expect(primary).not.toHaveBeenCalled();
      expect(listen).not.toHaveBeenCalled();
    });
  });
}

keyboardContract('BottomBar (Live)', async () => {
  const primary = vi.fn();
  const listen = vi.fn();
  await show(<BottomBar onToggleSing={primary} onListen={listen} singing={false} onMore={vi.fn()} />);
  return { primary, listen };
});

keyboardContract('SongBar (song player)', async () => {
  const primary = vi.fn();
  const listen = vi.fn();
  await show(
    <SongBar
      listening={false}
      listenDisabled={false}
      onListen={listen}
      primary={{ label: 'Sing', icon: Mic, ariaLabel: 'Sing phrase 1', onClick: primary }}
      onMore={vi.fn()}
      shortcuts
    />,
  );
  return { primary, listen };
});
