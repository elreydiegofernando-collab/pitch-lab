// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';

vi.mock('../../state/settings', async () => (await import('./test-fakes')).settingsModule());
vi.mock('../../state/audio', async () => (await import('./test-fakes')).audioModule());

import { installRouteGuard, resetRouterForTests, route, routeOf } from '../../router';
import { resetAudio } from '../../state/audio';
import { MoreSheet } from './MoreSheet';
import { resetSession, settingsSignal, updateSettingsMock } from './test-fakes';

let container: HTMLElement;

async function mount(props: { showReset?: boolean; onClose?: () => void; children?: preact.ComponentChildren } = {}): Promise<void> {
  resetRouterForTests([routeOf('home'), routeOf('sing', { target: 'level', levelId: 'foundations.03' })]);
  installRouteGuard(() => ({ ok: true }));
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(
      <MoreSheet open onClose={props.onClose ?? vi.fn()} showReset={props.showReset}>
        {props.children}
      </MoreSheet>,
      container,
    );
  });
}

const buttonNamed = (name: string): HTMLButtonElement | undefined => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(name));

beforeEach(() => {
  resetSession();
  vi.mocked(resetAudio).mockClear();
});

afterEach(async () => {
  await act(() => {
    render(null, container);
  });
  container.remove();
});

describe('MoreSheet', () => {
  it('has the Listen volume as a slider, writing the setting', async () => {
    await mount();
    expect(document.body.textContent).toContain('70%');
    const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider.getAttribute('aria-label')).toBe('Listen volume');
    slider.value = '0.25';
    await act(() => {
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(updateSettingsMock).toHaveBeenCalledWith({ referenceVolume: 0.25 });
    expect(settingsSignal.value.referenceVolume).toBe(0.25);
    expect(document.body.textContent).toContain('25%');
  });

  it('puts a screen’s own sections above the shared ones', async () => {
    await mount({ children: <p data-testid="own">Vibrato style</p> });
    const own = document.querySelector('[data-testid="own"]')!;
    const slider = document.querySelector('input[type="range"]')!;
    expect(own.compareDocumentPosition(slider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers Reset audio only where the microphone opens, and calls it straight from the click', async () => {
    await mount();
    expect(buttonNamed('Reset audio')).toBeUndefined();
    await act(() => {
      render(null, container);
    });
    container.remove();
    await mount({ showReset: true });
    buttonNamed('Reset audio')!.click();
    expect(resetAudio).toHaveBeenCalledTimes(1);
  });

  it('offers Send to Claude only where a screen asks for it: it closes itself, then hands over', async () => {
    await mount();
    expect(buttonNamed('Send to Claude')).toBeUndefined();
    await act(() => {
      render(null, container);
    });
    container.remove();
    const onClose = vi.fn();
    const onSendToClaude = vi.fn();
    resetRouterForTests([routeOf('home'), routeOf('level', { levelId: 'foundations.03' })]);
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(() => {
      render(<MoreSheet open onClose={onClose} onSendToClaude={onSendToClaude} />, container);
    });
    expect(document.body.textContent).toContain('Save a file of your last takes of this exercise, for a closer look in chat.');
    buttonNamed('Send to Claude')!.click();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSendToClaude).toHaveBeenCalledTimes(1);
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(onSendToClaude.mock.invocationCallOrder[0]);
  });

  it('closes itself and opens Setup & calibration', async () => {
    const onClose = vi.fn();
    await mount({ onClose });
    buttonNamed('Setup')!.click();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(route.value.name).toBe('setup');
  });
});
