/** A practice screen with nothing to show (an unknown level, malformed params, no take to report): the reason, and the way back. */
import type { JSX } from 'preact';
import { CircleAlert } from 'lucide-preact';
import { back } from '../../router';
import { AppBar } from '../components/AppBar';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';

export function Unavailable(props: { title: string; message: string }): JSX.Element {
  return (
    <div class="pl-screen" data-testid="unavailable">
      <AppBar title={props.title} onBack={() => back()} />
      <main class="pl-page">
        <EmptyState icon={CircleAlert} title={props.title} message={props.message}>
          <Button variant="secondary" onClick={() => back()}>
            Go back
          </Button>
        </EmptyState>
      </main>
    </div>
  );
}
