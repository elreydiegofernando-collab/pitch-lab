// @vitest-environment happy-dom
/** The action row: its labels follow the take, and the desktop keys never double-fire or steal a focused control. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { PracticeBar, type PracticeBarProps } from './PracticeBar';

let container: HTMLElement;

async function mount(props: PracticeBarProps): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<PracticeBar {...props} />, container);
  });
}

async function rerender(props: PracticeBarProps): Promise<void> {
  await act(() => {
    render(<PracticeBar {...props} />, container);
  });
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => container.querySelector<T>(sel);
const key = (init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};

afterEach(async () => {
  await act(() => {
    render(null, container);
  });
  container.remove();
});

describe('PracticeBar: what it shows', () => {
  it('has Listen, the primary and More, each with a text label', async () => {
    await mount({
      listen: { label: 'Listen', onClick: vi.fn() },
      primary: { kind: 'sing', label: 'Sing', onClick: vi.fn() },
      more: { onClick: vi.fn() },
    });
    expect(q('[data-testid="listen-button"]')?.textContent).toContain('Listen');
    expect(q('[data-testid="sing-button"]')?.textContent).toContain('Sing');
    expect(q('[data-testid="more-button"]')?.textContent).toContain('More');
    expect(q('[data-testid="more-button"]')?.getAttribute('aria-label')).toBe('More options');
    expect(q('nav')?.getAttribute('aria-label')).toBe('Primary actions');
  });

  it('keeps the three columns when Listen or More are not offered', async () => {
    await mount({ primary: { kind: 'sing', label: 'Sing again', onClick: vi.fn() } });
    expect(q('[data-testid="listen-button"]')).toBeNull();
    expect(q('[data-testid="more-button"]')).toBeNull();
    expect(container.querySelector('nav')!.children).toHaveLength(3);
    expect(q('[data-testid="sing-button"]')?.textContent).toContain('Sing again');
  });

  it('turns Listen into Stop for the demo', async () => {
    await mount({ listen: { label: 'Stop', onClick: vi.fn() }, primary: { kind: 'sing', label: 'Sing', onClick: vi.fn() } });
    expect(q('[data-testid="listen-button"]')?.getAttribute('aria-label')).toBe('Stop the demo');
    expect(q('[data-testid="listen-button"]')?.textContent).toContain('Stop');
  });

  it('shows Stop in the alert colour, Try again with its own label, and a spinner while busy', async () => {
    await mount({ primary: { kind: 'stop', label: 'Stop', onClick: vi.fn() } });
    expect(q('[data-testid="sing-button"]')?.className).toContain('pl-bottombar__primary--running');
    expect(q('[data-testid="sing-button"]')?.getAttribute('aria-label')).toBe('Stop singing');
    await rerender({ primary: { kind: 'retry', label: 'Try again', onClick: vi.fn() } });
    expect(q('[data-testid="sing-button"]')?.getAttribute('aria-label')).toBe('Try again');
    await rerender({ primary: { kind: 'busy', label: 'Scoring…', onClick: vi.fn() } });
    const busy = q<HTMLButtonElement>('[data-testid="sing-button"]')!;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.querySelector('.pl-btn__spinner')).not.toBeNull();
    expect(busy.textContent).toContain('Scoring…');
  });
});

describe('PracticeBar: clicks', () => {
  it('calls the handler of each button from the click itself', async () => {
    const listen = vi.fn();
    const sing = vi.fn();
    const more = vi.fn();
    await mount({ listen: { label: 'Listen', onClick: listen }, primary: { kind: 'sing', label: 'Sing', onClick: sing }, more: { onClick: more } });
    q<HTMLButtonElement>('[data-testid="listen-button"]')!.click();
    q<HTMLButtonElement>('[data-testid="sing-button"]')!.click();
    q<HTMLButtonElement>('[data-testid="more-button"]')!.click();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(sing).toHaveBeenCalledTimes(1);
    expect(more).toHaveBeenCalledTimes(1);
  });

  it('does not call a disabled button', async () => {
    const sing = vi.fn();
    await mount({ primary: { kind: 'sing', label: 'Sing', onClick: sing, disabled: true } });
    q<HTMLButtonElement>('[data-testid="sing-button"]')!.click();
    expect(sing).not.toHaveBeenCalled();
  });
});

describe('PracticeBar: desktop keys', () => {
  it('Space is the primary action, and the page does not scroll', async () => {
    const sing = vi.fn();
    await mount({ primary: { kind: 'sing', label: 'Sing', onClick: sing } });
    const e = key({ code: 'Space', key: ' ' });
    expect(sing).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('L is Listen', async () => {
    const listen = vi.fn();
    await mount({ listen: { label: 'Listen', onClick: listen }, primary: { kind: 'sing', label: 'Sing', onClick: vi.fn() } });
    key({ key: 'l', code: 'KeyL' });
    key({ key: 'L', code: 'KeyL', shiftKey: true });
    expect(listen).toHaveBeenCalledTimes(2);
  });

  it('ignores a held key, a disabled or busy primary, and a disabled Listen', async () => {
    const sing = vi.fn();
    const listen = vi.fn();
    await mount({ listen: { label: 'Listen', onClick: listen, disabled: true }, primary: { kind: 'sing', label: 'Sing', onClick: sing } });
    key({ code: 'Space', key: ' ', repeat: true });
    expect(sing).not.toHaveBeenCalled();
    key({ key: 'l', code: 'KeyL' });
    expect(listen).not.toHaveBeenCalled();
    await rerender({ primary: { kind: 'sing', label: 'Sing', onClick: sing, disabled: true } });
    key({ code: 'Space', key: ' ' });
    await rerender({ primary: { kind: 'busy', label: 'Scoring…', onClick: sing } });
    key({ code: 'Space', key: ' ' });
    expect(sing).not.toHaveBeenCalled();
  });

  it('leaves Space to a focused button or link, which activate on it', async () => {
    const sing = vi.fn();
    await mount({ primary: { kind: 'sing', label: 'Sing', onClick: sing }, more: { onClick: vi.fn() } });
    const more = q<HTMLButtonElement>('[data-testid="more-button"]')!;
    key({ code: 'Space', key: ' ' }, more);
    const link = document.createElement('a');
    link.setAttribute('href', '#x');
    container.appendChild(link);
    key({ code: 'Space', key: ' ' }, link);
    const radio = document.createElement('div');
    radio.setAttribute('role', 'radio');
    container.appendChild(radio);
    key({ code: 'Space', key: ' ' }, radio);
    expect(sing).not.toHaveBeenCalled();
  });

  it('stays out of typing, a slider, an open sheet and modified keys', async () => {
    const sing = vi.fn();
    const listen = vi.fn();
    await mount({ listen: { label: 'Listen', onClick: listen }, primary: { kind: 'sing', label: 'Sing', onClick: sing } });
    const input = document.createElement('input');
    container.appendChild(input);
    key({ code: 'Space', key: ' ' }, input);
    key({ key: 'l', code: 'KeyL' }, input);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const inner = document.createElement('p');
    dialog.appendChild(inner);
    container.appendChild(dialog);
    key({ code: 'Space', key: ' ' }, inner);
    key({ code: 'Space', key: ' ', ctrlKey: true });
    key({ key: 'l', code: 'KeyL', metaKey: true });
    expect(sing).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it('uses the newest handlers after a re-render, and stops listening when it goes away', async () => {
    const first = vi.fn();
    const second = vi.fn();
    await mount({ primary: { kind: 'sing', label: 'Sing', onClick: first } });
    await rerender({ primary: { kind: 'sing', label: 'Sing', onClick: second } });
    key({ code: 'Space', key: ' ' });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    await act(() => {
      render(null, container);
    });
    key({ code: 'Space', key: ' ' });
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('PracticeBar: Esc', () => {
  it('offers Esc to onEscape first, and when it acts the router never sees the key', async () => {
    const onEscape = vi.fn(() => true);
    await mount({ primary: { kind: 'stop', label: 'Stop', onClick: vi.fn() }, onEscape });
    const router = vi.fn();
    window.addEventListener('keydown', router);
    try {
      const e = key({ key: 'Escape', code: 'Escape' });
      expect(onEscape).toHaveBeenCalledTimes(1);
      expect(router).not.toHaveBeenCalled();
      expect(e.defaultPrevented).toBe(true);
    } finally {
      window.removeEventListener('keydown', router);
    }
  });

  it('lets Esc go on to Back when onEscape has nothing to stop', async () => {
    const onEscape = vi.fn(() => false);
    await mount({ primary: { kind: 'sing', label: 'Sing', onClick: vi.fn() }, onEscape });
    const router = vi.fn();
    window.addEventListener('keydown', router);
    try {
      key({ key: 'Escape', code: 'Escape' });
      expect(onEscape).toHaveBeenCalledTimes(1);
      expect(router).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', router);
    }
  });

  it('does nothing about Esc without onEscape', async () => {
    await mount({ primary: { kind: 'sing', label: 'Sing', onClick: vi.fn() } });
    const router = vi.fn();
    window.addEventListener('keydown', router);
    try {
      key({ key: 'Escape', code: 'Escape' });
      expect(router).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', router);
    }
  });
});
