/** WAVE 2 PLACEHOLDER: replaced by its builder (docs/ARCHITECTURE.md "Wave 2" ownership table). */
import type { JSX } from 'preact';
import { back } from '../../router';
import { AppBar } from '../components/AppBar';
import { EmptyState } from '../components/EmptyState';

export function SongImport(): JSX.Element {
  return (
    <>
      <AppBar title="Import a song" onBack={() => back()} />
      <main class="pl-screen">
        <EmptyState title="Import a song" message="This screen is being built." />
      </main>
    </>
  );
}
