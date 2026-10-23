/** PLACEHOLDER: replaced by its builder (check-up and song practice round, 2026-10-22). */
import type { JSX } from 'preact';
import { back } from '../../router';
import { AppBar } from '../components/AppBar';
import { EmptyState } from '../components/EmptyState';

export function Checkup(): JSX.Element {
  return (
    <>
      <AppBar title="Voice check-up" onBack={() => back()} />
      <main class="pl-screen">
        <EmptyState title="Voice check-up" message="This screen is being built." />
      </main>
    </>
  );
}
