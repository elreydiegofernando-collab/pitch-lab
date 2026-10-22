/** WAVE 2 PLACEHOLDER: replaced by its builder (docs/ARCHITECTURE.md "Wave 2" ownership table). */
import type { JSX } from 'preact';
import { back } from '../../router';
import { AppBar } from '../components/AppBar';
import { EmptyState } from '../components/EmptyState';

export function Audition(): JSX.Element {
  return (
    <>
      <AppBar title="Audition" onBack={() => back()} />
      <main class="pl-screen">
        <EmptyState title="Audition" message="This screen is being built." />
      </main>
    </>
  );
}
