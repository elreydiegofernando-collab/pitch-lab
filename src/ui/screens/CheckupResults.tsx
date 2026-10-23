/** PLACEHOLDER: replaced by its builder (check-up and song practice round, 2026-10-22). */
import type { JSX } from 'preact';
import { back } from '../../router';
import { AppBar } from '../components/AppBar';
import { EmptyState } from '../components/EmptyState';

export function CheckupResults(): JSX.Element {
  return (
    <>
      <AppBar title="Check-up results" onBack={() => back()} />
      <main class="pl-screen">
        <EmptyState title="Check-up results" message="This screen is being built." />
      </main>
    </>
  );
}
