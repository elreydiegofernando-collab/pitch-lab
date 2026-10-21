/** About: privacy, voice care, open-source credits, and the version. */
import type { JSX } from 'preact';
import { Heart } from 'lucide-preact';
import { back } from '../../router';
import { CONFIG } from '../../config';
import { AppBar } from '../components/AppBar';
import { Card } from '../components/Card';

/** Mirrors package.json's "version" — the ui agent does not edit package.json; see integrationNotes. */
const APP_VERSION = '0.1.0';

export function About(): JSX.Element {
  return (
    <div class="pl-screen" data-testid="about-screen">
      <AppBar title="About & voice care" routeIcon={Heart} onBack={() => back()} />
      <div class="pl-scroll">
        <div class="pl-page pl-fade-rise">
          <Card>
            <span class="pl-display-m">Privacy</span>
            <p class="pl-body pl-prose">
              Your voice audio never leaves this device unless you explicitly export it. Pitch Lab makes no
              analytics calls and no third-party requests at runtime, and nothing you sing is uploaded anywhere.
            </p>
          </Card>

          <Card>
            <span class="pl-display-m">Voice care</span>
            <ul class="pl-stack pl-body pl-prose" style={{ listStyle: 'disc', paddingLeft: '1.2em' }}>
              <li>Warm up before a session and stay hydrated.</li>
              <li>Stop if you feel pain or hoarseness &mdash; don't push through it.</li>
              <li>Don't force the edges of your range; build it gradually.</li>
              <li>Rest between hard sessions.</li>
            </ul>
            <p class="pl-body-s pl-muted">
              Pitch Lab suggests a break after about {CONFIG.health.breakReminderMin} minutes of active singing.
            </p>
            <p class="pl-body-s pl-muted">This is not medical advice.</p>
          </Card>

          <Card>
            <span class="pl-display-m">Open-source credits</span>
            <ul class="pl-stack pl-body-s pl-muted" style={{ listStyle: 'disc', paddingLeft: '1.2em' }}>
              <li>Big Shoulders Display &amp; Instrument Sans fonts &mdash; SIL Open Font License 1.1</li>
              <li>lucide-preact icons &mdash; ISC License</li>
              <li>@tonejs/midi &mdash; MIT License</li>
            </ul>
          </Card>

          <p class="pl-body-s pl-lo">Pitch Lab v{APP_VERSION}</p>
        </div>
      </div>
    </div>
  );
}
